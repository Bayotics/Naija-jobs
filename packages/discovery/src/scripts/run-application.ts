import { loadDotenv, loadEnv } from '@job-intel/config';
import { createLogger, EventRecorder } from '@job-intel/observability';
import {
  ApplicationRepository,
  CandidateRepository,
  EnrichmentRepository,
  EventRepository,
  IntelligenceRepository,
  JobRepository,
  MatchRepository,
  ProfileRepository,
  createDatabase,
  optionsFromEnv,
} from '@job-intel/db';
import { sql } from 'drizzle-orm';
import { RECOMMENDATION_LABEL, type ApplicationRecommendation } from '@job-intel/contracts';
import { ApplicationService } from '../application-service';

/**
 * End-to-end verification for the application intelligence layer.
 *
 * Runs against whatever is actually in the database — real jobs discovered from
 * real sources, the real candidate profile — rather than fixtures. The
 * simulation in the test suite proves the policy behaves sensibly across
 * constructed adversarial cases; this proves it survives contact with postings
 * nobody wrote for it.
 */

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv(process.env, { role: 'worker' });

  const logger = createLogger({ level: 'warn', pretty: false, base: { service: 'application-verify' } });
  const handle = await createDatabase(optionsFromEnv(env));

  try {
    const profiles = new ProfileRepository(handle.db);
    const active = await profiles.getActiveProfile();

    if (!active) {
      console.log('No active candidate profile. Nothing to verify against.');
      return;
    }

    const applications = new ApplicationRepository(handle.db);

    const service = new ApplicationService({
      applications,
      intelligence: new IntelligenceRepository(handle.db),
      candidates: new CandidateRepository(handle.db),
      profiles,
      matches: new MatchRepository(handle.db),
      jobs: new JobRepository(handle.db),
      enrichments: new EnrichmentRepository(handle.db),
      logger,
      events: new EventRecorder(logger, new EventRepository(handle.db)),
    });

    const limit = Number(process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] ?? 60);

    /*
     * `--force` discards stored analyses first.
     *
     * Analysis is keyed on (candidate, job, profile version), so a re-run is
     * normally a no-op — which is right in production and useless when
     * verifying a change to the engine, because the fixed code never executes
     * and the old verdicts are reported back as if they were fresh.
     */
    if (process.argv.includes('--force')) {
      await handle.db.execute(
        sql`DELETE FROM application_intelligence WHERE candidate_id = ${active.profileId}`,
      );
      console.log('Cleared stored analyses so the current engine actually runs.');
    }

    console.log('\n── Running application intelligence ──────────────────────────────────');
    const run = await service.analyseAll(active.profileId, { limit });

    console.log(`  considered   ${run.considered}`);
    console.log(`  analysed     ${run.analysed}`);
    console.log(`  failed       ${run.failed}`);
    console.log(`  duration     ${(run.durationMs / 1000).toFixed(1)}s`);

    if (run.errors.length > 0) {
      console.log('\n  first errors:');
      for (const error of run.errors.slice(0, 3)) {
        console.log(`    ${error.jobId.slice(0, 8)} — ${error.error}`);
      }
    }

    console.log('\n── Verdict distribution ──────────────────────────────────────────────');
    const counts = await service.counts(active.profileId);
    for (const [recommendation, total] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      const label = RECOMMENDATION_LABEL[recommendation as ApplicationRecommendation] ?? recommendation;
      console.log(`  ${recommendation.padEnd(12)} ${String(total).padStart(4)}  ${label}`);
    }

    console.log('\n── Top opportunities ─────────────────────────────────────────────────');
    const top = await service.opportunities(active.profileId, {
      recommendations: ['APPLY_NOW', 'APPLY', 'CONSIDER'],
      limit: 5,
    });

    for (const row of top) {
      console.log(
        `\n  [${row.recommendation}] ${Math.round(row.valueScore)}/100 · ${Math.round(row.confidence * 100)}% confident`,
      );
      console.log(`  ${row.title} — ${row.companyName}`);
      console.log(`  ${row.explanation.summary.slice(0, 320)}`);
      if (row.resume.recommendedLabel) {
        console.log(`  Resume: ${row.resume.recommendedLabel} (${row.resume.resumeFitScore}/100)`);
      }
    }

    console.log('\n── Blocked ───────────────────────────────────────────────────────────');
    const blocked = await service.opportunities(active.profileId, {
      recommendations: ['BLOCKED'],
      limit: 5,
    });

    if (blocked.length === 0) console.log('  none');
    for (const row of blocked) {
      console.log(`  ${row.title} — ${row.companyName}`);
      for (const blocker of row.blockers.filter((entry) => entry.severity === 'HARD_BLOCKER')) {
        console.log(`    ${blocker.statement} ${blocker.detail}`);
      }
    }

    console.log('\n── Recurring unknowns ────────────────────────────────────────────────');
    const gaps = await service.commonGaps(active.profileId, 8);
    if (gaps.length === 0) console.log('  none');
    for (const gap of gaps) {
      console.log(`  ${String(gap.jobs).padStart(3)} jobs (${Math.round(gap.share * 100)}%)  ${gap.requirement}`);
    }

    /*
     * The invariant the whole layer rests on.
     *
     * A requirement scored NOT_SUPPORTED must come from a conflict — an
     * explicit exclusion, a stated shortfall — never from a profile that simply
     * did not mention something. Checked against real postings rather than
     * fixtures, because prose is where the extractor is most likely to
     * manufacture a requirement nobody wrote.
     */
    console.log('\n── Invariant: silence never becomes a negative ───────────────────────');
    const sample = await service.opportunities(active.profileId, { limit: 100 });
    let checked = 0;
    let violations = 0;

    for (const row of sample) {
      const intelligence = await service.intelligenceFor(active.profileId, row.jobId);
      if (!intelligence) continue;

      for (const assessment of intelligence.eligibility.assessments) {
        checked += 1;
        if (assessment.support === 'NOT_SUPPORTED' && assessment.strength !== 'CONFLICT') {
          violations += 1;
          console.log(
            `  VIOLATION ${assessment.requirement.text} → ${assessment.strength}/${assessment.support}`,
          );
        }
      }
    }

    console.log(`  ${checked} requirement rows checked, ${violations} violations`);

    console.log('\n── Human approval boundary ───────────────────────────────────────────');
    if (top[0]) {
      const attempt = await applications.transition({
        candidateId: active.profileId,
        jobId: top[0].jobId,
        to: 'APPLIED',
        actor: 'system',
      });

      console.log(
        attempt.ok
          ? '  FAILED: the system was able to mark a job as applied'
          : `  refused, as designed: ${attempt.error}`,
      );
    } else {
      console.log('  no opportunity to test against');
    }

    console.log('\n── Application tracking ──────────────────────────────────────────────');
    const analytics = await service.analytics(active.profileId);
    console.log(`  applications   ${analytics.overall.applications}`);
    console.log(`  responses      ${analytics.overall.responses}`);
    console.log(`  sample usable  ${analytics.overall.sufficientSample}`);
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
