import { FREQUENCY_INTERVAL_MINUTES, type SearchFrequency } from '@job-intel/contracts';
import { SearchConfigRepository, SourceRepository, type Database } from '@job-intel/db';
import { buildRelevanceProfile, type RelevanceProfile } from '@job-intel/discovery';
import type { Logger } from '@job-intel/observability';
import type { DesiredProfileState, ReconciliationService, Scheduler } from '@job-intel/scheduler';

/**
 * Configuration → schedules.
 *
 * The missing link, and the reason a freshly installed system sat idle
 * indefinitely while reporting itself perfectly healthy.
 *
 * `ReconciliationService` turns a *desired state* into schedules, and the
 * scheduler turns schedules into tasks. But nothing ever built the desired
 * state from what is actually in the database: `CONFIGURATION_RECONCILIATION`
 * had a handler that read `task.payload.desired`, and no code path anywhere
 * enqueued that task. So `schedules` stayed empty, every tick found nothing
 * due, and the worker polled an empty queue forever — the failure looking
 * exactly like a working system, because by its own measures it was one.
 *
 * The autonomy test did not catch this because it called
 * `reconcileSearchProfile` directly, manufacturing the very precondition whose
 * absence was the bug.
 *
 * This module reads the user's search profiles and enabled sources and derives
 * the desired state, so a configuration change becomes scheduled work without a
 * deploy — which is Prompt 15's requirement, enforced here rather than assumed.
 */

export interface ConfigurationBridgeDeps {
  db: Database;
  logger: Logger;
  reconciler: ReconciliationService;
  /** Needed directly for the pipeline schedules, which belong to no profile. */
  scheduler: Scheduler;
}

/**
 * Access tiers that must never be scheduled automatically.
 *
 * `restricted` is off by policy. `user_provided` needs a person to supply the
 * input, so scheduling it would create work that can only ever fail. Both are
 * reported with a reason rather than silently dropped — a source the user
 * enabled and which never runs has to be explainable.
 */
const UNSCHEDULABLE_TIERS = new Set(['restricted', 'user_provided']);

/** Builds desired state for every active, enabled search profile. */
export async function desiredStateFromConfiguration(
  deps: Pick<ConfigurationBridgeDeps, 'db' | 'logger'>,
): Promise<DesiredProfileState[]> {
  const searchConfig = new SearchConfigRepository(deps.db);
  const sources = new SourceRepository(deps.db);

  const [profiles, allSources] = await Promise.all([
    searchConfig.schedulableProfiles(),
    sources.list({ enabledOnly: true }),
  ]);

  const desired: DesiredProfileState[] = [];

  for (const { profile } of profiles) {
    const frequency = profile.searchFrequency as SearchFrequency;

    /*
     * `manual` means the user asked for this profile to run only when they say
     * so. Skipped entirely rather than scheduled at some default cadence —
     * quietly inventing an interval for a profile explicitly set to manual is
     * the system overriding an instruction it was given.
     */
    if (frequency === 'manual') continue;

    const intervalMinutes = FREQUENCY_INTERVAL_MINUTES[frequency];

    const excluded = new Set(profile.excludedSources);

    /*
     * An empty `sources` selection means "all of them". Only when the user has
     * named specific sources does the list become a restriction — otherwise a
     * profile created without touching the source picker would search nothing,
     * which is the opposite of what leaving a filter blank means everywhere
     * else in the product.
     */
    const selected = new Map(profile.sources.map((entry) => [entry.sourceId, entry]));
    const restrictToSelection = selected.size > 0;

    const entries: DesiredProfileState['sources'] = [];

    for (const source of allSources) {
      if (excluded.has(source.id)) continue;
      if (restrictToSelection && !selected.get(source.id)?.enabled) continue;

      if (UNSCHEDULABLE_TIERS.has(source.accessTier)) {
        entries.push({
          sourceId: source.id,
          intervalMinutes,
          schedulable: false,
          reason:
            source.restrictionReason ??
            `Access tier "${source.accessTier}" is not scheduled automatically.`,
        });
        continue;
      }

      /*
       * Cadence follows source priority, not just the profile's frequency. A
       * P0 ATS API is cheap and fresh and can be polled at the configured rate;
       * a P3 source is expensive or low-yield, and hitting it as often would
       * spend the rate-limit budget where it returns least.
       */
      const multiplier = [1, 1, 2, 4][source.priority] ?? 2;

      entries.push({
        sourceId: source.id,
        intervalMinutes: intervalMinutes * multiplier,
        schedulable: true,
      });
    }

    desired.push({
      profileId: profile.id,
      active: true,
      intervalMinutes,
      sources: entries,
    });
  }

  return desired;
}

export interface BridgeResult {
  profiles: number;
  schedulesCreated: number;
  schedulesUpdated: number;
  schedulesDisabled: number;
}

/**
 * Reconciles the live configuration into schedules.
 *
 * Safe to call repeatedly: `upsertSchedule` is keyed on
 * (profile, task type, source), so a run that changes nothing writes nothing.
 * That is what lets this sit on a timer instead of being triggered by an event
 * that something has to remember to emit.
 */
export async function reconcileConfiguration(
  deps: ConfigurationBridgeDeps,
): Promise<BridgeResult> {
  const desired = await desiredStateFromConfiguration(deps);

  if (desired.length === 0) {
    /*
     * Warned rather than logged at debug. No schedulable profile is the single
     * most likely reason for a system that runs indefinitely and discovers
     * nothing, and it is invisible from the outside — the dashboard shows a
     * healthy worker and zero jobs, with nothing connecting the two.
     */
    deps.logger.warn(
      'No schedulable search profile — nothing will be discovered. ' +
        'Create a search profile in the Control Center, or run `pnpm bootstrap:search`.',
    );
    return { profiles: 0, schedulesCreated: 0, schedulesUpdated: 0, schedulesDisabled: 0 };
  }

  const results = await deps.reconciler.reconcileAll(desired);

  await ensurePipelineSchedules(deps);

  const summary = results.reduce<BridgeResult>(
    (acc, result) => ({
      profiles: acc.profiles + 1,
      schedulesCreated: acc.schedulesCreated + result.schedulesCreated,
      schedulesUpdated: acc.schedulesUpdated + result.schedulesUpdated,
      schedulesDisabled: acc.schedulesDisabled + result.schedulesDisabled,
    }),
    { profiles: 0, schedulesCreated: 0, schedulesUpdated: 0, schedulesDisabled: 0 },
  );

  if (summary.schedulesCreated > 0 || summary.schedulesDisabled > 0) {
    deps.logger.info('Configuration reconciled into schedules', { ...summary });
  }

  return summary;
}

// ── The relevance vocabulary ────────────────────────────────────────────────

/**
 * Supplies the ingestion gate's vocabulary, refreshed on a short TTL.
 *
 * Cached because it is rebuilt from the same two tables on every scan and the
 * answer changes only when the user edits their search configuration. The TTL
 * rather than an invalidation hook is deliberate: a stale vocabulary for at
 * most a minute costs a few extra rows, whereas an invalidation someone forgets
 * to fire means edits silently never take effect — the exact class of bug that
 * left this system idle for seven hours.
 */
export class RelevanceProvider {
  private cached: RelevanceProfile | null = null;
  private loadedAt = 0;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly ttlMs = 60_000,
  ) {}

  async get(): Promise<RelevanceProfile | null> {
    if (this.cached && Date.now() - this.loadedAt < this.ttlMs) return this.cached;

    try {
      const profiles = await new SearchConfigRepository(this.db).schedulableProfiles();
      const built = buildRelevanceProfile(profiles.map((entry) => entry.profile));

      if (!built.usable) {
        /*
         * Stood down rather than applied. A vocabulary built from too little
         * stated preference cannot tell a relevant posting from an irrelevant
         * one, and guessing would discard the candidate's market invisibly.
         */
        this.logger.warn(
          'Relevance gate inactive: the search profile states too few roles or skills to filter on. Every discovered posting will be stored.',
        );
        this.cached = null;
      } else {
        this.cached = built;
      }

      this.loadedAt = Date.now();
      return this.cached;
    } catch (error) {
      /*
       * A failure to build the vocabulary must not stop discovery. Filtering
       * is an improvement on storing everything, not a precondition for it.
       */
      this.logger.warn('Could not build the relevance vocabulary; scanning unfiltered', {
        err: error,
      });
      return null;
    }
  }
}

// ── Pipeline schedules ──────────────────────────────────────────────────────

/**
 * Cadences for the stages between a stored posting and an email.
 *
 * Not derived from the user's search frequency, because these are not searches.
 * Scanning more often finds jobs sooner; enriching more often only re-asks a
 * question already answered. Each interval is set from what the stage costs and
 * how quickly its output goes stale.
 *
 * These were three times faster and it cost real money. Every pass reads from
 * the database whether or not there is anything new, and hourly discovery adds
 * jobs by the dozen, not the thousand — so a match pass every thirty minutes
 * spent almost all of its budget re-reading rows it had already scored. Over
 * twelve days a 117 MB database moved 4.1 GB of egress and came close to
 * exhausting a Neon free tier.
 *
 * The cadence now matches the rate work actually arrives. Nothing waits
 * meaningfully longer: a job discovered at noon is still scored and ranked
 * inside a couple of hours, well before the daily digest that decides whether
 * anyone hears about it.
 */
const PIPELINE_SCHEDULES: ReadonlyArray<{
  taskType: 'ENRICH_JOB' | 'MATCH_JOB' | 'NOTIFICATION_EVALUATION';
  intervalMinutes: number;
  why: string;
}> = [
  {
    taskType: 'ENRICH_JOB',
    intervalMinutes: 60,
    why: 'Drains the unenriched backlog. Nothing downstream can run until it has.',
  },
  {
    taskType: 'MATCH_JOB',
    intervalMinutes: 120,
    why: 'Scores whatever enrichment has finished. Paced to what discovery actually produces.',
  },
  {
    taskType: 'NOTIFICATION_EVALUATION',
    intervalMinutes: 60,
    why: 'Ranks, then decides what is worth an email. Hourly; the digest window does the real pacing.',
  },
];

/**
 * Creates the pipeline schedules if they are absent.
 *
 * Deliberately not tied to a profile. These stages process everything the
 * system knows about rather than one profile's slice, so a per-profile schedule
 * would run the same global backlog pass N times and race itself.
 *
 * Idempotent: `upsertSchedule` is keyed on (task type, profile, source), so
 * calling this every reconciliation cycle writes nothing after the first.
 */
async function ensurePipelineSchedules(deps: ConfigurationBridgeDeps): Promise<void> {
  for (const entry of PIPELINE_SCHEDULES) {
    await deps.scheduler.upsertSchedule({
      taskType: entry.taskType,
      intervalMinutes: entry.intervalMinutes,
      enabled: true,
    });
  }
}
