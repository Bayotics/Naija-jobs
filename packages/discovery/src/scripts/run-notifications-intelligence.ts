import { sql } from 'drizzle-orm';
import { loadDotenv, loadEnv } from '@job-intel/config';
import { createLogger, EventRecorder } from '@job-intel/observability';
import {
  ApplicationRepository,
  CandidateRepository,
  EnrichmentRepository,
  EventRepository,
  JobRepository,
  MatchRepository,
  NotificationIntelligenceRepository,
  ProfileRepository,
  createDatabase,
  optionsFromEnv,
} from '@job-intel/db';
import { NotificationIntelligenceService } from '../notification-intelligence-service';

/**
 * End-to-end verification for the notification intelligence layer.
 *
 * Runs against the real database — jobs discovered from real sources, the real
 * candidate profile, the real application analyses — rather than fixtures. The
 * fifty-fixture simulation in the test suite proves the policy is sane across
 * constructed adversarial cases; this proves it survives postings nobody wrote
 * for it, which is where the interesting failures live.
 */

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv();

  const logger = createLogger({
    level: 'error',
    pretty: false,
    base: { service: 'notification-verify' },
  });

  const handle = await createDatabase(optionsFromEnv(env));

  try {
    const profiles = new ProfileRepository(handle.db);
    const active = await profiles.getActiveProfile();

    if (!active) {
      console.log('No active candidate profile. Nothing to verify against.');
      return;
    }

    const notifications = new NotificationIntelligenceRepository(handle.db);

    const service = new NotificationIntelligenceService({
      notifications,
      applications: new ApplicationRepository(handle.db),
      matches: new MatchRepository(handle.db),
      jobs: new JobRepository(handle.db),
      enrichments: new EnrichmentRepository(handle.db),
      candidates: new CandidateRepository(handle.db),
      logger,
      events: new EventRecorder(logger, new EventRepository(handle.db)),
    });

    const limit = Number(
      process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] ?? 200,
    );

    if (process.argv.includes('--force')) {
      await handle.db.execute(
        sql`DELETE FROM notification_scores WHERE candidate_id = ${active.profileId}`,
      );
      await handle.db.execute(
        sql`DELETE FROM notification_suppressions WHERE candidate_id = ${active.profileId}`,
      );
      console.log('Cleared stored scores so the current engine actually runs.');
    }

    // ── Seed the rarity window ────────────────────────────────────────────
    /*
     * Rarity is measured against observed discovery, and nothing has been
     * writing those counts yet. Derived here from what is actually in the jobs
     * table so the verification exercises the real path rather than skipping
     * the factor entirely.
     */
    const countsResult = await handle.db.execute<{ total: number; matching: number }>(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (
          WHERE remote_type = 'remote'
            AND country_code = 'GB'
        )::int AS matching
      FROM jobs
      WHERE first_seen_at > now() - interval '30 days'
    `);

    // `execute` returns a driver-shaped result, not an array.
    const counts = (countsResult.rows ?? countsResult)[0] as
      | { total: number; matching: number }
      | undefined;

    if (counts) {
      await notifications.recordDiscoveryCounts({
        candidateId: active.profileId,
        day: new Date(new Date().toISOString().slice(0, 10)),
        totalJobs: Number(counts.total ?? 0),
        matchingAllDimensions: Number(counts.matching ?? 0),
      });

      console.log(
        `\nRarity window seeded: ${counts.total} jobs in 30 days, ${counts.matching} matching the profile's core dimensions.`,
      );
    }

    console.log('\n── Scoring ───────────────────────────────────────────────────────────');
    const run = await service.runFor(active.profileId, { limit });

    console.log(`  considered   ${run.considered}`);
    console.log(`  instant      ${run.instant}`);
    console.log(`  digest       ${run.digest}`);
    console.log(`  dashboard    ${run.dashboard}`);
    console.log(`  suppressed   ${run.suppressed}`);
    console.log(`  duration     ${(run.durationMs / 1000).toFixed(1)}s`);

    console.log('\n── Suppression reasons ───────────────────────────────────────────────');
    const reasons = Object.entries(run.suppressionReasons).sort((a, b) => b[1] - a[1]);
    if (reasons.length === 0) console.log('  none');
    for (const [reason, total] of reasons) {
      console.log(`  ${String(total).padStart(4)}  ${reason}`);
    }

    console.log('\n── Would interrupt ───────────────────────────────────────────────────');
    const config = await service.getConfig(active.profileId);
    const top = await notifications.topScored(active.profileId, { limit: 8 });

    if (top.length === 0) console.log('  nothing scored');
    for (const row of top) {
      const channel =
        row.score >= config.thresholds.instant
          ? 'INSTANT'
          : row.score >= config.thresholds.digest
            ? 'digest'
            : 'dashboard';

      console.log(
        `\n  [${channel}] ${Math.round(row.score)}/100 · ${row.urgency} · ${row.title} — ${row.companyName}`,
      );
      console.log(`  ${row.explanation.slice(0, 260)}`);
    }

    console.log('\n── Transparency ──────────────────────────────────────────────────────');
    const suppressed = await service.suppressions(active.profileId, 3);
    for (const row of suppressed) {
      console.log(`\n  ${row.title} — ${row.companyName}`);
      console.log(`  ${row.reason}: ${row.detail}`);
      if (row.remedy) console.log(`  remedy: ${row.remedy}`);
      if (row.setting) console.log(`  setting: ${row.setting}`);
    }

    /*
     * The invariants the layer rests on.
     *
     * Checked against real postings because prose is where an extractor is most
     * likely to produce something the fixtures never anticipated.
     */
    console.log('\n── Invariants ────────────────────────────────────────────────────────');

    const expiredResult = await handle.db.execute<{ total: number }>(sql`
      SELECT count(*)::int AS total
      FROM notification_scores s
      JOIN jobs j ON j.id = s.job_id
      WHERE s.candidate_id = ${active.profileId}
        AND s.score >= ${config.thresholds.instant}
        AND (s.deadline->>'bucket') = 'expired'
    `);

    const expiredAlerted = (expiredResult.rows ?? expiredResult)[0] as
      | { total: number }
      | undefined;

    console.log(
      `  expired jobs at or above the instant threshold: ${expiredAlerted?.total ?? 0} (must be 0 after suppression)`,
    );

    const allSuppressions = await service.suppressions(active.profileId, 1_000);
    const withoutDetail = allSuppressions.filter((row) => row.detail.trim().length < 10).length;
    console.log(`  suppressions missing an explanation: ${withoutDetail} of ${allSuppressions.length}`);

    const instantShare = run.considered === 0 ? 0 : run.instant / run.considered;
    console.log(
      `  share of considered jobs that would interrupt: ${(instantShare * 100).toFixed(1)}%`,
    );

    console.log('\n── Digest ────────────────────────────────────────────────────────────');
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 24 * 3_600_000);

    const { plan, verdict } = await service.buildDigest(active.profileId, {
      windowStart,
      windowEnd,
      type: 'DAILY_DIGEST',
    });

    console.log(`  ${verdict.reason}`);
    for (const section of plan.sections) {
      console.log(`    ${section.title}: ${section.jobIds.length}`);
    }
    if (Object.keys(plan.excluded).length > 0) {
      console.log(`  excluded: ${JSON.stringify(plan.excluded)}`);
    }

    console.log('\n── Analytics ─────────────────────────────────────────────────────────');
    const analytics = await service.analytics(active.profileId);
    console.log(`  sent        ${analytics.overall.sent}`);
    console.log(`  suppressed  ${analytics.suppressed}`);
    console.log(
      `  suppression rate ${analytics.suppressionRate === null ? '—' : `${Math.round(analytics.suppressionRate * 100)}%`}`,
    );

    const fatigue = await service.fatigue(active.profileId);
    console.log(`  fatigue: ${fatigue.advice.slice(0, 200)}`);
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
