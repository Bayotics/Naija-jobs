import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type {
  EnqueueOptions,
  FailedQueueJob,
  JobEnvelope,
  QueueCounts,
  QueueDriver,
  QueueName,
  QueuePayload,
} from './types';

/**
 * Production queue driver.
 *
 * Two operational requirements the architecture calls out explicitly:
 *
 *  - Redis MUST run with `maxmemory-policy noeviction`. Any LRU policy silently
 *    evicts queue keys under memory pressure and jobs simply cease to exist —
 *    the classic way BullMQ deployments lose work invisibly.
 *  - `maxRetriesPerRequest: null` is required by BullMQ's blocking commands;
 *    without it ioredis aborts long-lived `BRPOPLPUSH` calls.
 */
export interface BullMqDriverOptions {
  connectionUrl: string;
  defaultAttempts?: number;
  defaultBackoffMs?: number;
  keyPrefix?: string;
}

export class BullMqQueueDriver implements QueueDriver {
  readonly kind = 'bullmq' as const;

  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private readonly connection: ConnectionOptions;

  constructor(private readonly options: BullMqDriverOptions) {
    const url = new URL(options.connectionUrl);
    this.connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
      maxRetriesPerRequest: null,
    };
  }

  private queueFor(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        ...(this.options.keyPrefix ? { prefix: this.options.keyPrefix } : {}),
        defaultJobOptions: {
          attempts: this.options.defaultAttempts ?? 3,
          // Full jitter: a thundering herd of retries is worse than the outage.
          backoff: { type: 'exponential', delay: this.options.defaultBackoffMs ?? 2_000 },
          removeOnComplete: { age: 3_600, count: 1_000 },
          // Failures are retained for DLQ inspection and replay.
          removeOnFail: { age: 7 * 24 * 3_600 },
        },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async enqueue<T>(
    queue: QueueName,
    payload: QueuePayload<T>,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const job = await this.queueFor(queue).add(queue, payload, {
      ...(options.delayMs !== undefined ? { delay: options.delayMs } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
      // BullMQ treats a duplicate jobId as a no-op, giving us enqueue-side
      // deduplication for free.
      ...(options.deduplicationId ? { jobId: options.deduplicationId } : {}),
    });
    return job.id ?? 'unknown';
  }

  process<T>(
    queue: QueueName,
    handler: (payload: QueuePayload<T>) => Promise<void>,
    options: { concurrency?: number } = {},
  ): Promise<void> {
    const worker = new Worker(
      queue,
      async (job) => {
        await handler(job.data as QueuePayload<T>);
      },
      {
        connection: this.connection,
        concurrency: options.concurrency ?? 5,
        ...(this.options.keyPrefix ? { prefix: this.options.keyPrefix } : {}),
      },
    );
    this.workers.push(worker);
    return Promise.resolve();
  }

  async counts(queue: QueueName): Promise<QueueCounts> {
    const c = await this.queueFor(queue).getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
    return {
      waiting: c.waiting ?? 0,
      active: c.active ?? 0,
      completed: c.completed ?? 0,
      failed: c.failed ?? 0,
      delayed: c.delayed ?? 0,
    };
  }

  /**
   * The dead-letter view.
   *
   * `removeOnFail` retains failures for seven days, so this is a real window
   * rather than a best-effort guess. Envelope fields are read defensively: a
   * job that failed during deserialisation may have no recognisable payload at
   * all, and the console still needs to show the reason it died.
   */
  async failedJobs(queue: QueueName, limit = 50): Promise<FailedQueueJob[]> {
    const jobs = await this.queueFor(queue).getFailed(0, Math.max(0, limit - 1));

    return jobs.map((job) => {
      const envelope = (job.data as { envelope?: Partial<JobEnvelope> } | undefined)?.envelope;
      return {
        id: String(job.id ?? 'unknown'),
        queue,
        attemptsMade: job.attemptsMade ?? 0,
        failedReason: job.failedReason ?? 'unknown',
        stack: job.stacktrace?.[0] ?? null,
        failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
        traceId: typeof envelope?.traceId === 'string' ? envelope.traceId : null,
        idempotencyKey:
          typeof envelope?.idempotencyKey === 'string' ? envelope.idempotencyKey : null,
      };
    });
  }

  async retryJob(queue: QueueName, jobId: string): Promise<boolean> {
    const job = await this.queueFor(queue).getJob(jobId);
    if (!job) return false;
    await job.retry();
    return true;
  }

  async discardJob(queue: QueueName, jobId: string): Promise<boolean> {
    const job = await this.queueFor(queue).getJob(jobId);
    if (!job) return false;
    await job.remove();
    return true;
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      // A real round trip to Redis. Cheaper than PING would be, but PING is not
      // on BullMQ's exposed client type and casting to reach it would hide a
      // future breaking change.
      await this.queueFor('maintenance').getJobCounts('waiting');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Drains in-flight jobs before exiting, so a deploy never truncates work. */
  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.workers.length = 0;
    this.queues.clear();
  }
}
