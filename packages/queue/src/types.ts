import { z } from 'zod';

/**
 * Queue port.
 *
 * BullMQ is the production driver, but nothing above this interface knows that.
 * The in-memory adapter satisfies the same contract, which keeps tests and the
 * web app (which enqueues but never consumes) free of a Redis dependency.
 *
 * Processors themselves land in prompt 10; this is the infrastructure they
 * plug into.
 */

/** The pipeline stages, each an independently tuned queue. */
export const QUEUE_NAMES = [
  'discovery',
  'extraction',
  'normalization',
  'enrichment',
  'url-resolution',
  'filtering',
  'embedding',
  'dedup',
  'validation',
  'match-triage',
  'match-deep',
  'ranking',
  'notification',
  'feedback',
  'learning',
  'maintenance',
  // Candidate intelligence. Extraction itself stays on the request path — the
  // candidate is waiting to hear whether their file was readable — so these
  // carry only the work that can happen after that answer.
  'profile-rebuild',
  'portfolio-refresh',
  'requirement-matrix',
  // Application intelligence. Analysis only — there is deliberately no queue
  // for submitting, approving or applying, because no such transition exists.
  'application-analyse',
  'application-analyse-all',
  /*
   * Notification intelligence. Scoring and digest planning are separate jobs
   * because scan frequency and notification frequency are separate settings —
   * the crawler running hourly must not imply an hourly email.
   */
  'notification-score',
  'notification-digest',
  /*
   * Search configuration. One scheduler for every setting — frequency, pause
   * state and source selection are all folded into the resolved configuration,
   * so the tick only has to compare timestamps.
   */
  'search-schedule-tick',
  'search-override-expiry',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * Envelope carried by every job.
 *
 * `traceId` makes one posting's journey through every stage a single query.
 * `idempotencyKey` is what makes at-least-once delivery safe: processors upsert
 * on a natural key rather than insert.
 */
export const jobEnvelopeSchema = z.object({
  traceId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  enqueuedAt: z.coerce.date(),
  attempt: z.number().int().min(0).default(0),
  deadlineAt: z.coerce.date().optional(),
});
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

export type QueuePayload<T> = T & { envelope: JobEnvelope };

export interface EnqueueOptions {
  delayMs?: number;
  priority?: number;
  attempts?: number;
  /** Collapses duplicate enqueues of the same logical work. */
  deduplicationId?: string;
}

/**
 * A job that exhausted its retries.
 *
 * Carries the envelope fields separately from the payload so the console can
 * link a dead job back to the trace that produced it without knowing anything
 * about the payload's shape.
 */
export interface FailedQueueJob {
  id: string;
  queue: QueueName;
  attemptsMade: number;
  failedReason: string;
  stack: string | null;
  failedAt: Date | null;
  traceId: string | null;
  idempotencyKey: string | null;
}

export interface QueueDriver {
  readonly kind: 'bullmq' | 'inmemory';
  enqueue<T>(queue: QueueName, payload: QueuePayload<T>, options?: EnqueueOptions): Promise<string>;
  /** Registers a consumer. The in-memory driver runs handlers eagerly. */
  process<T>(
    queue: QueueName,
    handler: (payload: QueuePayload<T>) => Promise<void>,
    options?: { concurrency?: number },
  ): Promise<void>;
  counts(queue: QueueName): Promise<QueueCounts>;
  /**
   * Jobs that exhausted their retries and are being retained for inspection.
   *
   * Part of the port rather than a BullMQ-only extra: an operations console
   * that can only show a *count* of failures cannot answer why anything
   * failed, and a driver that cannot enumerate them should say so by returning
   * an empty list rather than by not existing.
   */
  failedJobs(queue: QueueName, limit?: number): Promise<FailedQueueJob[]>;
  /** Re-queues one failed job. False when it is no longer present. */
  retryJob(queue: QueueName, jobId: string): Promise<boolean>;
  /** Drops one failed job without re-queueing it. False when already gone. */
  discardJob(queue: QueueName, jobId: string): Promise<boolean>;
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
  close(): Promise<void>;
}

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export function createEnvelope(
  traceId: string,
  idempotencyKey: string,
  overrides: Partial<JobEnvelope> = {},
): JobEnvelope {
  return jobEnvelopeSchema.parse({
    traceId,
    idempotencyKey,
    enqueuedAt: new Date(),
    attempt: 0,
    ...overrides,
  });
}
