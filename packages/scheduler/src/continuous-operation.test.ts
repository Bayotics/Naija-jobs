import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FailureClass } from '@job-intel/contracts';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '@job-intel/db/testing';
import { createLogger } from '@job-intel/observability';
import { TaskQueue } from './task-queue';
import { DeadLetterQueue } from './dead-letters';
import { CoordinationService } from './coordination';
import { Scheduler } from './scheduler';
import { WorkerRegistry } from './worker-runtime';
import { ReconciliationService, SystemHealthService } from './reconciliation';

/**
 * The 24/7 simulation (Part 50) and the load test.
 *
 * A simulated world rather than a real one: five profiles, ten sources, several
 * workers, and a clock the test controls. Time is advanced deliberately, so
 * three simulated days take milliseconds and every timing-dependent behaviour —
 * lease expiry, backoff, misfire — is exercised at a point the test chooses
 * rather than one it happens to reach.
 *
 * The workers here are *simulated* rather than real `Worker` instances. That is
 * deliberate: a real worker polls on a timer, so a test using them measures the
 * poll interval rather than the queue. Driving `claim`/`complete`/`fail`
 * directly exercises exactly the code paths a real worker takes, at a speed
 * that makes a ten-thousand-task load test practical.
 */

let ctx: TestDatabase;
let queue: TaskQueue;
let deadLetters: DeadLetterQueue;
let coordination: CoordinationService;
const logger = createLogger({ level: 'error', pretty: false, base: { service: 'sim' } });

beforeAll(async () => {
  ctx = await createTestDatabase();
  queue = new TaskQueue(ctx.db);
  deadLetters = new DeadLetterQueue(ctx.db);
  coordination = new CoordinationService(ctx.db);
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await resetTestDatabase(ctx.db);
});

/** A clock the simulation drives. */
class SimClock {
  constructor(private current: Date) {}
  now = (): Date => new Date(this.current);
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  get value(): Date {
    return new Date(this.current);
  }
}

const PROFILES = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];

const SOURCES = [
  { id: 'rss-weworkremotely', intervalMinutes: 30, behaviour: 'ok' },
  { id: 'ats-greenhouse', intervalMinutes: 60, behaviour: 'ok' },
  { id: 'careers-northwind', intervalMinutes: 60, behaviour: 'ok' },
  { id: 'api-remotive', intervalMinutes: 60, behaviour: 'ok' },
  { id: 'api-arbeitnow', intervalMinutes: 120, behaviour: 'ok' },
  { id: 'reddit', intervalMinutes: 60, behaviour: 'auth' },
  { id: 'flaky-board', intervalMinutes: 60, behaviour: 'transient' },
  { id: 'ratelimited-board', intervalMinutes: 60, behaviour: 'rate_limited' },
  { id: 'slow-source', intervalMinutes: 360, behaviour: 'timeout' },
  { id: 'broken-parser', intervalMinutes: 60, behaviour: 'parsing' },
] as const;

/** How each simulated source behaves when scanned. */
function outcomeFor(behaviour: string, attempt: number): { ok: boolean; failure?: FailureClass } {
  switch (behaviour) {
    case 'auth':
      return { ok: false, failure: 'AUTHENTICATION' };
    case 'parsing':
      return { ok: false, failure: 'PARSING' };
    case 'transient':
      /* Recovers on the third attempt, like a real flaky endpoint. */
      return attempt >= 3 ? { ok: true } : { ok: false, failure: 'TRANSIENT' };
    case 'rate_limited':
      return attempt >= 2 ? { ok: true } : { ok: false, failure: 'RATE_LIMITED' };
    case 'timeout':
      return attempt >= 2 ? { ok: true } : { ok: false, failure: 'TRANSIENT' };
    default:
      return { ok: true };
  }
}

interface SimStats {
  completed: number;
  failed: number;
  retried: number;
  deadLettered: number;
  crashedTasks: number;
  bySource: Record<string, { completed: number; failed: number }>;
}

/**
 * Runs one worker pass.
 *
 * `crashRate` drops tasks on the floor without completing or failing them —
 * exactly what a `kill -9` looks like to the queue. Those tasks stay
 * `PROCESSING` until their lease lapses, which is the recovery path the
 * simulation exists to exercise.
 */
async function runWorkerPass(
  workerId: string,
  clock: SimClock,
  stats: SimStats,
  options: { limit?: number; crashRate?: number; random?: () => number } = {},
): Promise<number> {
  const random = options.random ?? (() => 0);
  const claimed = await queue.claim({
    workerId,
    limit: options.limit ?? 5,
    now: clock.now(),
  });

  for (const task of claimed) {
    if (random() < (options.crashRate ?? 0)) {
      stats.crashedTasks += 1;
      continue;
    }

    const behaviour =
      SOURCES.find((source) => source.id === task.sourceId)?.behaviour ?? 'ok';
    const outcome = outcomeFor(behaviour, task.attempts);

    const bucket = (stats.bySource[task.sourceId ?? 'none'] ??= { completed: 0, failed: 0 });

    if (outcome.ok) {
      await queue.complete(task.taskId, workerId, clock.now());
      stats.completed += 1;
      bucket.completed += 1;
      continue;
    }

    const result = await queue.fail({
      taskId: task.taskId,
      workerId,
      error: `${behaviour} failure`,
      failureClass: outcome.failure!,
      retryAfterMs: outcome.failure === 'RATE_LIMITED' ? 30_000 : null,
      now: clock.now(),
      random: () => 0.5,
    });

    stats.failed += 1;
    bucket.failed += 1;
    if (result.outcome === 'retrying') stats.retried += 1;
    if (result.outcome === 'dead_letter') stats.deadLettered += 1;
  }

  return claimed.length;
}

describe('24/7 simulation (Part 50)', () => {
  it('runs a simulated day with five profiles, ten sources and three workers', async () => {
    const clock = new SimClock(new Date('2026-08-22T00:00:00Z'));
    const scheduler = new Scheduler(
      { db: ctx.db, queue, coordination, logger, instanceId: 'sched-1' },
      { now: clock.now, leaseDurationMs: 60_000 },
    );

    const reconciler = new ReconciliationService({ scheduler, queue, logger });

    // ── 1. Scheduler creates the right schedules ────────────────────────
    for (const profileId of PROFILES) {
      await reconciler.reconcileSearchProfile({
        profileId,
        active: true,
        intervalMinutes: 60,
        sources: SOURCES.map((source) => ({
          sourceId: source.id,
          intervalMinutes: source.intervalMinutes,
          schedulable: true,
        })),
      });
    }

    const schedules = await scheduler.listSchedules({});
    expect(schedules.length).toBeGreaterThan(0);

    const stats: SimStats = {
      completed: 0,
      failed: 0,
      retried: 0,
      deadLettered: 0,
      crashedTasks: 0,
      bySource: {},
    };

    let ticks = 0;
    let duplicateTasks = 0;
    let seed = 42;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };

    // Twenty-four simulated hours, ticking every fifteen minutes.
    for (let minute = 0; minute < 24 * 60; minute += 15) {
      const tick = await scheduler.tick();
      duplicateTasks += tick.duplicates;
      ticks += 1;

      // Three workers, one of which crashes occasionally.
      await runWorkerPass('worker-a', clock, stats, { limit: 8 });
      await runWorkerPass('worker-b', clock, stats, { limit: 8 });
      await runWorkerPass('worker-c', clock, stats, { limit: 8, crashRate: 0.15, random });

      // Recover anything a crashed worker was holding.
      await queue.reapExpiredLeases(clock.now());

      clock.advance(15 * 60_000);
    }

    // ── 2. Duplicate schedules are prevented ────────────────────────────
    expect(ticks).toBe(96);
    expect(duplicateTasks).toBe(0);

    // ── 3–5. Work was done, crashes recovered ───────────────────────────
    expect(stats.completed).toBeGreaterThan(50);
    expect(stats.crashedTasks).toBeGreaterThan(0);

    // ── 6–8. Failures behaved by class ──────────────────────────────────
    const dl = await deadLetters.summary();

    /*
     * Authentication and parsing failures are terminal on the first attempt;
     * transient and rate-limited ones recover. So the dead-letter queue should
     * contain the former and not the latter.
     */
    expect(dl.byFailureClass['AUTHENTICATION']).toBeGreaterThan(0);
    expect(dl.byFailureClass['PARSING']).toBeGreaterThan(0);
    expect(dl.byFailureClass['RATE_LIMITED'] ?? 0).toBe(0);

    // ── 19. One source failing did not stop the others ──────────────────
    for (const source of SOURCES.filter((entry) => entry.behaviour === 'ok')) {
      expect(
        stats.bySource[source.id]?.completed ?? 0,
        `${source.id} should have completed scans`,
      ).toBeGreaterThan(0);
    }

    // ── 13. Every profile got execution time ────────────────────────────
    const perProfile = await Promise.all(
      PROFILES.map(async (profileId) => ({
        profileId,
        depth: await queue.depth({ profileId }),
      })),
    );

    /* No profile is starved into an unbounded backlog. */
    const depths = perProfile.map((entry) => entry.depth);
    expect(Math.max(...depths) - Math.min(...depths)).toBeLessThan(200);

    // ── 20. Still operating ─────────────────────────────────────────────
    const health = new SystemHealthService({
      queue,
      deadLetters,
      workers: new WorkerRegistry(ctx.db),
      scheduler,
      logger,
    });

    const report = await health.check(clock.value);
    expect(report.components.map((entry) => entry.component)).toContain('scheduler');
  }, 180_000);

  it('recovers every task a crashed worker was holding', async () => {
    const clock = new SimClock(new Date('2026-08-22T00:00:00Z'));

    for (let i = 0; i < 20; i += 1) {
      await queue.enqueue(
        { type: 'SOURCE_SCAN', key: ['crash', String(i)], sourceId: 'rss-weworkremotely' },
        clock.now(),
      );
    }

    /* A worker claims everything, then dies. */
    const claimed = await queue.claim({ workerId: 'doomed', limit: 20, now: clock.now() });
    expect(claimed).toHaveLength(20);

    expect(await queue.depth()).toBe(0);

    clock.advance(20 * 60_000);
    const recovered = await queue.reapExpiredLeases(clock.now());

    expect(recovered).toBe(20);
    expect(await queue.depth()).toBe(20);

    /* Nothing was lost, and a new worker picks it all up. */
    const reclaimed = await queue.claim({ workerId: 'survivor', limit: 20, now: clock.now() });
    expect(reclaimed).toHaveLength(20);
  }, 60_000);

  it('does not duplicate tasks when the scheduler restarts mid-cycle', async () => {
    const clock = new SimClock(new Date('2026-08-22T00:00:00Z'));

    const first = new Scheduler(
      { db: ctx.db, queue, coordination, logger, instanceId: 'sched-before' },
      { now: clock.now },
    );

    await first.upsertSchedule({
      taskType: 'SOURCE_SCAN',
      sourceId: 'rss-weworkremotely',
      intervalMinutes: 60,
    });

    await first.tick();
    const afterFirst = await queue.depth();

    /* The process dies. A new one starts, same database, five seconds later. */
    clock.advance(5_000);

    const second = new Scheduler(
      { db: ctx.db, queue, coordination, logger, instanceId: 'sched-after' },
      { now: clock.now },
    );

    await second.tick();
    await second.tick();

    expect(await queue.depth()).toBe(afterFirst);
  }, 60_000);

  it('keeps critical work moving while the queue is saturated', async () => {
    const clock = new SimClock(new Date('2026-08-22T00:00:00Z'));

    /* Fill the queue with low-priority background work. */
    for (let i = 0; i < 200; i += 1) {
      await queue.enqueue(
        { type: 'UPDATE_ANALYTICS', key: ['bg', String(i)], priority: 'LOW' },
        clock.now(),
      );
    }

    await queue.enqueue(
      { type: 'RANK_JOBS', key: ['deadline'], priority: 'CRITICAL' },
      clock.now(),
    );

    const claimed = await queue.claim({ workerId: 'w', limit: 1, now: clock.now() });

    /* The deadline notification is claimed first despite arriving last. */
    expect(claimed[0]!.type).toBe('RANK_JOBS');
  }, 60_000);

  it('stops scanning a disabled source and leaves the rest running', async () => {
    const clock = new SimClock(new Date('2026-08-22T00:00:00Z'));
    const scheduler = new Scheduler(
      { db: ctx.db, queue, coordination, logger, instanceId: 'sched' },
      { now: clock.now },
    );

    for (const source of ['rss-weworkremotely', 'reddit']) {
      await scheduler.upsertSchedule({
        taskType: 'SOURCE_SCAN',
        profileId: PROFILES[0]!,
        sourceId: source,
        intervalMinutes: 60,
      });
    }

    await scheduler.tick();
    expect(await queue.depth({ sourceId: 'reddit' })).toBe(1);

    await scheduler.disableSource('reddit', true);

    expect(await queue.depth({ sourceId: 'reddit' })).toBe(0);
    expect(await queue.depth({ sourceId: 'rss-weworkremotely' })).toBe(1);

    clock.advance(2 * 3_600_000);
    await scheduler.tick();

    /* Still nothing for the disabled source; the other kept its cadence. */
    expect(await queue.depth({ sourceId: 'reddit' })).toBe(0);
    expect(await queue.depth({ sourceId: 'rss-weworkremotely' })).toBeGreaterThan(0);
  }, 60_000);

  it('does not replay three days of scans when a profile resumes', async () => {
    const clock = new SimClock(new Date('2026-08-19T00:00:00Z'));
    const scheduler = new Scheduler(
      { db: ctx.db, queue, coordination, logger, instanceId: 'sched' },
      { now: clock.now },
    );

    await scheduler.upsertSchedule({
      taskType: 'SEARCH_PROFILE_SCAN',
      profileId: PROFILES[0]!,
      intervalMinutes: 60,
    });

    await scheduler.tick();
    await scheduler.pauseProfile(PROFILES[0]!);

    clock.advance(3 * 24 * 3_600_000);
    await scheduler.resumeProfile(PROFILES[0]!);

    const tick = await scheduler.tick();

    expect(tick.enqueued).toBe(1);
    expect(await queue.depth({ profileId: PROFILES[0]! })).toBe(1);
  }, 60_000);

  it('sends an email-shaped side effect at most once per logical task', async () => {
    const clock = new SimClock(new Date('2026-08-22T00:00:00Z'));
    const sent: string[] = [];

    /*
     * The idempotency key stands in for a provider's own key. The task is
     * enqueued three times — a scheduler tick, a retry and a manual trigger —
     * and the notification is sent once.
     */
    for (let i = 0; i < 3; i += 1) {
      await queue.enqueue(
        {
          type: 'RANK_JOBS',
          key: ['job-42', 'deadline'],
          priority: 'CRITICAL',
        },
        clock.now(),
      );
    }

    const claimed = await queue.claim({ workerId: 'mailer', limit: 10, now: clock.now() });

    for (const task of claimed) {
      sent.push(task.idempotencyKey);
      await queue.complete(task.taskId, 'mailer', clock.now());
    }

    expect(sent).toHaveLength(1);
    expect(new Set(sent).size).toBe(1);
  }, 60_000);
});

describe('load test', () => {
  /**
   * A hundred profiles, fifty sources, ten thousand tasks, fifty workers.
   *
   * Looking for: starvation (does every profile progress?), duplicate execution
   * (does any task complete twice?), lock leakage (does anything stay
   * `PROCESSING` with nobody holding it?), and retry storms (does the failure
   * rate compound?).
   */
  it('drains ten thousand tasks across fifty workers without starvation or duplication', async () => {
    const clock = new SimClock(new Date('2026-08-22T00:00:00Z'));

    const profiles = Array.from(
      { length: 100 },
      (_, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
    );

    const sources = Array.from({ length: 50 }, (_, index) => `source-${index}`);

    // Enqueue ten thousand tasks, unevenly distributed across profiles.
    const inputs = [];
    for (let i = 0; i < 10_000; i += 1) {
      /*
       * Deliberately skewed: profile 0 gets a fifth of everything. A uniform
       * distribution would not test fairness at all.
       */
      const profileIndex = i % 5 === 0 ? 0 : i % profiles.length;

      inputs.push({
        type: 'MATCH_JOB' as const,
        key: ['load', String(i)],
        profileId: profiles[profileIndex]!,
        sourceId: sources[i % sources.length]!,
        priority: 'NORMAL' as const,
      });
    }

    const enqueueStarted = Date.now();
    const result = await queue.enqueueMany(inputs, clock.now());
    const enqueueMs = Date.now() - enqueueStarted;

    /*
     * Backpressure is expected to reject some: one profile holding a fifth of
     * ten thousand tasks exceeds the per-profile ceiling, which is exactly what
     * that ceiling is for.
     */
    expect(result.created.length).toBeGreaterThan(1_000);
    expect(result.duplicates).toBe(0);

    const initialDepth = await queue.depth();

    // Fifty workers, round-robin, until the queue drains or we give up.
    const completedIds = new Set<string>();
    let duplicateExecutions = 0;
    let rounds = 0;

    const drainStarted = Date.now();

    while ((await queue.depth()) > 0 && rounds < 400) {
      for (let workerIndex = 0; workerIndex < 50; workerIndex += 1) {
        const claimed = await queue.claim({
          workerId: `load-worker-${workerIndex}`,
          limit: 10,
          now: clock.now(),
          maxPerProfile: 3,
        });

        for (const task of claimed) {
          if (completedIds.has(task.taskId)) duplicateExecutions += 1;
          completedIds.add(task.taskId);
          await queue.complete(task.taskId, `load-worker-${workerIndex}`, clock.now());
        }
      }

      rounds += 1;
      clock.advance(1_000);

      /*
       * Yield to the macrotask queue once per round.
       *
       * PGlite executes Postgres as WASM on this thread, so every query blocks
       * it outright. The `await`s above only schedule microtasks, and a
       * microtask chain this long never lets a timer run — which starves
       * Vitest's reporter channel and fails the run with
       * `[vitest-worker]: Timeout calling "onTaskUpdate"` even though every
       * assertion passed.
       *
       * `setTimeout` rather than `queueMicrotask`: the point is specifically to
       * reach the timer phase. Four hundred yields cost milliseconds and change
       * nothing about what this test proves.
       */
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const drainMs = Date.now() - drainStarted;

    // ── No duplicate execution ──────────────────────────────────────────
    expect(duplicateExecutions).toBe(0);

    // ── The queue drained ───────────────────────────────────────────────
    expect(await queue.depth()).toBe(0);

    // ── No leaked locks ─────────────────────────────────────────────────
    const stuck = await queue.stuckTasks(clock.now(), 100);
    expect(stuck).toHaveLength(0);

    // ── No starvation: every profile that was queued made progress ──────
    const breakdown = await queue.depthBreakdown();
    expect(breakdown.total).toBe(0);

    // The load-test result is the deliverable, so it is reported rather than
    // asserted away silently.
    console.warn(
      `[load] enqueued ${result.created.length} of 10,000 in ${enqueueMs}ms ` +
        `(${result.rejected} shed by backpressure); drained ${initialDepth} ` +
        `across 50 workers in ${rounds} rounds / ${drainMs}ms; ` +
        `${duplicateExecutions} duplicate executions`,
    );
  }, 600_000);

  it('does not let a retry storm compound', async () => {
    const clock = new SimClock(new Date('2026-08-22T00:00:00Z'));

    for (let i = 0; i < 200; i += 1) {
      await queue.enqueue(
        { type: 'SOURCE_SCAN', key: ['storm', String(i)], sourceId: 'down-source' },
        clock.now(),
      );
    }

    /* Everything fails at once, as it would if one source went down. */
    const claimed = await queue.claim({ workerId: 'w', limit: 200, now: clock.now() });

    for (const task of claimed) {
      await queue.fail({
        taskId: task.taskId,
        workerId: 'w',
        error: 'connection refused',
        failureClass: 'TRANSIENT',
        now: clock.now(),
      });
    }

    /*
     * A moment later almost nothing should be claimable: jitter spreads the
     * retries out instead of firing all two hundred at the same instant.
     */
    clock.advance(1_000);
    const immediately = await queue.claim({ workerId: 'w', limit: 200, now: clock.now() });
    expect(immediately.length).toBeLessThan(20);

    /* And they do come back, rather than being lost. */
    clock.advance(120_000);
    const later = await queue.claim({ workerId: 'w', limit: 200, now: clock.now() });
    expect(later.length).toBeGreaterThan(50);
  }, 300_000);
});
