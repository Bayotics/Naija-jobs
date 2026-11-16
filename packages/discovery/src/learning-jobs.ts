import type { QueueDriver, QueuePayload } from '@job-intel/queue';
import { createEnvelope } from '@job-intel/queue';
import type { BehaviorEventInput } from '@job-intel/contracts';
import type { Logger } from '@job-intel/observability';
import type { LearningService } from './learning-service';

/**
 * Learning queue jobs.
 *
 * Every one is idempotent, and the idempotency is structural rather than
 * defensive:
 *
 *  - `processBehaviorEvent` writes through a unique dedupe key, so redelivery
 *    inserts nothing.
 *  - `updateBehavioralProfile` only reads events with `processed_at IS NULL`,
 *    so a retry after a partial success re-reads nothing.
 *  - The recompute jobs are pure functions of stored state, so running one
 *    twice produces the same rows.
 *
 * The shape matters for the performance requirement. Ingestion is a single
 * insert with no aggregation; aggregation is a separate, debounced job. That is
 * how a hundred thousand events cost a hundred thousand inserts and a handful
 * of recomputations rather than a hundred thousand profile rebuilds.
 */

export interface ProcessBehaviorEventPayload {
  event: BehaviorEventInput;
}

export interface CandidateScopedPayload {
  candidateId: string;
  windowDays?: number;
  full?: boolean;
}

export interface LearningJobDependencies {
  service: LearningService;
  queue: QueueDriver;
  logger: Logger;
}

/**
 * Debounce window for profile recomputation.
 *
 * A burst of clicks should produce one recomputation, not twenty. The
 * deduplication id collapses enqueues within the window, which is why this is a
 * queue concern rather than a timer in the service.
 */
const PROFILE_DEBOUNCE_MS = 30_000;

export function registerLearningJobs(deps: LearningJobDependencies): void {
  const { service, queue, logger } = deps;

  // ── Ingest one interaction ───────────────────────────────────────────────
  void queue.process<ProcessBehaviorEventPayload>('feedback', async (payload) => {
    const result = await service.recordEvent(payload.event);

    if (result.duplicate) {
      logger.debug('Behaviour event already recorded', {
        candidateId: payload.event.candidateId,
        eventType: payload.event.eventType,
      });
      return;
    }

    // Aggregation is a *separate* job, debounced. Doing it inline would make
    // every click pay for a profile rebuild.
    await enqueueProfileUpdate(queue, payload.event.candidateId);
  });

  // ── Fold events into affinities ──────────────────────────────────────────
  void queue.process<CandidateScopedPayload>('learning', async (payload) => {
    const result = await service.updateBehavioralProfile(payload.candidateId, {
      ...(payload.full ? { full: true } : {}),
      ...(payload.windowDays !== undefined ? { sinceDays: payload.windowDays } : {}),
    });

    logger.info('Behavioural profile updated', {
      candidateId: payload.candidateId,
      eventsProcessed: result.eventsProcessed,
      affinities: result.affinities,
    });
  });

  // ── Periodic recomputation ───────────────────────────────────────────────
  void queue.process<CandidateScopedPayload>('maintenance', async (payload) => {
    if (!payload.candidateId) return;

    await service.updatePerformance(payload.candidateId, payload.windowDays ?? 30);
    await service.computeAnalytics(payload.candidateId, payload.windowDays ?? 30);
    await service.generatePreferenceSuggestions(payload.candidateId);

    logger.info('Learning maintenance complete', { candidateId: payload.candidateId });
  });
}

/** Enqueues one interaction. Cheap and safe to call from a request handler. */
export async function enqueueBehaviorEvent(
  queue: QueueDriver,
  event: BehaviorEventInput,
  traceId = crypto.randomUUID(),
): Promise<string> {
  const key = `behavior:${event.candidateId}:${event.jobId ?? 'none'}:${event.eventType}:${
    event.occurredAt instanceof Date ? event.occurredAt.getTime() : Date.now()
  }`;

  return queue.enqueue<ProcessBehaviorEventPayload>(
    'feedback',
    { event, envelope: createEnvelope(traceId, key) },
    { deduplicationId: key },
  );
}

/**
 * Enqueues a profile update, collapsing bursts.
 *
 * The deduplication id is bucketed to the debounce window, so twenty clicks in
 * thirty seconds produce one recomputation rather than twenty.
 */
export async function enqueueProfileUpdate(
  queue: QueueDriver,
  candidateId: string,
  traceId = crypto.randomUUID(),
): Promise<string> {
  const bucket = Math.floor(Date.now() / PROFILE_DEBOUNCE_MS);
  const key = `profile:${candidateId}:${bucket}`;

  return queue.enqueue<CandidateScopedPayload>(
    'learning',
    { candidateId, envelope: createEnvelope(traceId, key) },
    { deduplicationId: key, delayMs: 5_000 },
  );
}

/** Full recomputation, for an algorithm-version bump. */
export async function enqueueFullRecompute(
  queue: QueueDriver,
  candidateId: string,
  traceId = crypto.randomUUID(),
): Promise<string> {
  const key = `recompute:${candidateId}:${Date.now()}`;
  return queue.enqueue<CandidateScopedPayload>(
    'learning',
    { candidateId, full: true, envelope: createEnvelope(traceId, key) },
    { deduplicationId: key },
  );
}

/** Periodic performance, analytics and suggestion refresh. */
export async function enqueueLearningMaintenance(
  queue: QueueDriver,
  candidateId: string,
  windowDays = 30,
  traceId = crypto.randomUUID(),
): Promise<string> {
  // Bucketed to the hour: maintenance is not urgent, and running it repeatedly
  // within an hour would recompute identical numbers.
  const key = `learning-maintenance:${candidateId}:${Math.floor(Date.now() / 3_600_000)}`;

  return queue.enqueue<CandidateScopedPayload>(
    'maintenance',
    { candidateId, windowDays, envelope: createEnvelope(traceId, key) },
    { deduplicationId: key },
  );
}

/** Type guard used by the worker to route payloads. */
export function isCandidateScopedPayload(
  payload: QueuePayload<unknown>,
): payload is QueuePayload<CandidateScopedPayload> {
  return typeof (payload as { candidateId?: unknown }).candidateId === 'string';
}
