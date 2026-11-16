import {
  type ComponentHealth,
  type ComponentStatus,
  type HealthRollup,
  rollUpHealth,
  type TaskPriority,
} from '@job-intel/contracts';
import type { Logger } from '@job-intel/observability';
import type { Scheduler } from './scheduler';
import type { TaskQueue } from './task-queue';
import type { DeadLetterQueue } from './dead-letters';
import type { WorkerRegistry } from './worker-runtime';

/**
 * Reconciliation and health.
 *
 * Reconciliation is the answer to "what happens when the user changes
 * something". The naive answer — update the setting and wait for the next tick
 * to notice — is wrong in a specific way: disabling a source leaves its already
 * queued scans to run anyway, so the user watches the thing they turned off
 * keep happening for another hour.
 *
 * So reconciliation is *declarative*. It takes the desired state and makes the
 * schedule match it: create what should exist, disable what should not, cancel
 * queued work for anything now off. It is idempotent by construction, which
 * means it can run on every configuration change, on a timer, and at startup
 * without any of those interfering with each other.
 */

/** What the scheduler should be doing for one profile. */
export interface DesiredProfileState {
  profileId: string;
  /** False when the profile is paused, archived or disabled. */
  active: boolean;
  intervalMinutes: number;
  timezone?: string;
  priority?: TaskPriority;
  pausedUntil?: Date | null;

  /** Sources this profile should scan, and how often. */
  sources: Array<{
    sourceId: string;
    intervalMinutes: number;
    /** False when the source is disabled, restricted or awaiting credentials. */
    schedulable: boolean;
    reason?: string;
    /** Adaptive signals, so a quiet source is scanned less. */
    emptyScans?: number;
    freshJobsLastScan?: number;
    healthScore?: number;
  }>;
}

export interface ReconcileResult {
  profileId: string;
  schedulesCreated: number;
  schedulesUpdated: number;
  schedulesDisabled: number;
  tasksCancelled: number;
  actions: string[];
}

export class ReconciliationService {
  constructor(
    private readonly deps: {
      scheduler: Scheduler;
      queue: TaskQueue;
      logger: Logger;
    },
  ) {}

  /**
   * Makes the schedule match one profile's configuration (Part 47).
   *
   * Everything here is an upsert or a disable — nothing is deleted on a normal
   * path. A source that disappears from the desired set is disabled rather than
   * removed, so its history and its last-run timestamps survive the user turning
   * it off and on again.
   */
  async reconcileSearchProfile(desired: DesiredProfileState): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      profileId: desired.profileId,
      schedulesCreated: 0,
      schedulesUpdated: 0,
      schedulesDisabled: 0,
      tasksCancelled: 0,
      actions: [],
    };

    const existing = await this.deps.scheduler.listSchedules({ profileId: desired.profileId });
    const existingByKey = new Map(
      existing.map((entry) => [`${entry.taskType}:${entry.sourceId ?? ''}`, entry]),
    );

    /*
     * A paused profile is handled first and exclusively.
     *
     * Reconciling its sources afterwards would re-enable the schedules that
     * pausing just turned off — the two operations would fight, and which one
     * won would depend on ordering.
     */
    if (!desired.active) {
      const cancelled = await this.deps.scheduler.pauseProfile(
        desired.profileId,
        desired.pausedUntil ?? null,
      );

      result.tasksCancelled = cancelled;
      result.schedulesDisabled = existing.filter((entry) => entry.enabled).length;
      result.actions.push(
        `Profile is not active: disabled ${result.schedulesDisabled} schedule(s) and cancelled ${cancelled} queued task(s).`,
      );

      return result;
    }

    // The profile-level scan.
    const profileKey = 'SEARCH_PROFILE_SCAN:';
    const hadProfileSchedule = existingByKey.has(profileKey);

    await this.deps.scheduler.upsertSchedule({
      taskType: 'SEARCH_PROFILE_SCAN',
      profileId: desired.profileId,
      intervalMinutes: desired.intervalMinutes,
      timezone: desired.timezone ?? 'UTC',
      priority: desired.priority ?? 'HIGH',
      enabled: true,
    });

    if (hadProfileSchedule) result.schedulesUpdated += 1;
    else result.schedulesCreated += 1;

    result.actions.push(
      `Profile scan every ${desired.intervalMinutes} minute(s) (${desired.timezone ?? 'UTC'}).`,
    );

    // Per-source scans.
    for (const source of desired.sources) {
      const key = `SOURCE_SCAN:${source.sourceId}`;
      const had = existingByKey.has(key);

      if (!source.schedulable) {
        const cancelled = await this.deps.scheduler.disableSource(source.sourceId, true);

        result.schedulesDisabled += 1;
        result.tasksCancelled += cancelled;
        result.actions.push(
          `${source.sourceId}: not schedulable (${source.reason ?? 'no reason given'}); ` +
            `disabled and cancelled ${cancelled} queued task(s).`,
        );
        continue;
      }

      await this.deps.scheduler.upsertSchedule({
        taskType: 'SOURCE_SCAN',
        profileId: desired.profileId,
        sourceId: source.sourceId,
        intervalMinutes: source.intervalMinutes,
        timezone: desired.timezone ?? 'UTC',
        priority: 'NORMAL',
        enabled: true,
        ...(source.emptyScans !== undefined
          ? {
              adaptive: {
                emptyScans: source.emptyScans,
                freshJobsLastScan: source.freshJobsLastScan ?? 0,
                healthScore: source.healthScore ?? 100,
              },
            }
          : {}),
      });

      if (had) result.schedulesUpdated += 1;
      else result.schedulesCreated += 1;
    }

    /*
     * Sources that used to be scheduled and no longer appear.
     *
     * Disabled rather than deleted, and their queued work is cancelled — the
     * user removed the source, so scans already waiting for it are work they
     * have said they do not want.
     */
    const desiredSourceIds = new Set(desired.sources.map((source) => source.sourceId));

    for (const entry of existing) {
      if (entry.taskType !== 'SOURCE_SCAN' || !entry.sourceId) continue;
      if (desiredSourceIds.has(entry.sourceId)) continue;
      if (!entry.enabled) continue;

      const cancelled = await this.deps.scheduler.disableSource(entry.sourceId, true);

      result.schedulesDisabled += 1;
      result.tasksCancelled += cancelled;
      result.actions.push(`${entry.sourceId}: no longer configured; disabled.`);
    }

    this.deps.logger.info('Reconciled search profile', { ...result });

    return result;
  }

  /** Reconciles many profiles, isolating failures. */
  async reconcileAll(desired: readonly DesiredProfileState[]): Promise<ReconcileResult[]> {
    const results: ReconcileResult[] = [];

    for (const profile of desired) {
      try {
        results.push(await this.reconcileSearchProfile(profile));
      } catch (error) {
        /*
         * One profile's reconciliation failing must not stop the others. The
         * same isolation rule that governs source scanning governs this.
         */
        this.deps.logger.warn('Profile reconciliation failed', {
          profileId: profile.profileId,
          err: error,
        });
      }
    }

    return results;
  }
}

// ── System health (Part 49) ─────────────────────────────────────────────────

export interface HealthProbe {
  component: string;
  check(): Promise<{ status: ComponentStatus; detail: string; latencyMs?: number }>;
}

export interface SystemHealthDependencies {
  queue: TaskQueue;
  deadLetters: DeadLetterQueue;
  workers: WorkerRegistry;
  scheduler: Scheduler;
  logger: Logger;
  /** Extra probes: database, cache, email provider, AI provider, connectors. */
  probes?: HealthProbe[];
}

export class SystemHealthService {
  constructor(private readonly deps: SystemHealthDependencies) {}

  /**
   * Checks every component and rolls the answers into one sentence.
   *
   * Each probe is wrapped so a failing check reports `down` rather than
   * throwing. A health endpoint that can itself fail is a health endpoint that
   * tells you nothing during exactly the incident it exists for.
   */
  async check(now = new Date()): Promise<HealthRollup> {
    const components: ComponentHealth[] = [];

    const record = async (
      component: string,
      fn: () => Promise<{ status: ComponentStatus; detail: string; latencyMs?: number }>,
    ): Promise<void> => {
      const startedAt = Date.now();

      try {
        const result = await fn();
        components.push({
          component,
          status: result.status,
          detail: result.detail,
          latencyMs: result.latencyMs ?? Date.now() - startedAt,
          checkedAt: now,
        });
      } catch (error) {
        components.push({
          component,
          status: 'down',
          detail: `${component} check failed: ${error instanceof Error ? error.message : String(error)}`,
          latencyMs: Date.now() - startedAt,
          checkedAt: now,
        });
      }
    };

    await record('scheduler', async () => {
      const lag = await this.deps.scheduler.lagSeconds();

      if (lag > 900) {
        return { status: 'down', detail: `Scheduler is ${lag}s behind; schedules are not firing.` };
      }
      if (lag > 180) {
        return { status: 'degraded', detail: `Scheduler is ${lag}s behind.` };
      }
      return { status: 'healthy', detail: `Scheduler lag ${lag}s.` };
    });

    await record('queue', async () => {
      const breakdown = await this.deps.queue.depthBreakdown();
      const stuck = await this.deps.queue.stuckTasks(now, 10);

      if (stuck.length > 0) {
        return {
          status: 'degraded',
          detail: `${stuck.length} task(s) have been processing longer than their timeout.`,
        };
      }
      if (breakdown.total > 20_000) {
        return { status: 'down', detail: `Queue depth ${breakdown.total} is at the hard limit.` };
      }
      if (breakdown.total > 5_000) {
        return { status: 'degraded', detail: `Queue depth ${breakdown.total} is above the soft limit.` };
      }
      return { status: 'healthy', detail: `${breakdown.total} task(s) queued.` };
    });

    await record('workers', async () => {
      const utilisation = await this.deps.workers.utilisation(now);

      if (utilisation.workers === 0) {
        return { status: 'down', detail: 'No workers are reporting heartbeats.' };
      }
      if (utilisation.utilisation >= 1) {
        return {
          status: 'degraded',
          detail: `All ${utilisation.workers} worker(s) are busy; work is queueing.`,
        };
      }
      return {
        status: 'healthy',
        detail: `${utilisation.workers} worker(s), ${Math.round(utilisation.utilisation * 100)}% busy.`,
      };
    });

    await record('dead-letters', async () => {
      const summary = await this.deps.deadLetters.summary();

      if (summary.open === 0) return { status: 'healthy', detail: 'No dead letters.' };

      /*
       * The dominant failure class is named, because that is the actionable
       * part. "412 dead letters" prompts a search; "412 dead letters, mostly
       * AUTHENTICATION on reddit" prompts a fix.
       */
      const [worstClass] = Object.entries(summary.byFailureClass).sort((a, b) => b[1] - a[1]);
      const [worstSource] = Object.entries(summary.bySource).sort((a, b) => b[1] - a[1]);

      const where = worstSource ? ` on ${worstSource[0]}` : '';
      const detail = `${summary.open} dead letter(s), mostly ${worstClass?.[0] ?? 'UNKNOWN'}${where}.`;

      return { status: summary.open > 100 ? 'down' : 'degraded', detail };
    });

    for (const probe of this.deps.probes ?? []) {
      await record(probe.component, () => probe.check());
    }

    return rollUpHealth(components, now);
  }
}
