import { randomUUID } from 'node:crypto';
import type { QueueDriver } from '@job-intel/queue';
import { createEnvelope } from '@job-intel/queue';
import type { Logger } from '@job-intel/observability';
import type { ResumeService } from './resume-service';

/**
 * Candidate-intelligence queue jobs.
 *
 * The split follows the same rule as everywhere else in this system: the
 * request path does the minimum that must be synchronous, and everything that
 * can wait waits.
 *
 * Extraction itself is synchronous inside `upload` — the candidate is standing
 * at the screen and needs to know within a second or two whether their file was
 * readable, and telling them "we will email you if your PDF was a scan" is a
 * worse product than telling them now. What moves to the queue is everything
 * *after* that: rebuilding matrices against jobs, refreshing linked portfolios,
 * and recomputing the profile when nothing is waiting on it.
 *
 * Every job here is idempotent by construction. Profile rebuilds are a pure
 * function of stored extractions, matrices upsert on (candidate, job, version),
 * and a portfolio refetch overwrites its own row.
 */

export interface RebuildProfilePayload {
  candidateId: string;
}

export interface RefreshPortfolioPayload {
  candidateId: string;
  url: string;
}

export interface BuildMatrixPayload {
  candidateId: string;
  jobId: string;
  force?: boolean;
}

export interface ResumeJobDependencies {
  service: ResumeService;
  queue: QueueDriver;
  logger: Logger;
}

/**
 * Debounce window for profile rebuilds.
 *
 * Uploading three CVs in a row should produce one rebuild, not three — and the
 * middle two would be thrown away anyway, since each rebuild merges every
 * document the candidate has.
 */
const REBUILD_DEBOUNCE_MS = 20_000;

export function registerResumeJobs(deps: ResumeJobDependencies): void {
  const { service, queue, logger } = deps;

  // ── Rebuild the merged profile ───────────────────────────────────────────
  void queue.process<RebuildProfilePayload>('profile-rebuild', async (payload) => {
    const result = await service.rebuildProfile(payload.candidateId);

    logger.info('Candidate profile rebuilt', {
      candidateId: payload.candidateId,
      profileVersion: result.profile.profileVersion,
      conflictsDetected: result.conflictsDetected,
      skills: result.profile.skills.length,
    });
  });

  // ── Refresh a linked public profile ──────────────────────────────────────
  void queue.process<RefreshPortfolioPayload>('portfolio-refresh', async (payload) => {
    const result = await service.linkExternalProfile({
      candidateId: payload.candidateId,
      url: payload.url,
    });

    if (!result.ok) {
      // A portfolio that cannot be read is a normal outcome — accounts get
      // renamed and sites go down — and must not fail the job into a retry
      // storm against someone else's server.
      logger.warn('Portfolio refresh did not succeed', {
        candidateId: payload.candidateId,
        provider: result.provider,
        error: result.error,
      });
      return;
    }

    logger.info('Portfolio refreshed', {
      candidateId: payload.candidateId,
      provider: result.provider,
      skills: result.skills,
    });
  });

  // ── Precompute a requirement matrix ──────────────────────────────────────
  void queue.process<BuildMatrixPayload>('requirement-matrix', async (payload) => {
    const matrix = await service.matrixFor({
      candidateId: payload.candidateId,
      jobId: payload.jobId,
      force: payload.force ?? false,
    });

    if (!matrix) {
      logger.debug('No active profile; matrix skipped', {
        candidateId: payload.candidateId,
        jobId: payload.jobId,
      });
      return;
    }

    logger.debug('Requirement matrix computed', {
      candidateId: payload.candidateId,
      jobId: payload.jobId,
      coverage: matrix.coverageScore,
      unknowns: matrix.unknowns,
    });
  });
}

/** Enqueues a rebuild, collapsing bursts of uploads into one. */
export async function enqueueProfileRebuild(
  queue: QueueDriver,
  candidateId: string,
  traceId = randomUUID(),
): Promise<string> {
  const bucket = Math.floor(Date.now() / REBUILD_DEBOUNCE_MS);
  const key = `profile_rebuild:${candidateId}:${bucket}`;

  return queue.enqueue<RebuildProfilePayload>(
    'profile-rebuild',
    { candidateId, envelope: createEnvelope(traceId, key) },
    { deduplicationId: key, delayMs: 3_000 },
  );
}

export async function enqueuePortfolioRefresh(
  queue: QueueDriver,
  candidateId: string,
  url: string,
  traceId = randomUUID(),
): Promise<string> {
  const key = `portfolio:${candidateId}:${url}`;

  return queue.enqueue<RefreshPortfolioPayload>(
    'portfolio-refresh',
    { candidateId, url, envelope: createEnvelope(traceId, key) },
    { deduplicationId: key },
  );
}

/**
 * Enqueues matrix computation for a job the candidate is about to be shown.
 *
 * Keyed on the profile version as well as the pair, so a profile change
 * invalidates the queued work rather than reusing a matrix computed against a
 * person the profile no longer describes.
 */
export async function enqueueRequirementMatrix(
  queue: QueueDriver,
  candidateId: string,
  jobId: string,
  profileVersion: number,
  traceId = randomUUID(),
): Promise<string> {
  const key = `matrix:${candidateId}:${jobId}:${profileVersion}`;

  return queue.enqueue<BuildMatrixPayload>(
    'requirement-matrix',
    { candidateId, jobId, envelope: createEnvelope(traceId, key) },
    { deduplicationId: key },
  );
}
