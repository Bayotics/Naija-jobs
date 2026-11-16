import { z } from 'zod';
import { createEnvelope, type EnqueueOptions, type QueueDriver, type QueuePayload } from '@job-intel/queue';
import type { Logger } from '@job-intel/observability';
import type { MatchingService } from './matching-service';

/**
 * Matching work as queue jobs.
 *
 * Matching is asynchronous for a reason that shows up the moment the corpus
 * grows: scoring hundreds of jobs against a changed preference set takes far
 * longer than an HTTP request should live, and doing it inline would make
 * "save preferences" appear to hang. The API enqueues; the worker scores.
 *
 * Every payload is schema-validated on the way in *and* on the way out of the
 * queue. A job that has been sitting in Redis across a deploy may predate the
 * current shape, and failing loudly beats processing a half-understood payload.
 */

// ── Payloads ────────────────────────────────────────────────────────────────

export const calculateJobMatchPayloadSchema = z.object({
  profileId: z.string().uuid(),
  jobId: z.string().uuid(),
  reason: z.string().max(200).default('job enriched'),
});
export type CalculateJobMatchPayload = z.infer<typeof calculateJobMatchPayloadSchema>;

export const recalculateJobMatchPayloadSchema = z.object({
  profileId: z.string().uuid(),
  jobId: z.string().uuid(),
  reason: z.string().max(200).default('recalculation requested'),
});
export type RecalculateJobMatchPayload = z.infer<typeof recalculateJobMatchPayloadSchema>;

export const recalculateCandidateMatchesPayloadSchema = z.object({
  profileId: z.string().uuid(),
  reason: z.string().max(200).default('preferences changed'),
  limit: z.number().int().min(1).max(10_000).optional(),
});
export type RecalculateCandidateMatchesPayload = z.infer<
  typeof recalculateCandidateMatchesPayloadSchema
>;

export const rebuildCandidateEmbeddingPayloadSchema = z.object({
  profileId: z.string().uuid(),
  reason: z.string().max(200).default('profile changed'),
  /** Rematch afterwards, since a new vector changes every semantic score. */
  rematch: z.boolean().default(true),
});
export type RebuildCandidateEmbeddingPayload = z.infer<
  typeof rebuildCandidateEmbeddingPayloadSchema
>;

export const rebuildJobEmbeddingsPayloadSchema = z.object({
  limit: z.number().int().min(1).max(5_000).default(200),
});
export type RebuildJobEmbeddingsPayload = z.infer<typeof rebuildJobEmbeddingsPayloadSchema>;

// ── Enqueueing ──────────────────────────────────────────────────────────────

/**
 * Type-safe producers.
 *
 * The `deduplicationId` on each is what makes at-least-once delivery tolerable:
 * enqueueing "recalculate everything for this candidate" five times while the
 * user edits five preferences must not produce five full rescoring runs.
 */
export class MatchingQueue {
  constructor(private readonly queue: QueueDriver) {}

  async calculateJobMatch(
    payload: CalculateJobMatchPayload,
    traceId: string,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const parsed = calculateJobMatchPayloadSchema.parse(payload);
    const key = `match:${parsed.profileId}:${parsed.jobId}`;
    return this.queue.enqueue(
      'match-triage',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  async recalculateJobMatch(
    payload: RecalculateJobMatchPayload,
    traceId: string,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const parsed = recalculateJobMatchPayloadSchema.parse(payload);
    // Timestamped so an explicit recalculation is never deduplicated away
    // against the original scoring job.
    const key = `rematch:${parsed.profileId}:${parsed.jobId}:${Date.now()}`;
    return this.queue.enqueue(
      'match-deep',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  async recalculateCandidateMatches(
    payload: RecalculateCandidateMatchesPayload,
    traceId: string,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const parsed = recalculateCandidateMatchesPayloadSchema.parse(payload);
    const key = `rematch-all:${parsed.profileId}`;
    return this.queue.enqueue(
      'match-deep',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      // Collapsed on the candidate alone: several preference edits in a row
      // should produce one rescoring run, not one per edit.
      { deduplicationId: key, ...options },
    );
  }

  async rebuildCandidateEmbedding(
    payload: RebuildCandidateEmbeddingPayload,
    traceId: string,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const parsed = rebuildCandidateEmbeddingPayloadSchema.parse(payload);
    const key = `embed-candidate:${parsed.profileId}`;
    return this.queue.enqueue(
      'embedding',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  async rebuildJobEmbeddings(
    payload: RebuildJobEmbeddingsPayload,
    traceId: string,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const parsed = rebuildJobEmbeddingsPayloadSchema.parse(payload);
    const key = `embed-jobs:${Date.now()}`;
    return this.queue.enqueue(
      'embedding',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────

export interface MatchingHandlerDependencies {
  matching: MatchingService;
  queue: MatchingQueue;
  logger: Logger;
}

/**
 * Consumers, as plain factories.
 *
 * Returned rather than self-registering so the worker owns concurrency and
 * queue wiring, and so each handler can be driven directly from a test without
 * a queue at all.
 */
export function createMatchingHandlers(deps: MatchingHandlerDependencies) {
  return {
    /** Score a newly enriched job for one candidate. */
    async calculateJobMatch(payload: QueuePayload<unknown>): Promise<void> {
      const input = calculateJobMatchPayloadSchema.parse(payload);
      const match = await deps.matching.matchJob(input.profileId, input.jobId, input.reason);
      deps.logger.debug('Job matched', {
        jobId: input.jobId,
        score: match.overallScore,
        recommendation: match.recommendation,
      });
    },

    /** Re-score one job, e.g. after re-enrichment. */
    async recalculateJobMatch(payload: QueuePayload<unknown>): Promise<void> {
      const input = recalculateJobMatchPayloadSchema.parse(payload);
      await deps.matching.matchJob(input.profileId, input.jobId, input.reason);
    },

    /** Re-score everything for one candidate after a preference change. */
    async recalculateCandidateMatches(payload: QueuePayload<unknown>): Promise<void> {
      const input = recalculateCandidateMatchesPayloadSchema.parse(payload);
      const result = await deps.matching.recalculateForCandidate(input.profileId, input.reason);
      deps.logger.info('Candidate matches recalculated', {
        profileId: input.profileId,
        matched: result.matched,
        failed: result.failed,
        reason: input.reason,
      });
    },

    /**
     * Regenerate the candidate vector, then rematch.
     *
     * The rematch is chained rather than assumed: a new profile vector changes
     * the semantic score of every job, and leaving the old scores in place
     * would show the candidate rankings computed against a profile they no
     * longer have.
     */
    async rebuildCandidateEmbedding(payload: QueuePayload<unknown>): Promise<void> {
      const input = rebuildCandidateEmbeddingPayloadSchema.parse(payload);
      const result = await deps.matching.rebuildCandidateEmbedding(input.profileId);
      deps.logger.info('Candidate embedding rebuild', { profileId: input.profileId, ...result });

      if (result.generated && input.rematch) {
        await deps.queue.recalculateCandidateMatches(
          { profileId: input.profileId, reason: 'candidate embedding regenerated' },
          payload.envelope.traceId,
        );
      }
    },

    /** Backfill missing job vectors. */
    async rebuildJobEmbeddings(payload: QueuePayload<unknown>): Promise<void> {
      const input = rebuildJobEmbeddingsPayloadSchema.parse(payload);
      const result = await deps.matching.backfillJobEmbeddings(input.limit);
      deps.logger.info('Job embeddings backfilled', result);
    },
  };
}
