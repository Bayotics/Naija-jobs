import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  NOTIFICATION_ENGINE_VERSION,
  notificationPreferencesSchema,
  type AlertPriority,
  type DeliveryEvent,
  type NotificationDecision,
  type NotificationPreferences,
  type NotificationType,
  type RenderedEmail,
} from '@job-intel/contracts';
import type { Database } from '../client';
import {
  notificationChannelDeliveries,
  notificationDecisions,
  notificationDeliveryEvents,
  notificationEvents,
  notificationPreferences,
  notifiedJobs,
  sourceAlertState,
} from '../schema/notification-engine';
import { jobs } from '../schema/jobs';

/**
 * Notification persistence.
 *
 * Two invariants are enforced here rather than trusted:
 *
 *  - **A job is notified once per candidate.** `notified_jobs` is keyed on the
 *    *canonical* job id with a unique constraint, so a job re-found through a
 *    second source cannot produce a second email even under concurrent workers.
 *  - **A delivery is attempted once per idempotency key.** The unique index on
 *    that column is what makes a retry after an ambiguous provider response
 *    safe; the application check is only an optimisation on top of it.
 */

export class NotificationRepository {
  constructor(private readonly db: Database) {}

  // ── Preferences ───────────────────────────────────────────────────────────

  /**
   * The candidate's settings, created on first access.
   *
   * Auto-initialisation matters: a profile with no row must behave as "the
   * defaults", not fail. Re-validated on read so a payload written by an older
   * schema upgrades cleanly or fails loudly.
   */
  async getPreferences(profileId: string): Promise<{
    preferences: NotificationPreferences;
    lastDigestAt: Date | null;
    lastWeeklySummaryAt: Date | null;
  }> {
    const rows = await this.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.profileId, profileId))
      .limit(1);

    const row = rows[0];
    if (row) {
      return {
        preferences: notificationPreferencesSchema.parse(row.payload),
        lastDigestAt: row.lastDigestAt,
        lastWeeklySummaryAt: row.lastWeeklySummaryAt,
      };
    }

    const defaults = notificationPreferencesSchema.parse({});
    await this.savePreferences(profileId, defaults);
    return { preferences: defaults, lastDigestAt: null, lastWeeklySummaryAt: null };
  }

  async savePreferences(
    profileId: string,
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    const parsed = notificationPreferencesSchema.parse(preferences);
    const values = {
      profileId,
      payload: parsed,
      digestEnabled: parsed.digestEnabled,
      digestFrequency: parsed.digestFrequency,
      timezone: parsed.timezone,
      updatedAt: new Date(),
    };

    await this.db
      .insert(notificationPreferences)
      .values(values)
      .onConflictDoUpdate({ target: notificationPreferences.profileId, set: values });

    return parsed;
  }

  async recordDigestSent(profileId: string, at = new Date()): Promise<void> {
    await this.db
      .update(notificationPreferences)
      .set({ lastDigestAt: at, updatedAt: at })
      .where(eq(notificationPreferences.profileId, profileId));
  }

  async recordWeeklySummarySent(profileId: string, at = new Date()): Promise<void> {
    await this.db
      .update(notificationPreferences)
      .set({ lastWeeklySummaryAt: at, updatedAt: at })
      .where(eq(notificationPreferences.profileId, profileId));
  }

  // ── Decision trace ────────────────────────────────────────────────────────

  /** Records every outcome, suppressions included. Chunked for large runs. */
  async recordDecisions(
    profileId: string,
    decisions: readonly NotificationDecision[],
    notificationId: string | null = null,
  ): Promise<number> {
    if (decisions.length === 0) return 0;

    const chunkSize = 200;
    for (let i = 0; i < decisions.length; i += chunkSize) {
      await this.db.insert(notificationDecisions).values(
        decisions.slice(i, i + chunkSize).map((decision) => ({
          profileId,
          jobId: decision.jobId,
          canonicalJobId: decision.canonicalJobId,
          outcome: decision.outcome,
          priority: decision.priority,
          reason: decision.reason,
          recommendationScore: decision.recommendationScore,
          matchScore: decision.matchScore,
          confidence: decision.confidence,
          deferredUntil: decision.deferredUntil,
          notificationId,
          engineVersion: NOTIFICATION_ENGINE_VERSION,
          decidedAt: decision.decidedAt,
        })),
      );
    }
    return decisions.length;
  }

  /** The answer to "why wasn't I told about this job?". */
  async decisionsForJob(profileId: string, jobId: string, limit = 20) {
    return this.db
      .select()
      .from(notificationDecisions)
      .where(
        and(
          eq(notificationDecisions.profileId, profileId),
          or(eq(notificationDecisions.jobId, jobId), eq(notificationDecisions.canonicalJobId, jobId)),
        ),
      )
      .orderBy(desc(notificationDecisions.decidedAt))
      .limit(limit);
  }

  async recentDecisions(profileId: string, limit = 100) {
    return this.db
      .select({ decision: notificationDecisions, job: jobs })
      .from(notificationDecisions)
      .leftJoin(jobs, eq(jobs.id, notificationDecisions.jobId))
      .where(eq(notificationDecisions.profileId, profileId))
      .orderBy(desc(notificationDecisions.decidedAt))
      .limit(limit);
  }

  async decisionCounts(profileId: string, since: Date) {
    const rows = await this.db
      .select({
        outcome: notificationDecisions.outcome,
        count: sql<number>`count(*)::int`,
      })
      .from(notificationDecisions)
      .where(
        and(
          eq(notificationDecisions.profileId, profileId),
          gte(notificationDecisions.decidedAt, since),
        ),
      )
      .groupBy(notificationDecisions.outcome);

    return Object.fromEntries(rows.map((row) => [row.outcome, row.count]));
  }

  // ── Events and deliveries ─────────────────────────────────────────────────

  /**
   * Creates an event and its email delivery in one transaction.
   *
   * Returns the existing row when the idempotency key is already present rather
   * than throwing: a re-render of identical content is a no-op, which is what
   * makes the whole pipeline safe to re-run.
   */
  async createEvent(input: {
    profileId: string;
    type: NotificationType;
    priority: AlertPriority;
    email: RenderedEmail;
    recipient: string;
    jobIds: string[];
    canonicalJobIds: string[];
    payload: Record<string, unknown>;
    maxAttempts?: number;
  }): Promise<{ eventId: string; deliveryId: string; created: boolean }> {
    const existing = await this.db
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.idempotencyKey, input.email.idempotencyKey))
      .limit(1);

    if (existing[0]) {
      const delivery = await this.db
        .select({ id: notificationChannelDeliveries.id })
        .from(notificationChannelDeliveries)
        .where(eq(notificationChannelDeliveries.eventId, existing[0].id))
        .limit(1);
      return {
        eventId: existing[0].id,
        deliveryId: delivery[0]?.id ?? '',
        created: false,
      };
    }

    return this.db.transaction(async (tx) => {
      const [event] = await tx
        .insert(notificationEvents)
        .values({
          profileId: input.profileId,
          type: input.type,
          priority: input.priority,
          subject: input.email.subject,
          jobIds: input.jobIds,
          canonicalJobIds: input.canonicalJobIds,
          html: input.email.html,
          textBody: input.email.text,
          idempotencyKey: input.email.idempotencyKey,
          payload: input.payload,
          engineVersion: NOTIFICATION_ENGINE_VERSION,
        })
        .returning({ id: notificationEvents.id });

      const [delivery] = await tx
        .insert(notificationChannelDeliveries)
        .values({
          eventId: event!.id,
          channel: 'email',
          recipient: input.recipient,
          status: 'queued',
          maxAttempts: input.maxAttempts ?? 5,
          idempotencyKey: input.email.idempotencyKey,
          nextAttemptAt: new Date(),
        })
        .returning({ id: notificationChannelDeliveries.id });

      await tx.insert(notificationDeliveryEvents).values({
        deliveryId: delivery!.id,
        event: 'created',
        detail: `${input.type} queued for ${input.recipient}`,
      });

      return { eventId: event!.id, deliveryId: delivery!.id, created: true };
    });
  }

  /** Deliveries due for an attempt, oldest first. */
  async pendingDeliveries(limit = 50) {
    const now = new Date();
    return this.db
      .select({ delivery: notificationChannelDeliveries, event: notificationEvents })
      .from(notificationChannelDeliveries)
      .innerJoin(
        notificationEvents,
        eq(notificationEvents.id, notificationChannelDeliveries.eventId),
      )
      .where(
        and(
          inArray(notificationChannelDeliveries.status, ['queued', 'sending']),
          or(
            isNull(notificationChannelDeliveries.nextAttemptAt),
            lte(notificationChannelDeliveries.nextAttemptAt, now),
          ),
          sql`${notificationChannelDeliveries.attempts} < ${notificationChannelDeliveries.maxAttempts}`,
        ),
      )
      .orderBy(notificationChannelDeliveries.createdAt)
      .limit(limit);
  }

  async recordAttempt(input: {
    deliveryId: string;
    status: 'sent' | 'failed' | 'queued';
    providerId: string;
    providerMessageId?: string | null;
    error?: string | null;
    nextAttemptAt?: Date | null;
  }): Promise<void> {
    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx
        .update(notificationChannelDeliveries)
        .set({
          status: input.status,
          attempts: sql`${notificationChannelDeliveries.attempts} + 1`,
          providerId: input.providerId,
          providerMessageId: input.providerMessageId ?? null,
          lastError: input.error ?? null,
          sentAt: input.status === 'sent' ? now : null,
          failedAt: input.status === 'failed' ? now : null,
          nextAttemptAt: input.nextAttemptAt ?? null,
          updatedAt: now,
        })
        .where(eq(notificationChannelDeliveries.id, input.deliveryId));

      await tx.insert(notificationDeliveryEvents).values({
        deliveryId: input.deliveryId,
        event: input.status === 'sent' ? 'sent' : input.status === 'failed' ? 'failed' : 'queued',
        detail: input.error ?? null,
        providerMessageId: input.providerMessageId ?? null,
        occurredAt: now,
      });
    });
  }

  /**
   * Records a provider webhook.
   *
   * Looked up by provider message id, so an unknown id is ignored rather than
   * throwing — webhooks arrive for messages from other environments, and an
   * error there would retry the webhook forever.
   */
  async recordDeliveryEvent(input: {
    providerMessageId: string;
    event: DeliveryEvent;
    detail?: string | null;
    occurredAt?: Date;
  }): Promise<boolean> {
    const rows = await this.db
      .select({ id: notificationChannelDeliveries.id })
      .from(notificationChannelDeliveries)
      .where(eq(notificationChannelDeliveries.providerMessageId, input.providerMessageId))
      .limit(1);

    const delivery = rows[0];
    if (!delivery) return false;

    const occurredAt = input.occurredAt ?? new Date();
    await this.db.transaction(async (tx) => {
      await tx.insert(notificationDeliveryEvents).values({
        deliveryId: delivery.id,
        event: input.event,
        detail: input.detail ?? null,
        providerMessageId: input.providerMessageId,
        occurredAt,
      });

      // Only terminal states move the delivery row. `opened` and `clicked` are
      // engagement, not delivery state, and must not overwrite `delivered`.
      const terminal: Partial<Record<DeliveryEvent, 'delivered' | 'bounced' | 'complained' | 'failed'>> = {
        delivered: 'delivered',
        bounced: 'bounced',
        complained: 'complained',
        failed: 'failed',
      };
      const status = terminal[input.event];
      if (status) {
        await tx
          .update(notificationChannelDeliveries)
          .set({
            status,
            deliveredAt: input.event === 'delivered' ? occurredAt : null,
            updatedAt: occurredAt,
          })
          .where(eq(notificationChannelDeliveries.id, delivery.id));
      }
    });

    return true;
  }

  async history(profileId: string, limit = 50) {
    return this.db
      .select({ event: notificationEvents, delivery: notificationChannelDeliveries })
      .from(notificationEvents)
      .leftJoin(
        notificationChannelDeliveries,
        eq(notificationChannelDeliveries.eventId, notificationEvents.id),
      )
      .where(eq(notificationEvents.profileId, profileId))
      .orderBy(desc(notificationEvents.createdAt))
      .limit(limit);
  }

  async getEvent(eventId: string) {
    const rows = await this.db
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.id, eventId))
      .limit(1);
    return rows[0] ?? null;
  }

  async deliveryTimeline(deliveryId: string) {
    return this.db
      .select()
      .from(notificationDeliveryEvents)
      .where(eq(notificationDeliveryEvents.deliveryId, deliveryId))
      .orderBy(notificationDeliveryEvents.occurredAt);
  }

  // ── Notified-job ledger ───────────────────────────────────────────────────

  /** Canonical ids already notified, as a map, for a whole ranking pass. */
  async loadNotifiedJobs(profileId: string): Promise<
    Map<string, { lastNotifiedAt: Date; count: number; fingerprint: string | null }>
  > {
    const rows = await this.db
      .select()
      .from(notifiedJobs)
      .where(eq(notifiedJobs.profileId, profileId));

    return new Map(
      rows.map((row) => [
        row.canonicalJobId,
        {
          lastNotifiedAt: row.lastNotifiedAt,
          count: row.notificationCount,
          fingerprint: row.contentFingerprint,
        },
      ]),
    );
  }

  /**
   * Marks canonical jobs as notified.
   *
   * The unique constraint does the real work: a concurrent worker attempting
   * the same insert updates the existing row instead of creating a second.
   */
  async markNotified(
    profileId: string,
    entries: ReadonlyArray<{
      canonicalJobId: string;
      priority: AlertPriority;
      score: number;
      fingerprint: string | null;
      eventId: string;
    }>,
    at = new Date(),
  ): Promise<number> {
    if (entries.length === 0) return 0;

    for (const entry of entries) {
      await this.db
        .insert(notifiedJobs)
        .values({
          profileId,
          canonicalJobId: entry.canonicalJobId,
          firstNotifiedAt: at,
          lastNotifiedAt: at,
          notificationCount: 1,
          lastPriority: entry.priority,
          lastScore: entry.score,
          contentFingerprint: entry.fingerprint,
          lastEventId: entry.eventId,
        })
        .onConflictDoUpdate({
          target: [notifiedJobs.profileId, notifiedJobs.canonicalJobId],
          set: {
            lastNotifiedAt: at,
            notificationCount: sql`${notifiedJobs.notificationCount} + 1`,
            lastPriority: entry.priority,
            lastScore: entry.score,
            contentFingerprint: entry.fingerprint,
            lastEventId: entry.eventId,
          },
        });
    }

    return entries.length;
  }

  /** Immediate alerts already sent inside a window, for the daily cap. */
  async countAlertsSince(profileId: string, since: Date): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationEvents)
      .where(
        and(
          eq(notificationEvents.profileId, profileId),
          eq(notificationEvents.type, 'JOB_ALERT'),
          gte(notificationEvents.createdAt, since),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  // ── Source alert state ────────────────────────────────────────────────────

  async getSourceAlertState(sourceId: string) {
    const rows = await this.db
      .select()
      .from(sourceAlertState)
      .where(eq(sourceAlertState.sourceId, sourceId))
      .limit(1);
    return rows[0] ?? null;
  }

  async recordSourceAlert(input: {
    sourceId: string;
    failures: number;
    severity: string;
    at?: Date;
  }): Promise<void> {
    const at = input.at ?? new Date();
    const values = {
      sourceId: input.sourceId,
      alertedAtFailures: input.failures,
      lastAlertedAt: at,
      lastSeverity: input.severity,
      recoveredAt: null,
    };
    await this.db
      .insert(sourceAlertState)
      .values(values)
      .onConflictDoUpdate({ target: sourceAlertState.sourceId, set: values });
  }

  /** Clears alert state when a source starts working again. */
  async recordSourceRecovery(sourceId: string, at = new Date()): Promise<void> {
    await this.db
      .update(sourceAlertState)
      .set({ alertedAtFailures: null, recoveredAt: at })
      .where(eq(sourceAlertState.sourceId, sourceId));
  }
}
