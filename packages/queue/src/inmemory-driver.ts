import { randomUUID } from 'node:crypto';
import type {
  EnqueueOptions,
  FailedQueueJob,
  QueueCounts,
  QueueDriver,
  QueueName,
  QueuePayload,
} from './types';

/**
 * In-process queue driver.
 *
 * Used by tests and by the web app, which enqueues work but never consumes it.
 * Jobs are executed on the next tick when a handler is registered, and buffered
 * otherwise — so ordering and delivery are observable without a broker.
 *
 * Not a production driver: nothing survives a restart. `QUEUE_DRIVER=bullmq` is
 * required for the worker fleet.
 */
export class InMemoryQueueDriver implements QueueDriver {
  readonly kind = 'inmemory' as const;

  private readonly handlers = new Map<
    QueueName,
    (payload: QueuePayload<unknown>) => Promise<void>
  >();
  private readonly pending = new Map<QueueName, QueuePayload<unknown>[]>();
  private readonly stats = new Map<QueueName, QueueCounts>();
  private readonly seenDeduplicationIds = new Set<string>();
  /**
   * Failures, retained with their payload so a retry can genuinely re-run the
   * work rather than merely clearing the row. Bounded, because this driver
   * lives for the lifetime of a process that never restarts under test.
   */
  private readonly failures = new Map<
    QueueName,
    Array<{ record: FailedQueueJob; payload: QueuePayload<unknown> }>
  >();

  private statsFor(queue: QueueName): QueueCounts {
    let s = this.stats.get(queue);
    if (!s) {
      s = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
      this.stats.set(queue, s);
    }
    return s;
  }

  async enqueue<T>(
    queue: QueueName,
    payload: QueuePayload<T>,
    options: EnqueueOptions = {},
  ): Promise<string> {
    if (options.deduplicationId) {
      if (this.seenDeduplicationIds.has(options.deduplicationId)) return options.deduplicationId;
      this.seenDeduplicationIds.add(options.deduplicationId);
    }

    const id = randomUUID();
    const stats = this.statsFor(queue);
    const handler = this.handlers.get(queue);

    if (!handler) {
      const queued = this.pending.get(queue) ?? [];
      queued.push(payload as QueuePayload<unknown>);
      this.pending.set(queue, queued);
      stats.waiting += 1;
      return id;
    }

    await this.run(queue, handler, payload as QueuePayload<unknown>);
    return id;
  }

  private async run(
    queue: QueueName,
    handler: (payload: QueuePayload<unknown>) => Promise<void>,
    payload: QueuePayload<unknown>,
  ): Promise<void> {
    const stats = this.statsFor(queue);
    stats.active += 1;
    try {
      await handler(payload);
      stats.completed += 1;
    } catch (error) {
      // Mirrors BullMQ: a throwing handler marks the job failed rather than
      // propagating to the enqueuer.
      stats.failed += 1;
      this.recordFailure(queue, payload, error);
    } finally {
      stats.active -= 1;
    }
  }

  private recordFailure(
    queue: QueueName,
    payload: QueuePayload<unknown>,
    error: unknown,
  ): void {
    const list = this.failures.get(queue) ?? [];
    list.unshift({
      record: {
        id: randomUUID(),
        queue,
        attemptsMade: (payload.envelope?.attempt ?? 0) + 1,
        failedReason: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? null) : null,
        failedAt: new Date(),
        traceId: payload.envelope?.traceId ?? null,
        idempotencyKey: payload.envelope?.idempotencyKey ?? null,
      },
      payload,
    });
    this.failures.set(queue, list.slice(0, 200));
  }

  failedJobs(queue: QueueName, limit = 50): Promise<FailedQueueJob[]> {
    return Promise.resolve((this.failures.get(queue) ?? []).slice(0, limit).map((f) => f.record));
  }

  async retryJob(queue: QueueName, jobId: string): Promise<boolean> {
    const list = this.failures.get(queue) ?? [];
    const index = list.findIndex((f) => f.record.id === jobId);
    if (index === -1) return false;

    const [entry] = list.splice(index, 1);
    this.failures.set(queue, list);
    // The failed count stays where it is: a retry does not un-fail history, and
    // a counter that decrements on retry hides how often work is failing.
    const handler = this.handlers.get(queue);
    if (handler && entry) await this.run(queue, handler, entry.payload);
    return true;
  }

  discardJob(queue: QueueName, jobId: string): Promise<boolean> {
    const list = this.failures.get(queue) ?? [];
    const index = list.findIndex((f) => f.record.id === jobId);
    if (index === -1) return Promise.resolve(false);
    list.splice(index, 1);
    this.failures.set(queue, list);
    return Promise.resolve(true);
  }

  async process<T>(
    queue: QueueName,
    handler: (payload: QueuePayload<T>) => Promise<void>,
  ): Promise<void> {
    const typed = handler as (payload: QueuePayload<unknown>) => Promise<void>;
    this.handlers.set(queue, typed);

    // Drain anything enqueued before the consumer registered.
    const backlog = this.pending.get(queue) ?? [];
    this.pending.set(queue, []);
    const stats = this.statsFor(queue);
    stats.waiting = Math.max(0, stats.waiting - backlog.length);
    for (const payload of backlog) await this.run(queue, typed, payload);
  }

  counts(queue: QueueName): Promise<QueueCounts> {
    return Promise.resolve({ ...this.statsFor(queue) });
  }

  healthCheck(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }

  close(): Promise<void> {
    this.handlers.clear();
    this.pending.clear();
    this.failures.clear();
    return Promise.resolve();
  }
}
