import { hostname } from 'node:os';
import { and, eq, lte, sql } from 'drizzle-orm';
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_STALE_AFTER_MS,
  DEFAULT_TASK_TIMEOUT_MS,
  type FailureClass,
  type Task,
  type TaskType,
  type WorkerState,
} from '@job-intel/contracts';
import type { Database } from '@job-intel/db';
import { schema } from '@job-intel/db';
import type { Logger } from '@job-intel/observability';
import type { TaskQueue } from './task-queue';

/**
 * The worker runtime.
 *
 * One runtime with per-type handlers, rather than six specialised worker
 * binaries. The brief allows either and this codebase wants the former: the
 * stages differ by which function they call, not by what they need from the
 * host, and six deployables would mean six restarts to ship one change with no
 * corresponding gain. A deployment that later wants a dedicated enrichment pool
 * runs the same binary with `--types ENRICH_JOB`, which is the horizontal
 * scaling path without the microservice tax.
 *
 * Three commitments define the runtime.
 *
 * **Nothing is lost when a worker dies.** Leases expire and the task returns to
 * the queue. Crash recovery needs no supervisor to notice.
 *
 * **Nothing runs twice concurrently.** A claim is atomic, and a lease can only
 * be renewed by the worker that holds it.
 *
 * **Shutdown is graceful by default.** On a signal the worker stops claiming,
 * finishes what it holds, and releases its registration — so a deploy costs a
 * few seconds rather than a handful of tasks that must time out.
 */

export type TaskHandler = (task: Task, context: HandlerContext) => Promise<void>;

export interface HandlerContext {
  workerId: string;
  logger: Logger;
  /** Extends the lease. Long handlers should call this periodically. */
  heartbeat(): Promise<boolean>;
  /** True once shutdown has begun; long loops should check it and stop early. */
  readonly shuttingDown: boolean;
  signal: AbortSignal;
}

export interface WorkerOptions {
  workerId?: string;
  types?: readonly TaskType[];
  concurrency?: number;
  /** Gap between polls when the queue was empty. */
  idlePollMs?: number;
  /** Gap between polls when work was found. */
  busyPollMs?: number;
  heartbeatMs?: number;
  version?: string;
  /** Longest to wait for in-flight tasks during shutdown. */
  shutdownGraceMs?: number;
  now?: () => Date;
}

export interface WorkerDependencies {
  db: Database;
  queue: TaskQueue;
  logger: Logger;
  /** Maps a failure to a class, so retry policy can be applied. */
  classifyFailure?: (error: unknown) => { failureClass: FailureClass; retryAfterMs?: number | null };
  /**
   * Told the outcome of every task, after the queue has recorded it.
   *
   * A hook rather than a direct call to the scheduler, so the runtime keeps
   * knowing nothing about schedules: it reports what happened and the caller
   * decides what that means. Best-effort by contract — see the call site.
   */
  onOutcome?: (task: Task, outcome: 'success' | 'failure') => Promise<void> | void;
}

/**
 * Default failure classification.
 *
 * Deliberately conservative: anything unrecognised is `UNKNOWN`, which retries
 * a few times rather than either giving up immediately or retrying forever.
 * Callers with real connector errors should pass their own classifier.
 */
function defaultClassify(error: unknown): { failureClass: FailureClass; retryAfterMs?: number | null } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (/\b429\b|too many requests|rate limit/.test(lower)) {
    const seconds = /retry[- ]after[: ]+(\d+)/.exec(lower)?.[1];
    return {
      failureClass: 'RATE_LIMITED',
      retryAfterMs: seconds ? Number(seconds) * 1000 : null,
    };
  }

  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid credential|expired token/.test(lower)) {
    return { failureClass: 'AUTHENTICATION' };
  }

  if (/\b404\b|\b410\b|not found|gone/.test(lower)) return { failureClass: 'PERMANENT' };
  if (/timeout|timed out|abort|econnreset|etimedout|socket hang up/.test(lower)) {
    return { failureClass: 'TRANSIENT' };
  }
  if (/\b5\d\d\b|bad gateway|service unavailable/.test(lower)) return { failureClass: 'TRANSIENT' };
  if (/ssrf|blocked|not permitted|private network|robots/.test(lower)) {
    return { failureClass: 'SECURITY' };
  }
  if (/parse|malformed|unexpected token|invalid json/.test(lower)) return { failureClass: 'PARSING' };
  if (/validation|invalid input|schema/.test(lower)) return { failureClass: 'VALIDATION' };

  return { failureClass: 'UNKNOWN' };
}

export class Worker {
  readonly workerId: string;

  private readonly handlers = new Map<TaskType, TaskHandler>();
  private readonly types: TaskType[];
  private readonly concurrency: number;
  private readonly idlePollMs: number;
  private readonly busyPollMs: number;
  private readonly heartbeatMs: number;
  private readonly version: string;
  private readonly shutdownGraceMs: number;
  private readonly now: () => Date;

  private state: WorkerState = 'STARTING';
  private running = false;
  private shuttingDown = false;
  private inFlight = 0;
  private processed = 0;
  private failed = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private loopPromise: Promise<void> | null = null;
  /*
   * The actual in-flight executions, not just a count of them.
   *
   * `inFlight` alone tells shutdown how many tasks are running but gives it
   * nothing to await, so `stop()` could only poll the number and then continue
   * once its grace deadline passed — leaving a still-running handler writing to
   * a database the caller was about to close. Holding the promises lets
   * shutdown wait for the work itself.
   */
  private readonly active = new Set<Promise<void>>();

  constructor(
    private readonly deps: WorkerDependencies,
    options: WorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `worker-${hostname()}-${process.pid}-${Date.now()}`;
    this.types = [...(options.types ?? [])];
    this.concurrency = options.concurrency ?? 4;
    this.idlePollMs = options.idlePollMs ?? 2_000;
    this.busyPollMs = options.busyPollMs ?? 50;
    this.heartbeatMs = options.heartbeatMs ?? WORKER_HEARTBEAT_INTERVAL_MS;
    this.version = options.version ?? '1.0.0';
    this.shutdownGraceMs = options.shutdownGraceMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
  }

  register(type: TaskType, handler: TaskHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  get currentState(): WorkerState {
    return this.state;
  }

  get stats() {
    return { processed: this.processed, failed: this.failed, inFlight: this.inFlight };
  }

  /** Types this worker will claim: its registered handlers, narrowed by config. */
  private claimableTypes(): TaskType[] {
    const registered = [...this.handlers.keys()];
    if (this.types.length === 0) return registered;
    return registered.filter((type) => this.types.includes(type));
  }

  // ── Lifecycle (Parts 30, 31, 32) ────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.shuttingDown = false;
    await this.setState('STARTING');
    await this.upsertRegistration();

    this.heartbeatTimer = setInterval(() => {
      void this.beat();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();

    await this.setState('IDLE');
    this.loopPromise = this.loop();
  }

  /**
   * Stops cleanly.
   *
   * The order matters: stop claiming *first*, then wait for in-flight work.
   * Reversing it means the worker keeps picking up tasks while waiting to
   * finish, and shutdown never converges.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.shuttingDown = true;
    await this.setState('DRAINING');

    const deadline = Date.now() + this.shutdownGraceMs;

    /*
     * Wait for the work itself, bounded by the grace period.
     *
     * Previously this polled `inFlight` and then continued regardless once the
     * deadline passed, so a handler that overran kept issuing queries against a
     * database the caller then closed — surfacing as an unhandled rejection
     * during shutdown, attributed to whatever happened to be running at the
     * time. Racing the settle against the deadline keeps the bound while giving
     * the common case something real to await.
     */
    if (this.active.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.active]),
        delay(Math.max(0, deadline - Date.now())),
      ]);
    }

    while (this.inFlight > 0 && Date.now() < deadline) {
      await delay(100);
    }

    this.running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    await this.loopPromise?.catch(() => undefined);

    /*
     * Any task still held is released rather than left to time out. Its lease
     * would have expired eventually; releasing it now means a redeploy costs
     * milliseconds instead of a lease duration.
     */
    if (this.inFlight > 0) {
      await this.deps.db
        .update(schema.tasks)
        .set({
          status: 'READY',
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          lastError: 'Released during worker shutdown.',
          updatedAt: this.now(),
        })
        .where(and(eq(schema.tasks.lockedBy, this.workerId), eq(schema.tasks.status, 'PROCESSING')));
    }

    await this.setState('STOPPED');
  }

  /** Wires SIGTERM/SIGINT to a graceful stop. */
  installSignalHandlers(): void {
    const handler = (): void => {
      this.deps.logger.info('Shutdown signal received', { workerId: this.workerId });
      void this.stop();
    };

    process.once('SIGTERM', handler);
    process.once('SIGINT', handler);
  }

  private async setState(state: WorkerState): Promise<void> {
    this.state = state;

    await this.deps.db
      .update(schema.workers)
      .set({
        state,
        lastHeartbeatAt: this.now(),
        ...(state === 'STOPPED' ? { stoppedAt: this.now() } : {}),
      })
      .where(eq(schema.workers.id, this.workerId))
      .catch(() => undefined);
  }

  private async upsertRegistration(): Promise<void> {
    const now = this.now();

    await this.deps.db
      .insert(schema.workers)
      .values({
        id: this.workerId,
        taskTypes: this.claimableTypes(),
        version: this.version,
        hostname: hostname(),
        pid: process.pid,
        state: this.state,
        concurrency: this.concurrency,
        startedAt: now,
        lastHeartbeatAt: now,
      })
      .onConflictDoUpdate({
        target: schema.workers.id,
        set: {
          taskTypes: this.claimableTypes(),
          state: this.state,
          lastHeartbeatAt: now,
          stoppedAt: null,
        },
      });
  }

  private async beat(): Promise<void> {
    try {
      await this.deps.db
        .update(schema.workers)
        .set({
          lastHeartbeatAt: this.now(),
          state: this.state,
          tasksProcessed: this.processed,
          tasksFailed: this.failed,
        })
        .where(eq(schema.workers.id, this.workerId));
    } catch (error) {
      /*
       * A failed heartbeat is not fatal. The database may be briefly
       * unavailable; the leases this worker holds will lapse and its tasks will
       * be recovered, which is the designed behaviour rather than a bug worth
       * crashing over.
       */
      this.deps.logger.debug('Heartbeat failed', { workerId: this.workerId, err: error });
    }
  }

  // ── The claim loop ──────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    while (this.running && !this.shuttingDown) {
      let claimedAny = false;

      try {
        const capacity = this.concurrency - this.inFlight;

        if (capacity > 0) {
          const claimed = await this.deps.queue.claim({
            workerId: this.workerId,
            types: this.claimableTypes(),
            limit: capacity,
            now: this.now(),
          });

          claimedAny = claimed.length > 0;

          for (const task of claimed) {
            this.inFlight += 1;

            const running = this.execute(task).finally(() => {
              this.inFlight -= 1;
              this.active.delete(running);
            });

            /*
             * Tracked and deliberately not awaited: the loop must stay free to
             * claim up to `concurrency` tasks. `stop()` awaits the set.
             */
            this.active.add(running);
            void running.catch(() => undefined);
          }
        }

        await this.setState(this.inFlight > 0 ? 'BUSY' : 'IDLE');
      } catch (error) {
        this.deps.logger.warn('Claim loop error', { workerId: this.workerId, err: error });
        await this.setState('UNHEALTHY');
      }

      await delay(claimedAny ? this.busyPollMs : this.idlePollMs);
    }
  }

  /**
   * Runs one task.
   *
   * The timeout races the handler rather than trusting it. A handler that hangs
   * on a socket with no timeout of its own would otherwise hold its slot until
   * the process restarts, and one wedged handler per slot is a worker that
   * quietly stops working while reporting itself healthy.
   */
  private async execute(task: Task): Promise<void> {
    const handler = this.handlers.get(task.type);

    if (!handler) {
      await this.deps.queue.fail({
        taskId: task.taskId,
        workerId: this.workerId,
        error: `No handler registered for ${task.type}.`,
        failureClass: 'PERMANENT',
      });
      return;
    }

    const controller = new AbortController();
    const timeoutMs = task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS[task.type];

    const context: HandlerContext = {
      workerId: this.workerId,
      logger: this.deps.logger,
      heartbeat: () => this.deps.queue.heartbeat(task.taskId, this.workerId, this.now()),
      get shuttingDown() {
        return controller.signal.aborted;
      },
      signal: controller.signal,
    };

    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      await Promise.race([
        handler(task, context),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error(`Task timed out after ${timeoutMs}ms.`));
          });
        }),
      ]);

      const completed = await this.deps.queue.complete(task.taskId, this.workerId, this.now());

      if (completed) this.processed += 1;
      else {
        /*
         * The lease was lost mid-task and someone else owns it now. The work
         * was done — at-least-once means that is acceptable — but this worker
         * must not claim the completion, because the other worker's result is
         * the one the record reflects.
         */
        this.deps.logger.warn('Completed a task whose lease had been reassigned', {
          workerId: this.workerId,
          taskId: task.taskId,
        });
      }

      await this.report(task, 'success');
    } catch (error) {
      this.failed += 1;

      const classify = this.deps.classifyFailure ?? defaultClassify;
      const classified = classify(error);

      const result = await this.deps.queue.fail({
        taskId: task.taskId,
        workerId: this.workerId,
        error: error instanceof Error ? error.message : String(error),
        failureClass: classified.failureClass,
        retryAfterMs: classified.retryAfterMs ?? null,
        now: this.now(),
      });

      this.deps.logger.warn('Task failed', {
        workerId: this.workerId,
        taskId: task.taskId,
        type: task.type,
        outcome: result.outcome,
        reason: result.reason,
      });

      await this.report(task, 'failure');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reports an outcome, and never lets reporting become a failure of its own.
   *
   * The task is already finished and the queue already knows. If the listener
   * throws here it would be caught by the handler's own catch block, counted
   * as a second failure and retried — a task that succeeded would be recorded
   * as having failed because the bookkeeping did.
   */
  private async report(task: Task, outcome: 'success' | 'failure'): Promise<void> {
    if (!this.deps.onOutcome) return;

    try {
      await this.deps.onOutcome(task, outcome);
    } catch (error) {
      this.deps.logger.warn('Failed to report a task outcome', {
        workerId: this.workerId,
        taskId: task.taskId,
        err: error,
      });
    }
  }
}

/**
 * The poll delay, deliberately *not* unref'd.
 *
 * Unref'ing it looked tidy and broke graceful shutdown: with the heartbeat
 * cleared and every other timer unref'd, Node found nothing holding the event
 * loop and exited the process while `stop()` was still awaiting the loop. The
 * worker never reached `STOPPED`, never released the tasks it held, and left a
 * row that `purgeStopped` would never clean up — so every restart leaked one.
 *
 * A running worker *should* keep its process alive. That is what running means.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Worker fleet introspection (Parts 7, 48).
 *
 * Marks silent workers unhealthy and reports the fleet. Separate from the
 * `Worker` class because it is about *other* workers — a process cannot notice
 * its own death, so this has to be someone else's job.
 */
export class WorkerRegistry {
  constructor(private readonly db: Database) {}

  async list() {
    return this.db.select().from(schema.workers).orderBy(schema.workers.startedAt);
  }

  async active(now = new Date()) {
    const cutoff = new Date(now.getTime() - WORKER_STALE_AFTER_MS);

    return this.db
      .select()
      .from(schema.workers)
      .where(and(sql`${schema.workers.state} <> 'STOPPED'`, sql`${schema.workers.lastHeartbeatAt} >= ${cutoff}`));
  }

  /**
   * Marks silent workers unhealthy.
   *
   * Does *not* release their tasks. Lease expiry already does that, and it does
   * it with a margin that a heartbeat check does not have — a worker paused by
   * a long GC is silent but very much alive, and reclaiming its work here would
   * create the double execution that leases exist to prevent.
   */
  async markStaleUnhealthy(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - WORKER_STALE_AFTER_MS);

    const updated = await this.db
      .update(schema.workers)
      .set({ state: 'UNHEALTHY' })
      .where(
        and(
          lte(schema.workers.lastHeartbeatAt, cutoff),
          sql`${schema.workers.state} NOT IN ('STOPPED','UNHEALTHY')`,
        ),
      )
      .returning({ id: schema.workers.id });

    return updated.length;
  }

  /** Removes long-stopped workers so the table reflects the live fleet. */
  async purgeStopped(olderThanHours = 24, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - olderThanHours * 3_600_000);

    const removed = await this.db
      .delete(schema.workers)
      .where(and(sql`${schema.workers.state} = 'STOPPED'`, lte(schema.workers.lastHeartbeatAt, cutoff)))
      .returning({ id: schema.workers.id });

    return removed.length;
  }

  async utilisation(now = new Date()) {
    const live = await this.active(now);

    const capacity = live.reduce((sum, worker) => sum + worker.concurrency, 0);
    const busy = live.filter((worker) => worker.state === 'BUSY').length;

    return {
      workers: live.length,
      capacity,
      busy,
      utilisation: live.length === 0 ? 0 : busy / live.length,
    };
  }
}
