import { z } from 'zod';
import {
  createEnvelope,
  type EnqueueOptions,
  type QueueDriver,
  type QueuePayload,
} from '@job-intel/queue';
import type { Logger } from '@job-intel/observability';
import type { NotificationService } from './notification-service';

/**
 * Notification work as queue jobs.
 *
 * The brief rules out in-memory timers, and rightly: a `setInterval` holding
 * the digest schedule loses every pending send on a deploy and silently stops
 * if the process wedges. These are ordinary queue jobs on the driver the rest
 * of the system already uses, so they survive restarts and are observable.
 *
 * Every handler is idempotent. `processImmediateAlerts` and `generateDigest`
 * both funnel into the same decision pass, whose events are keyed on content —
 * running either twice produces one email, not two.
 */

const profileRef = z.object({ profileId: z.string().uuid() });

export const processImmediateAlertsPayloadSchema = profileRef.extend({
  reason: z.string().max(200).default('new recommendations'),
});
export type ProcessImmediateAlertsPayload = z.infer<typeof processImmediateAlertsPayloadSchema>;

export const generateDigestPayloadSchema = profileRef.extend({
  /** Send regardless of whether the cadence says it is due. */
  force: z.boolean().default(false),
  reason: z.string().max(200).default('scheduled digest'),
});
export type GenerateDigestPayload = z.infer<typeof generateDigestPayloadSchema>;

export const processSourceHealthPayloadSchema = profileRef.extend({
  reason: z.string().max(200).default('scheduled health check'),
});
export type ProcessSourceHealthPayload = z.infer<typeof processSourceHealthPayloadSchema>;

export const processWeeklySummaryPayloadSchema = profileRef.extend({
  reason: z.string().max(200).default('weekly summary'),
});
export type ProcessWeeklySummaryPayload = z.infer<typeof processWeeklySummaryPayloadSchema>;

export const deliverNotificationsPayloadSchema = z.object({
  limit: z.number().int().min(1).max(200).default(20),
});
export type DeliverNotificationsPayload = z.infer<typeof deliverNotificationsPayloadSchema>;

// ── Producers ───────────────────────────────────────────────────────────────

export class NotificationQueue {
  constructor(private readonly queue: QueueDriver) {}

  async processImmediateAlerts(
    payload: ProcessImmediateAlertsPayload,
    traceId: string,
    options: EnqueueOptions = {},
  ) {
    const parsed = processImmediateAlertsPayloadSchema.parse(payload);
    // Collapsed on the candidate: a burst of new recommendations should produce
    // one decision pass, not one per job.
    const key = `alerts:${parsed.profileId}`;
    return this.queue.enqueue(
      'notification',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  async generateDigest(
    payload: GenerateDigestPayload,
    traceId: string,
    options: EnqueueOptions = {},
  ) {
    const parsed = generateDigestPayloadSchema.parse(payload);
    // Hour-scoped so a scheduler firing twice in one window is a no-op.
    const key = `digest:${parsed.profileId}:${new Date().toISOString().slice(0, 13)}`;
    return this.queue.enqueue(
      'notification',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  async processSourceHealthAlerts(
    payload: ProcessSourceHealthPayload,
    traceId: string,
    options: EnqueueOptions = {},
  ) {
    const parsed = processSourceHealthPayloadSchema.parse(payload);
    const key = `health:${parsed.profileId}:${new Date().toISOString().slice(0, 13)}`;
    return this.queue.enqueue(
      'notification',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  async processWeeklySummary(
    payload: ProcessWeeklySummaryPayload,
    traceId: string,
    options: EnqueueOptions = {},
  ) {
    const parsed = processWeeklySummaryPayloadSchema.parse(payload);
    const key = `weekly:${parsed.profileId}:${new Date().toISOString().slice(0, 10)}`;
    return this.queue.enqueue(
      'notification',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }

  /** The send pass. Runs often and independently of any decision pass. */
  async deliverNotifications(
    payload: DeliverNotificationsPayload,
    traceId: string,
    options: EnqueueOptions = {},
  ) {
    const parsed = deliverNotificationsPayloadSchema.parse(payload);
    const key = `deliver:${new Date().toISOString().slice(0, 16)}`;
    return this.queue.enqueue(
      'notification',
      { ...parsed, envelope: createEnvelope(traceId, key) },
      { deduplicationId: key, ...options },
    );
  }
}

// ── Consumers ───────────────────────────────────────────────────────────────

export interface NotificationHandlerDependencies {
  notifications: NotificationService;
  logger: Logger;
  /** Supplies the stats a weekly summary reports. */
  weeklyStats?: (profileId: string) => Promise<Parameters<NotificationService['sendWeeklySummary']>[1]>;
}

export function createNotificationHandlers(deps: NotificationHandlerDependencies) {
  return {
    /**
     * Decides and queues immediate alerts.
     *
     * Shares the decision pass with the digest handler: the two are not
     * separate pipelines, they are two outputs of one decision, and splitting
     * them would let a job be alerted *and* digested in the same run.
     */
    async processImmediateAlerts(payload: QueuePayload<unknown>): Promise<void> {
      const input = processImmediateAlertsPayloadSchema.parse(payload);
      const result = await deps.notifications.processCandidate(input.profileId, {
        reason: input.reason,
      });
      deps.logger.info('Immediate alert pass complete', {
        profileId: input.profileId,
        alerts: result.immediateAlerts,
        suppressed: result.suppressed,
      });
    },

    async generateDigest(payload: QueuePayload<unknown>): Promise<void> {
      const input = generateDigestPayloadSchema.parse(payload);
      const result = await deps.notifications.processCandidate(input.profileId, {
        forceDigest: input.force,
        reason: input.reason,
      });
      deps.logger.info('Digest pass complete', {
        profileId: input.profileId,
        sent: result.digestSent,
        jobs: result.digestJobs,
      });
    },

    async processSourceHealthAlerts(payload: QueuePayload<unknown>): Promise<void> {
      const input = processSourceHealthPayloadSchema.parse(payload);
      const result = await deps.notifications.processSourceHealth(input.profileId);
      deps.logger.info('Source health pass complete', { profileId: input.profileId, ...result });
    },

    async processWeeklySummary(payload: QueuePayload<unknown>): Promise<void> {
      const input = processWeeklySummaryPayloadSchema.parse(payload);
      if (!deps.weeklyStats) {
        deps.logger.warn('No weekly stats provider configured; summary skipped');
        return;
      }
      const stats = await deps.weeklyStats(input.profileId);
      const eventId = await deps.notifications.sendWeeklySummary(input.profileId, stats);
      deps.logger.info('Weekly summary pass complete', {
        profileId: input.profileId,
        queued: eventId !== null,
      });
    },

    /** Attempts pending sends. Independent, so a provider outage stalls only this. */
    async deliverNotifications(payload: QueuePayload<unknown>): Promise<void> {
      const input = deliverNotificationsPayloadSchema.parse(payload);
      const result = await deps.notifications.processDeliveries(input.limit);
      if (result.attempted > 0) deps.logger.info('Delivery pass complete', { ...result });
    },
  };
}
