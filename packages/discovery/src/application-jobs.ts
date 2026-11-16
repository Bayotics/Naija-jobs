import type { QueueDriver } from '@job-intel/queue';
import { createEnvelope } from '@job-intel/queue';
import type { Logger } from '@job-intel/observability';
import type { ApplicationService } from './application-service';

/**
 * Application-intelligence queue jobs.
 *
 * Two jobs, and a deliberate absence.
 *
 * `application-analyse` recomputes one job's recommendation.
 * `application-analyse-all` sweeps everything that needs it.
 *
 * What is *not* here is any job that submits an application, approves an
 * opportunity, or advances one past RECOMMENDED. That is not an oversight to be
 * filled in later — the repository rejects a `system` actor on those
 * transitions, so such a job could not work even if someone wrote it. The
 * absence is the feature.
 *
 * Both jobs are idempotent: analysis upserts on (candidate, job, profile
 * version), and re-running produces the same row unless an input changed.
 */

export interface AnalyseJobPayload {
  candidateId: string;
  jobId: string;
}

export interface AnalyseAllPayload {
  candidateId: string;
  limit?: number;
}

export interface ApplicationJobDependencies {
  service: ApplicationService;
  queue: QueueDriver;
  logger: Logger;
}

export function registerApplicationJobs(deps: ApplicationJobDependencies): void {
  const { service, queue, logger } = deps;

  // ── One job ──────────────────────────────────────────────────────────────
  void queue.process<AnalyseJobPayload>('application-analyse', async (payload) => {
    const { intelligence } = await service.analyse(payload.candidateId, payload.jobId);

    logger.info('Application intelligence computed', {
      candidateId: payload.candidateId,
      jobId: payload.jobId,
      recommendation: intelligence.overallRecommendation,
      valueScore: intelligence.applicationValueScore,
      confidence: intelligence.confidence,
      blockers: intelligence.blockers.length,
    });
  });

  // ── Everything that needs it ─────────────────────────────────────────────
  void queue.process<AnalyseAllPayload>('application-analyse-all', async (payload) => {
    const result = await service.analyseAll(payload.candidateId, {
      ...(payload.limit !== undefined ? { limit: payload.limit } : {}),
    });

    logger.info('Application analysis run complete', {
      candidateId: payload.candidateId,
      considered: result.considered,
      analysed: result.analysed,
      failed: result.failed,
      durationMs: result.durationMs,
      ...result.byRecommendation,
    });

    /*
     * A run that fails on most of what it touched is worth surfacing.
     *
     * Individual failures are expected — a posting with no enrichment, a job
     * deleted mid-run — but a majority failure means something systemic, and it
     * should not look like a quiet success in the logs.
     */
    if (result.failed > result.analysed && result.considered > 5) {
      logger.warn('Most jobs failed application analysis', {
        candidateId: payload.candidateId,
        failed: result.failed,
        analysed: result.analysed,
        sample: result.errors.slice(0, 3),
      });
    }
  });
}

/**
 * Enqueues analysis for one job.
 *
 * Deduplicated on (candidate, job): the same analysis queued twice is one piece
 * of work, and the result would be identical anyway.
 */
export async function enqueueAnalysis(
  queue: QueueDriver,
  payload: AnalyseJobPayload,
  traceId: string,
): Promise<string> {
  const key = `application:${payload.candidateId}:${payload.jobId}`;
  return queue.enqueue(
    'application-analyse',
    { ...payload, envelope: createEnvelope(traceId, key) },
    { deduplicationId: key },
  );
}

/** Enqueues a full sweep for one candidate. */
export async function enqueueAnalyseAll(
  queue: QueueDriver,
  payload: AnalyseAllPayload,
  traceId: string,
): Promise<string> {
  const key = `application-all:${payload.candidateId}`;
  return queue.enqueue(
    'application-analyse-all',
    { ...payload, envelope: createEnvelope(traceId, key) },
    { deduplicationId: key },
  );
}
