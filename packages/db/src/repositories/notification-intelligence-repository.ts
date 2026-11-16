import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  notificationIntelligenceConfigSchema,
  notificationOverrideSchema,
  notificationRecordSchema,
  notificationScoreSchema,
  suppressionRecordSchema,
  type NotificationIntelligenceConfig,
  type NotificationOverride,
  type NotificationRecord,
  type NotificationScore,
  type NotificationState,
  type NotificationType,
  type SuppressionRecord,
} from '@job-intel/contracts';
import type { Database } from '../client';
import {
  digestPlans,
  discoveryProfileCounts,
  notificationAddressHealth,
  notificationIntelligenceConfigs,
  notificationOverrides,
  notificationRecords,
  notificationScores,
  notificationSuppressions,
} from '../schema/notification-intelligence';
import { jobs } from '../schema/jobs';

/**
 * Notification intelligence persistence.
 *
 * Two invariants live here rather than in callers.
 *
 * **Sending is idempotent.** `dedupeKey` is a unique index and every insert
 * uses `onConflictDoNothing`. A queue that delivers at-least-once is the normal
 * case, and a retried job that becomes a second email is precisely the failure
 * this whole layer exists to prevent — so the guard is in the database, where a
 * concurrent worker cannot race past it.
 *
 * **Suppressions are current, not historical.** One row per (candidate, job),
 * rewritten each pass. The candidate wants to know why they are not hearing
 * about a job *now*; a hundred rows saying "below threshold" answer a question
 * nobody asked.
 */
export class NotificationIntelligenceRepository {
  constructor(private readonly db: Database) {}

  // ── Configuration ─────────────────────────────────────────────────────────

  async getConfig(candidateId: string): Promise<NotificationIntelligenceConfig> {
    const [row] = await this.db
      .select()
      .from(notificationIntelligenceConfigs)
      .where(eq(notificationIntelligenceConfigs.candidateId, candidateId))
      .limit(1);

    return notificationIntelligenceConfigSchema.parse(row?.config ?? {});
  }

  async setConfig(
    candidateId: string,
    config: NotificationIntelligenceConfig,
  ): Promise<NotificationIntelligenceConfig> {
    const parsed = notificationIntelligenceConfigSchema.parse({ ...config, updatedAt: new Date() });

    await this.db
      .insert(notificationIntelligenceConfigs)
      .values({ candidateId, config: parsed, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: notificationIntelligenceConfigs.candidateId,
        set: { config: parsed, updatedAt: new Date() },
      });

    return parsed;
  }

  // ── Overrides ─────────────────────────────────────────────────────────────

  async listOverrides(candidateId: string): Promise<NotificationOverride[]> {
    const rows = await this.db
      .select()
      .from(notificationOverrides)
      .where(eq(notificationOverrides.candidateId, candidateId))
      .limit(500);

    return rows
      .map((row) => notificationOverrideSchema.safeParse(row))
      .filter((parsed): parsed is { success: true; data: NotificationOverride } => parsed.success)
      .map((parsed) => parsed.data);
  }

  async addOverride(input: {
    candidateId: string;
    subject: NotificationOverride['subject'];
    value: string;
    action: NotificationOverride['action'];
    note?: string | null;
  }): Promise<void> {
    await this.db
      .insert(notificationOverrides)
      .values({
        candidateId: input.candidateId,
        subject: input.subject,
        value: input.value,
        action: input.action,
        note: input.note ?? null,
      })
      /*
       * Re-stating a rule with a different action replaces it.
       *
       * Someone switching a company from "always" to "never" is changing their
       * mind, not adding a second contradictory rule — and leaving both would
       * make the precedence resolution do work the candidate did not intend.
       */
      .onConflictDoUpdate({
        target: [notificationOverrides.candidateId, notificationOverrides.subject, notificationOverrides.value],
        set: { action: input.action, note: input.note ?? null },
      });
  }

  async removeOverride(candidateId: string, overrideId: string): Promise<void> {
    await this.db
      .delete(notificationOverrides)
      .where(
        and(
          eq(notificationOverrides.candidateId, candidateId),
          eq(notificationOverrides.id, overrideId),
        ),
      );
  }

  // ── Scores ────────────────────────────────────────────────────────────────

  async saveScore(candidateId: string, jobId: string, score: NotificationScore): Promise<void> {
    const row = {
      candidateId,
      jobId,
      score: score.score,
      urgency: score.urgency,
      opportunityValue: score.opportunityValue.score,
      confidence: score.confidence,
      deadline: score.deadline,
      rarity: score.rarity,
      factors: score.factors,
      explanation: score.explanation,
      algorithmVersion: score.algorithmVersion,
      computedAt: new Date(),
    };

    await this.db
      .insert(notificationScores)
      .values(row)
      .onConflictDoUpdate({
        target: [notificationScores.candidateId, notificationScores.jobId],
        set: row,
      });
  }

  async getScore(candidateId: string, jobId: string): Promise<NotificationScore | null> {
    const [row] = await this.db
      .select()
      .from(notificationScores)
      .where(
        and(eq(notificationScores.candidateId, candidateId), eq(notificationScores.jobId, jobId)),
      )
      .limit(1);

    if (!row) return null;

    const parsed = notificationScoreSchema.safeParse({
      score: row.score,
      urgency: row.urgency,
      opportunityValue: { score: row.opportunityValue },
      factors: row.factors,
      confidence: row.confidence,
      deadline: row.deadline,
      rarity: row.rarity,
      explanation: row.explanation,
      algorithmVersion: row.algorithmVersion,
    });

    return parsed.success ? parsed.data : null;
  }

  /** Top-scoring jobs, for the dashboard and for digest assembly. */
  async topScored(candidateId: string, options: { minimum?: number; limit?: number } = {}) {
    const conditions = [eq(notificationScores.candidateId, candidateId)];
    if (options.minimum !== undefined) {
      conditions.push(gte(notificationScores.score, options.minimum));
    }

    return this.db
      .select({
        jobId: notificationScores.jobId,
        score: notificationScores.score,
        urgency: notificationScores.urgency,
        opportunityValue: notificationScores.opportunityValue,
        confidence: notificationScores.confidence,
        explanation: notificationScores.explanation,
        deadline: notificationScores.deadline,
        computedAt: notificationScores.computedAt,
        title: jobs.title,
        companyName: jobs.companyNameRaw,
        applyUrl: jobs.applyUrl,
        canonicalUrl: jobs.canonicalUrl,
        sourceUrl: jobs.sourceUrl,
      })
      .from(notificationScores)
      .innerJoin(jobs, eq(jobs.id, notificationScores.jobId))
      .where(and(...conditions))
      .orderBy(desc(notificationScores.score))
      .limit(options.limit ?? 50);
  }

  // ── Suppressions ──────────────────────────────────────────────────────────

  async recordSuppression(record: SuppressionRecord): Promise<void> {
    const row = {
      candidateId: record.candidateId,
      jobId: record.jobId,
      reason: record.reason,
      detail: record.detail,
      setting: record.setting,
      remedy: record.remedy,
      notificationScore: record.notificationScore,
      thresholdApplied: record.thresholdApplied,
      occurredAt: record.occurredAt,
    };

    await this.db
      .insert(notificationSuppressions)
      .values(row)
      .onConflictDoUpdate({
        target: [notificationSuppressions.candidateId, notificationSuppressions.jobId],
        set: row,
      });
  }

  /** Clears a suppression, so a job that now qualifies is not blocked by a stale row. */
  async clearSuppression(candidateId: string, jobId: string): Promise<void> {
    await this.db
      .delete(notificationSuppressions)
      .where(
        and(
          eq(notificationSuppressions.candidateId, candidateId),
          eq(notificationSuppressions.jobId, jobId),
        ),
      );
  }

  /** "Why didn't I hear about this job?" — the Part 32 query. */
  async suppressionFor(candidateId: string, jobId: string): Promise<SuppressionRecord | null> {
    const [row] = await this.db
      .select()
      .from(notificationSuppressions)
      .where(
        and(
          eq(notificationSuppressions.candidateId, candidateId),
          eq(notificationSuppressions.jobId, jobId),
        ),
      )
      .limit(1);

    if (!row) return null;

    const parsed = suppressionRecordSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }

  async listSuppressions(candidateId: string, limit = 100) {
    return this.db
      .select({
        jobId: notificationSuppressions.jobId,
        reason: notificationSuppressions.reason,
        detail: notificationSuppressions.detail,
        setting: notificationSuppressions.setting,
        remedy: notificationSuppressions.remedy,
        notificationScore: notificationSuppressions.notificationScore,
        thresholdApplied: notificationSuppressions.thresholdApplied,
        occurredAt: notificationSuppressions.occurredAt,
        title: jobs.title,
        companyName: jobs.companyNameRaw,
      })
      .from(notificationSuppressions)
      .innerJoin(jobs, eq(jobs.id, notificationSuppressions.jobId))
      .where(eq(notificationSuppressions.candidateId, candidateId))
      .orderBy(desc(notificationSuppressions.occurredAt))
      .limit(limit);
  }

  async suppressionCounts(candidateId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({
        reason: notificationSuppressions.reason,
        total: sql<number>`count(*)::int`,
      })
      .from(notificationSuppressions)
      .where(eq(notificationSuppressions.candidateId, candidateId))
      .groupBy(notificationSuppressions.reason);

    return Object.fromEntries(rows.map((row) => [row.reason, row.total]));
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  /**
   * Creates a notification, or does nothing if one with the same key exists.
   *
   * Returns null on conflict so the caller can tell "created" from "already
   * there" — which matters because the second case must not be counted as a
   * send, or the analytics inherit the duplicate the database just prevented.
   */
  async enqueueNotification(input: {
    candidateId: string;
    jobId: string | null;
    type: NotificationType;
    priority: string;
    urgency: string;
    channel: string;
    reason: string;
    notificationScore: number | null;
    scoreDetail: NotificationScore | null;
    dedupeKey: string;
    groupId?: string | null;
    scheduledAt?: Date | null;
    metadata?: Record<string, unknown>;
  }): Promise<NotificationRecord | null> {
    const [row] = await this.db
      .insert(notificationRecords)
      .values({
        candidateId: input.candidateId,
        jobId: input.jobId,
        type: input.type,
        priority: input.priority,
        urgency: input.urgency,
        channel: input.channel,
        state: input.scheduledAt ? 'SCHEDULED' : 'PENDING',
        reason: input.reason,
        notificationScore: input.notificationScore,
        scoreDetail: input.scoreDetail,
        dedupeKey: input.dedupeKey,
        groupId: input.groupId ?? null,
        scheduledAt: input.scheduledAt ?? null,
        metadata: input.metadata ?? {},
      })
      .onConflictDoNothing({ target: notificationRecords.dedupeKey })
      .returning();

    if (!row) return null;

    const parsed = notificationRecordSchema.safeParse({ ...row, notificationId: row.id });
    return parsed.success ? parsed.data : null;
  }

  /** Notifications ready to send now. */
  async due(now: Date, limit = 50) {
    return this.db
      .select()
      .from(notificationRecords)
      .where(
        and(
          inArray(notificationRecords.state, ['PENDING', 'SCHEDULED']),
          or(isNull(notificationRecords.scheduledAt), lte(notificationRecords.scheduledAt, now)),
        ),
      )
      .orderBy(desc(notificationRecords.notificationScore))
      .limit(limit);
  }

  async markState(
    notificationId: string,
    state: NotificationState,
    extra: {
      sentAt?: Date;
      deliveredAt?: Date;
      failedAt?: Date;
      failureReason?: string | null;
      incrementAttempts?: boolean;
    } = {},
  ): Promise<void> {
    await this.db
      .update(notificationRecords)
      .set({
        state,
        ...(extra.sentAt ? { sentAt: extra.sentAt } : {}),
        ...(extra.deliveredAt ? { deliveredAt: extra.deliveredAt } : {}),
        ...(extra.failedAt ? { failedAt: extra.failedAt } : {}),
        ...(extra.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
        ...(extra.incrementAttempts
          ? { attempts: sql`${notificationRecords.attempts} + 1` }
          : {}),
      })
      .where(eq(notificationRecords.id, notificationId));
  }

  /** Records an open or a click. Clicks are the signal worth reading. */
  async recordEngagement(
    notificationId: string,
    kind: 'opened' | 'clicked',
    at = new Date(),
  ): Promise<void> {
    await this.db
      .update(notificationRecords)
      .set(kind === 'opened' ? { openedAt: at } : { clickedAt: at })
      .where(eq(notificationRecords.id, notificationId));
  }

  // ── Cooldown queries ──────────────────────────────────────────────────────

  /**
   * Everything the suppression engine needs about recent sends, in one pass.
   *
   * Bundled deliberately: this runs for every candidate job on every scoring
   * pass, and four separate round trips per job would make the pass quadratic
   * in the wrong dimension.
   */
  async notificationHistory(candidateId: string, now: Date) {
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const hourAgo = new Date(now.getTime() - 3_600_000);

    const [perJob, recent] = await Promise.all([
      this.db
        .select({
          jobId: notificationRecords.jobId,
          sentAt: sql<Date>`max(${notificationRecords.sentAt})`,
          score: sql<number>`max(${notificationRecords.notificationScore})`,
        })
        .from(notificationRecords)
        .where(
          and(
            eq(notificationRecords.candidateId, candidateId),
            isNotNull(notificationRecords.sentAt),
            isNotNull(notificationRecords.jobId),
          ),
        )
        .groupBy(notificationRecords.jobId),

      this.db
        .select({
          jobId: notificationRecords.jobId,
          sentAt: notificationRecords.sentAt,
          companyName: jobs.companyNameRaw,
          title: jobs.title,
        })
        .from(notificationRecords)
        .leftJoin(jobs, eq(jobs.id, notificationRecords.jobId))
        .where(
          and(
            eq(notificationRecords.candidateId, candidateId),
            eq(notificationRecords.type, 'JOB_ALERT'),
            gte(notificationRecords.sentAt, dayAgo),
          ),
        )
        .orderBy(desc(notificationRecords.sentAt))
        .limit(200),
    ]);

    const lastByJob = new Map(
      perJob
        .filter((row) => row.jobId !== null)
        .map((row) => [row.jobId!, { sentAt: row.sentAt, score: row.score }]),
    );

    const lastByCompany = new Map<string, Date>();
    for (const row of recent) {
      if (!row.companyName || !row.sentAt) continue;
      const key = row.companyName.toLowerCase();
      if (!lastByCompany.has(key)) lastByCompany.set(key, row.sentAt);
    }

    return {
      lastByJob,
      lastByCompany,
      alertsInRollingDay: recent.length,
      alertsInRollingHour: recent.filter((row) => row.sentAt !== null && row.sentAt >= hourAgo).length,
    };
  }

  // ── Analytics source data ─────────────────────────────────────────────────

  async engagementEvents(candidateId: string, sinceDays = 30) {
    const since = new Date(Date.now() - sinceDays * 86_400_000);

    return this.db
      .select({
        notificationId: notificationRecords.id,
        jobId: notificationRecords.jobId,
        type: notificationRecords.type,
        notificationScore: notificationRecords.notificationScore,
        sentAt: notificationRecords.sentAt,
        deliveredAt: notificationRecords.deliveredAt,
        openedAt: notificationRecords.openedAt,
        clickedAt: notificationRecords.clickedAt,
        companyName: jobs.companyNameRaw,
        sourceId: jobs.sourceId,
        countryCode: jobs.countryCode,
        seniority: jobs.seniority,
        technologies: jobs.techStack,
      })
      .from(notificationRecords)
      .leftJoin(jobs, eq(jobs.id, notificationRecords.jobId))
      .where(
        and(
          eq(notificationRecords.candidateId, candidateId),
          gte(notificationRecords.createdAt, since),
        ),
      )
      .limit(2_000);
  }

  // ── Address health (Part 44) ──────────────────────────────────────────────

  async addressHealth(candidateId: string) {
    const [row] = await this.db
      .select()
      .from(notificationAddressHealth)
      .where(eq(notificationAddressHealth.candidateId, candidateId))
      .limit(1);

    return row ?? null;
  }

  /**
   * Records a delivery outcome and updates the address's health.
   *
   * A hard bounce or a complaint suppresses the address immediately and
   * permanently until a person clears it. Continuing to send to a dead address
   * is not merely futile — it damages the sender reputation that every other
   * email depends on.
   */
  async recordDeliveryOutcome(input: {
    candidateId: string;
    email: string;
    outcome: 'delivered' | 'bounced_hard' | 'bounced_soft' | 'complained' | 'failed';
    detail?: string | null;
    now?: Date;
  }): Promise<{ suppressed: boolean; reason: string | null }> {
    const now = input.now ?? new Date();
    const permanent = input.outcome === 'bounced_hard' || input.outcome === 'complained';

    const reason = permanent
      ? input.outcome === 'complained'
        ? 'The recipient marked an email as spam.'
        : 'The address hard-bounced — it does not exist or refuses mail.'
      : null;

    const base = {
      candidateId: input.candidateId,
      email: input.email,
      updatedAt: now,
    };

    if (input.outcome === 'delivered') {
      await this.db
        .insert(notificationAddressHealth)
        .values({ ...base, lastSuccessAt: now, consecutiveFailures: 0 })
        .onConflictDoUpdate({
          target: notificationAddressHealth.candidateId,
          set: { lastSuccessAt: now, consecutiveFailures: 0, updatedAt: now },
        });

      return { suppressed: false, reason: null };
    }

    const increment =
      input.outcome === 'bounced_hard'
        ? { hardBounces: sql`${notificationAddressHealth.hardBounces} + 1` }
        : input.outcome === 'bounced_soft'
          ? { softBounces: sql`${notificationAddressHealth.softBounces} + 1` }
          : input.outcome === 'complained'
            ? { complaints: sql`${notificationAddressHealth.complaints} + 1` }
            : {};

    await this.db
      .insert(notificationAddressHealth)
      .values({
        ...base,
        suppressed: permanent,
        suppressedReason: reason,
        hardBounces: input.outcome === 'bounced_hard' ? 1 : 0,
        softBounces: input.outcome === 'bounced_soft' ? 1 : 0,
        complaints: input.outcome === 'complained' ? 1 : 0,
        consecutiveFailures: 1,
        lastFailureAt: now,
      })
      .onConflictDoUpdate({
        target: notificationAddressHealth.candidateId,
        set: {
          ...increment,
          ...(permanent ? { suppressed: true, suppressedReason: reason } : {}),
          consecutiveFailures: sql`${notificationAddressHealth.consecutiveFailures} + 1`,
          lastFailureAt: now,
          updatedAt: now,
        },
      });

    return { suppressed: permanent, reason };
  }

  // ── Rarity history (Part 10) ──────────────────────────────────────────────

  async recordDiscoveryCounts(input: {
    candidateId: string;
    day: Date;
    totalJobs: number;
    matchingAllDimensions: number;
  }): Promise<void> {
    await this.db
      .insert(discoveryProfileCounts)
      .values(input)
      .onConflictDoUpdate({
        target: [discoveryProfileCounts.candidateId, discoveryProfileCounts.day],
        set: {
          totalJobs: input.totalJobs,
          matchingAllDimensions: input.matchingAllDimensions,
        },
      });
  }

  async discoveryHistory(candidateId: string, windowDays = 30) {
    const since = new Date(Date.now() - windowDays * 86_400_000);

    const [row] = await this.db
      .select({
        totalJobs: sql<number>`coalesce(sum(${discoveryProfileCounts.totalJobs}), 0)::int`,
        matchingAllDimensions: sql<number>`coalesce(sum(${discoveryProfileCounts.matchingAllDimensions}), 0)::int`,
      })
      .from(discoveryProfileCounts)
      .where(
        and(
          eq(discoveryProfileCounts.candidateId, candidateId),
          gte(discoveryProfileCounts.day, since),
        ),
      );

    return {
      totalJobs: row?.totalJobs ?? 0,
      matchingAllDimensions: row?.matchingAllDimensions ?? 0,
      windowDays,
    };
  }

  // ── Digest plans ──────────────────────────────────────────────────────────

  async saveDigestPlan(input: {
    candidateId: string;
    type: string;
    windowStart: Date;
    windowEnd: Date;
    sections: unknown[];
    totalJobs: number;
    excluded: Record<string, number>;
    notificationId?: string | null;
  }): Promise<void> {
    await this.db
      .insert(digestPlans)
      .values({ ...input, notificationId: input.notificationId ?? null })
      .onConflictDoUpdate({
        target: [digestPlans.candidateId, digestPlans.type, digestPlans.windowStart],
        set: {
          sections: input.sections,
          totalJobs: input.totalJobs,
          excluded: input.excluded,
          generatedAt: new Date(),
        },
      });
  }

  async recentDigests(candidateId: string, limit = 10) {
    return this.db
      .select()
      .from(digestPlans)
      .where(eq(digestPlans.candidateId, candidateId))
      .orderBy(desc(digestPlans.generatedAt))
      .limit(limit);
  }

  /** Companies that have appeared in a previous digest. Drives "new to you". */
  async companiesAlreadyDigested(candidateId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ companyName: jobs.companyNameRaw })
      .from(notificationRecords)
      .innerJoin(jobs, eq(jobs.id, notificationRecords.jobId))
      .where(
        and(
          eq(notificationRecords.candidateId, candidateId),
          isNotNull(notificationRecords.sentAt),
        ),
      )
      .limit(1_000);

    return new Set(
      rows
        .map((row) => row.companyName?.toLowerCase())
        .filter((value): value is string => typeof value === 'string'),
    );
  }
}
