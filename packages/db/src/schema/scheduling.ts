import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The durable execution engine.
 *
 * Postgres rather than Redis, and the choice is deliberate rather than
 * expedient. This system already requires Postgres and does not require Redis;
 * adding a second stateful dependency to run a queue would double the number of
 * things that can be down at 3am in exchange for throughput this workload — a
 * few thousand tasks an hour — does not need.
 *
 * `SELECT … FOR UPDATE SKIP LOCKED` gives the properties that matter: atomic
 * claim across any number of workers, no polling contention, and a queue that
 * survives a restart because it was never anywhere else. When throughput
 * eventually justifies Redis, the interface above these tables does not change.
 *
 * The BullMQ port from prompt 2 is untouched and still serves the stage
 * pipeline. This is the *scheduling* engine, which is a different problem:
 * BullMQ is excellent at moving work between stages and has no opinion about
 * whether a search profile is due.
 */

/**
 * One unit of work.
 *
 * The lease columns — `locked_by`, `locked_at`, `lease_expires_at` — are what
 * make worker death survivable. A row whose lease has lapsed is claimable
 * again, so a crashed worker costs a delay rather than a lost task, and no
 * external supervisor has to notice anything.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    status: text('status').notNull().default('READY'),
    priority: text('priority').notNull().default('NORMAL'),
    /** Denormalised from priority so ORDER BY needs no CASE expression. */
    priorityRank: integer('priority_rank').notNull().default(2),

    /**
     * The natural key for this work.
     *
     * Unique among live tasks, which is what collapses a duplicate enqueue to a
     * no-op. Enforced by the index below rather than by a check-then-insert,
     * because the case this exists for — two schedulers ticking at once — is
     * exactly the case a check-then-insert loses.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    payload: jsonb('payload').notNull().default({}),

    profileId: uuid('profile_id'),
    sourceId: text('source_id'),
    jobId: uuid('job_id'),

    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),

    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    /** Not claimable before this. Retry backoff pushes it forward. */
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),

    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),

    lastError: text('last_error'),
    lastFailureClass: text('last_failure_class'),

    timeoutMs: integer('timeout_ms'),
    traceId: text('trace_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * Idempotency, scoped to live tasks only.
     *
     * A partial index rather than a plain unique constraint: yesterday's
     * completed hourly scan must not block today's. Without the `WHERE`, the
     * first successful run of any recurring task would permanently prevent the
     * next one — the constraint would be enforcing "run this once, ever".
     */
    uniqueIndex('tasks_idempotency_live_unique')
      .on(t.idempotencyKey)
      .where(
        sql`${t.status} IN ('PENDING','SCHEDULED','READY','PROCESSING','RETRYING','FAILED')`,
      ),

    /*
     * The claim index.
     *
     * Column order mirrors the claim query exactly — filter on status, order by
     * priority then availability. A different order turns every claim into a
     * sort of the whole ready set, which is the difference between a queue that
     * scales and one that degrades as it fills.
     */
    index('tasks_claim_idx').on(t.status, t.priorityRank, t.availableAt),
    index('tasks_lease_idx').on(t.status, t.leaseExpiresAt),
    index('tasks_profile_idx').on(t.profileId, t.status),
    index('tasks_source_idx').on(t.sourceId, t.status),
    index('tasks_type_idx').on(t.type, t.status),
  ],
);

/**
 * Tasks that exhausted their retries.
 *
 * A separate table rather than a status on `tasks`, for two reasons. The live
 * queue stays small and its indexes stay hot, and dead letters need to be kept
 * far longer than completed tasks — the whole value of a dead-letter queue is
 * being able to ask in a fortnight what went wrong.
 */
export const taskDeadLetters = pgTable(
  'task_dead_letters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull(),

    type: text('type').notNull(),
    priority: text('priority').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').notNull().default({}),

    profileId: uuid('profile_id'),
    sourceId: text('source_id'),
    jobId: uuid('job_id'),

    attempts: integer('attempts').notNull().default(0),
    /** Every failure, not only the last — the pattern is the diagnosis. */
    errors: jsonb('errors').notNull().default([]),
    lastError: text('last_error'),
    lastFailureClass: text('last_failure_class'),
    lastWorkerId: text('last_worker_id'),

    firstFailedAt: timestamp('first_failed_at', { withTimezone: true }),
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }).notNull().defaultNow(),

    /** Set when an administrator sends it back to the queue. */
    retriedAt: timestamp('retried_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('task_dead_letters_task_unique').on(t.taskId),
    index('task_dead_letters_type_idx').on(t.type, t.deadLetteredAt),
    index('task_dead_letters_source_idx').on(t.sourceId),
  ],
);

/**
 * Live workers.
 *
 * A row per process, refreshed by heartbeat. Its purpose is not bookkeeping: a
 * worker whose heartbeat has stopped is how the system knows to reclaim leases
 * before they expire naturally, which shortens a crash from minutes to seconds.
 */
export const workers = pgTable(
  'workers',
  {
    id: text('id').primaryKey(),
    taskTypes: jsonb('task_types').notNull().default([]),
    version: text('version').notNull().default('0.0.0'),
    hostname: text('hostname').notNull().default('unknown'),
    pid: integer('pid').notNull().default(0),

    state: text('state').notNull().default('STARTING'),
    currentTaskId: uuid('current_task_id'),
    concurrency: integer('concurrency').notNull().default(4),

    tasksProcessed: integer('tasks_processed').notNull().default(0),
    tasksFailed: integer('tasks_failed').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
  },
  (t) => [index('workers_heartbeat_idx').on(t.state, t.lastHeartbeatAt)],
);

/**
 * Persistent schedules.
 *
 * The row *is* the schedule. An in-process timer is a schedule that a deploy
 * silently deletes, and the symptom — discovery quietly stopping after a
 * release — is invisible until someone notices no new jobs for a day.
 */
export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskType: text('task_type').notNull(),

    profileId: uuid('profile_id'),
    sourceId: text('source_id'),

    intervalMinutes: integer('interval_minutes').notNull(),
    timezone: text('timezone').notNull().default('UTC'),

    enabled: boolean('enabled').notNull().default(true),
    misfirePolicy: text('misfire_policy').notNull().default('RUN_ONCE'),
    maxCatchUpRuns: integer('max_catch_up_runs').notNull().default(3),
    priority: text('priority').notNull().default('NORMAL'),

    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastSuccessfulRunAt: timestamp('last_successful_run_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    pausedUntil: timestamp('paused_until', { withTimezone: true }),

    payload: jsonb('payload').notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * One schedule per (type, profile, source).
     *
     * `COALESCE` because Postgres treats NULLs as distinct in a unique index,
     * so a plain constraint would happily allow ten `CLEANUP` schedules with no
     * profile and no source. Reconciliation runs repeatedly and must converge
     * rather than accumulate.
     */
    uniqueIndex('schedules_target_unique').on(
      t.taskType,
      sql`coalesce(${t.profileId}::text, '')`,
      sql`coalesce(${t.sourceId}, '')`,
    ),
    index('schedules_due_idx').on(t.enabled, t.nextRunAt),
  ],
);

/**
 * Coordination locks (Part 39).
 *
 * Leader election for the scheduler, and mutual exclusion for anything else
 * that must run in one place at a time. A lease rather than a lock, for the
 * same reason tasks use one: a leader that dies holding a permanent lock stops
 * the system until a human intervenes.
 */
export const coordinationLeases = pgTable('coordination_leases', {
  /** The thing being coordinated: `scheduler`, `reaper`, … */
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  renewedAt: timestamp('renewed_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** Incremented on every acquisition, so leadership changes are visible. */
  fencingToken: integer('fencing_token').notNull().default(0),
});

/**
 * Token buckets, shared across workers.
 *
 * In-process limiters cannot answer the question that matters once there is
 * more than one worker: "have *we*, collectively, exceeded this source's
 * limit?" Three workers each politely observing ten requests a minute make
 * thirty. The bucket is a row so every worker draws from the same allowance.
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    /** `source:reddit`, `domain:example.com`, `global`. */
    key: text('key').primaryKey(),
    tokens: integer('tokens').notNull(),
    capacity: integer('capacity').notNull(),
    /** Tokens added per second, stored ×1000 to stay integral. */
    refillMilliPerSecond: integer('refill_milli_per_second').notNull(),
    lastRefillAt: timestamp('last_refill_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set from a `Retry-After`; no tokens are issued before it. */
    blockedUntil: timestamp('blocked_until', { withTimezone: true }),
  },
  (t) => [index('rate_limit_blocked_idx').on(t.blockedUntil)],
);
