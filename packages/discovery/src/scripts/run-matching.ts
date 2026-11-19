/**
 * Matching CLI: `pnpm match [--force] [--limit N] [--embed] [--job <uuid>] [--top N]`
 *
 * Runs the real engine against the real corpus. Exists so matching can be
 * exercised and verified without the web app in the loop — which is how the
 * scoring gets checked against live enriched data during development, and how
 * the score distribution becomes something you can look at rather than assume.
 */
import { loadDotenv, loadEnv, AppConfigProvider } from '@job-intel/config';
import { createLogger, EventRecorder } from '@job-intel/observability';
import {
  CandidateRepository,
  ConfigRepository,
  EmbeddingRepository,
  EnrichmentRepository,
  EventRepository,
  JobRepository,
  MatchRepository,
  ProfileRepository,
  createDatabase,
  optionsFromEnv,
} from '@job-intel/db';
import { HashingEmbeddingProvider } from '@job-intel/matching';
import { MATCHING_VERSION } from '@job-intel/contracts';
import { MatchingService } from '../matching-service';
import { CandidateIntelligenceService } from '../candidate-intelligence-service';

function parseArgs(argv: string[]) {
  let force = false;
  let embed = false;
  let limit: number | undefined;
  let top = 10;
  let jobId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') force = true;
    else if (arg === '--embed') embed = true;
    else if (arg === '--limit') limit = Number(argv[++i]);
    else if (arg === '--top') top = Number(argv[++i]);
    else if (arg === '--job') jobId = argv[++i];
  }
  return { force, embed, limit, top, jobId };
}

function bar(score: number, width = 24): string {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * width);
  return `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`;
}

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv(process.env, { role: 'worker' });
  const args = parseArgs(process.argv.slice(2));

  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY,
    base: { service: 'match-cli' },
  });

  const handle = await createDatabase(optionsFromEnv(env));
  const events = new EventRecorder(logger, new EventRepository(handle.db));
  const config = await new AppConfigProvider(new ConfigRepository(handle.db)).get();

  const profiles = new ProfileRepository(handle.db);
  const profile = await profiles.getActiveProfile();
  if (!profile) {
    console.error('No active candidate profile. Create one before matching.');
    await handle.close();
    process.exitCode = 1;
    return;
  }

  const matches = new MatchRepository(handle.db);
  const candidates = new CandidateRepository(handle.db);

  const service = new MatchingService({
    matches,
    candidates,
    profiles,
    enrichments: new EnrichmentRepository(handle.db),
    jobs: new JobRepository(handle.db),
    embeddings: new EmbeddingRepository(handle.db),
    logger,
    events,
    config: { thresholds: { possible: config.matching.minimumScore } },
    // Local, deterministic, clearly labelled. Exercises the semantic pathway
    // end to end without a paid API; the model id says what it is.
    embedder: new HashingEmbeddingProvider(config.ai.embeddingDimensions),
  });

  console.log(`\nMatching engine ${MATCHING_VERSION}`);
  console.log(`Profile ${profile.profileId} (v${profile.version})\n`);

  if (args.embed) {
    const backfill = await service.backfillJobEmbeddings(args.limit ?? 500);
    console.log(`Embeddings: ${backfill.embedded} generated, ${backfill.skipped} skipped`);

    // The canonical profile text has to exist before there is anything to
    // embed. Building it belongs to the candidate layer, not the matching
    // layer — duplicating it here would give the system two definitions of
    // "what the candidate's profile says", which is how they drift apart.
    const intelligence = new CandidateIntelligenceService({
      candidates,
      profiles,
      logger,
      events,
      embeddingModel: new HashingEmbeddingProvider(config.ai.embeddingDimensions).model,
      embeddingDimensions: config.ai.embeddingDimensions,
    });
    const canonical = await intelligence.refreshCanonicalProfile(profile.profileId);
    console.log(`Canonical profile: ${canonical.hash.slice(0, 12)} (${canonical.reason})`);

    const candidateVector = await service.rebuildCandidateEmbedding(profile.profileId);
    console.log(`Candidate vector: ${candidateVector.reason}\n`);
  }

  if (args.jobId) {
    const match = await service.matchJob(profile.profileId, args.jobId, 'cli');
    console.log(JSON.stringify(match, null, 2));
    await handle.close();
    return;
  }

  const result = await service.matchAll(profile.profileId, {
    force: args.force,
    reason: 'cli match run',
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });

  console.log('── Run ────────────────────────────────────────────');
  console.log(`considered  ${result.considered}`);
  console.log(`matched     ${result.matched}`);
  console.log(`failed      ${result.failed}`);
  console.log(`eligible    ${result.eligible}`);
  console.log(`ineligible  ${result.ineligible}`);
  console.log(`llm calls   ${result.llmCalls}`);
  console.log(`duration    ${result.durationMs} ms`);
  if (result.matched > 0) {
    console.log(`avg/job     ${(result.durationMs / result.matched).toFixed(1)} ms`);
  }

  if (result.errors.length > 0) {
    console.log('\n── Errors ─────────────────────────────────────────');
    for (const error of result.errors.slice(0, 10)) {
      console.log(`${error.jobId}  ${error.error}`);
    }
  }

  const statistics = await matches.statistics(profile.profileId);
  console.log('\n── Distribution ───────────────────────────────────');
  for (const [category, count] of Object.entries(statistics.byRecommendation).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`${category.padEnd(20)} ${String(count).padStart(5)}`);
  }
  console.log(`\naverage score      ${statistics.averageScore}`);
  console.log(`average confidence ${statistics.averageConfidence}`);

  const top = await matches.list({ profileId: profile.profileId, limit: args.top });
  const jobsRepo = new JobRepository(handle.db);

  console.log('\n── Top matches ────────────────────────────────────');
  for (const match of top) {
    const job = await jobsRepo.getById(match.jobId);
    console.log(
      `\n${bar(match.overallScore)} ${String(Math.round(match.overallScore)).padStart(3)}  ` +
        `${match.recommendation}  (${Math.round(match.confidence * 100)}% conf.)`,
    );
    console.log(`  ${job?.title ?? 'unknown'} — ${job?.companyNameRaw ?? 'unknown'}`);
    console.log(`  ${match.explanation}`);
    const applicable = match.componentScores.filter((c) => c.applicable);
    console.log(
      `  dimensions: ${applicable
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((c) => `${c.dimension} ${Math.round(c.score)}`)
        .join(', ')}`,
    );
    if (match.hardConstraintResult.unknowns.length > 0) {
      console.log(
        `  unresolved: ${match.hardConstraintResult.unknowns.map((u) => u.constraint).join(', ')}`,
      );
    }
  }

  // Ineligible jobs are printed separately and with their reasons: the useful
  // question about an exclusion is "was that right?", which needs the reason.
  const ineligible = await matches.list({
    profileId: profile.profileId,
    eligibleOnly: false,
    recommendations: ['INELIGIBLE'],
    limit: 5,
  });
  if (ineligible.length > 0) {
    console.log('\n── Excluded (sample) ──────────────────────────────');
    for (const match of ineligible) {
      const job = await jobsRepo.getById(match.jobId);
      console.log(`\n  ${job?.title ?? 'unknown'} — ${job?.companyNameRaw ?? 'unknown'}`);
      for (const violation of match.hardConstraintResult.violations) {
        console.log(`    ✗ ${violation.constraint}: ${violation.explanation}`);
      }
    }
  }

  const pending = await matches.findJobsNeedingMatch(profile.profileId, { limit: 5000 });
  console.log(`\nAwaiting rescore: ${pending.length}\n`);

  await handle.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
