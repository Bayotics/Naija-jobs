import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import {
  DEFAULT_BACKPRESSURE,
  DEFAULT_TASK_PRIORITY,
  DEFAULT_TASK_TIMEOUT_MS,
  MAX_ATTEMPTS,
  RETRYABLE,
  TASK_PRIORITY_RANK,
  canTransition,
  evaluateBackpressure,
  idempotencyKey as buildKey,
  leaseDurationFor,
  nextRetryDelayMs,
  taskSchema,
  type BackpressureConfig,
  type FailureClass,
  type RetryPolicy,
  type Task,
  type TaskPriority,
  type TaskState,
  type TaskType,
} from '@job-intel/contracts';
import type { Database } from '@job-intel/db';
import { schema } from '@job-intel/db';

/**
 * The durable task queue.
 *
 * Two properties matter more than anything else here, and both are enforced by
 * the database rather than by the code that calls it.
 *
 * **Claiming is atomic.** `FOR UPDATE SKIP LOCKED` lets any number of workers
 * poll the same table without coordinating: each takes rows the others have not
 * locked, and nobody waits. The alternative — read, then update, then hope — is
 * a race that shows up as two workers scanning one source, which looks like a
 * rate-limit problem and is actually a concurrency bug.
 *
 * **Enqueueing is idempotent.** A partial unique index on the idempotency key
 * collapses duplicate submissions to one row. This is what makes it safe to run
 * two schedulers, retry an enqueue, or replay a tick.
 *
 * Execution is *at-least-once*. A worker can complete a task and die before
 * recording it, and the task will run again. Every handler must be idempotent;
 * this queue does not pretend to remove a problem that cannot be removed.
 */

export interface EnqueueInput {
  type: TaskType;
  payload?: Record<string, unknown>;
  priority?: TaskPriority;
  /** Parts of the natural key. The type is prepended automatically. */
  key?: ReadonlyArray<string | null | undefined>;
  /** Full override, when the caller has computed the key itself. */
  idempotencyKey?: string;

  profileId?: string | null;
  sourceId?: string | null;
  jobId?: string | null;

  availableAt?: Date;
  scheduledAt?: Date | null;
  maxAttempts?: number;
  timeoutMs?: number;
  traceId?: string | null;
}

export interface EnqueueResult {
  task: Task | null;
  /** False when an equivalent live task already existed. */
  created: boolean;
  reason: string;
}

export interface ClaimOptions {
  workerId: string;
  /** Types this worker handles. Empty means all of them. */
  types?: readonly TaskType[];
  limit?: number;
  now?: Date;
  /** Ceiling on simultaneous tasks per profile, for fairness. */
  maxPerProfile?: number;
}

export interface FailureInput {
  taskId: string;
  workerId: string;
  error: string;
  failureClass: FailureClass;
  /** From a `Retry-After` header, when the source supplied one. */
  retryAfterMs?: number | null;
  policy?: RetryPolicy;
  now?: Date;
  random?: () => number;
}

export interface FailureResult {
  outcome: 'retrying' | 'dead_letter' | 'failed';
  nextAttemptAt: Date | null;
  attempts: number;
  reason: string;
}

/**
 * Row to contract.
 *
 * The column is `id` and the contract field is `taskId`. Mapped in one place
 * rather than aliased in every select: a missed alias produces a Zod error at
 * runtime rather than a type error at build time, which is the worst of both.
 */
function toTask(row: typeof schema.tasks.$inferSelect): Task {
  return taskSchema.parse({ ...row, taskId: row.id });
}

const LIVE_STATES: TaskState[] = [
  'PENDING',
  'SCHEDULED',
  'READY',
  'PROCESSING',
  'RETRYING',
  'FAILED',
];

export class TaskQueue {
  constructor(
    private readonly db: Database,
    private readonly backpressure: BackpressureConfig = DEFAULT_BACKPRESSURE,
  ) {}

  // ── Enqueue (Parts 4, 21) ───────────────────────────────────────────────

  /**
   * Adds a task, or reports that an equivalent one is already queued.
   *
   * The `onConflictDoNothing` is the entire idempotency mechanism. Checking
   * first and inserting second would be readable and wrong: the window between
   * the two is exactly where a second scheduler inserts the same row.
   */
  async enqueue(input: EnqueueInput, now = new Date()): Promise<EnqueueResult> {
    const priority = input.priority ?? DEFAULT_TASK_PRIORITY[input.type];

    /*
     * Backpressure is evaluated before the insert, and only for work that can
     * wait. A critical task is admitted at any depth — shedding a deadline
     * notification to protect a queue is protecting the wrong thing.
     */
    if (priority !== 'CRITICAL') {
      const [depth, profileDepth] = await Promise.all([
        this.depth(),
        input.profileId ? this.depth({ profileId: input.profileId }) : Promise.resolve(undefined),
      ]);

      const decision = evaluateBackpressure(
        { queueDepth: depth, profileDepth, priority },
        this.backpressure,
      );

      if (!decision.accept) {
        return { task: null, created: false, reason: decision.reason };
      }
    }

    return this.insert(input, priority, now);
  }

  /** The insert itself, without the backpressure check. */
  private async insert(
    input: EnqueueInput,
    priority: TaskPriority,
    now: Date,
  ): Promise<EnqueueResult> {
    const key = input.idempotencyKey ?? buildKey(input.type, input.key ?? []);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS[input.type];

    const [row] = await this.db
      .insert(schema.tasks)
      .values({
        id: randomUUID(),
        type: input.type,
        status: 'READY',
        priority,
        priorityRank: TASK_PRIORITY_RANK[priority],
        idempotencyKey: key,
        payload: input.payload ?? {},
        profileId: input.profileId ?? null,
        sourceId: input.sourceId ?? null,
        jobId: input.jobId ?? null,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 5,
        scheduledAt: input.scheduledAt ?? null,
        availableAt: input.availableAt ?? now,
        timeoutMs,
        traceId: input.traceId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (!row) {
      return {
        task: null,
        created: false,
        reason: `An equivalent task is already queued (${key}).`,
      };
    }

    return { task: toTask(row), created: true, reason: 'Enqueued.' };
  }

  /**
   * Enqueues many, reporting how many collapsed into existing work.
   *
   * Depth is counted *once* and then tracked in memory rather than re-queried
   * per task. The obvious loop over `enqueue` costs two `COUNT(*)` queries per
   * task, which turned a ten-thousand-task batch into twenty thousand
   * full-table counts — seventy seconds of the load test was this, and it would
   * have been far worse against a real table with real contention.
   *
   * The in-memory tally can drift if another process enqueues concurrently, and
   * that is acceptable: backpressure is a throttle, not an invariant, and it is
   * re-derived from the database on the next batch.
   */
  async enqueueMany(inputs: readonly EnqueueInput[], now = new Date()) {
    const created: Task[] = [];
    let duplicates = 0;
    let rejected = 0;

    let depth = await this.depth();
    const profileDepths = new Map<string, number>();

    for (const input of inputs) {
      const priority = input.priority ?? DEFAULT_TASK_PRIORITY[input.type];

      if (priority !== 'CRITICAL') {
        let profileDepth: number | undefined;

        if (input.profileId) {
          if (!profileDepths.has(input.profileId)) {
            profileDepths.set(input.profileId, await this.depth({ profileId: input.profileId }));
          }
          profileDepth = profileDepths.get(input.profileId);
        }

        const decision = evaluateBackpressure(
          { queueDepth: depth, profileDepth, priority },
          this.backpressure,
        );

        if (!decision.accept) {
          rejected += 1;
          continue;
        }
      }

      const result = await this.insert(input, priority, now);

      if (result.created && result.task) {
        created.push(result.task);
        depth += 1;
        if (input.profileId) {
          profileDepths.set(input.profileId, (profileDepths.get(input.profileId) ?? 0) + 1);
        }
      } else {
        duplicates += 1;
      }
    }

    return { created, duplicates, rejected };
  }

  // ── Claim (Parts 5, 6, 10) ──────────────────────────────────────────────

  /**
   * Claims up to `limit` tasks for one worker.
   *
   * The ordering is the scheduling policy: priority first, then availability.
   * Fairness is applied *after* the database returns candidates rather than in
   * SQL — expressing "at most two per profile" as a window function would work
   * and would also make the query unreadable and unindexable. Over-fetching a
   * small multiple and filtering in memory costs nothing at this scale.
   */
  async claim(options: ClaimOptions): Promise<Task[]> {
    const now = options.now ?? new Date();
    const limit = options.limit ?? 1;
    const maxPerProfile = options.maxPerProfile ?? Math.max(1, Math.ceil(limit / 2));

    const typeFilter =
      options.types && options.types.length > 0
        ? inArray(schema.tasks.type, options.types as string[])
        : undefined;

    /*
     * Two ways a task becomes claimable: it is READY and due, or it is
     * PROCESSING with a lapsed lease. The second is crash recovery, and folding
     * it into the same query means recovery needs no separate sweeper to be
     * running for work to resume.
     */
    const claimable = or(
      and(inArray(schema.tasks.status, ['READY', 'RETRYING']), lte(schema.tasks.availableAt, now)),
      and(
        eq(schema.tasks.status, 'PROCESSING'),
        isNotNull(schema.tasks.leaseExpiresAt),
        lte(schema.tasks.leaseExpiresAt, now),
      ),
    );

    const candidates = await this.db
      .select({
        id: schema.tasks.id,
        type: schema.tasks.type,
        profileId: schema.tasks.profileId,
        status: schema.tasks.status,
        attempts: schema.tasks.attempts,
        timeoutMs: schema.tasks.timeoutMs,
      })
      .from(schema.tasks)
      .where(typeFilter ? and(claimable, typeFilter) : claimable)
      .orderBy(asc(schema.tasks.priorityRank), asc(schema.tasks.availableAt))
      /*
       * Over-fetch so fairness has something to choose between. Without the
       * multiplier, a profile with ten thousand queued tasks fills every
       * candidate slot and the fairness filter has nothing else to pick.
       */
      .limit(limit * 8)
      .for('update', { skipLocked: true });

    if (candidates.length === 0) return [];

    const perProfile = new Map<string, number>();
    const selected: typeof candidates = [];

    for (const candidate of candidates) {
      if (selected.length >= limit) break;

      const profile = candidate.profileId ?? '__none__';
      const taken = perProfile.get(profile) ?? 0;

      if (candidate.profileId && taken >= maxPerProfile) continue;

      perProfile.set(profile, taken + 1);
      selected.push(candidate);
    }

    if (selected.length === 0) return [];

    const claimed: Task[] = [];

    for (const candidate of selected) {
      const lease = leaseDurationFor(
        candidate.type as TaskType,
        candidate.timeoutMs ?? undefined,
      );

      const [row] = await this.db
        .update(schema.tasks)
        .set({
          status: 'PROCESSING',
          lockedBy: options.workerId,
          lockedAt: now,
          leaseExpiresAt: new Date(now.getTime() + lease),
          startedAt: now,
          attempts: candidate.attempts + 1,
          updatedAt: now,
        })
        .where(eq(schema.tasks.id, candidate.id))
        .returning();

      if (row) claimed.push(toTask(row));
    }

    return claimed;
  }

  // ── Leases and heartbeats (Parts 6, 7) ──────────────────────────────────

  /**
   * Extends a lease, if this worker still holds it.
   *
   * The `lockedBy` check is what makes this safe. A worker that paused long
   * enough for its lease to lapse and its task to be reassigned must not be
   * able to renew — it would then be holding a lease on a task another worker
   * is actively running, and both would write results.
   */
  async heartbeat(taskId: string, workerId: string, now = new Date()): Promise<boolean> {
    const [row] = await this.db
      .select({ type: schema.tasks.type, timeoutMs: schema.tasks.timeoutMs })
      .from(schema.tasks)
      .where(
        and(eq(schema.tasks.id, taskId), eq(schema.tasks.lockedBy, workerId), eq(schema.tasks.status, 'PROCESSING')),
      )
      .limit(1);

    if (!row) return false;

    const lease = leaseDurationFor(row.type as TaskType, row.timeoutMs ?? undefined);

    const updated = await this.db
      .update(schema.tasks)
      .set({ leaseExpiresAt: new Date(now.getTime() + lease), updatedAt: now })
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.lockedBy, workerId)))
      .returning({ id: schema.tasks.id });

    return updated.length > 0;
  }

  /**
   * Returns tasks whose leases have lapsed to the ready pool.
   *
   * Belt and braces: `claim` already picks up lapsed tasks, but running this
   * explicitly makes recovery visible in the metrics rather than silently
   * folded into normal claiming, and it releases tasks even when no worker is
   * currently polling for that type.
   */
  async reapExpiredLeases(now = new Date()): Promise<number> {
    const expired = await this.db
      .update(schema.tasks)
      .set({
        status: 'READY',
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
        lastError: 'Lease expired; the worker did not report back.',
        lastFailureClass: 'TRANSIENT',
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.tasks.status, 'PROCESSING'),
          isNotNull(schema.tasks.leaseExpiresAt),
          lte(schema.tasks.leaseExpiresAt, now),
          /*
           * Attempts are *not* incremented here. The claim already counted this
           * attempt, and counting it twice would send a task to the dead-letter
           * queue after two crashes rather than five failures.
           */
          sql`${schema.tasks.attempts} < ${schema.tasks.maxAttempts}`,
        ),
      )
      .returning({ id: schema.tasks.id });

    return expired.length;
  }

  /**
   * Tasks running longer than expected (Part 35).
   *
   * Reported rather than acted on. A task past its timeout may still be
   * running, and requeuing it would mean two workers doing the same thing — so
   * the lease is the only thing allowed to actually reclaim work, and this
   * exists to make the situation visible before the lease lapses.
   */
  async stuckTasks(now = new Date(), limit = 50) {
    const rows = await this.db
      .select()
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.status, 'PROCESSING'),
          isNotNull(schema.tasks.startedAt),
          sql`${schema.tasks.startedAt} + (coalesce(${schema.tasks.timeoutMs}, 300000) || ' milliseconds')::interval < ${now}`,
        ),
      )
      .limit(limit);

    return rows.map((row) => toTask(row));
  }

  // ── Completion and failure (Parts 23–27) ────────────────────────────────

  async complete(taskId: string, workerId: string, now = new Date()): Promise<boolean> {
    const updated = await this.db
      .update(schema.tasks)
      .set({
        status: 'COMPLETED',
        completedAt: now,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.lockedBy, workerId)))
      .returning({ id: schema.tasks.id });

    return updated.length > 0;
  }

  /**
   * Records a failure and decides what happens next.
   *
   * The decision is made from the failure's *class*, not from the attempt count
   * alone. An authentication failure is final on the first attempt because the
   * credential will not fix itself, and five retries against a provider that
   * has already rejected the credential is how an expired token becomes a
   * locked account.
   */
  async fail(input: FailureInput): Promise<FailureResult> {
    const now = input.now ?? new Date();

    const [current] = await this.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, input.taskId))
      .limit(1);

    if (!current) {
      return { outcome: 'failed', nextAttemptAt: null, attempts: 0, reason: 'Task not found.' };
    }

    const attempts = current.attempts;
    const classLimit = MAX_ATTEMPTS[input.failureClass];
    const limit = Math.min(current.maxAttempts, classLimit);
    const retryable = RETRYABLE[input.failureClass];

    if (!retryable || attempts >= limit) {
      await this.deadLetter(current, input, now);

      return {
        outcome: 'dead_letter',
        nextAttemptAt: null,
        attempts,
        reason: retryable
          ? `Exhausted ${attempts} of ${limit} attempts.`
          : `${input.failureClass} failures are not retried.`,
      };
    }

    const delay = nextRetryDelayMs(attempts, input.policy, {
      retryAfterMs: input.retryAfterMs ?? null,
      ...(input.random ? { random: input.random } : {}),
    });

    const nextAttemptAt = new Date(now.getTime() + delay);

    await this.db
      .update(schema.tasks)
      .set({
        status: 'RETRYING',
        availableAt: nextAttemptAt,
        failedAt: now,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
        lastError: input.error.slice(0, 2_000),
        lastFailureClass: input.failureClass,
        updatedAt: now,
      })
      .where(eq(schema.tasks.id, input.taskId))
      .returning({ id: schema.tasks.id });

    return {
      outcome: 'retrying',
      nextAttemptAt,
      attempts,
      reason: `Attempt ${attempts} of ${limit} failed (${input.failureClass}); retrying in ${Math.round(delay / 1000)}s.`,
    };
  }

  /** Moves a task out of the live queue and into the dead-letter table. */
  private async deadLetter(
    current: typeof schema.tasks.$inferSelect,
    input: FailureInput,
    now: Date,
  ): Promise<void> {
    const previous = Array.isArray(current.payload)
      ? []
      : ((current.payload as Record<string, unknown>)['__errors'] as unknown[] | undefined) ?? [];

    await this.db
      .insert(schema.taskDeadLetters)
      .values({
        taskId: current.id,
        type: current.type,
        priority: current.priority,
        idempotencyKey: current.idempotencyKey,
        payload: current.payload,
        profileId: current.profileId,
        sourceId: current.sourceId,
        jobId: current.jobId,
        attempts: current.attempts,
        errors: [
          ...previous,
          { at: now.toISOString(), class: input.failureClass, error: input.error.slice(0, 1_000) },
        ],
        lastError: input.error.slice(0, 2_000),
        lastFailureClass: input.failureClass,
        lastWorkerId: input.workerId,
        firstFailedAt: current.failedAt ?? now,
        deadLetteredAt: now,
      })
      .onConflictDoNothing({ target: schema.taskDeadLetters.taskId });

    /*
     * The live row is deleted rather than marked.
     *
     * Leaving it as `DEAD_LETTER` would keep its idempotency key occupying the
     * partial unique index, so the next hourly scan of that source could never
     * be enqueued — one poisoned task would silently stop a source forever.
     */
    await this.db.delete(schema.tasks).where(eq(schema.tasks.id, current.id));
  }

  // ── Cancellation and reconciliation (Parts 13, 46) ──────────────────────

  /**
   * Cancels queued work matching a filter.
   *
   * Only work that has not started. A `PROCESSING` task is left alone: it is
   * running somewhere, and marking it cancelled would not stop it — it would
   * only make the record disagree with reality. The worker's own completion
   * path handles it.
   */
  async cancelPending(
    filter: { profileId?: string; sourceId?: string; type?: TaskType },
    now = new Date(),
  ): Promise<number> {
    const conditions = [inArray(schema.tasks.status, ['READY', 'RETRYING', 'SCHEDULED', 'PENDING'])];

    if (filter.profileId) conditions.push(eq(schema.tasks.profileId, filter.profileId));
    if (filter.sourceId) conditions.push(eq(schema.tasks.sourceId, filter.sourceId));
    if (filter.type) conditions.push(eq(schema.tasks.type, filter.type));

    const cancelled = await this.db
      .update(schema.tasks)
      .set({ status: 'CANCELLED', updatedAt: now })
      .where(and(...conditions))
      .returning({ id: schema.tasks.id });

    /*
     * Cancelled rows are removed so their idempotency keys free up. A cancelled
     * hourly scan whose key lingered would block the next one, which turns
     * "pause this profile" into "this profile never scans again".
     */
    if (cancelled.length > 0) {
      await this.db.delete(schema.tasks).where(
        inArray(
          schema.tasks.id,
          cancelled.map((row) => row.id),
        ),
      );
    }

    return cancelled.length;
  }

  // ── Introspection (Parts 22, 48) ────────────────────────────────────────

  async depth(filter: { profileId?: string; type?: TaskType; sourceId?: string } = {}) {
    const conditions = [inArray(schema.tasks.status, ['READY', 'RETRYING', 'SCHEDULED', 'PENDING'])];

    if (filter.profileId) conditions.push(eq(schema.tasks.profileId, filter.profileId));
    if (filter.type) conditions.push(eq(schema.tasks.type, filter.type));
    if (filter.sourceId) conditions.push(eq(schema.tasks.sourceId, filter.sourceId));

    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.tasks)
      .where(and(...conditions));

    return row?.count ?? 0;
  }

  /**
   * Depth broken down every way the dashboard needs it.
   *
   * Counts *queued* work only. Including completed rows made a perfectly
   * drained queue report its lifetime throughput as its depth, which the health
   * check then read as "at the hard limit" — a system working flawlessly
   * reporting itself unhealthy, and getting worse the better it worked.
   *
   * `processing` is reported separately rather than folded in: work in flight
   * is not backlog, and adding it to depth would make every busy period look
   * like congestion.
   */
  async depthBreakdown() {
    const rows = await this.db
      .select({
        type: schema.tasks.type,
        status: schema.tasks.status,
        priority: schema.tasks.priority,
        sourceId: schema.tasks.sourceId,
        profileId: schema.tasks.profileId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.tasks)
      .where(inArray(schema.tasks.status, [...LIVE_STATES]))
      .groupBy(schema.tasks.type, schema.tasks.status, schema.tasks.priority, schema.tasks.sourceId, schema.tasks.profileId);

    const byType = new Map<string, number>();
    const byStatus = new Map<string, number>();
    const byPriority = new Map<string, number>();
    const bySource = new Map<string, number>();
    const byProfile = new Map<string, number>();

    const add = (map: Map<string, number>, key: string | null, count: number): void => {
      if (key === null) return;
      map.set(key, (map.get(key) ?? 0) + count);
    };

    for (const row of rows) {
      add(byType, row.type, row.count);
      add(byStatus, row.status, row.count);
      add(byPriority, row.priority, row.count);
      add(bySource, row.sourceId, row.count);
      add(byProfile, row.profileId, row.count);
    }

    const processing = rows
      .filter((row) => row.status === 'PROCESSING')
      .reduce((sum, row) => sum + row.count, 0);

    return {
      byType: Object.fromEntries(byType),
      byStatus: Object.fromEntries(byStatus),
      byPriority: Object.fromEntries(byPriority),
      bySource: Object.fromEntries(bySource),
      byProfile: Object.fromEntries(byProfile),
      /** Waiting to run. Excludes work currently in flight. */
      total: rows
        .filter((row) => row.status !== 'PROCESSING')
        .reduce((sum, row) => sum + row.count, 0),
      processing,
    };
  }

  async get(taskId: string): Promise<Task | null> {
    const [row] = await this.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
    return row ? toTask(row) : null;
  }

  /** Removes completed and cancelled tasks older than the retention window. */
  async purgeCompleted(olderThanHours = 24, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - olderThanHours * 3_600_000);

    const removed = await this.db
      .delete(schema.tasks)
      .where(
        and(
          inArray(schema.tasks.status, ['COMPLETED', 'CANCELLED']),
          lte(schema.tasks.updatedAt, cutoff),
        ),
      )
      .returning({ id: schema.tasks.id });

    return removed.length;
  }

  /** Guard used by callers that need to check a transition before writing. */
  static isLegalTransition(from: TaskState, to: TaskState): boolean {
    return canTransition(from, to);
  }

  static get liveStates(): TaskState[] {
    return [...LIVE_STATES];
  }
}
