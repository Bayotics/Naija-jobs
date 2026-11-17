import {
  CandidateRepository,
  EmbeddingRepository,
  EnrichmentRepository,
  JobRepository,
  MatchRepository,
  OpsRepository,
  ProfileRepository,
  RecommendationRepository,
  SourceRepository,
  type Database,
} from '@job-intel/db';
import {
  EnrichmentRunner,
  MatchingService,
  RecommendationService,
} from '@job-intel/discovery';
import { HashingEmbeddingProvider } from '@job-intel/matching';
import type { EventRecorder, Logger } from '@job-intel/observability';
import type { AppConfig, Env } from '@job-intel/config';

/**
 * The stages that turn a discovered posting into an email.
 *
 * Discovery was wired into the execution engine and these four were not, so the
 * pipeline ended at the first step: postings accumulated, and nothing enriched,
 * scored, ranked or notified them unless a person ran a CLI by hand. The
 * system's entire promise — *wake up to relevant jobs in your inbox* — lived in
 * scripts nobody was going to run at 3am.
 *
 * ── Backlog passes, not per-job tasks ─────────────────────────────────────
 *
 * `ENRICH_JOB` and `MATCH_JOB` read as though each should process one posting.
 * They process the outstanding backlog instead, and the reason is idempotency
 * economics: each stage already knows how to find its own unprocessed rows, so
 * a backlog pass is naturally idempotent and self-healing — anything missed by
 * a crashed run is simply picked up by the next one. Per-job tasks would need
 * a fan-out step, one queue row per posting, and a reconciliation pass to find
 * jobs whose task was lost. That is three new failure modes to replace a
 * `WHERE enriched_at IS NULL`.
 *
 * ── Ordering ──────────────────────────────────────────────────────────────
 *
 * Enrich → match → recommend → notify, each stage feeding the next. The stages
 * are scheduled independently rather than chained, so a failure in one does not
 * strand the others: a broken enrichment pass means matching has less new work
 * next cycle, not that matching stops running.
 */

export interface StageDependencies {
  db: Database;
  logger: Logger;
  events: EventRecorder;
  env: Env;
  /** Read fresh per run so a config change takes effect without a restart. */
  config: () => Promise<AppConfig>;
}

export interface StageResult {
  processed: number;
  detail: Record<string, unknown>;
}

/**
 * Resolves the active candidate once per stage run.
 *
 * Returns null rather than throwing when there is none: a system with no
 * candidate profile is unconfigured, not broken, and turning that into a failed
 * task would fill the dead-letter queue with a state the user fixes in the UI.
 */
async function activeProfileId(db: Database, logger: Logger): Promise<string | null> {
  const active = await new ProfileRepository(db).getActiveProfile();

  if (!active) {
    logger.warn('No active candidate profile — pipeline stage skipped.');
    return null;
  }

  return active.profileId;
}

// ── Enrichment ──────────────────────────────────────────────────────────────

export async function runEnrichment(deps: StageDependencies): Promise<StageResult> {
  const enrichment = new EnrichmentRepository(deps.db);

  const runner = new EnrichmentRunner({
    enrichment,
    logger: deps.logger,
    events: deps.events,
    ops: new OpsRepository(deps.db),
  });

  /*
   * Bounded per pass. An unbounded run on a large backlog would hold its lease
   * past the timeout and be reaped mid-flight; the next cycle picks up whatever
   * is left, so the backlog still drains — just in slices the queue can
   * supervise.
   */
  const result = await runner.run({ limit: 200 });

  return {
    processed: result.succeeded,
    detail: {
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
      aiCalls: result.aiCalls,
    },
  };
}

// ── Matching ────────────────────────────────────────────────────────────────

export async function runMatching(deps: StageDependencies): Promise<StageResult> {
  const profileId = await activeProfileId(deps.db, deps.logger);
  if (!profileId) return { processed: 0, detail: { reason: 'no active profile' } };

  const config = await deps.config();

  const service = new MatchingService({
    matches: new MatchRepository(deps.db),
    candidates: new CandidateRepository(deps.db),
    profiles: new ProfileRepository(deps.db),
    enrichments: new EnrichmentRepository(deps.db),
    jobs: new JobRepository(deps.db),
    embeddings: new EmbeddingRepository(deps.db),
    logger: deps.logger,
    events: deps.events,
    config: { thresholds: { possible: config.matching.minimumScore } },
    /*
     * Deterministic, local, and named for what it is. The semantic pathway runs
     * end to end without a paid API; swapping in a hosted embedder changes this
     * line and nothing else.
     */
    embedder: new HashingEmbeddingProvider(config.ai.embeddingDimensions),
  });

  /*
   * Bounded, like enrichment.
   *
   * An unbounded pass asks the database for every job needing a match and pulls
   * their rows across the wire. Run every thirty minutes against a growing
   * corpus, that is the same data fetched over and over: a 117 MB database
   * moved 4.1 GB of egress in twelve days and came within a fifth of exhausting
   * a Neon quota, while the thing actually producing new work — a handful of
   * newly discovered jobs per hour — would have fitted in a rounding error.
   *
   * 300 per pass at the configured cadence clears far more than any hour of
   * discovery produces, so a backlog still drains quickly and the steady state
   * costs almost nothing.
   */
  const result = await service.matchAll(profileId, {
    reason: 'scheduled match pass',
    limit: 300,
  });

  return {
    processed: result.matched,
    detail: {
      considered: result.considered,
      matched: result.matched,
      eligible: result.eligible,
      failed: result.failed,
    },
  };
}

// ── Recommendation ──────────────────────────────────────────────────────────

export async function runRecommendation(deps: StageDependencies): Promise<StageResult> {
  const profileId = await activeProfileId(deps.db, deps.logger);
  if (!profileId) return { processed: 0, detail: { reason: 'no active profile' } };

  const config = await deps.config();

  const service = new RecommendationService({
    recommendations: new RecommendationRepository(deps.db),
    candidates: new CandidateRepository(deps.db),
    profiles: new ProfileRepository(deps.db),
    sources: new SourceRepository(deps.db),
    logger: deps.logger,
    events: deps.events,
    config: {
      notification: { minimumScore: config.matching.minimumScore },
      calibration: config.recommendationCalibration,
    },
  });

  /*
   * Signals first. Ranking reads them; it does not produce them.
   *
   * This was the gap that made the system discover 422 jobs and email about
   * none of them. Only `rank` was wired here, so `job_signals` held rows only
   * for the jobs that existed the last time someone ran the CLI by hand. Every
   * job discovered afterwards had no signals row, and the notification decider
   * read a missing row as "not active" and suppressed it as stale. Notification
   * passes ran, completed, and produced nothing.
   *
   * `staleAfterHours` is 72 rather than 24: re-deriving staleness for the same
   * job every day costs a full read of it and changes almost nothing, and
   * freshness is already a scoring factor rather than something this pass has
   * to keep current.
   */
  const refreshed = await service.refreshSignals({ limit: 300, staleAfterHours: 72 });

  const ranking = await service.rank(profileId);

  return {
    processed: ranking.ranked,
    detail: {
      signalsRefreshed: refreshed,
      ranked: ranking.ranked,
      considered: ranking.considered,
    },
  };
}
