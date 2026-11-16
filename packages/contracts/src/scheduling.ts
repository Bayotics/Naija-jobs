import { z } from 'zod';
import {
  STATUS_RANK,
  type ComponentHealth,
  type ComponentStatus,
} from './ops';

/**
 * The execution engine's contracts.
 *
 * This layer answers one question: how does a system that must run unattended
 * for months decide what to do next, and survive everything that will go wrong
 * while it does?
 *
 * Four commitments run through the whole design, and each rules out a simpler
 * thing that would have worked until it didn't.
 *
 * **At-least-once, never exactly-once.** A worker that finishes a task and dies
 * before recording that fact is indistinguishable from one that died mid-task.
 * No amount of protocol removes that ambiguity — it can only be moved. So the
 * engine guarantees a task runs *at least* once and every handler is required
 * to be idempotent. Pretending otherwise is how systems send duplicate emails.
 *
 * **Durability lives in the database, not in memory.** An in-process timer is a
 * schedule that a deploy silently deletes. Every scheduled task is a row, so a
 * restart resumes rather than forgets.
 *
 * **Leases, not locks.** A lock held by a dead worker is held forever. A lease
 * expires, which turns "the worker crashed" from an outage into a delay.
 *
 * **Bounded everything.** Retries, queue depth, discovery budgets, catch-up
 * after downtime: each has a ceiling, because the failure mode of an unbounded
 * anything is an outage that arrives at 3am and compounds.
 */

// ── Task types (Part 1) ─────────────────────────────────────────────────────

/**
 * Every kind of work the system performs.
 *
 * Explicit types rather than one generic task carrying a discriminator in its
 * payload. The difference is not cosmetic: type is what timeouts, priorities,
 * concurrency limits, retry policies and dashboards are all keyed on. A single
 * `PROCESS` task would make every one of those settings a payload inspection.
 */
export const TASK_TYPES = [
  'SEARCH_PROFILE_SCAN',
  'SOURCE_SCAN',
  'SOURCE_HEALTH_CHECK',
  'FETCH_JOB',
  'PARSE_JOB',
  'NORMALIZE_JOB',
  'DEDUPLICATE_JOB',
  'ENRICH_JOB',
  'MATCH_JOB',
  'APPLICATION_ANALYSIS',
  'NOTIFICATION_EVALUATION',
  'SEND_NOTIFICATION',
  'GENERATE_DIGEST',
  'UPDATE_ANALYTICS',
  'LEARNING_UPDATE',
  'CONFIGURATION_RECONCILIATION',
  'CLEANUP',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

// ── Task states (Part 3) ────────────────────────────────────────────────────

export const TASK_STATES = [
  'PENDING',
  'SCHEDULED',
  'READY',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'RETRYING',
  'CANCELLED',
  'DEAD_LETTER',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/**
 * Which transitions are legal.
 *
 * Encoded as data and checked on every write, because a state machine that
 * lives only in the heads of the people who wrote the callers is one PR away
 * from a task that is `COMPLETED` and also `PROCESSING`. The expensive
 * transitions to get wrong are the terminal ones: nothing leaves `COMPLETED`,
 * and only an explicit administrative action leaves `DEAD_LETTER`.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  PENDING: ['SCHEDULED', 'READY', 'CANCELLED'],
  SCHEDULED: ['READY', 'CANCELLED'],
  READY: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'FAILED', 'RETRYING', 'READY', 'CANCELLED'],
  RETRYING: ['READY', 'PROCESSING', 'CANCELLED', 'DEAD_LETTER'],
  FAILED: ['RETRYING', 'DEAD_LETTER', 'CANCELLED'],
  /*
   * `READY` is reachable from `PROCESSING` on purpose: that is lease expiry,
   * where a task whose worker vanished returns to the queue. It is the single
   * most important edge in this table — without it a crash loses work forever.
   */
  COMPLETED: [],
  CANCELLED: [],
  DEAD_LETTER: ['READY'],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** States in which a task is finished and will not run again on its own. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'COMPLETED',
  'CANCELLED',
  'DEAD_LETTER',
];

// ── Priority (Parts 8, 9) ───────────────────────────────────────────────────

export const TASK_PRIORITIES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Lower sorts first, so a plain `ORDER BY` claims the right task. */
export const TASK_PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

/**
 * Default priority per task type, overridable per task.
 *
 * The shape of this table is the scheduling policy: work a person is waiting on
 * outranks work that keeps the system tidy. `SEND_NOTIFICATION` is CRITICAL
 * because a deadline alert delivered late is worthless, while `UPDATE_ANALYTICS`
 * is LOW because nobody has ever needed a dashboard to be current to the second.
 */
export const DEFAULT_TASK_PRIORITY: Readonly<Record<TaskType, TaskPriority>> = {
  SEND_NOTIFICATION: 'CRITICAL',
  NOTIFICATION_EVALUATION: 'HIGH',
  SEARCH_PROFILE_SCAN: 'HIGH',
  SOURCE_SCAN: 'NORMAL',
  FETCH_JOB: 'NORMAL',
  PARSE_JOB: 'NORMAL',
  NORMALIZE_JOB: 'NORMAL',
  DEDUPLICATE_JOB: 'NORMAL',
  ENRICH_JOB: 'NORMAL',
  MATCH_JOB: 'NORMAL',
  APPLICATION_ANALYSIS: 'NORMAL',
  GENERATE_DIGEST: 'NORMAL',
  CONFIGURATION_RECONCILIATION: 'HIGH',
  SOURCE_HEALTH_CHECK: 'LOW',
  UPDATE_ANALYTICS: 'LOW',
  LEARNING_UPDATE: 'LOW',
  CLEANUP: 'LOW',
};

// ── Timeouts (Part 34) ──────────────────────────────────────────────────────

/**
 * How long each type may run before its lease is considered lost.
 *
 * Set from what the work actually does rather than from a single global number.
 * A source scan is bounded by network latency and a handful of pages; an
 * enrichment pass may call a model several times. One timeout covering both is
 * either too short for enrichment or long enough that a wedged scan sits for
 * five minutes before anyone notices.
 */
export const DEFAULT_TASK_TIMEOUT_MS: Readonly<Record<TaskType, number>> = {
  SOURCE_HEALTH_CHECK: 30_000,
  FETCH_JOB: 30_000,
  PARSE_JOB: 30_000,
  NORMALIZE_JOB: 30_000,
  DEDUPLICATE_JOB: 60_000,
  SEND_NOTIFICATION: 60_000,
  UPDATE_ANALYTICS: 60_000,
  CLEANUP: 120_000,
  CONFIGURATION_RECONCILIATION: 120_000,
  SOURCE_SCAN: 180_000,
  MATCH_JOB: 120_000,
  ENRICH_JOB: 300_000,
  APPLICATION_ANALYSIS: 300_000,
  NOTIFICATION_EVALUATION: 120_000,
  GENERATE_DIGEST: 180_000,
  LEARNING_UPDATE: 300_000,
  SEARCH_PROFILE_SCAN: 600_000,
};

/**
 * The lease is longer than the timeout, deliberately.
 *
 * A lease that expires exactly when a task times out means a healthy worker
 * finishing at the boundary races a reaper handing its task to someone else.
 * The margin makes that race impossible rather than merely unlikely.
 */
export const LEASE_MARGIN_MS = 60_000;

export function leaseDurationFor(type: TaskType, timeoutMs?: number): number {
  return (timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS[type]) + LEASE_MARGIN_MS;
}

// ── Failure classification (Part 23) ────────────────────────────────────────

export const FAILURE_CLASSES = [
  'TRANSIENT',
  'PERMANENT',
  'RATE_LIMITED',
  'AUTHENTICATION',
  'VALIDATION',
  'PARSING',
  'SECURITY',
  'UNKNOWN',
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * Which failures are worth trying again.
 *
 * The three `false` entries are the ones that matter. Retrying a validation
 * error re-runs identical input through identical code and fails identically.
 * Retrying an authentication failure hammers a provider with credentials it has
 * already rejected, which is how an expired token becomes a blocked account.
 * And retrying a security failure — a blocked SSRF target, a refused redirect —
 * is the system arguing with its own safety guard.
 *
 * `UNKNOWN` retries, but with the tightest budget: an unclassified error is more
 * often a transient thing nobody has named than a permanent one.
 */
export const RETRYABLE: Readonly<Record<FailureClass, boolean>> = {
  TRANSIENT: true,
  RATE_LIMITED: true,
  UNKNOWN: true,
  PARSING: false,
  VALIDATION: false,
  PERMANENT: false,
  AUTHENTICATION: false,
  SECURITY: false,
};

/** Attempts allowed per class. Zero means the first failure is final. */
export const MAX_ATTEMPTS: Readonly<Record<FailureClass, number>> = {
  TRANSIENT: 5,
  RATE_LIMITED: 8,
  UNKNOWN: 3,
  PARSING: 1,
  VALIDATION: 1,
  PERMANENT: 1,
  AUTHENTICATION: 1,
  SECURITY: 1,
};

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20).default(5),
  baseDelayMs: z.number().int().min(100).max(3_600_000).default(30_000),
  /** Each attempt multiplies the delay by this. */
  factor: z.number().min(1).max(10).default(2),
  maxDelayMs: z.number().int().min(1_000).max(86_400_000).default(600_000),
  /**
   * Randomisation, as a fraction of the computed delay.
   *
   * Without jitter, fifty tasks that failed together retry together — the
   * thundering herd that turns one brief outage into a repeating one. This is
   * the cheapest insurance in the whole engine.
   */
  jitter: z.number().min(0).max(1).default(0.3),
});

export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = retryPolicySchema.parse({});

/**
 * When to try again.
 *
 * Exponential with full-range jitter, capped. `retryAfterMs` — from a
 * `Retry-After` header — always wins when it is longer than our own backoff,
 * because a source that has told us how long to wait has given us information
 * we do not otherwise have, and second-guessing it downward is how a client
 * gets banned.
 */
export function nextRetryDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  options: { retryAfterMs?: number | null; random?: () => number } = {},
): number {
  const random = options.random ?? Math.random;

  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * Math.pow(policy.factor, Math.max(0, attempt - 1)),
  );

  const jitterRange = exponential * policy.jitter;
  const jittered = Math.round(exponential - jitterRange / 2 + random() * jitterRange);

  const backoff = Math.max(policy.baseDelayMs / 2, jittered);

  if (options.retryAfterMs && options.retryAfterMs > backoff) {
    /*
     * Honoured even beyond `maxDelayMs`. The cap exists to stop *our* backoff
     * running away; it is not a licence to ignore a source that asked for an
     * hour.
     */
    return options.retryAfterMs;
  }

  return backoff;
}

// ── Task entity (Part 2) ────────────────────────────────────────────────────

export const taskSchema = z.object({
  taskId: z.string().uuid(),
  type: z.enum(TASK_TYPES),
  status: z.enum(TASK_STATES).default('READY'),
  priority: z.enum(TASK_PRIORITIES).default('NORMAL'),

  /**
   * The natural key for this unit of work (Part 4).
   *
   * Two enqueues of the same logical task collapse to one row, enforced by a
   * unique index rather than by a check-then-insert. That distinction is the
   * whole point: the check-then-insert version loses the race between two
   * scheduler instances, which is precisely the case idempotency exists for.
   */
  idempotencyKey: z.string().min(1).max(300),

  payload: z.record(z.string(), z.unknown()).default({}),

  /** Denormalised for fair scheduling, filtering and the dashboard. */
  profileId: z.string().uuid().nullable().default(null),
  sourceId: z.string().max(120).nullable().default(null),
  jobId: z.string().uuid().nullable().default(null),

  attempts: z.number().int().min(0).default(0),
  maxAttempts: z.number().int().min(1).max(20).default(5),

  scheduledAt: z.coerce.date().nullable().default(null),
  /** Not claimable before this. Retry backoff moves it forward. */
  availableAt: z.coerce.date().default(() => new Date()),
  startedAt: z.coerce.date().nullable().default(null),
  completedAt: z.coerce.date().nullable().default(null),
  failedAt: z.coerce.date().nullable().default(null),

  lockedAt: z.coerce.date().nullable().default(null),
  lockedBy: z.string().max(120).nullable().default(null),
  /** When the lease lapses and another worker may reclaim the task. */
  leaseExpiresAt: z.coerce.date().nullable().default(null),

  lastError: z.string().max(2_000).nullable().default(null),
  lastFailureClass: z.enum(FAILURE_CLASSES).nullable().default(null),

  timeoutMs: z.number().int().min(1_000).max(3_600_000).nullable().default(null),
  traceId: z.string().max(120).nullable().default(null),

  createdAt: z.coerce.date().default(() => new Date()),
  updatedAt: z.coerce.date().default(() => new Date()),
});

export type Task = z.infer<typeof taskSchema>;

/**
 * Builds an idempotency key from its parts.
 *
 * Deliberately readable — `SOURCE_SCAN:reddit:2026-08-21T13` rather than a
 * hash. When a duplicate is suppressed, the operator needs to see *which*
 * duplicate, and an opaque key turns a two-second diagnosis into an
 * archaeology exercise.
 */
export function idempotencyKey(
  type: TaskType,
  parts: ReadonlyArray<string | null | undefined>,
): string {
  const suffix = parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(':');

  return `${type}${suffix ? `:${suffix}` : ''}`.slice(0, 300);
}

/**
 * The window a recurring task belongs to, at minute granularity.
 *
 * This is what makes "scan Reddit hourly" idempotent: every enqueue inside the
 * same hour produces the same key, so a scheduler that ticks every thirty
 * seconds creates one task rather than a hundred and twenty.
 */
export function scanWindow(at: Date, intervalMinutes: number): string {
  const minutes = Math.max(1, intervalMinutes);
  const epochMinutes = Math.floor(at.getTime() / 60_000);
  const windowStart = Math.floor(epochMinutes / minutes) * minutes;

  return new Date(windowStart * 60_000).toISOString().slice(0, 16);
}

// ── Workers (Parts 30, 31) ──────────────────────────────────────────────────

export const WORKER_STATES = [
  'STARTING',
  'IDLE',
  'BUSY',
  'DRAINING',
  'UNHEALTHY',
  'STOPPED',
] as const;

export type WorkerState = (typeof WORKER_STATES)[number];

export const workerRegistrationSchema = z.object({
  workerId: z.string().min(1).max(120),
  /** Which task types this worker will claim. Empty means all of them. */
  taskTypes: z.array(z.enum(TASK_TYPES)).default([]),
  version: z.string().max(40).default('0.0.0'),
  hostname: z.string().max(200).default('unknown'),
  pid: z.number().int().nonnegative().default(0),

  state: z.enum(WORKER_STATES).default('STARTING'),
  currentTaskId: z.string().uuid().nullable().default(null),

  concurrency: z.number().int().min(1).max(256).default(4),
  tasksProcessed: z.number().int().nonnegative().default(0),
  tasksFailed: z.number().int().nonnegative().default(0),

  startedAt: z.coerce.date().default(() => new Date()),
  lastHeartbeatAt: z.coerce.date().default(() => new Date()),
});

export type WorkerRegistration = z.infer<typeof workerRegistrationSchema>;

/**
 * A worker silent for this long is presumed dead.
 *
 * Three missed heartbeats rather than one. A single missed beat is a garbage
 * collection pause or a slow query; treating that as death would recycle
 * healthy workers under exactly the load that made them slow.
 */
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKER_STALE_AFTER_MS = WORKER_HEARTBEAT_INTERVAL_MS * 3;

// ── Scheduling (Parts 11–16, 40, 41) ────────────────────────────────────────

/**
 * What to do about runs missed while the system was down (Part 15).
 *
 * `RUN_ONCE` is the default and the only sane one for job discovery. A profile
 * paused for three days has missed seventy-two hourly scans, and running them
 * all would produce seventy-two identical scans of the same sources — the
 * postings do not come back in seventy-two batches, they are simply there now.
 */
export const MISFIRE_POLICIES = ['SKIP', 'RUN_ONCE', 'CATCH_UP_LIMITED'] as const;
export type MisfirePolicy = (typeof MISFIRE_POLICIES)[number];

export const scheduleEntrySchema = z.object({
  scheduleId: z.string().uuid(),
  /** What this schedule produces when it fires. */
  taskType: z.enum(TASK_TYPES),

  profileId: z.string().uuid().nullable().default(null),
  sourceId: z.string().max(120).nullable().default(null),

  intervalMinutes: z.number().int().min(1).max(43_200),
  /** IANA zone. Schedules are stored in UTC and rendered in this. */
  timezone: z.string().max(80).default('UTC'),

  enabled: z.boolean().default(true),
  misfirePolicy: z.enum(MISFIRE_POLICIES).default('RUN_ONCE'),
  /** Ceiling on catch-up runs, honoured only by `CATCH_UP_LIMITED`. */
  maxCatchUpRuns: z.number().int().min(1).max(24).default(3),

  priority: z.enum(TASK_PRIORITIES).default('NORMAL'),

  nextRunAt: z.coerce.date().nullable().default(null),
  lastRunAt: z.coerce.date().nullable().default(null),
  lastSuccessfulRunAt: z.coerce.date().nullable().default(null),
  lastFailureAt: z.coerce.date().nullable().default(null),

  pausedUntil: z.coerce.date().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;

export interface MisfireDecision {
  runsToEnqueue: number;
  nextRunAt: Date;
  /** Missed runs deliberately not run, for the dashboard. */
  skipped: number;
  reason: string;
}

/**
 * How many runs to fire after a gap, and when to run next.
 *
 * The arithmetic matters less than the ceiling. A profile that has been paused
 * for a month has missed seven hundred runs; every policy here refuses to
 * enqueue seven hundred tasks, and they differ only in whether the answer is
 * zero, one, or a small handful.
 */
export function resolveMisfire(
  entry: ScheduleEntry,
  now: Date,
): MisfireDecision {
  const intervalMs = entry.intervalMinutes * 60_000;

  const next = (from: Date): Date => new Date(from.getTime() + intervalMs);

  if (!entry.nextRunAt) {
    return {
      runsToEnqueue: 1,
      nextRunAt: next(now),
      skipped: 0,
      reason: 'First run for this schedule.',
    };
  }

  if (entry.nextRunAt > now) {
    return { runsToEnqueue: 0, nextRunAt: entry.nextRunAt, skipped: 0, reason: 'Not due yet.' };
  }

  const missed = Math.floor((now.getTime() - entry.nextRunAt.getTime()) / intervalMs);

  /*
   * The next run is computed forward from *now*, not from the stale
   * `nextRunAt`. Advancing by one interval from a timestamp three days old
   * would leave the schedule still overdue, and it would fire again on the very
   * next tick — a catch-up storm assembled one tick at a time.
   */
  const aligned = next(now);

  if (missed === 0) {
    return { runsToEnqueue: 1, nextRunAt: aligned, skipped: 0, reason: 'Due now.' };
  }

  switch (entry.misfirePolicy) {
    case 'SKIP':
      return {
        runsToEnqueue: 0,
        nextRunAt: aligned,
        skipped: missed,
        reason: `Skipped ${missed} missed run(s); waiting for the next scheduled time.`,
      };

    case 'CATCH_UP_LIMITED': {
      const runs = Math.min(missed, entry.maxCatchUpRuns);
      return {
        runsToEnqueue: runs,
        nextRunAt: aligned,
        skipped: missed - runs,
        reason: `Catching up ${runs} of ${missed} missed run(s).`,
      };
    }

    case 'RUN_ONCE':
    default:
      return {
        runsToEnqueue: 1,
        nextRunAt: aligned,
        skipped: missed - 1,
        reason:
          missed > 1
            ? `Missed ${missed} runs; running once rather than replaying them.`
            : 'Due now.',
      };
  }
}

// ── Concurrency and rate limits (Parts 17–20) ───────────────────────────────

export const concurrencyLimitsSchema = z.object({
  global: z.number().int().min(1).max(1_000).default(50),
  perSource: z.number().int().min(1).max(100).default(4),
  perDomain: z.number().int().min(1).max(100).default(4),
  perProfile: z.number().int().min(1).max(100).default(8),
  perType: z.record(z.string(), z.number().int().min(1).max(500)).default({}),
});

export type ConcurrencyLimits = z.infer<typeof concurrencyLimitsSchema>;

export const DEFAULT_CONCURRENCY: ConcurrencyLimits = concurrencyLimitsSchema.parse({});

/**
 * Global external-request ceiling (Part 19).
 *
 * Sits above every per-source limiter. Twenty sources each correctly observing
 * their own limit still add up to a number the machine, the database and the
 * network have opinions about.
 */
export const globalRateLimitSchema = z.object({
  requestsPerMinute: z.number().int().min(1).max(100_000).default(1_000),
  burst: z.number().int().min(1).max(10_000).default(100),
});

export type GlobalRateLimit = z.infer<typeof globalRateLimitSchema>;

// ── Backpressure (Parts 21, 22) ─────────────────────────────────────────────

export const backpressureSchema = z.object({
  /** Above this depth, low-priority enqueues are refused. */
  softLimit: z.number().int().min(10).max(1_000_000).default(5_000),
  /** Above this, only CRITICAL work is accepted. */
  hardLimit: z.number().int().min(10).max(1_000_000).default(20_000),
  /** Per-profile ceiling, so one profile cannot fill the queue. */
  perProfileLimit: z.number().int().min(10).max(100_000).default(2_000),
});

export type BackpressureConfig = z.infer<typeof backpressureSchema>;

export const DEFAULT_BACKPRESSURE: BackpressureConfig = backpressureSchema.parse({});

export interface BackpressureDecision {
  accept: boolean;
  reason: string;
  /** True when the caller should slow down but the task was still accepted. */
  degraded: boolean;
}

/**
 * Whether to accept one more task.
 *
 * Priority-aware rather than a flat cap, because the point of backpressure is
 * not to stop working — it is to stop doing *unimportant* work while important
 * work waits. A queue at its hard limit still accepts a deadline notification.
 */
export function evaluateBackpressure(
  input: {
    queueDepth: number;
    profileDepth?: number;
    priority: TaskPriority;
  },
  config: BackpressureConfig = DEFAULT_BACKPRESSURE,
): BackpressureDecision {
  if (input.priority === 'CRITICAL') {
    return {
      accept: true,
      reason: 'Critical work is never shed.',
      degraded: input.queueDepth >= config.softLimit,
    };
  }

  if (
    input.profileDepth !== undefined &&
    input.profileDepth >= config.perProfileLimit
  ) {
    return {
      accept: false,
      reason: `This profile already has ${input.profileDepth} queued tasks (limit ${config.perProfileLimit}).`,
      degraded: true,
    };
  }

  if (input.queueDepth >= config.hardLimit) {
    return {
      accept: false,
      reason: `Queue depth ${input.queueDepth} is at the hard limit; only critical work is accepted.`,
      degraded: true,
    };
  }

  if (input.queueDepth >= config.softLimit && input.priority === 'LOW') {
    return {
      accept: false,
      reason: `Queue depth ${input.queueDepth} is above the soft limit; low-priority work is deferred.`,
      degraded: true,
    };
  }

  return {
    accept: true,
    reason: 'Accepted.',
    degraded: input.queueDepth >= config.softLimit,
  };
}

/*
 * Per-scan budgets (Part 42).
 *
 * Distinct from `discoveryBudgetSchema` in `discovery-framework.ts`, which caps
 * a whole cycle's spend across every source. This one bounds a *single* scan,
 * and both are needed: the cycle budget stops a month's quota disappearing in
 * an afternoon, and this one stops one runaway source consuming the cycle.
 */

export const scanBudgetSchema = z.object({
  maxQueries: z.number().int().min(1).max(500).default(20),
  maxPages: z.number().int().min(1).max(1_000).default(40),
  maxRequests: z.number().int().min(1).max(5_000).default(200),
  maxDurationMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
  maxResults: z.number().int().min(1).max(50_000).default(1_000),
});

export type ScanBudget = z.infer<typeof scanBudgetSchema>;

export const DEFAULT_SCAN_BUDGET: ScanBudget = scanBudgetSchema.parse({});

// ── Adaptive scanning (Parts 43, 44) ────────────────────────────────────────

export interface AdaptiveInterval {
  intervalMinutes: number;
  reason: string;
  /** True when the configured interval was left alone. */
  atConfiguredRate: boolean;
}

/**
 * Adjusts a scan interval from observed yield.
 *
 * Bounded in one direction only, and that asymmetry is the requirement: the
 * configured interval is a *maximum frequency* the user set, so this may slow a
 * source down but must never speed it past what was asked for. Part 43 is
 * explicit that adaptive behaviour is advisory and must not silently override
 * configuration.
 */
export function adaptInterval(
  configuredMinutes: number,
  signals: { emptyScans: number; freshJobsLastScan: number; healthScore: number },
  options: { maxSlowdownFactor?: number } = {},
): AdaptiveInterval {
  const maxFactor = options.maxSlowdownFactor ?? 8;

  if (signals.freshJobsLastScan > 0) {
    return {
      intervalMinutes: configuredMinutes,
      reason: `Produced ${signals.freshJobsLastScan} fresh job(s) last scan; running at the configured rate.`,
      atConfiguredRate: true,
    };
  }

  if (signals.healthScore < 30) {
    return {
      intervalMinutes: Math.min(configuredMinutes * maxFactor, configuredMinutes * 4),
      reason: `Health score ${signals.healthScore}; backing off while it recovers.`,
      atConfiguredRate: false,
    };
  }

  if (signals.emptyScans < 3) {
    return {
      intervalMinutes: configuredMinutes,
      reason: 'Too few empty scans to justify slowing down.',
      atConfiguredRate: true,
    };
  }

  /*
   * Doubling per three empty scans, capped. Gentle on purpose: a source that
   * publishes weekly should not be pushed to a monthly cadence by four quiet
   * days, because the cost of scanning it is one request.
   */
  const factor = Math.min(maxFactor, Math.pow(2, Math.floor(signals.emptyScans / 3)));

  return {
    intervalMinutes: Math.round(configuredMinutes * factor),
    reason: `${signals.emptyScans} consecutive empty scans; slowing to ${factor}× the configured interval.`,
    atConfiguredRate: false,
  };
}

// ── System health (Part 49) ─────────────────────────────────────────────────

/*
 * Health uses the ops vocabulary (`componentHealthSchema`, `COMPONENT_STATUSES`)
 * rather than introducing a second one. Two health enums would mean two
 * dashboards that disagree about what "degraded" means, and the operator
 * reading them would have to know which was which.
 */
export interface HealthRollup {
  status: ComponentStatus;
  summary: string;
  components: ComponentHealth[];
  checkedAt: Date;
}

/**
 * Rolls component health into one status and one sentence.
 *
 * The sentence is the deliverable. "System degraded" tells an operator to go
 * looking; "System degraded: Reddit connector authentication expired" tells
 * them what to do, and the difference is the twenty minutes they would spend
 * finding out which of nine components is unhappy.
 */
export function rollUpHealth(
  components: ComponentHealth[],
  now: Date = new Date(),
): HealthRollup {
  if (components.length === 0) {
    return { status: 'unknown', summary: 'No components reported.', components, checkedAt: now };
  }

  const worst = components.reduce<ComponentStatus>(
    (highest, entry) =>
      STATUS_RANK[entry.status] > STATUS_RANK[highest]
        ? entry.status
        : highest,
    'healthy',
  );

  /*
   * Only the components at the worst level are named.
   *
   * Listing every degraded component alongside the one that is down buries the
   * thing that actually needs attention in a paragraph.
   */
  const offenders = components.filter((entry) => entry.status === worst);

  if (worst === 'healthy') {
    return { status: 'healthy', summary: 'All components healthy.', components, checkedAt: now };
  }

  const label = worst === 'down' ? 'System unhealthy' : worst === 'degraded' ? 'System degraded' : 'System status unknown';

  return {
    status: worst,
    summary: `${label}: ${offenders.map((entry) => entry.detail).join('; ')}`.slice(0, 400),
    components,
    checkedAt: now,
  };
}
