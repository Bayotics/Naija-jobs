import type { QueueDriver } from '@job-intel/queue';
import { createEnvelope } from '@job-intel/queue';
import type { Logger } from '@job-intel/observability';
import type { NotificationIntelligenceService } from './notification-intelligence-service';

/**
 * Notification intelligence queue jobs.
 *
 * The architectural point the brief makes in Part 37 lives here: **scan
 * frequency and notification frequency are different things.** Discovery may
 * run hourly; that produces scoring work, not emails. Whether an email goes out
 * is decided by the score, the thresholds and the candidate's chosen cadence —
 * three separate settings, none of them coupled to how often the crawler runs.
 *
 * So there are two jobs. One scores; one assembles a digest on the candidate's
 * schedule. Neither sends anything on its own — the existing prompt-8 delivery
 * path owns that, and giving this layer a second one would mean two systems
 * that both believe they own the inbox.
 */

export interface ScoreNotificationsPayload {
  candidateId: string;
  /** Specific jobs, when discovery has just produced them. */
  jobIds?: string[];
  limit?: number;
}

export interface PlanDigestPayload {
  candidateId: string;
  type: 'DAILY_DIGEST' | 'WEEKLY_DIGEST';
  /** Hours the digest covers. Explicit so a replay is reproducible. */
  windowHours: number;
}

export interface NotificationIntelligenceJobDependencies {
  service: NotificationIntelligenceService;
  queue: QueueDriver;
  logger: Logger;
}

export function registerNotificationIntelligenceJobs(
  deps: NotificationIntelligenceJobDependencies,
): void {
  const { service, queue, logger } = deps;

  // ── Scoring ──────────────────────────────────────────────────────────────
  void queue.process<ScoreNotificationsPayload>('notification-score', async (payload) => {
    const result = await service.runFor(payload.candidateId, {
      ...(payload.jobIds ? { jobIds: payload.jobIds } : {}),
      ...(payload.limit !== undefined ? { limit: payload.limit } : {}),
    });

    logger.info('Notification scoring complete', {
      candidateId: payload.candidateId,
      considered: result.considered,
      instant: result.instant,
      digest: result.digest,
      dashboard: result.dashboard,
      suppressed: result.suppressed,
      durationMs: result.durationMs,
    });

    /*
     * A run that alerts on most of what it saw is a broken run.
     *
     * The layer exists to be selective, and a majority-instant pass means a
     * threshold has been set too low or a scoring change has drifted. Worth a
     * warning rather than a silent flood of email.
     */
    if (result.considered >= 20 && result.instant > result.considered / 2) {
      logger.warn('Notification scoring alerted on most of what it saw', {
        candidateId: payload.candidateId,
        instant: result.instant,
        considered: result.considered,
      });
    }
  });

  // ── Digest assembly ──────────────────────────────────────────────────────
  void queue.process<PlanDigestPayload>('notification-digest', async (payload) => {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - payload.windowHours * 3_600_000);

    const { plan, verdict } = await service.buildDigest(payload.candidateId, {
      windowStart,
      windowEnd,
      type: payload.type,
    });

    logger.info('Digest planned', {
      candidateId: payload.candidateId,
      type: payload.type,
      totalJobs: plan.totalJobs,
      sections: plan.sections.length,
      willSend: verdict.send,
      reason: verdict.reason,
      excluded: plan.excluded,
    });
  });
}

/** Enqueues a scoring pass. Deduplicated per candidate. */
export async function enqueueNotificationScoring(
  queue: QueueDriver,
  payload: ScoreNotificationsPayload,
  traceId: string,
): Promise<string> {
  const key = `notification-score:${payload.candidateId}`;
  return queue.enqueue(
    'notification-score',
    { ...payload, envelope: createEnvelope(traceId, key) },
    { deduplicationId: key },
  );
}

/**
 * Enqueues a digest plan.
 *
 * Keyed on the window rather than the candidate, so two firings for the same
 * window collapse and a firing for the next one does not.
 */
export async function enqueueDigestPlan(
  queue: QueueDriver,
  payload: PlanDigestPayload,
  traceId: string,
): Promise<string> {
  const window = Math.floor(Date.now() / (payload.windowHours * 3_600_000));
  const key = `notification-digest:${payload.candidateId}:${payload.type}:${window}`;

  return queue.enqueue(
    'notification-digest',
    { ...payload, envelope: createEnvelope(traceId, key) },
    { deduplicationId: key },
  );
}
