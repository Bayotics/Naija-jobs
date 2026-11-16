import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import {
  LEARNING_ALGORITHM_VERSION,
  behaviorEventSchema,
  featureAffinitySchema,
  learningConfigSchema,

  type BehaviorEventInput,
  type BehavioralProfile,
  type EngagementMetrics,
  type Experiment,
  type FeatureAffinity,
  type LearningConfig,
  type PreferenceSuggestion,
  type QueryPerformance,
  type RankingQuality,
  type SourceUserValue,
} from '@job-intel/contracts';
import type { Database } from '../client';
import {
  behaviorEvents,
  behavioralProfiles,
  engagementSnapshots,
  experiments,
  featureAffinities,
  learningSettings,
  preferenceSuggestions,
  queryPerformance,
  sourceUserValue,
} from '../schema/feedback-loop';
import { jobs } from '../schema/jobs';
import { jobEnrichments } from '../schema/enrichment';
import { jobRecommendations } from '../schema/recommendation';

/**
 * Feedback-loop persistence.
 *
 * Two invariants live here rather than in the callers:
 *
 *  - **Ingestion is idempotent.** `dedupeKey` is a unique index, and
 *    `recordEvent` uses `onConflictDoNothing`. At-least-once delivery is the
 *    normal case for a queue, and a retried click that becomes two clicks
 *    corrupts every metric computed downstream.
 *
 *  - **No method here writes a preference.** Suggestions are stored and their
 *    status updated; applying one goes through `CandidateRepository`, which is
 *    the only path that versions a preference change.
 */
export class LearningRepository {
  constructor(private readonly db: Database) {}

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * Appends one event.
   *
   * Returns null when the event was a duplicate, so a caller can distinguish
   * "recorded" from "already had it" without a second query.
   */
  async recordEvent(input: BehaviorEventInput & { dedupeKey?: string | null }): Promise<string | null> {
    const event = behaviorEventSchema.parse({
      ...input,
      eventId: input.eventId ?? crypto.randomUUID(),
      occurredAt: input.occurredAt ?? new Date(),
    });

    const [row] = await this.db
      .insert(behaviorEvents)
      .values({
        id: event.eventId,
        candidateId: event.candidateId,
        jobId: event.jobId,
        eventType: event.eventType,
        context: event.context,
        occurredAt: event.occurredAt,
        sessionId: event.sessionId,
        notificationId: event.notificationId,
        recommendationId: event.recommendationId,
        shownAtRank: event.shownAtRank,
        rejectionReason: event.rejectionReason,
        reasonText: event.reasonText,
        experimentId: event.experimentId,
        variant: event.variant,
        metadata: event.metadata,
        dedupeKey: input.dedupeKey ?? null,
      })
      .onConflictDoNothing({ target: behaviorEvents.dedupeKey })
      .returning({ id: behaviorEvents.id });

    return row?.id ?? null;
  }

  /** Events with the job attributes needed to extract features. */
  async listEventsWithJobs(
    candidateId: string,
    options: { sinceDays?: number; limit?: number; unprocessedOnly?: boolean } = {},
  ) {
    const conditions = [eq(behaviorEvents.candidateId, candidateId)];
    if (options.sinceDays !== undefined) {
      conditions.push(gte(behaviorEvents.occurredAt, daysAgo(options.sinceDays)));
    }
    if (options.unprocessedOnly) conditions.push(isNull(behaviorEvents.processedAt));

    return this.db
      .select({
        event: behaviorEvents,
        job: {
          id: jobs.id,
          title: jobs.title,
          companyNameRaw: jobs.companyNameRaw,
          countryCode: jobs.countryCode,
          city: jobs.city,
          remoteType: jobs.remoteType,
          employmentTypes: jobs.employmentTypes,
          techStack: jobs.techStack,
          salaryNormalizedAnnualUsd: jobs.salaryNormalizedAnnualUsd,
          sourceId: jobs.sourceId,
        },
        enrichment: {
          seniority: jobEnrichments.seniority,
          classification: jobEnrichments.classification,
        },
      })
      .from(behaviorEvents)
      .leftJoin(jobs, eq(jobs.id, behaviorEvents.jobId))
      .leftJoin(jobEnrichments, eq(jobEnrichments.jobId, behaviorEvents.jobId))
      .where(and(...conditions))
      .orderBy(desc(behaviorEvents.occurredAt))
      .limit(options.limit ?? 5_000);
  }

  /** Marks events folded into the profile, so the next pass skips them. */
  async markProcessed(eventIds: readonly string[]): Promise<number> {
    if (eventIds.length === 0) return 0;
    const rows = await this.db
      .update(behaviorEvents)
      .set({ processedAt: new Date() })
      .where(inArray(behaviorEvents.id, [...eventIds]))
      .returning({ id: behaviorEvents.id });
    return rows.length;
  }

  /** Recent activity for the behaviour timeline. */
  async recentActivity(candidateId: string, limit = 40) {
    return this.db
      .select({
        id: behaviorEvents.id,
        eventType: behaviorEvents.eventType,
        context: behaviorEvents.context,
        occurredAt: behaviorEvents.occurredAt,
        rejectionReason: behaviorEvents.rejectionReason,
        jobId: behaviorEvents.jobId,
        jobTitle: jobs.title,
        companyName: jobs.companyNameRaw,
      })
      .from(behaviorEvents)
      .leftJoin(jobs, eq(jobs.id, behaviorEvents.jobId))
      .where(eq(behaviorEvents.candidateId, candidateId))
      .orderBy(desc(behaviorEvents.occurredAt))
      .limit(limit);
  }

  async eventCounts(candidateId: string, sinceDays = 30) {
    return this.db
      .select({
        eventType: behaviorEvents.eventType,
        count: sql<number>`count(*)::int`,
      })
      .from(behaviorEvents)
      .where(
        and(
          eq(behaviorEvents.candidateId, candidateId),
          gte(behaviorEvents.occurredAt, daysAgo(sinceDays)),
        ),
      )
      .groupBy(behaviorEvents.eventType);
  }

  // ── Affinities ────────────────────────────────────────────────────────────

  async saveAffinities(candidateId: string, affinities: readonly FeatureAffinity[]): Promise<number> {
    if (affinities.length === 0) return 0;

    for (const affinity of affinities) {
      await this.db
        .insert(featureAffinities)
        .values({
          candidateId,
          dimension: affinity.dimension,
          value: affinity.value,
          affinity: affinity.affinity,
          confidence: affinity.confidence,
          sampleSize: affinity.sampleSize,
          positiveEvents: affinity.positiveEvents,
          negativeEvents: affinity.negativeEvents,
          evidence: affinity.evidence,
          firstObservedAt: affinity.firstObservedAt,
          lastObservedAt: affinity.lastObservedAt,
          lastUpdated: affinity.lastUpdated,
          conflictsWithExplicit: affinity.conflictsWithExplicit,
          explicitValue: affinity.explicitValue,
          algorithmVersion: affinity.algorithmVersion,
          featureVersion: affinity.featureVersion,
        })
        .onConflictDoUpdate({
          target: [featureAffinities.candidateId, featureAffinities.dimension, featureAffinities.value],
          set: {
            affinity: affinity.affinity,
            confidence: affinity.confidence,
            sampleSize: affinity.sampleSize,
            positiveEvents: affinity.positiveEvents,
            negativeEvents: affinity.negativeEvents,
            evidence: affinity.evidence,
            lastObservedAt: affinity.lastObservedAt,
            lastUpdated: affinity.lastUpdated,
            conflictsWithExplicit: affinity.conflictsWithExplicit,
            explicitValue: affinity.explicitValue,
            algorithmVersion: affinity.algorithmVersion,
            featureVersion: affinity.featureVersion,
          },
        });
    }

    return affinities.length;
  }

  /**
   * Replaces the whole affinity set for a candidate.
   *
   * Used by a full recompute. `saveAffinities` alone upserts and leaves behind
   * any row the new computation no longer produces — so an algorithm-version
   * bump or a fix to feature extraction would keep serving the stale values it
   * was meant to remove. That is precisely the corruption that versioning
   * exists to prevent, so a full recompute must replace rather than merge.
   *
   * In one transaction, so a reader never observes an empty profile.
   */
  async replaceAffinities(
    candidateId: string,
    affinities: readonly FeatureAffinity[],
  ): Promise<{ written: number; removed: number }> {
    return this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(featureAffinities)
        .where(eq(featureAffinities.candidateId, candidateId))
        .returning({ id: featureAffinities.id });

      if (affinities.length > 0) {
        await tx.insert(featureAffinities).values(
          affinities.map((affinity) => ({
            candidateId,
            dimension: affinity.dimension,
            value: affinity.value,
            affinity: affinity.affinity,
            confidence: affinity.confidence,
            sampleSize: affinity.sampleSize,
            positiveEvents: affinity.positiveEvents,
            negativeEvents: affinity.negativeEvents,
            evidence: affinity.evidence,
            firstObservedAt: affinity.firstObservedAt,
            lastObservedAt: affinity.lastObservedAt,
            lastUpdated: affinity.lastUpdated,
            conflictsWithExplicit: affinity.conflictsWithExplicit,
            explicitValue: affinity.explicitValue,
            algorithmVersion: affinity.algorithmVersion,
            featureVersion: affinity.featureVersion,
          })),
        );
      }

      return { written: affinities.length, removed: removed.length };
    });
  }

  async listAffinities(
    candidateId: string,
    options: { dimensions?: string[]; minConfidence?: number; limit?: number } = {},
  ): Promise<FeatureAffinity[]> {
    const conditions = [eq(featureAffinities.candidateId, candidateId)];
    if (options.dimensions?.length) {
      conditions.push(inArray(featureAffinities.dimension, options.dimensions));
    }
    if (options.minConfidence !== undefined) {
      conditions.push(gte(featureAffinities.confidence, options.minConfidence));
    }

    const rows = await this.db
      .select()
      .from(featureAffinities)
      .where(and(...conditions))
      .orderBy(desc(featureAffinities.confidence))
      .limit(options.limit ?? 500);

    return rows
      .map((row) => featureAffinitySchema.safeParse(row))
      .filter((parsed): parsed is { success: true; data: FeatureAffinity } => parsed.success)
      .map((parsed) => parsed.data);
  }

  /**
   * Clears learned state.
   *
   * Scoped by dimension so "reset company affinity" is a real operation rather
   * than a euphemism for wiping everything. Explicit preferences are in a
   * different table entirely and are untouched by any argument to this method.
   */
  async resetAffinities(candidateId: string, dimensions?: readonly string[]): Promise<number> {
    const conditions = [eq(featureAffinities.candidateId, candidateId)];
    if (dimensions?.length) {
      conditions.push(inArray(featureAffinities.dimension, [...dimensions]));
    }

    const rows = await this.db
      .delete(featureAffinities)
      .where(and(...conditions))
      .returning({ id: featureAffinities.id });

    return rows.length;
  }

  /** Deletes behavioural history. Explicit profile and preferences survive. */
  async deleteBehaviorHistory(candidateId: string): Promise<{ events: number; affinities: number }> {
    const removedEvents = await this.db
      .delete(behaviorEvents)
      .where(eq(behaviorEvents.candidateId, candidateId))
      .returning({ id: behaviorEvents.id });

    const removedAffinities = await this.resetAffinities(candidateId);

    await this.db
      .delete(behavioralProfiles)
      .where(eq(behavioralProfiles.candidateId, candidateId));

    return { events: removedEvents.length, affinities: removedAffinities };
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  async saveProfile(profile: BehavioralProfile): Promise<void> {
    await this.db
      .insert(behavioralProfiles)
      .values({
        candidateId: profile.candidateId,
        totalEvents: profile.totalEvents,
        distinctJobs: profile.distinctJobs,
        firstEventAt: profile.firstEventAt,
        lastEventAt: profile.lastEventAt,
        hasSufficientData: profile.hasSufficientData,
        coldStartReason: profile.coldStartReason,
        algorithmVersion: profile.algorithmVersion,
        featureVersion: profile.featureVersion,
        computedAt: profile.computedAt,
      })
      .onConflictDoUpdate({
        target: behavioralProfiles.candidateId,
        set: {
          totalEvents: profile.totalEvents,
          distinctJobs: profile.distinctJobs,
          firstEventAt: profile.firstEventAt,
          lastEventAt: profile.lastEventAt,
          hasSufficientData: profile.hasSufficientData,
          coldStartReason: profile.coldStartReason,
          algorithmVersion: profile.algorithmVersion,
          featureVersion: profile.featureVersion,
          computedAt: profile.computedAt,
        },
      });
  }

  async getProfile(candidateId: string) {
    const rows = await this.db
      .select()
      .from(behavioralProfiles)
      .where(eq(behavioralProfiles.candidateId, candidateId))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async getConfig(candidateId: string): Promise<LearningConfig> {
    const rows = await this.db
      .select()
      .from(learningSettings)
      .where(eq(learningSettings.candidateId, candidateId))
      .limit(1);

    // Defaults are valid by construction, so an absent row is a working config
    // rather than a missing one.
    return learningConfigSchema.parse(rows[0]?.config ?? {});
  }

  async saveConfig(candidateId: string, config: Partial<LearningConfig>): Promise<LearningConfig> {
    const current = await this.getConfig(candidateId);
    const next = learningConfigSchema.parse({
      ...current,
      ...config,
      configurationVersion: current.configurationVersion + 1,
    });

    await this.db
      .insert(learningSettings)
      .values({
        candidateId,
        config: next,
        configurationVersion: next.configurationVersion,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: learningSettings.candidateId,
        set: { config: next, configurationVersion: next.configurationVersion, updatedAt: new Date() },
      });

    return next;
  }

  // ── Suggestions ───────────────────────────────────────────────────────────

  async saveSuggestions(suggestions: readonly PreferenceSuggestion[]): Promise<number> {
    let stored = 0;
    for (const suggestion of suggestions) {
      const [row] = await this.db
        .insert(preferenceSuggestions)
        .values({
          id: suggestion.id,
          candidateId: suggestion.candidateId,
          path: suggestion.path,
          operation: suggestion.operation,
          currentValue: suggestion.currentValue ?? null,
          suggestedValue: suggestion.suggestedValue ?? null,
          message: suggestion.message,
          evidence: suggestion.evidence,
          confidence: suggestion.confidence,
          status: suggestion.status,
          createdAt: suggestion.createdAt,
          algorithmVersion: suggestion.algorithmVersion,
        })
        // One open suggestion per path — re-running the generator refreshes the
        // wording and evidence rather than stacking duplicates.
        .onConflictDoUpdate({
          target: [
            preferenceSuggestions.candidateId,
            preferenceSuggestions.path,
            preferenceSuggestions.status,
          ],
          set: {
            message: suggestion.message,
            evidence: suggestion.evidence,
            confidence: suggestion.confidence,
            suggestedValue: suggestion.suggestedValue ?? null,
            currentValue: suggestion.currentValue ?? null,
            createdAt: suggestion.createdAt,
          },
        })
        .returning({ id: preferenceSuggestions.id });

      if (row) stored += 1;
    }
    return stored;
  }

  async listSuggestions(candidateId: string, status = 'pending') {
    return this.db
      .select()
      .from(preferenceSuggestions)
      .where(
        and(
          eq(preferenceSuggestions.candidateId, candidateId),
          eq(preferenceSuggestions.status, status),
        ),
      )
      .orderBy(desc(preferenceSuggestions.confidence));
  }

  async getSuggestion(id: string) {
    const rows = await this.db
      .select()
      .from(preferenceSuggestions)
      .where(eq(preferenceSuggestions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Records the candidate's answer. Never applies it — that is a separate write. */
  async respondToSuggestion(
    id: string,
    status: 'accepted' | 'declined' | 'dismissed',
    appliedVersion?: number | null,
  ): Promise<void> {
    await this.db
      .update(preferenceSuggestions)
      .set({ status, respondedAt: new Date(), appliedVersion: appliedVersion ?? null })
      .where(eq(preferenceSuggestions.id, id));
  }

  /** Paths the candidate has declined, so they are not asked again. */
  async declinedPaths(candidateId: string): Promise<string[]> {
    const rows = await this.db
      .select({ path: preferenceSuggestions.path })
      .from(preferenceSuggestions)
      .where(
        and(
          eq(preferenceSuggestions.candidateId, candidateId),
          inArray(preferenceSuggestions.status, ['declined', 'dismissed']),
        ),
      );
    return rows.map((row) => row.path);
  }

  // ── Query and source learning ─────────────────────────────────────────────

  /**
   * Interaction counts per discovery query.
   *
   * This is the join that closes the loop, and it took two attempts to close
   * properly. The first version read a `queryId` out of the event's metadata,
   * which meant the caller had to know which query had produced the job — and
   * no caller did, so the table stayed empty and query learning never ran.
   *
   * The attribution now lives on the job itself, stamped at discovery, and the
   * event only has to name the job. An explicit `queryId` in the event metadata
   * still wins where a caller genuinely knows better, but nothing depends on
   * one being supplied.
   */
  async queryInteractionCounts(candidateId: string, sinceDays = 30) {
    const queryId = sql<string>`coalesce(${behaviorEvents.metadata}->>'queryId', ${jobs.discoveryQueryId})`;

    return this.db
      .select({
        queryId,
        views: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} = 'JOB_VIEWED')::int`,
        clicks: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} IN ('JOB_CLICKED','JOB_NOTIFICATION_CLICKED'))::int`,
        saves: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} = 'JOB_SAVED')::int`,
        applications: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} = 'JOB_APPLIED')::int`,
        rejections: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} IN ('JOB_REJECTED','JOB_DISMISSED'))::int`,
      })
      .from(behaviorEvents)
      .innerJoin(jobs, eq(jobs.id, behaviorEvents.jobId))
      .where(
        and(
          eq(behaviorEvents.candidateId, candidateId),
          gte(behaviorEvents.occurredAt, daysAgo(sinceDays)),
          // Events about jobs no query discovered contribute nothing here.
          sql`coalesce(${behaviorEvents.metadata}->>'queryId', ${jobs.discoveryQueryId}) IS NOT NULL`,
        ),
      )
      .groupBy(queryId);
  }

  /** Interaction counts per source, joined through the job. */
  async sourceInteractionCounts(candidateId: string, sinceDays = 30) {
    return this.db
      .select({
        sourceId: jobs.sourceId,
        jobsDiscovered: sql<number>`count(DISTINCT ${jobs.id})::int`,
        views: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} = 'JOB_VIEWED')::int`,
        clicks: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} IN ('JOB_CLICKED','JOB_NOTIFICATION_CLICKED'))::int`,
        saves: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} = 'JOB_SAVED')::int`,
        applications: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} = 'JOB_APPLIED')::int`,
        rejections: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} IN ('JOB_REJECTED','JOB_DISMISSED'))::int`,
      })
      .from(behaviorEvents)
      .innerJoin(jobs, eq(jobs.id, behaviorEvents.jobId))
      .where(
        and(
          eq(behaviorEvents.candidateId, candidateId),
          gte(behaviorEvents.occurredAt, daysAgo(sinceDays)),
        ),
      )
      .groupBy(jobs.sourceId);
  }

  /** Jobs discovered per source in the window, the denominator for user value. */
  async jobsPerSource(sinceDays = 30) {
    return this.db
      .select({ sourceId: jobs.sourceId, total: sql<number>`count(*)::int` })
      .from(jobs)
      .where(gte(jobs.firstSeenAt, daysAgo(sinceDays)))
      .groupBy(jobs.sourceId);
  }

  async saveQueryPerformance(rows: readonly QueryPerformance[]): Promise<number> {
    for (const row of rows) {
      await this.db
        .insert(queryPerformance)
        .values({ ...row, computedAt: row.computedAt })
        .onConflictDoUpdate({
          target: [queryPerformance.queryId, queryPerformance.candidateId],
          set: {
            jobsDiscovered: row.jobsDiscovered,
            jobsMatched: row.jobsMatched,
            jobsShown: row.jobsShown,
            views: row.views,
            clicks: row.clicks,
            saves: row.saves,
            applications: row.applications,
            rejections: row.rejections,
            engagementRate: row.engagementRate,
            valueScore: row.valueScore,
            explanation: row.explanation,
            computedAt: row.computedAt,
          },
        });
    }
    return rows.length;
  }

  async listQueryPerformance(candidateId: string) {
    return this.db
      .select()
      .from(queryPerformance)
      .where(eq(queryPerformance.candidateId, candidateId))
      .orderBy(desc(queryPerformance.valueScore));
  }

  async saveSourceUserValue(rows: readonly SourceUserValue[]): Promise<number> {
    for (const row of rows) {
      await this.db
        .insert(sourceUserValue)
        .values({ ...row, computedAt: row.computedAt })
        .onConflictDoUpdate({
          target: [sourceUserValue.sourceId, sourceUserValue.candidateId],
          set: {
            jobsDiscovered: row.jobsDiscovered,
            jobsShown: row.jobsShown,
            views: row.views,
            clicks: row.clicks,
            saves: row.saves,
            applications: row.applications,
            rejections: row.rejections,
            engagementRate: row.engagementRate,
            userValueScore: row.userValueScore,
            explanation: row.explanation,
            computedAt: row.computedAt,
          },
        });
    }
    return rows.length;
  }

  async listSourceUserValue(candidateId: string) {
    return this.db
      .select()
      .from(sourceUserValue)
      .where(eq(sourceUserValue.candidateId, candidateId))
      .orderBy(desc(sourceUserValue.userValueScore));
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  /** Recommendations shown, from the ranking table rather than from events. */
  async recommendationsShown(candidateId: string, sinceDays = 30): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobRecommendations)
      .where(
        and(
          eq(jobRecommendations.profileId, candidateId),
          gte(jobRecommendations.computedAt, daysAgo(sinceDays)),
        ),
      );
    return row?.count ?? 0;
  }

  /** Ranked interactions, for Precision@K. */
  async rankedInteractions(candidateId: string, sinceDays = 30) {
    return this.db
      .select({
        jobId: behaviorEvents.jobId,
        rank: behaviorEvents.shownAtRank,
        clicked: sql<boolean>`bool_or(${behaviorEvents.eventType} IN ('JOB_CLICKED','JOB_NOTIFICATION_CLICKED'))`,
        saved: sql<boolean>`bool_or(${behaviorEvents.eventType} = 'JOB_SAVED')`,
        applied: sql<boolean>`bool_or(${behaviorEvents.eventType} = 'JOB_APPLIED')`,
      })
      .from(behaviorEvents)
      .where(
        and(
          eq(behaviorEvents.candidateId, candidateId),
          gte(behaviorEvents.occurredAt, daysAgo(sinceDays)),
          sql`${behaviorEvents.shownAtRank} IS NOT NULL`,
        ),
      )
      .groupBy(behaviorEvents.jobId, behaviorEvents.shownAtRank);
  }

  async saveEngagementSnapshot(
    metrics: EngagementMetrics,
    quality: readonly RankingQuality[],
  ): Promise<void> {
    await this.db.insert(engagementSnapshots).values({
      candidateId: metrics.candidateId,
      windowDays: metrics.windowDays,
      recommendationsShown: metrics.recommendationsShown,
      jobsViewed: metrics.jobsViewed,
      jobsClicked: metrics.jobsClicked,
      jobsSaved: metrics.jobsSaved,
      jobsRejected: metrics.jobsRejected,
      jobsApplied: metrics.jobsApplied,
      viewRate: metrics.viewRate,
      clickRate: metrics.clickRate,
      saveRate: metrics.saveRate,
      applicationRate: metrics.applicationRate,
      acceptanceRate: metrics.acceptanceRate,
      rejectionRate: metrics.rejectionRate,
      rankingQuality: [...quality],
      computedAt: metrics.computedAt,
    });
  }

  async latestEngagement(candidateId: string) {
    const rows = await this.db
      .select()
      .from(engagementSnapshots)
      .where(eq(engagementSnapshots.candidateId, candidateId))
      .orderBy(desc(engagementSnapshots.computedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async engagementHistory(candidateId: string, limit = 30) {
    return this.db
      .select()
      .from(engagementSnapshots)
      .where(eq(engagementSnapshots.candidateId, candidateId))
      .orderBy(desc(engagementSnapshots.computedAt))
      .limit(limit);
  }

  // ── Experiments ───────────────────────────────────────────────────────────

  async saveExperiment(experiment: Experiment): Promise<void> {
    await this.db
      .insert(experiments)
      .values({
        id: experiment.id,
        name: experiment.name,
        hypothesis: experiment.hypothesis,
        status: experiment.status,
        variants: experiment.variants,
        enrolledCandidateIds: experiment.enrolledCandidateIds,
        startedAt: experiment.startedAt,
        endedAt: experiment.endedAt,
      })
      .onConflictDoUpdate({
        target: experiments.id,
        set: {
          name: experiment.name,
          hypothesis: experiment.hypothesis,
          status: experiment.status,
          variants: experiment.variants,
          enrolledCandidateIds: experiment.enrolledCandidateIds,
          startedAt: experiment.startedAt,
          endedAt: experiment.endedAt,
        },
      });
  }

  async listExperiments() {
    return this.db.select().from(experiments).orderBy(desc(experiments.createdAt));
  }

  /** Running experiments this candidate is explicitly enrolled in. */
  async experimentsFor(candidateId: string) {
    const rows = await this.db
      .select()
      .from(experiments)
      .where(eq(experiments.status, 'running'));

    return rows.filter((row) => row.enrolledCandidateIds.includes(candidateId));
  }

  /** Per-variant outcomes, from the events that carry variant attribution. */
  async experimentOutcomes(experimentId: string, sinceDays = 90) {
    return this.db
      .select({
        variant: behaviorEvents.variant,
        candidates: sql<number>`count(DISTINCT ${behaviorEvents.candidateId})::int`,
        clicks: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} IN ('JOB_CLICKED','JOB_NOTIFICATION_CLICKED'))::int`,
        saves: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} = 'JOB_SAVED')::int`,
        applications: sql<number>`count(*) FILTER (WHERE ${behaviorEvents.eventType} = 'JOB_APPLIED')::int`,
        interactions: sql<number>`count(*)::int`,
      })
      .from(behaviorEvents)
      .where(
        and(
          eq(behaviorEvents.experimentId, experimentId),
          gte(behaviorEvents.occurredAt, daysAgo(sinceDays)),
        ),
      )
      .groupBy(behaviorEvents.variant);
  }
}

const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

export const LEARNING_REPOSITORY_ALGORITHM_VERSION = LEARNING_ALGORITHM_VERSION;
