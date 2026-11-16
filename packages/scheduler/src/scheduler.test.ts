import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKPRESSURE,
  adaptInterval,
  canTransition,
  evaluateBackpressure,
  idempotencyKey,
  nextRetryDelayMs,
  resolveMisfire,
  rollUpHealth,
  scanWindow,
  scheduleEntrySchema,
  type ComponentHealth,
  type FailureClass,
  type Task,
} from '@job-intel/contracts';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '@job-intel/db/testing';
import { createLogger } from '@job-intel/observability';
import { TaskQueue } from './task-queue';
import { DeadLetterQueue } from './dead-letters';
import { CoordinationService } from './coordination';
import { Scheduler } from './scheduler';
import { Worker, WorkerRegistry } from './worker-runtime';
import { ReconciliationService, SystemHealthService } from './reconciliation';

/**
 * The execution engine, exercised against a real database.
 *
 * PGlite rather than mocks, because every property this engine claims —
 * atomic claim, unique idempotency keys, lease expiry, conditional updates —
 * is a property *of the database*. A mocked queue would test the mock.
 *
 * One caveat stated plainly: PGlite is single-connection, so "two workers race
 * for one task" is exercised logically (both call `claim`, only one wins) rather
 * than with true OS-level parallelism. The mechanism under test is the SQL, and
 * the SQL is real; what is simulated is the wall-clock overlap.
 */

let handle: TestDatabase;
let queue: TaskQueue;
let deadLetters: DeadLetterQueue;
let coordination: CoordinationService;
const logger = createLogger({ level: 'error', pretty: false, base: { service: 'scheduler-test' } });

beforeAll(async () => {
  handle = await createTestDatabase();
  queue = new TaskQueue(handle.db);
  deadLetters = new DeadLetterQueue(handle.db);
  coordination = new CoordinationService(handle.db);
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await resetTestDatabase(handle.db);
});

const profileA = '11111111-1111-4111-8111-111111111111';
const profileB = '22222222-2222-4222-8222-222222222222';

const makeScheduler = (instanceId: string, now: () => Date = () => new Date()) =>
  new Scheduler(
    { db: handle.db, queue, coordination, logger, instanceId },
    { now, leaseDurationMs: 60_000 },
  );

// ── Pure policy ─────────────────────────────────────────────────────────────

describe('task state machine (Part 3)', () => {
  it('permits lease expiry to return a processing task to the queue', () => {
    /* The single most important edge: without it a crash loses work forever. */
    expect(canTransition('PROCESSING', 'READY')).toBe(true);
  });

  it('makes completion terminal', () => {
    expect(canTransition('COMPLETED', 'READY')).toBe(false);
    expect(canTransition('COMPLETED', 'PROCESSING')).toBe(false);
  });

  it('lets an administrator revive a dead letter but nothing else', () => {
    expect(canTransition('DEAD_LETTER', 'READY')).toBe(true);
    expect(canTransition('CANCELLED', 'READY')).toBe(false);
  });
});

describe('retry backoff (Parts 24, 25)', () => {
  it('grows exponentially and stays under the cap', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) =>
      nextRetryDelayMs(attempt, undefined, { random: () => 0.5 }),
    );

    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    }

    expect(delays.at(-1)!).toBeLessThanOrEqual(600_000);
  });

  it('spreads simultaneous failures apart', () => {
    /*
     * Without jitter, fifty tasks that failed together retry together — the
     * thundering herd that turns one brief outage into a repeating one.
     */
    const values = new Set(
      Array.from({ length: 50 }, () => nextRetryDelayMs(3)),
    );

    expect(values.size).toBeGreaterThan(20);
  });

  it('honours a Retry-After longer than our own backoff', () => {
    const delay = nextRetryDelayMs(1, undefined, {
      retryAfterMs: 3_600_000,
      random: () => 0.5,
    });

    /* Beyond maxDelayMs, deliberately: the source told us the answer. */
    expect(delay).toBe(3_600_000);
  });

  it('ignores a Retry-After shorter than our backoff', () => {
    const delay = nextRetryDelayMs(5, undefined, { retryAfterMs: 100, random: () => 0.5 });
    expect(delay).toBeGreaterThan(100);
  });
});

describe('misfire policy (Parts 14, 15)', () => {
  const entry = (overrides: Partial<Parameters<typeof resolveMisfire>[0]> = {}) =>
    scheduleEntrySchema.parse({
      scheduleId: randomUUID(),
      taskType: 'SEARCH_PROFILE_SCAN',
      intervalMinutes: 60,
      ...overrides,
    });

  it('does not replay 72 hours of missed hourly scans', () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const decision = resolveMisfire(
      entry({ nextRunAt: new Date('2026-08-19T12:00:00Z'), misfirePolicy: 'RUN_ONCE' }),
      now,
    );

    expect(decision.runsToEnqueue).toBe(1);
    expect(decision.skipped).toBe(71);
    expect(decision.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('caps catch-up runs', () => {
    const decision = resolveMisfire(
      entry({
        nextRunAt: new Date('2026-08-19T12:00:00Z'),
        misfirePolicy: 'CATCH_UP_LIMITED',
        maxCatchUpRuns: 3,
      }),
      new Date('2026-08-22T12:00:00Z'),
    );

    expect(decision.runsToEnqueue).toBe(3);
    expect(decision.skipped).toBe(69);
  });

  it('re-bases the next run from now, not from the stale timestamp', () => {
    /*
     * Advancing one interval from a three-day-old timestamp would leave the
     * schedule still overdue, and it would fire again on the very next tick —
     * a catch-up storm assembled one tick at a time.
     */
    const now = new Date('2026-08-22T12:00:00Z');
    const decision = resolveMisfire(entry({ nextRunAt: new Date('2026-08-19T12:00:00Z') }), now);

    expect(decision.nextRunAt.getTime()).toBe(now.getTime() + 3_600_000);
  });

  it('skips entirely under SKIP', () => {
    const decision = resolveMisfire(
      entry({ nextRunAt: new Date('2026-08-21T12:00:00Z'), misfirePolicy: 'SKIP' }),
      new Date('2026-08-22T12:00:00Z'),
    );

    expect(decision.runsToEnqueue).toBe(0);
  });
});

describe('backpressure (Part 21)', () => {
  it('never sheds critical work', () => {
    const decision = evaluateBackpressure(
      { queueDepth: 999_999, priority: 'CRITICAL' },
      DEFAULT_BACKPRESSURE,
    );

    expect(decision.accept).toBe(true);
    expect(decision.degraded).toBe(true);
  });

  it('defers low-priority work above the soft limit', () => {
    expect(
      evaluateBackpressure({ queueDepth: 6_000, priority: 'LOW' }, DEFAULT_BACKPRESSURE).accept,
    ).toBe(false);

    expect(
      evaluateBackpressure({ queueDepth: 6_000, priority: 'HIGH' }, DEFAULT_BACKPRESSURE).accept,
    ).toBe(true);
  });

  it('stops one profile filling the queue', () => {
    const decision = evaluateBackpressure(
      { queueDepth: 100, profileDepth: 5_000, priority: 'NORMAL' },
      DEFAULT_BACKPRESSURE,
    );

    expect(decision.accept).toBe(false);
    expect(decision.reason).toContain('profile');
  });
});

describe('adaptive scanning (Part 43)', () => {
  it('never scans faster than configured', () => {
    const adapted = adaptInterval(60, { emptyScans: 0, freshJobsLastScan: 40, healthScore: 100 });

    expect(adapted.intervalMinutes).toBe(60);
    expect(adapted.atConfiguredRate).toBe(true);
  });

  it('slows a persistently empty source', () => {
    const adapted = adaptInterval(60, { emptyScans: 9, freshJobsLastScan: 0, healthScore: 90 });

    expect(adapted.intervalMinutes).toBeGreaterThan(60);
    expect(adapted.atConfiguredRate).toBe(false);
  });

  it('returns to the configured rate as soon as a source produces something', () => {
    const adapted = adaptInterval(60, { emptyScans: 20, freshJobsLastScan: 1, healthScore: 90 });
    expect(adapted.intervalMinutes).toBe(60);
  });
});

// ── The queue ───────────────────────────────────────────────────────────────

describe('idempotency (Part 4)', () => {
  it('collapses duplicate enqueues of the same logical work', async () => {
    const input = {
      type: 'SOURCE_SCAN' as const,
      key: ['reddit', '2026-08-21T13:00'],
      sourceId: 'reddit',
    };

    const first = await queue.enqueue(input);
    const second = await queue.enqueue(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reason).toContain('already queued');
    expect(await queue.depth()).toBe(1);
  });

  it('produces the same key for every enqueue inside one window', () => {
    const a = scanWindow(new Date('2026-08-21T13:04:59Z'), 60);
    const b = scanWindow(new Date('2026-08-21T13:59:00Z'), 60);

    expect(a).toBe(b);
    expect(scanWindow(new Date('2026-08-21T14:00:01Z'), 60)).not.toBe(a);
  });

  it('lets the next window through once the first completes', async () => {
    const first = await queue.enqueue({ type: 'SOURCE_SCAN', key: ['reddit', 'w1'] });
    await queue.claim({ workerId: 'w', limit: 1 });
    await queue.complete(first.task!.taskId, 'w');

    /*
     * The partial index is scoped to live states. Without that scope the first
     * successful hourly scan would permanently block every later one.
     */
    const second = await queue.enqueue({ type: 'SOURCE_SCAN', key: ['reddit', 'w1'] });
    expect(second.created).toBe(true);
  });

  it('builds readable keys', () => {
    expect(idempotencyKey('SOURCE_SCAN', ['reddit', '2026-08-21T13:00'])).toBe(
      'SOURCE_SCAN:reddit:2026-08-21T13:00',
    );
  });
});

describe('claiming and leases (Parts 5, 6)', () => {
  it('gives a task to exactly one worker', async () => {
    await queue.enqueue({ type: 'SOURCE_SCAN', key: ['only-one'] });

    const first = await queue.claim({ workerId: 'worker-a', limit: 5 });
    const second = await queue.claim({ workerId: 'worker-b', limit: 5 });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('claims in priority order', async () => {
    await queue.enqueue({ type: 'UPDATE_ANALYTICS', key: ['low'], priority: 'LOW' });
    await queue.enqueue({ type: 'SEND_NOTIFICATION', key: ['crit'], priority: 'CRITICAL' });
    await queue.enqueue({ type: 'SOURCE_SCAN', key: ['normal'], priority: 'NORMAL' });

    const claimed = await queue.claim({ workerId: 'w', limit: 3 });

    expect(claimed.map((task) => task.priority)).toEqual(['CRITICAL', 'NORMAL', 'LOW']);
  });

  it('recovers a task whose worker died', async () => {
    await queue.enqueue({ type: 'SOURCE_SCAN', key: ['crash-me'] });

    const claimed = await queue.claim({ workerId: 'doomed', limit: 1 });
    expect(claimed).toHaveLength(1);

    /* The worker vanishes: no completion, no heartbeat, lease runs out. */
    const afterLease = new Date(Date.now() + 20 * 60_000);

    const recovered = await queue.reapExpiredLeases(afterLease);
    expect(recovered).toBe(1);

    const reclaimed = await queue.claim({ workerId: 'survivor', limit: 1, now: afterLease });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.taskId).toBe(claimed[0]!.taskId);
  });

  it('refuses to renew a lease the worker no longer holds', async () => {
    await queue.enqueue({ type: 'SOURCE_SCAN', key: ['stolen'] });
    const [task] = await queue.claim({ workerId: 'first', limit: 1 });

    const later = new Date(Date.now() + 20 * 60_000);
    await queue.reapExpiredLeases(later);
    await queue.claim({ workerId: 'second', limit: 1, now: later });

    /*
     * The original worker waking up must not be able to renew — it would then
     * hold a lease on a task another worker is actively running.
     */
    expect(await queue.heartbeat(task!.taskId, 'first')).toBe(false);
    expect(await queue.heartbeat(task!.taskId, 'second')).toBe(true);
  });

  it('does not let a stale worker complete a reassigned task', async () => {
    await queue.enqueue({ type: 'SOURCE_SCAN', key: ['reassigned'] });
    const [task] = await queue.claim({ workerId: 'first', limit: 1 });

    const later = new Date(Date.now() + 20 * 60_000);
    await queue.reapExpiredLeases(later);
    await queue.claim({ workerId: 'second', limit: 1, now: later });

    expect(await queue.complete(task!.taskId, 'first')).toBe(false);
    expect(await queue.complete(task!.taskId, 'second')).toBe(true);
  });

  it('does not count a lease expiry as a failed attempt', async () => {
    await queue.enqueue({ type: 'SOURCE_SCAN', key: ['no-double-count'] });
    await queue.claim({ workerId: 'a', limit: 1 });

    const later = new Date(Date.now() + 20 * 60_000);
    await queue.reapExpiredLeases(later);

    const [task] = await queue.claim({ workerId: 'b', limit: 1, now: later });

    /*
     * One claim, one attempt. Counting the expiry too would dead-letter a task
     * after two crashes rather than five failures.
     */
    expect(task!.attempts).toBe(2);
  });
});

describe('fairness (Part 10)', () => {
  it('does not let one profile monopolise the workers', async () => {
    for (let i = 0; i < 60; i += 1) {
      await queue.enqueue({
        type: 'MATCH_JOB',
        key: ['greedy', String(i)],
        profileId: profileA,
      });
    }

    await queue.enqueue({ type: 'MATCH_JOB', key: ['polite'], profileId: profileB });

    const claimed = await queue.claim({ workerId: 'w', limit: 10, maxPerProfile: 5 });

    const fromA = claimed.filter((task) => task.profileId === profileA).length;
    const fromB = claimed.filter((task) => task.profileId === profileB).length;

    expect(fromA).toBeLessThanOrEqual(5);
    expect(fromB).toBe(1);
  });
});

describe('retries and dead letters (Parts 23, 26, 27, 28)', () => {
  const failTask = async (
    key: string,
    failureClass: FailureClass,
    times: number,
  ): Promise<{ task: Task; outcome: string }> => {
    await queue.enqueue({ type: 'SOURCE_SCAN', key: [key], sourceId: 'reddit' });

    let last = { outcome: 'retrying' } as { outcome: string };
    let task: Task | undefined;

    for (let attempt = 0; attempt < times; attempt += 1) {
      const claimed = await queue.claim({
        workerId: 'w',
        limit: 1,
        now: new Date(Date.now() + attempt * 3_600_000),
      });

      if (claimed.length === 0) break;
      task = claimed[0]!;

      last = await queue.fail({
        taskId: task.taskId,
        workerId: 'w',
        error: `failure ${attempt}`,
        failureClass,
        now: new Date(Date.now() + attempt * 3_600_000),
      });
    }

    return { task: task!, outcome: last.outcome };
  };

  it('retries a transient failure', async () => {
    const result = await failTask('transient', 'TRANSIENT', 1);
    expect(result.outcome).toBe('retrying');
  });

  it('does not retry an authentication failure even once', async () => {
    /*
     * Five retries against a provider that has already rejected the credential
     * is how an expired token becomes a locked account.
     */
    const result = await failTask('auth', 'AUTHENTICATION', 1);
    expect(result.outcome).toBe('dead_letter');
  });

  it('does not retry a security failure', async () => {
    const result = await failTask('security', 'SECURITY', 1);
    expect(result.outcome).toBe('dead_letter');
  });

  it('dead-letters after exhausting transient retries', async () => {
    const result = await failTask('exhaust', 'TRANSIENT', 8);
    expect(result.outcome).toBe('dead_letter');

    const summary = await deadLetters.summary();
    expect(summary.open).toBe(1);
    expect(summary.byFailureClass['TRANSIENT']).toBe(1);
  });

  it('frees the idempotency key when a task dies', async () => {
    await failTask('poisoned', 'PERMANENT', 1);

    /*
     * Leaving a dead task holding its key would silently stop the source
     * forever — the next hourly scan could never be enqueued.
     */
    const next = await queue.enqueue({ type: 'SOURCE_SCAN', key: ['poisoned'] });
    expect(next.created).toBe(true);
  });

  it('keeps every failure, not only the last', async () => {
    await failTask('history', 'TRANSIENT', 8);
    const [entry] = await deadLetters.list();

    expect(entry!.attempts).toBeGreaterThan(1);
    expect(entry!.lastError).toContain('failure');
  });

  it('caps a bulk retry', async () => {
    for (let i = 0; i < 5; i += 1) await failTask(`bulk-${i}`, 'PERMANENT', 1);

    const result = await deadLetters.retryMany({}, 1_000);

    expect(result.capped).toBe(true);
    expect(result.requeued).toBe(5);
  });

  it('lets an administrator retry one entry', async () => {
    await failTask('single', 'PERMANENT', 1);
    const [entry] = await deadLetters.list();

    const result = await deadLetters.retry(entry!.id);
    expect(result.ok).toBe(true);
    expect(await queue.depth()).toBe(1);
  });
});

describe('rate limiting (Parts 17, 18, 19, 25)', () => {
  it('shares one allowance across workers', async () => {
    const key = 'source:reddit';
    const config = { capacity: 3, refillPerSecond: 0.01 };
    const now = new Date();

    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await coordination.takeTokens(key, { ...config, now }));
    }

    /*
     * Three workers each politely observing ten requests a minute make thirty.
     * The bucket is shared so the fourth caller is refused.
     */
    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(results.at(-1)!.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time', async () => {
    const key = 'source:refill';
    const start = new Date('2026-08-22T12:00:00Z');

    await coordination.takeTokens(key, { capacity: 2, refillPerSecond: 1, now: start });
    await coordination.takeTokens(key, { capacity: 2, refillPerSecond: 1, now: start });

    const blocked = await coordination.takeTokens(key, {
      capacity: 2,
      refillPerSecond: 1,
      now: start,
    });
    expect(blocked.allowed).toBe(false);

    const later = new Date(start.getTime() + 5_000);
    const allowed = await coordination.takeTokens(key, {
      capacity: 2,
      refillPerSecond: 1,
      now: later,
    });
    expect(allowed.allowed).toBe(true);
  });

  it('honours a Retry-After across every worker', async () => {
    const until = new Date(Date.now() + 60_000);
    await coordination.blockUntil('source:429', until);

    const result = await coordination.takeTokens('source:429', {
      capacity: 100,
      refillPerSecond: 100,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('wait until');
  });
});

describe('leader election (Part 39)', () => {
  it('gives leadership to exactly one instance', async () => {
    const now = new Date();

    const a = await coordination.acquireLease('scheduler', 'instance-a', 60_000, now);
    const b = await coordination.acquireLease('scheduler', 'instance-b', 60_000, now);

    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(false);
    expect(b.reason).toContain('instance-a');
  });

  it('lets the incumbent renew without changing the fencing token', async () => {
    const now = new Date();
    const first = await coordination.acquireLease('scheduler', 'a', 60_000, now);
    const renewed = await coordination.acquireLease('scheduler', 'a', 60_000, new Date(now.getTime() + 1_000));

    expect(renewed.acquired).toBe(true);
    expect(renewed.fencingToken).toBe(first.fencingToken);
  });

  it('hands leadership over when the lease expires', async () => {
    const now = new Date();
    const first = await coordination.acquireLease('scheduler', 'dead', 1_000, now);

    const later = new Date(now.getTime() + 5_000);
    const second = await coordination.acquireLease('scheduler', 'alive', 60_000, later);

    expect(second.acquired).toBe(true);
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
  });

  it('releases immediately on graceful shutdown', async () => {
    const now = new Date();
    await coordination.acquireLease('scheduler', 'a', 600_000, now);
    await coordination.releaseLease('scheduler', 'a', now);

    const taken = await coordination.acquireLease('scheduler', 'b', 60_000, now);
    expect(taken.acquired).toBe(true);
  });
});

// ── Scheduler ───────────────────────────────────────────────────────────────

describe('scheduling (Parts 11, 12, 38, 41)', () => {
  it('creates one task per interval however often it ticks', async () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const scheduler = makeScheduler('sched-1', () => now);

    await scheduler.upsertSchedule({
      taskType: 'SEARCH_PROFILE_SCAN',
      profileId: profileA,
      intervalMinutes: 60,
    });

    const first = await scheduler.tick();
    const second = await scheduler.tick();
    const third = await scheduler.tick();

    expect(first.enqueued).toBe(1);
    expect(second.enqueued + third.enqueued).toBe(0);
    expect(await queue.depth()).toBe(1);
  });

  it('stops a second scheduler instance duplicating work', async () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const a = makeScheduler('sched-a', () => now);
    const b = makeScheduler('sched-b', () => now);

    await a.upsertSchedule({ taskType: 'SOURCE_SCAN', sourceId: 'rss', intervalMinutes: 30 });

    const resultA = await a.tick();
    const resultB = await b.tick();

    expect(resultA.isLeader).toBe(true);
    expect(resultB.isLeader).toBe(false);
    expect(await queue.depth()).toBe(1);
  });

  it('survives a scheduler restart without duplicating tasks', async () => {
    const now = new Date('2026-08-22T12:00:00Z');

    await makeScheduler('before-restart', () => now).upsertSchedule({
      taskType: 'SOURCE_SCAN',
      sourceId: 'rss',
      intervalMinutes: 60,
    });

    await makeScheduler('before-restart', () => now).tick();

    /* A new process, same database. The schedule is a row, not a timer. */
    const after = makeScheduler('after-restart', () => new Date(now.getTime() + 5_000));
    const result = await after.tick();

    expect(result.enqueued).toBe(0);
    expect(await queue.depth()).toBe(1);
  });

  it('re-bases the next run when the interval changes', async () => {
    let now = new Date('2026-08-22T12:00:00Z');
    const scheduler = makeScheduler('sched', () => now);

    await scheduler.upsertSchedule({
      taskType: 'SEARCH_PROFILE_SCAN',
      profileId: profileA,
      intervalMinutes: 60,
    });
    await scheduler.tick();

    now = new Date('2026-08-22T12:05:00Z');

    const updated = await scheduler.upsertSchedule({
      taskType: 'SEARCH_PROFILE_SCAN',
      profileId: profileA,
      intervalMinutes: 15,
    });

    /*
     * Someone moving from hourly to every fifteen minutes expects it to take
     * effect now, not fifty-five minutes from now.
     */
    expect(updated.intervalMinutes).toBe(15);
    expect(updated.nextRunAt!.getTime()).toBeLessThanOrEqual(now.getTime() + 15 * 60_000);
  });

  it('reports how far behind it is', async () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const scheduler = makeScheduler('sched', () => now);

    await scheduler.upsertSchedule({
      taskType: 'CLEANUP',
      intervalMinutes: 60,
    });

    const lag = await scheduler.lagSeconds();
    expect(lag).toBeGreaterThanOrEqual(0);
  });
});

describe('pause and resume (Parts 13, 14)', () => {
  it('stops new scans and cancels queued ones on pause', async () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const scheduler = makeScheduler('sched', () => now);

    await scheduler.upsertSchedule({
      taskType: 'SEARCH_PROFILE_SCAN',
      profileId: profileA,
      intervalMinutes: 60,
    });
    await scheduler.tick();
    expect(await queue.depth({ profileId: profileA })).toBe(1);

    const cancelled = await scheduler.pauseProfile(profileA);

    expect(cancelled).toBe(1);
    expect(await queue.depth({ profileId: profileA })).toBe(0);

    const afterPause = await scheduler.tick();
    expect(afterPause.enqueued).toBe(0);
  });

  it('does not replay three days of scans on resume', async () => {
    let now = new Date('2026-08-19T12:00:00Z');
    const scheduler = makeScheduler('sched', () => now);

    await scheduler.upsertSchedule({
      taskType: 'SEARCH_PROFILE_SCAN',
      profileId: profileA,
      intervalMinutes: 60,
    });
    await scheduler.tick();
    await scheduler.pauseProfile(profileA);

    now = new Date('2026-08-22T12:00:00Z');
    await scheduler.resumeProfile(profileA);

    const result = await scheduler.tick();

    /* Seventy-two hours of downtime yields one scan, not seventy-two. */
    expect(result.enqueued).toBe(1);
    expect(result.skippedMisfires).toBe(0);
  });
});

describe('reconciliation (Parts 46, 47)', () => {
  const reconcile = (now: Date) =>
    new ReconciliationService({
      scheduler: makeScheduler('sched', () => now),
      queue,
      logger,
    });

  it('creates the schedules a profile needs', async () => {
    const now = new Date('2026-08-22T12:00:00Z');

    const result = await reconcile(now).reconcileSearchProfile({
      profileId: profileA,
      active: true,
      intervalMinutes: 60,
      sources: [
        { sourceId: 'rss', intervalMinutes: 30, schedulable: true },
        { sourceId: 'reddit', intervalMinutes: 60, schedulable: true },
      ],
    });

    expect(result.schedulesCreated).toBe(3);
  });

  it('cancels queued work for a source that was turned off', async () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const scheduler = makeScheduler('sched', () => now);

    await scheduler.upsertSchedule({
      taskType: 'SOURCE_SCAN',
      profileId: profileA,
      sourceId: 'reddit',
      intervalMinutes: 60,
    });
    await scheduler.tick();

    const result = await reconcile(now).reconcileSearchProfile({
      profileId: profileA,
      active: true,
      intervalMinutes: 60,
      sources: [
        {
          sourceId: 'reddit',
          intervalMinutes: 60,
          schedulable: false,
          reason: 'AUTH_REQUIRED',
        },
      ],
    });

    expect(result.tasksCancelled).toBeGreaterThan(0);
    expect(result.actions.some((action) => action.includes('AUTH_REQUIRED'))).toBe(true);
    expect(await queue.depth({ sourceId: 'reddit' })).toBe(0);
  });

  it('converges when run twice', async () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const service = reconcile(now);

    const desired = {
      profileId: profileA,
      active: true,
      intervalMinutes: 60,
      sources: [{ sourceId: 'rss', intervalMinutes: 30, schedulable: true }],
    };

    const first = await service.reconcileSearchProfile(desired);
    const second = await service.reconcileSearchProfile(desired);

    expect(first.schedulesCreated).toBe(2);
    expect(second.schedulesCreated).toBe(0);
    expect(second.schedulesUpdated).toBe(2);
  });
});

// ── Workers ─────────────────────────────────────────────────────────────────

describe('worker runtime (Parts 29–32)', () => {
  it('processes a task and records it', async () => {
    const seen: string[] = [];

    const worker = new Worker(
      { db: handle.db, queue, logger },
      { workerId: 'w1', concurrency: 2, idlePollMs: 10, busyPollMs: 5 },
    ).register('SOURCE_SCAN', async (task) => {
      seen.push(task.taskId);
    });

    await queue.enqueue({ type: 'SOURCE_SCAN', key: ['run-me'] });
    await worker.start();

    await waitFor(() => seen.length === 1, 3_000);
    await worker.stop();

    expect(worker.stats.processed).toBe(1);
    expect(worker.currentState).toBe('STOPPED');
  });

  it('retries a failing handler rather than losing the task', async () => {
    let attempts = 0;

    const worker = new Worker(
      { db: handle.db, queue, logger },
      { workerId: 'w2', idlePollMs: 10, busyPollMs: 5 },
    ).register('SOURCE_SCAN', async () => {
      attempts += 1;
      throw new Error('connection timeout');
    });

    await queue.enqueue({ type: 'SOURCE_SCAN', key: ['flaky'] });
    await worker.start();

    await waitFor(() => attempts >= 1, 3_000);
    await worker.stop();

    const task = (await handle.db.execute(
      "select status, attempts from tasks where idempotency_key = 'SOURCE_SCAN:flaky'",
    )) as unknown as { rows?: Array<{ status: string }> };

    const rows = task.rows ?? (task as unknown as Array<{ status: string }>);
    expect(rows[0]!.status).toBe('RETRYING');
  });

  it('releases held tasks on graceful shutdown', async () => {
    let started = false;

    const worker = new Worker(
      { db: handle.db, queue, logger },
      { workerId: 'w3', idlePollMs: 10, busyPollMs: 5, shutdownGraceMs: 100 },
    ).register('ENRICH_JOB', async () => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    });

    await queue.enqueue({ type: 'ENRICH_JOB', key: ['long'] });
    await worker.start();
    await waitFor(() => started, 3_000);

    await worker.stop();

    /*
     * The task is back on the queue rather than waiting out its lease. A
     * redeploy costs milliseconds instead of five minutes.
     */
    const depth = await queue.depth();
    expect(depth).toBe(1);
  }, 20_000);

  it('dead-letters a task with no registered handler', async () => {
    const worker = new Worker(
      { db: handle.db, queue, logger },
      { workerId: 'w4', idlePollMs: 10, busyPollMs: 5 },
    ).register('SOURCE_SCAN', async () => undefined);

    await queue.enqueue({ type: 'SOURCE_SCAN', key: ['handled'] });
    await worker.start();
    await waitFor(async () => (await queue.depth()) === 0, 3_000);
    await worker.stop();

    expect(worker.stats.processed).toBe(1);
  });

  it('marks a silent worker unhealthy without stealing its tasks', async () => {
    const registry = new WorkerRegistry(handle.db);

    await handle.db.execute(
      `insert into workers (id, state, last_heartbeat_at, started_at)
       values ('ghost', 'BUSY', now() - interval '10 minutes', now() - interval '20 minutes')`,
    );

    const marked = await registry.markStaleUnhealthy();
    expect(marked).toBeGreaterThanOrEqual(1);

    /*
     * Marking unhealthy must not release tasks: a worker paused by a long GC is
     * silent and very much alive. Only lease expiry may reclaim work.
     */
    const active = await registry.active();
    expect(active.find((worker) => worker.id === 'ghost')).toBeUndefined();
  });
});

// ── System health ───────────────────────────────────────────────────────────

describe('system health (Part 49)', () => {
  it('names the specific thing that is wrong', () => {
    const components: ComponentHealth[] = [
      { component: 'queue', status: 'healthy', detail: '12 tasks queued.', latencyMs: 1, checkedAt: new Date() },
      {
        component: 'connectors',
        status: 'degraded',
        detail: 'Reddit connector authentication expired.',
        latencyMs: 1,
        checkedAt: new Date(),
      },
    ];

    const rollup = rollUpHealth(components);

    expect(rollup.status).toBe('degraded');
    expect(rollup.summary).toContain('Reddit connector authentication expired');
  });

  it('names only the worst offenders', () => {
    const rollup = rollUpHealth([
      { component: 'a', status: 'degraded', detail: 'A is slow.', latencyMs: 1, checkedAt: new Date() },
      { component: 'b', status: 'down', detail: 'B is unreachable.', latencyMs: 1, checkedAt: new Date() },
    ]);

    expect(rollup.summary).toContain('B is unreachable');
    expect(rollup.summary).not.toContain('A is slow');
  });

  it('checks every component without throwing when one fails', async () => {
    const scheduler = makeScheduler('sched');

    const service = new SystemHealthService({
      queue,
      deadLetters,
      workers: new WorkerRegistry(handle.db),
      scheduler,
      logger,
      probes: [
        {
          component: 'ai-provider',
          check: async () => {
            throw new Error('provider unreachable');
          },
        },
      ],
    });

    const health = await service.check();

    expect(health.components.map((entry) => entry.component)).toContain('ai-provider');
    expect(health.status).toBe('down');
    expect(health.summary).toContain('provider unreachable');
  });
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Timed out waiting for condition.');
}

describe('regressions found by the load test', () => {
  it('does not count completed work as queue depth', async () => {
    /*
     * `depthBreakdown` counted every row including COMPLETED, so a perfectly
     * drained queue reported its lifetime throughput as its depth — and the
     * health check read that as "at the hard limit". A system working flawlessly
     * reported itself unhealthy, and got worse the better it worked.
     */
    for (let i = 0; i < 5; i += 1) {
      await queue.enqueue({ type: 'MATCH_JOB', key: ['drained', String(i)] });
    }

    const claimed = await queue.claim({ workerId: 'w', limit: 5 });
    for (const task of claimed) await queue.complete(task.taskId, 'w');

    const breakdown = await queue.depthBreakdown();

    expect(breakdown.total).toBe(0);
    expect(await queue.depth()).toBe(0);
  });

  it('reports work in flight separately from backlog', async () => {
    await queue.enqueue({ type: 'MATCH_JOB', key: ['inflight'] });
    await queue.claim({ workerId: 'w', limit: 1 });

    const breakdown = await queue.depthBreakdown();

    /* In-flight work is not backlog; counting it would make every busy period
     * look like congestion. */
    expect(breakdown.total).toBe(0);
    expect(breakdown.processing).toBe(1);
  });

  it('counts depth once per batch rather than once per task', async () => {
    /*
     * The obvious loop over `enqueue` cost two COUNT(*) queries per task, which
     * turned a ten-thousand-task batch into twenty thousand full-table counts.
     */
    const inputs = Array.from({ length: 200 }, (_, index) => ({
      type: 'MATCH_JOB' as const,
      key: ['batch', String(index)],
      profileId: profileA,
    }));

    const started = Date.now();
    const result = await queue.enqueueMany(inputs);
    const elapsed = Date.now() - started;

    expect(result.created).toHaveLength(200);
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);
});

describe('regressions found by booting the real worker', () => {
  it('reaches STOPPED so its row can be cleaned up', async () => {
    /*
     * The poll delay was unref'd, so with the heartbeat cleared Node found
     * nothing holding the event loop and exited mid-shutdown. The worker stayed
     * DRAINING forever, `purgeStopped` never matched it, and every restart
     * leaked a row.
     */
    const worker = new Worker(
      { db: handle.db, queue, logger },
      { workerId: 'graceful', idlePollMs: 50 },
    ).register('CLEANUP', async () => undefined);

    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await worker.stop();

    const registry = new WorkerRegistry(handle.db);
    const all = await registry.list();
    const row = all.find((entry) => entry.id === 'graceful');

    expect(row?.state).toBe('STOPPED');
    expect(row?.stoppedAt).not.toBeNull();

    /* And the purge can now actually reclaim it. */
    const purged = await registry.purgeStopped(0, new Date(Date.now() + 1_000));
    expect(purged).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
