/**
 * Recommendation CLI: `pnpm recommend [--dedup] [--signals] [--top N] [--limit N]`
 *
 * Runs the real pipeline stages against the real corpus — deduplicate, refresh
 * signals, rank — and prints the resulting order with the reasons behind it.
 * Exists so the ranking can be *looked at* rather than assumed: the only way to
 * tell whether a ranking is sensible is to read the top twenty and disagree.
 */
import { loadDotenv, loadEnv, AppConfigProvider } from '@job-intel/config';
import { createLogger, EventRecorder } from '@job-intel/observability';
import {
  CandidateRepository,
  ConfigRepository,
  EventRepository,
  ProfileRepository,
  RecommendationRepository,
  SourceRepository,
  createDatabase,
  optionsFromEnv,
} from '@job-intel/db';
import { RECOMMENDATION_VERSION, TIER_ICONS } from '@job-intel/contracts';
import { RecommendationService } from '../recommendation-service';

function parseArgs(argv: string[]) {
  let dedup = false;
  let signals = true;
  let top = 15;
  let limit = 2000;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dedup') dedup = true;
    else if (arg === '--no-signals') signals = false;
    else if (arg === '--top') top = Number(argv[++i]);
    else if (arg === '--limit') limit = Number(argv[++i]);
  }
  return { dedup, signals, top, limit };
}

function bar(score: number, width = 20): string {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * width);
  return `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`;
}

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv();
  const args = parseArgs(process.argv.slice(2));

  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY,
    base: { service: 'recommend-cli' },
  });

  const handle = await createDatabase(optionsFromEnv(env));
  const events = new EventRecorder(logger, new EventRepository(handle.db));
  const config = await new AppConfigProvider(new ConfigRepository(handle.db)).get();

  const profiles = new ProfileRepository(handle.db);
  const profile = await profiles.getActiveProfile();
  if (!profile) {
    console.error('No active candidate profile. Create one before ranking.');
    await handle.close();
    process.exitCode = 1;
    return;
  }

  const repository = new RecommendationRepository(handle.db);
  const service = new RecommendationService({
    recommendations: repository,
    candidates: new CandidateRepository(handle.db),
    profiles,
    sources: new SourceRepository(handle.db),
    logger,
    events,
    config: { notification: { minimumScore: config.matching.minimumScore } },
  });

  console.log(`\nRecommendation engine ${RECOMMENDATION_VERSION}`);
  console.log(`Profile ${profile.profileId} (v${profile.version})\n`);

  if (args.dedup) {
    const pending = await repository.findJobsNeedingSignals({ limit: args.limit, staleAfterHours: 0 });
    const dedup = await service.deduplicate(pending);
    console.log('── Deduplication ──────────────────────────────────');
    console.log(`examined  ${dedup.examined}`);
    console.log(`recorded  ${dedup.recorded}`);
    console.log(`merged    ${dedup.merged}`);
    console.log(`groups    ${dedup.groups}`);
    console.log(`conflicts ${dedup.conflicts}`);
    console.log(`duration  ${dedup.durationMs} ms\n`);
  }

  if (args.signals) {
    const started = Date.now();
    const updated = await service.refreshSignals({ limit: args.limit, staleAfterHours: 0 });
    console.log('── Signals ────────────────────────────────────────');
    console.log(`computed  ${updated} in ${Date.now() - started} ms\n`);
  }

  const ranking = await service.rank(profile.profileId);

  console.log('── Ranking ────────────────────────────────────────');
  console.log(`considered ${ranking.considered}`);
  console.log(`ranked     ${ranking.ranked}`);
  console.log(`suppressed ${ranking.suppressed}`);
  console.log(`notifiable ${ranking.notifiable}`);
  console.log(`duration   ${ranking.durationMs} ms`);
  if (ranking.ranked > 0) {
    console.log(`avg/job    ${(ranking.durationMs / ranking.ranked).toFixed(2)} ms`);
  }

  const distribution = ranking.distribution as Record<string, unknown>;
  console.log('\n── Score distribution ─────────────────────────────');
  console.log(`min ${distribution.min}  median ${distribution.median}  p90 ${distribution.p90}  max ${distribution.max}`);
  console.log(`90+ share ${distribution.share90Plus}  75+ share ${distribution.share75Plus}`);
  console.log(`${distribution.note}`);

  const statistics = await repository.statistics(profile.profileId);
  console.log('\n── Tiers ──────────────────────────────────────────');
  for (const [tier, count] of Object.entries(statistics.byTier).sort((a, b) => b[1] - a[1])) {
    const icon = TIER_ICONS[tier as keyof typeof TIER_ICONS] ?? '';
    console.log(`${icon} ${tier.padEnd(20)} ${String(count).padStart(5)}`);
  }

  const top = await repository.topRecommendations({ profileId: profile.profileId, limit: args.top });

  console.log('\n── Top recommendations ────────────────────────────');
  for (const row of top) {
    const rec = row.recommendation;
    console.log(
      `\n#${String(rec.rank).padStart(2)} ${bar(rec.finalScore)} ${String(Math.round(rec.finalScore)).padStart(3)}  ` +
        `${TIER_ICONS[rec.tier]} ${rec.tier}  (match ${Math.round(rec.matchScore)})`,
    );
    console.log(`    ${row.job.title} — ${row.job.companyNameRaw} [${row.job.sourceId}]`);
    console.log(`    ${rec.rankExplanation}`);
    for (const reason of rec.rankReasons.slice(0, 4)) console.log(`      · ${reason}`);
    if (!rec.notificationEligible) {
      console.log(`    ✗ held back: ${rec.notificationBlockers.slice(0, 2).join('; ')}`);
    }
  }

  // The list a digest would actually send, once per-set caps are applied.
  const notifiable = await repository.topRecommendations({
    profileId: profile.profileId,
    limit: 50,
    notificationEligibleOnly: true,
  });
  console.log('\n── Would be notified ──────────────────────────────');
  if (notifiable.length === 0) {
    console.log('nothing passes every notification rule right now');
  } else {
    for (const row of notifiable.slice(0, service.config.notification.maxPerDigest)) {
      console.log(
        `  ${String(Math.round(row.recommendation.finalScore)).padStart(3)}  ` +
          `${row.job.title} — ${row.job.companyNameRaw}`,
      );
    }
    console.log(`\n  ${notifiable.length} eligible, capped at ${service.config.notification.maxPerDigest} per digest`);
  }

  console.log('');
  await handle.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
