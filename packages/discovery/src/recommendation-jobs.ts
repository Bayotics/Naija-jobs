import { z } from 'zod';
import {
  createEnvelope,
  type EnqueueOptions,
  type QueueDriver,
  type QueuePayload,
} from '@job-intel/queue';
import type { Logger } from '@job-intel/observability';
import type { RecommendationService } from './recommendation-service';

/**
 * Recommendation work as queue jobs.
 *
 * Every handler is **idempotent**, which at-least-once delivery makes a
 * requirement rather than a nicety:
 *
 *  - `deduplicateJob` upserts on the (job, duplicate-of) pair.
 *  - `calculateQuality` / `recalculateFreshness` upsert one signals row.
 *  - `rankRecommendations` replaces the candidate's list wholesale.
 *  - `verifyJob` appends a check, and appending the same check twice records
 *    two observations of the same fact — which is true, and harmless.
 *
 * Running any of these twice therefore produces the same state as running it
 * once, so a redelivery after a worker crash needs no reconciliation.
 */

const jobRef = z.object({ jobId: z.string().uuid() });
const profileRef = z.object({ profileId: z.string().uuid() });

export const deduplicateJobPayloadSchema = jobRef.extend({
  reason: z.string().max(200).default('job discovered'),
});
export type DeduplicateJobPayload = z.infer<typeof deduplicateJobPayloadSchema>;

export const verifyJobPayloadSchema = jobRef.extend({
  reason: z.string().max(200).default('scheduled verification'),
});
export type VerifyJobPayload = z.infer<typeof verifyJobPayloadSchema>;

export const calculateQualityPayloadSchema = z.object({
  jobIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  limit: z.number().int().min(1).max(2000).default(500),
});
export type CalculateQualityPayload = z.infer<typeof calculateQualityPayloadSchema>;

export const recalculateFreshnessPayloadSchema = z.object({
  /** Recompute signals older than this. Freshness decays continuously. */
  staleAfterHours: z.number().int().min(1).max(720).default(12),
  limit: z.number().int().min(1).max(5000).default(1000),
});
export type RecalculateFreshnessPayload = z.infer<typeof recalculateFreshnessPayloadSchema>;

export const rankRecommendationsPayloadSchema = profileRef.extend({
  reason: z.string().max(200).default('scheduled ranking'),
  /** Verify the top application URLs before ranking is published. */
  verifyHighValue: z.boolean().default(false),
});
export type RankRecommendationsPayload = z.infer<typeof rankRecommendationsPayloadSchema>;

export const detectStaleJobPayloadSchema = z.object({
  limit: z.number().int().min(1).max(5000).default(500),
});
export type DetectStaleJobPayload = z.infer<typeof detectStaleJobPayloadSchema>;

export const reverifyHighValuePayloadSchema = profileRef.extend({
  reason: z.string().max(200).default('pre-notification verification'),
});
export type ReverifyHighValuePayload = z.infer<typeof reverifyHighValuePayloadSchema>;

// ── Producers ───────────────────────────────────────────────────────────────

/**
 * Type-safe enqueue helpers.
 *
 * `deduplicationId` collapses redundant work: ranking the same candidate five
 * times while five jobs arrive should produce one ranking pass, not five.
 */
export class RecommendationQueue {
  constructor(private readonly queue: QueueDriver) {}

  async deduplicateJob(payload: DeduplicateJobPayload, traceId: string, options: EnqueueOptions = {}) {
    const parsed = deduplicateJobPayloadSchema.parse(payload);
    const key = `dedup:${parsed.jobId}`;
    return this.queue.enqueue(
      'dedup',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  async verifyJob(payload: VerifyJobPayload, traceId: string, options: EnqueueOptions = {}) {
    const parsed = verifyJobPayloadSchema.parse(payload);
    const key = `verify:${parsed.jobId}:${Date.now()}`;
    return this.queue.enqueue(
      'validation',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  async calculateQuality(payload: CalculateQualityPayload, traceId: string, options: EnqueueOptions = {}) {
    const parsed = calculateQualityPayloadSchema.parse(payload);
    const key = `quality:${Date.now()}`;
    return this.queue.enqueue(
      'validation',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  async recalculateFreshness(
    payload: RecalculateFreshnessPayload,
    traceId: string,
    options: EnqueueOptions = {},
  ) {
    const parsed = recalculateFreshnessPayloadSchema.parse(payload);
    // Collapsed on the hour: freshness moves continuously but not usefully
    // faster than that, and a job per posting would be pure churn.
    const key = `freshness:${new Date().toISOString().slice(0, 13)}`;
    return this.queue.enqueue(
      'maintenance',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  async rankRecommendations(
    payload: RankRecommendationsPayload,
    traceId: string,
    options: EnqueueOptions = {},
  ) {
    const parsed = rankRecommendationsPayloadSchema.parse(payload);
    const key = `rank:${parsed.profileId}`;
    return this.queue.enqueue(
      'ranking',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  async detectStaleJob(payload: DetectStaleJobPayload, traceId: string, options: EnqueueOptions = {}) {
    const parsed = detectStaleJobPayloadSchema.parse(payload);
    const key = `stale:${new Date().toISOString().slice(0, 13)}`;
    return this.queue.enqueue(
      'maintenance',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  async reverifyHighValueJob(
    payload: ReverifyHighValuePayload,
    traceId: string,
    options: EnqueueOptions = {},
  ) {
    const parsed = reverifyHighValuePayloadSchema.parse(payload);
    const key = `reverify:${parsed.profileId}`;
    return this.queue.enqueue(
      'validation',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }
}

// ── Consumers ───────────────────────────────────────────────────────────────

export interface RecommendationHandlerDependencies {
  recommendations: RecommendationService;
  queue: RecommendationQueue;
  logger: Logger;
}

/**
 * Handlers, as plain factories.
 *
 * Returned rather than self-registering so the worker owns queue wiring and
 * concurrency, and so each can be driven from a test with no queue at all.
 */
export function createRecommendationHandlers(deps: RecommendationHandlerDependencies) {
  return {
    async deduplicateJob(payload: QueuePayload<unknown>): Promise<void> {
      const input = deduplicateJobPayloadSchema.parse(payload);
      const result = await deps.recommendations.deduplicate([input.jobId]);
      if (result.merged > 0) {
        deps.logger.debug('Job merged as duplicate', { jobId: input.jobId, ...result });
      }
    },

    async calculateQuality(payload: QueuePayload<unknown>): Promise<void> {
      const input = calculateQualityPayloadSchema.parse(payload);
      const updated = await deps.recommendations.refreshSignals({
        limit: input.limit,
        // Explicit recalculation ignores the cache window entirely.
        staleAfterHours: 0,
      });
      deps.logger.info('Quality signals recalculated', { updated });
    },

    async recalculateFreshness(payload: QueuePayload<unknown>): Promise<void> {
      const input = recalculateFreshnessPayloadSchema.parse(payload);
      const updated = await deps.recommendations.refreshSignals({
        limit: input.limit,
        staleAfterHours: input.staleAfterHours,
      });
      deps.logger.info('Freshness recalculated', { updated });
    },

    async detectStaleJob(payload: QueuePayload<unknown>): Promise<void> {
      const input = detectStaleJobPayloadSchema.parse(payload);
      // Staleness is one of the signals, so recomputing signals *is* stale
      // detection. Kept as its own job because it wants a different cadence.
      const updated = await deps.recommendations.refreshSignals({
        limit: input.limit,
        staleAfterHours: 6,
      });
      deps.logger.info('Stale detection complete', { updated });
    },

    async reverifyHighValueJob(payload: QueuePayload<unknown>): Promise<void> {
      const input = reverifyHighValuePayloadSchema.parse(payload);
      const result = await deps.recommendations.verifyHighValue(input.profileId);
      deps.logger.info('High-value re-verification complete', {
        profileId: input.profileId,
        ...result,
      });
    },

    /**
     * The stage that produces the list a digest will consume.
     *
     * Verification runs *before* ranking when requested, so a job whose
     * application URL has just died is demoted rather than emailed.
     */
    async rankRecommendations(payload: QueuePayload<unknown>): Promise<void> {
      const input = rankRecommendationsPayloadSchema.parse(payload);

      if (input.verifyHighValue) {
        await deps.recommendations.verifyHighValue(input.profileId);
        await deps.recommendations.refreshSignals({ limit: 500, staleAfterHours: 0 });
      }

      const result = await deps.recommendations.rank(input.profileId);
      deps.logger.info('Recommendations ranked', {
        profileId: input.profileId,
        ranked: result.ranked,
        notifiable: result.notifiable,
        reason: input.reason,
      });
    },
  };
}
