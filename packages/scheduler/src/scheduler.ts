import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import {
  adaptInterval,
  idempotencyKey,
  resolveMisfire,
  scanWindow,
  scheduleEntrySchema,
  type MisfirePolicy,
  type ScheduleEntry,
  type TaskPriority,
  type TaskType,
} from '@job-intel/contracts';
import type { Database } from '@job-intel/db';
import { schema } from '@job-intel/db';
import type { Logger } from '@job-intel/observability';
import type { TaskQueue } from './task-queue';
import type { CoordinationService } from './coordination';

/**
 * The scheduler.
 *
 * A tick-driven reconciler rather than a cron daemon. Every tick it asks one
 * question — what is due? — and turns the answer into tasks. That shape has
 * three properties worth the trade:
 *
 * It is **testable with a clock** rather than with real time, so a test can
 * simulate three days of operation in milliseconds.
 *
 * It is **restart-safe**, because the schedule is rows rather than timers. A
 * deploy in the middle of an interval loses nothing.
 *
 * It **converges**. Reconciliation is idempotent: running it twice produces the
 * same schedules, so a configuration change and a routine tick can race without
 * producing duplicates.
 *
 * Leadership is an efficiency measure, not a correctness one. Idempotency keys
 * already make duplicate tasks impossible; the lease exists so that ten
 * instances do not each do the same work of finding that out.
 */

export const SCHEDULER_LEASE_NAME = 'scheduler';

export interface SchedulerDependencies {
  db: Database;
  queue: TaskQueue;
  coordination: CoordinationService;
  logger: Logger;
  /** Identifies this instance in the leadership lease. */
  instanceId: string;
}

export interface SchedulerOptions {
  leaseDurationMs?: number;
  /** Ceiling on tasks created in one tick, so a backlog cannot stampede. */
  maxTasksPerTick?: number;
  now?: () => Date;
}

export interface TickResult {
  isLeader: boolean;
  leaderReason: string;
  due: number;
  enqueued: number;
  duplicates: number;
  skippedMisfires: number;
  rejected: number;
  details: Array<{ scheduleId: string; taskType: string; reason: string }>;
}

export interface UpsertScheduleInput {
  taskType: TaskType;
  profileId?: string | null;
  sourceId?: string | null;
  intervalMinutes: number;
  timezone?: string;
  enabled?: boolean;
  misfirePolicy?: MisfirePolicy;
  maxCatchUpRuns?: number;
  priority?: TaskPriority;
  payload?: Record<string, unknown>;
  /** Adaptive signals, used to stretch the interval when a source is quiet. */
  adaptive?: { emptyScans: number; freshJobsLastScan: number; healthScore: number };
  /**
   * When a *newly created* schedule should first fire. Ignored once the
   * schedule exists, so it never re-dates a running one.
   *
   * A new schedule otherwise fires immediately, which is right for work that
   * should have been running all along and wrong for work that deletes
   * things: a weekly purge created today would purge today, which is not what
   * "weekly from next week" means to the person who asked for it.
   */
  firstRunAt?: Date;
}

export class Scheduler {
  private readonly leaseDurationMs: number;
  private readonly maxTasksPerTick: number;
  private readonly now: () => Date;

  constructor(
    private readonly deps: SchedulerDependencies,
    options: SchedulerOptions = {},
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.maxTasksPerTick = options.maxTasksPerTick ?? 200;
    this.now = options.now ?? (() => new Date());
  }

  // ── Schedule management (Parts 11, 12, 38, 47) ──────────────────────────

  /**
   * Creates or updates one schedule.
   *
   * The upsert is keyed on (type, profile, source), so calling this repeatedly
   * with the same target converges rather than accumulating. That is what makes
   * reconciliation safe to run on every configuration change *and* on a timer.
   *
   * `nextRunAt` is preserved when the interval has not changed, so re-saving an
   * unrelated field does not silently postpone a scan that was about to fire.
   */
  async upsertSchedule(input: UpsertScheduleInput): Promise<ScheduleEntry> {
    const now = this.now();
    const existing = await this.findSchedule(input.taskType, input.profileId, input.sourceId);

    /*
     * Adaptive stretching is applied here rather than at fire time, so the
     * effective interval is visible in the row an operator is looking at. A
     * source quietly being scanned at a different rate than its configuration
     * says is exactly the kind of surprise Part 43 warns against.
     */
    const adapted = input.adaptive
      ? adaptInterval(input.intervalMinutes, input.adaptive)
      : { intervalMinutes: input.intervalMinutes, reason: 'Configured rate.', atConfiguredRate: true };

    const intervalChanged = existing !== null && existing.intervalMinutes !== adapted.intervalMinutes;

    /*
     * A changed interval re-bases the next run immediately (Part 12).
     *
     * Someone moving a profile from hourly to every fifteen minutes expects the
     * change to take effect now, not fifty-nine minutes from now when the old
     * interval happens to elapse.
     */
    const nextRunAt =
      existing === null
        ? (input.firstRunAt ?? now)
        : intervalChanged
          ? new Date(
              Math.min(
                now.getTime() + adapted.intervalMinutes * 60_000,
                (existing.lastRunAt?.getTime() ?? now.getTime()) + adapted.intervalMinutes * 60_000,
              ),
            )
          : existing.nextRunAt;

    const values = {
      taskType: input.taskType,
      profileId: input.profileId ?? null,
      sourceId: input.sourceId ?? null,
      intervalMinutes: adapted.intervalMinutes,
      timezone: input.timezone ?? 'UTC',
      enabled: input.enabled ?? true,
      misfirePolicy: input.misfirePolicy ?? 'RUN_ONCE',
      maxCatchUpRuns: input.maxCatchUpRuns ?? 3,
      priority: input.priority ?? 'NORMAL',
      payload: input.payload ?? {},
      nextRunAt,
      updatedAt: now,
    };

    if (existing) {
      const [row] = await this.db
        .update(schema.schedules)
        .set(values)
        .where(eq(schema.schedules.id, existing.scheduleId))
        .returning();

      return this.toEntry(row!);
    }

    const [row] = await this.db.insert(schema.schedules).values(values).returning();

    return this.toEntry(row!);
  }

  private get db(): Database {
    return this.deps.db;
  }

  private async findSchedule(
    taskType: TaskType,
    profileId?: string | null,
    sourceId?: string | null,
  ): Promise<ScheduleEntry | null> {
    const [row] = await this.db
      .select()
      .from(schema.schedules)
      .where(
        and(
          eq(schema.schedules.taskType, taskType),
          profileId ? eq(schema.schedules.profileId, profileId) : isNull(schema.schedules.profileId),
          sourceId ? eq(schema.schedules.sourceId, sourceId) : isNull(schema.schedules.sourceId),
        ),
      )
      .limit(1);

    return row ? this.toEntry(row) : null;
  }

  async listSchedules(filter: { profileId?: string; enabledOnly?: boolean } = {}) {
    const conditions = [];
    if (filter.profileId) conditions.push(eq(schema.schedules.profileId, filter.profileId));
    if (filter.enabledOnly) conditions.push(eq(schema.schedules.enabled, true));

    const rows = await this.db
      .select()
      .from(schema.schedules)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(schema.schedules.nextRunAt));

    return rows.map((row) => this.toEntry(row));
  }

  // ── Pause and resume (Parts 13, 14) ─────────────────────────────────────

  /**
   * Stops future scans for a profile.
   *
   * Running tasks are left alone. Cancelling work already in flight would not
   * stop it — the worker is executing — and would only make the record disagree
   * with what is happening. Queued-but-unstarted work *is* cancelled, since
   * that is what "stop scanning" means to the person who clicked pause.
   */
  async pauseProfile(profileId: string, until?: Date | null): Promise<number> {
    const now = this.now();

    await this.db
      .update(schema.schedules)
      .set({ enabled: false, pausedUntil: until ?? null, updatedAt: now })
      .where(eq(schema.schedules.profileId, profileId));

    return this.deps.queue.cancelPending({ profileId }, now);
  }

  /**
   * Resumes a paused profile without replaying its downtime.
   *
   * The important line is `nextRunAt: now`. Leaving the stale value would make
   * every schedule instantly overdue by however long the pause lasted, and the
   * misfire policy would then have to absorb a three-day backlog on the next
   * tick. Re-basing means a resumed profile runs once, now, and then normally.
   */
  async resumeProfile(profileId: string): Promise<number> {
    const now = this.now();

    const updated = await this.db
      .update(schema.schedules)
      .set({ enabled: true, pausedUntil: null, nextRunAt: now, updatedAt: now })
      .where(eq(schema.schedules.profileId, profileId))
      .returning({ id: schema.schedules.id });

    return updated.length;
  }

  /** Disables every schedule for a source (Parts 45, 46). */
  async disableSource(sourceId: string, cancelQueued = true): Promise<number> {
    const now = this.now();

    await this.db
      .update(schema.schedules)
      .set({ enabled: false, updatedAt: now })
      .where(eq(schema.schedules.sourceId, sourceId));

    return cancelQueued ? this.deps.queue.cancelPending({ sourceId }, now) : 0;
  }

  async enableSource(sourceId: string): Promise<number> {
    const now = this.now();

    const updated = await this.db
      .update(schema.schedules)
      .set({ enabled: true, nextRunAt: now, updatedAt: now })
      .where(eq(schema.schedules.sourceId, sourceId))
      .returning({ id: schema.schedules.id });

    return updated.length;
  }

  async removeSchedulesFor(filter: { profileId?: string; sourceId?: string }): Promise<number> {
    const conditions = [];
    if (filter.profileId) conditions.push(eq(schema.schedules.profileId, filter.profileId));
    if (filter.sourceId) conditions.push(eq(schema.schedules.sourceId, filter.sourceId));
    if (conditions.length === 0) return 0;

    const removed = await this.db
      .delete(schema.schedules)
      .where(and(...conditions))
      .returning({ id: schema.schedules.id });

    return removed.length;
  }

  // ── The tick (Parts 39, 41) ─────────────────────────────────────────────

  /**
   * One scheduling pass.
   *
   * Acquires leadership, finds due schedules, applies the misfire policy, and
   * enqueues. A non-leader returns immediately having done nothing, which is
   * the point: ten instances ticking every ten seconds should produce one
   * instance's worth of work.
   */
  async tick(): Promise<TickResult> {
    const now = this.now();

    const leadership = await this.deps.coordination.acquireLease(
      SCHEDULER_LEASE_NAME,
      this.deps.instanceId,
      this.leaseDurationMs,
      now,
    );

    if (!leadership.acquired) {
      return {
        isLeader: false,
        leaderReason: leadership.reason,
        due: 0,
        enqueued: 0,
        duplicates: 0,
        skippedMisfires: 0,
        rejected: 0,
        details: [],
      };
    }

    const dueRows = await this.db
      .select()
      .from(schema.schedules)
      .where(
        and(
          eq(schema.schedules.enabled, true),
          or(isNull(schema.schedules.nextRunAt), lte(schema.schedules.nextRunAt, now)),
          or(isNull(schema.schedules.pausedUntil), lte(schema.schedules.pausedUntil, now)),
        ),
      )
      .orderBy(asc(schema.schedules.nextRunAt))
      .limit(this.maxTasksPerTick);

    const result: TickResult = {
      isLeader: true,
      leaderReason: 'Holding the scheduler lease.',
      due: dueRows.length,
      enqueued: 0,
      duplicates: 0,
      skippedMisfires: 0,
      rejected: 0,
      details: [],
    };

    for (const row of dueRows) {
      const entry = this.toEntry(row);
      const decision = resolveMisfire(entry, now);

      result.skippedMisfires += decision.skipped;

      for (let index = 0; index < decision.runsToEnqueue; index += 1) {
        /*
         * The window is what makes a tick idempotent.
         *
         * Every enqueue inside one interval produces the same key, so a
         * scheduler ticking every ten seconds creates one task per hour rather
         * than three hundred and sixty. The catch-up index disambiguates the
         * handful of runs `CATCH_UP_LIMITED` legitimately wants separately.
         */
        const window = scanWindow(now, entry.intervalMinutes);

        const enqueued = await this.deps.queue.enqueue(
          {
            type: entry.taskType,
            priority: entry.priority,
            key: [
              entry.profileId,
              entry.sourceId,
              window,
              index > 0 ? `catchup-${index}` : null,
            ],
            payload: { ...entry.payload, scheduleId: entry.scheduleId, window },
            profileId: entry.profileId,
            sourceId: entry.sourceId,
            scheduledAt: entry.nextRunAt,
          },
          now,
        );

        if (enqueued.created) result.enqueued += 1;
        else if (enqueued.reason.includes('already queued')) result.duplicates += 1;
        else result.rejected += 1;
      }

      await this.db
        .update(schema.schedules)
        .set({
          nextRunAt: decision.nextRunAt,
          lastRunAt: decision.runsToEnqueue > 0 ? now : row.lastRunAt,
          updatedAt: now,
        })
        .where(eq(schema.schedules.id, row.id));

      result.details.push({
        scheduleId: row.id,
        taskType: row.taskType,
        reason: decision.reason,
      });
    }

    return result;
  }

  /** Records the outcome of a run, for the dashboard and adaptive scanning. */
  async recordRun(scheduleId: string, outcome: 'success' | 'failure'): Promise<void> {
    const now = this.now();

    await this.db
      .update(schema.schedules)
      .set(
        outcome === 'success'
          ? { lastSuccessfulRunAt: now, updatedAt: now }
          : { lastFailureAt: now, updatedAt: now },
      )
      .where(eq(schema.schedules.id, scheduleId));
  }

  /**
   * Scheduler lag: how overdue the most overdue schedule is (Part 48).
   *
   * The single most useful number for telling whether the engine is keeping up.
   * Growing lag means ticks are not completing, or the leader is gone, and both
   * are invisible in a queue-depth graph.
   */
  async lagSeconds(): Promise<number> {
    const now = this.now();

    const [row] = await this.db
      .select({
        oldest: sql<string | null>`min(${schema.schedules.nextRunAt})`,
      })
      .from(schema.schedules)
      .where(and(eq(schema.schedules.enabled, true), lte(schema.schedules.nextRunAt, now)));

    if (!row?.oldest) return 0;

    return Math.max(0, Math.round((now.getTime() - new Date(row.oldest).getTime()) / 1000));
  }

  private toEntry(row: typeof schema.schedules.$inferSelect): ScheduleEntry {
    return scheduleEntrySchema.parse({ ...row, scheduleId: row.id });
  }
}

/** Key for a recurring scan, exported so callers can predict it. */
export function scanTaskKey(
  type: TaskType,
  profileId: string | null,
  sourceId: string | null,
  at: Date,
  intervalMinutes: number,
): string {
  return idempotencyKey(type, [profileId, sourceId, scanWindow(at, intervalMinutes)]);
}
