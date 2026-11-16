/**
 * Learning CLI: `pnpm learn [--simulate N] [--recompute] [--report]`
 *
 * Demonstrates the loop end to end against the real database:
 * interaction → event → behavioural update → ranking adjustment → improved
 * recommendation.
 *
 * `--simulate` records interactions against real stored jobs, picking the ones
 * that match the candidate's stated preferences as "engaged with" and the rest
 * as "passed over". That is a simulation of *behaviour*, never of results: every
 * number printed afterwards is computed from the database.
 */
import { loadDotenv, loadEnv } from '@job-intel/config';
import { createLogger, EventRecorder } from '@job-intel/observability';
import {
  CandidateRepository,
  EventRepository,
  LearningRepository,
  ProfileRepository,
  createDatabase,
  optionsFromEnv,
  schema,
} from '@job-intel/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { LearningService, affinityStars } from '../learning-service';

function parseArgs(argv: string[]) {
  let simulate = 0;
  let recompute = false;
  let report = false;

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--simulate') simulate = Number(argv[++i]) || 60;
    else if (argv[i] === '--recompute') recompute = true;
    else if (argv[i] === '--report') report = true;
  }

  return { simulate, recompute, report: report || (!simulate && !recompute) };
}

const rule = (title: string) => `\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`;
const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

async function main() {
  loadDotenv();
  const env = loadEnv();
  const args = parseArgs(process.argv.slice(2));

  const logger = createLogger({ level: 'error', pretty: false, base: { service: 'learning-cli' } });
  const handle = await createDatabase(optionsFromEnv(env));

  try {
    const profiles = new ProfileRepository(handle.db);
    const profile = await profiles.getActiveProfile();
    if (!profile) {
      console.error('No active candidate profile.');
      process.exitCode = 1;
      return;
    }

    const candidateId = profile.profileId;
    const learning = new LearningRepository(handle.db);
    const candidates = new CandidateRepository(handle.db);

    const service = new LearningService({
      learning,
      candidates,
      logger,
      events: new EventRecorder(logger, new EventRepository(handle.db)),
    });

    console.log(`Profile ${candidateId} (v${profile.version})`);

    // ── Simulate interactions against real stored jobs ────────────────────
    if (args.simulate > 0) {
      /*
       * Two real cohorts, selected by SQL rather than by filtering a recency
       * window.
       *
       * The engaged cohort is "engineering roles", the passed-over cohort is
       * everything else. Drawing both explicitly is what makes the
       * demonstration meaningful: a sample that happens to contain only one
       * kind of job teaches the system "you dislike everything", which is a
       * correct conclusion from the data and a useless demonstration.
       */
      const half = Math.max(1, Math.floor(args.simulate / 2));

      const engagedRows = await handle.db
        .select({ id: schema.jobs.id, title: schema.jobs.title })
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.status, 'active'),
            sql`${schema.jobs.title} ~* '(engineer|developer|software|frontend|backend)'`,
          ),
        )
        .orderBy(desc(schema.jobs.firstSeenAt))
        .limit(half);

      const passedRows = await handle.db
        .select({ id: schema.jobs.id, title: schema.jobs.title })
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.status, 'active'),
            sql`${schema.jobs.title} !~* '(engineer|developer|software|frontend|backend)'`,
          ),
        )
        .orderBy(desc(schema.jobs.firstSeenAt))
        .limit(half);

      console.log(rule(`SIMULATING ${engagedRows.length + passedRows.length} INTERACTION(S)`));

      let engaged = 0;
      let passed = 0;

      for (const [index, row] of engagedRows.entries()) {
        await service.recordEvent({
          candidateId,
          jobId: row.id,
          eventType: 'JOB_VIEWED',
          context: 'RECOMMENDATIONS',
          shownAtRank: index + 1,
        });
        await service.recordEvent({
          candidateId,
          jobId: row.id,
          eventType: index % 5 === 0 ? 'JOB_APPLIED' : 'JOB_SAVED',
          context: 'RECOMMENDATIONS',
          shownAtRank: index + 1,
        });
        engaged += 1;
      }

      for (const [index, row] of passedRows.entries()) {
        await service.recordEvent({
          candidateId,
          jobId: row.id,
          eventType: 'JOB_VIEWED',
          context: 'RECOMMENDATIONS',
          shownAtRank: engagedRows.length + index + 1,
        });
        await service.recordEvent({
          candidateId,
          jobId: row.id,
          eventType: index % 3 === 0 ? 'JOB_DISMISSED' : 'JOB_IGNORED',
          context: 'RECOMMENDATIONS',
          shownAtRank: engagedRows.length + index + 1,
        });
        passed += 1;
      }

      console.log(`engaged with ${engaged}, passed over ${passed}`);
    }

    // ── Fold into the behavioural profile ─────────────────────────────────
    const update = await service.updateBehavioralProfile(candidateId, { full: args.recompute });
    console.log(rule('BEHAVIOURAL UPDATE'));
    console.log(
      `processed ${update.eventsProcessed} event(s), ${update.affinities} learned signal(s)`,
    );
    console.log(
      update.profile.hasSufficientData
        ? `profile is warm: ${update.profile.totalEvents} interaction(s) across ${update.profile.distinctJobs} job(s)`
        : `cold start: ${update.profile.coldStartReason}`,
    );

    await service.updatePerformance(candidateId);
    await service.computeAnalytics(candidateId);

    if (!args.report) {
      console.log('');
      return;
    }

    // ── What was learned ──────────────────────────────────────────────────
    const state = await service.getLearningState(candidateId);

    console.log(rule('WHAT THE SYSTEM LEARNED'));
    const strong = state.affinities.filter((a) => affinityStars(a) >= 4).slice(0, 12);
    const weak = state.affinities.filter((a) => affinityStars(a) <= 2).slice(0, 6);

    if (strong.length === 0) console.log('  no strong signals yet');
    for (const affinity of strong) {
      console.log(
        `  ${affinity.dimension.padEnd(18)} ${affinity.value.padEnd(24)} ${stars(affinityStars(affinity))}  ` +
          `affinity ${affinity.affinity.toFixed(2).padStart(5)}  confidence ${String(
            Math.round(affinity.confidence * 100),
          ).padStart(3)}%  n=${affinity.sampleSize}` +
          (affinity.conflictsWithExplicit ? '  ⚠ contradicts your stated preference' : ''),
      );
    }

    if (weak.length > 0) {
      console.log('\n  weak / uncertain:');
      for (const affinity of weak) {
        console.log(
          `  ${affinity.dimension.padEnd(18)} ${affinity.value.padEnd(24)} ${stars(affinityStars(affinity))}  n=${affinity.sampleSize}`,
        );
      }
    }

    // ── The ranking effect ────────────────────────────────────────────────
    const sample = await handle.db
      .select({
        id: schema.jobs.id,
        title: schema.jobs.title,
        companyNameRaw: schema.jobs.companyNameRaw,
        countryCode: schema.jobs.countryCode,
        city: schema.jobs.city,
        remoteType: schema.jobs.remoteType,
        employmentTypes: schema.jobs.employmentTypes,
        techStack: schema.jobs.techStack,
        salaryNormalizedAnnualUsd: schema.jobs.salaryNormalizedAnnualUsd,
        sourceId: schema.jobs.sourceId,
        seniority: schema.jobEnrichments.seniority,
      })
      .from(schema.jobs)
      .leftJoin(schema.jobEnrichments, eq(schema.jobEnrichments.jobId, schema.jobs.id))
      .where(and(eq(schema.jobs.status, 'active'), sql`${schema.jobs.techStack} IS NOT NULL`))
      .orderBy(desc(schema.jobs.firstSeenAt))
      .limit(40);

    const adjustments = await service.scoreJobs(
      candidateId,
      sample.map((row) => ({
        jobId: row.id,
        attributes: {
          jobId: row.id,
          title: row.title,
          companyName: row.companyNameRaw,
          countryCode: row.countryCode,
          city: row.city,
          remoteType: row.remoteType,
          employmentTypes: row.employmentTypes ?? [],
          seniority: row.seniority,
          technologies: row.techStack ?? [],
          industries: [],
          salaryAnnualUsd:
            row.salaryNormalizedAnnualUsd === null ? null : Number(row.salaryNormalizedAnnualUsd),
          sourceId: row.sourceId,
          companySize: null,
        },
      })),
    );

    const ranked = [...adjustments.values()].sort((a, b) => b.adjustment - a.adjustment);

    console.log(rule('RANKING EFFECT'));
    const titleOf = (id: string) => sample.find((row) => row.id === id)?.title ?? id;

    console.log('  boosted most:');
    for (const adjustment of ranked.slice(0, 5)) {
      if (adjustment.adjustment <= 0) break;
      console.log(`   +${adjustment.adjustment.toFixed(2).padStart(5)}  ${titleOf(adjustment.jobId)}`);
      console.log(`            ${adjustment.explanation.slice(0, 150)}`);
    }

    console.log('\n  lowered most:');
    for (const adjustment of ranked.slice(-5).reverse()) {
      if (adjustment.adjustment >= 0) break;
      console.log(`   ${adjustment.adjustment.toFixed(2).padStart(6)}  ${titleOf(adjustment.jobId)}`);
      console.log(`            ${adjustment.explanation.slice(0, 150)}`);
    }

    // ── Analytics ─────────────────────────────────────────────────────────
    const engagement = await learning.latestEngagement(candidateId);
    if (engagement) {
      console.log(rule('CONVERSION'));
      console.log(
        `  shown ${engagement.recommendationsShown}  view ${(engagement.viewRate * 100).toFixed(1)}%  ` +
          `click ${(engagement.clickRate * 100).toFixed(1)}%  save ${(engagement.saveRate * 100).toFixed(1)}%  ` +
          `apply ${(engagement.applicationRate * 100).toFixed(1)}%  accepted ${(engagement.acceptanceRate * 100).toFixed(1)}%`,
      );

      const quality = engagement.rankingQuality as Array<{
        k: number;
        precisionAtK: number;
        saveAtK: number;
        applyAtK: number;
      }>;
      for (const row of quality) {
        console.log(
          `  @${String(row.k).padStart(2)}  precision ${(row.precisionAtK * 100).toFixed(1)}%  ` +
            `save ${(row.saveAtK * 100).toFixed(1)}%  apply ${(row.applyAtK * 100).toFixed(1)}%`,
        );
      }
    }

    // ── Suggestions ───────────────────────────────────────────────────────
    const suggestions = await service.generatePreferenceSuggestions(candidateId);
    console.log(rule('PREFERENCE SUGGESTIONS'));
    if (suggestions.length === 0) console.log('  none — not enough consistent evidence');
    for (const suggestion of suggestions) {
      console.log(`  [${suggestion.path}] ${suggestion.message}`);
      console.log(
        `    evidence: ${suggestion.evidence.supporting} supporting, ` +
          `${suggestion.evidence.contradicting} contradicting · confidence ${Math.round(
            suggestion.confidence * 100,
          )}%`,
      );
    }

    const after = await candidates.getActivePreferences(candidateId);
    console.log(
      `\n  Preference version is still ${after?.version} — nothing was changed automatically.`,
    );

    console.log('');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('[learn] failed:', error);
  process.exitCode = 1;
});
