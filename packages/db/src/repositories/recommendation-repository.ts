import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  RECOMMENDATION_VERSION,
  type DuplicateVerdict,
  type Exposure,
  type ExposureState,
  type JobRecommendation,
  type LifecycleStatus,
  type RecommendationTier,
  type VerificationResult,
} from '@job-intel/contracts';
import type { Database } from '../client';
import {
  candidateJobExposure,
  jobDuplicates,
  jobGroupMerges,
  jobRecommendations,
  jobSignals,
  jobVerifications,
  recommendationRuns,
} from '../schema/recommendation';
import { jobs } from '../schema/jobs';
import { jobEnrichments } from '../schema/enrichment';
import { jobMatches } from '../schema/matching';

/**
 * Recommendation persistence.
 *
 * The queries here are the ones Part 27 of the brief is about: "active jobs",
 * "top scores for this candidate", "what still needs ranking", "what is
 * notifiable". Each has a covering index, and none of them pulls the corpus
 * into memory to sort it — the point of storing the ranking is that the
 * database can answer questions about it.
 */

export interface DedupCandidateRow {
  jobId: string;
  sourceId: string;
  sourceType: string;
  externalId: string | null;
  sourceUrl: string;
  canonicalUrl: string | null;
  applyUrl: string | null;
  companyName: string;
  companyId: string | null;
  companyDomain: string | null;
  title: string;
  city: string | null;
  countryCode: string | null;
  remoteType: string | null;
  salaryAnnualUsd: number | null;
  postedAt: Date | null;
  description: string | null;
  requirements: string[];
  atsVendor: string | null;
  atsSlug: string | null;
  simhash: string | null;
  fingerprint: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export class RecommendationRepository {
  constructor(private readonly db: Database) {}

  // ── Deduplication ─────────────────────────────────────────────────────────

  /**
   * The blocking query.
   *
   * Comparison only ever runs inside a small candidate set: same fingerprint
   * (company + title + location + posted week), same URL hash, or same company.
   * Without this, deduplication is O(n²) over the whole corpus and stops being
   * viable somewhere around a thousand jobs.
   */
  async findDedupCandidates(
    subject: { jobId: string; fingerprint: string; companyId: string | null; urlHash: string | null },
    limit = 40,
  ): Promise<DedupCandidateRow[]> {
    const blocks = [eq(jobs.fingerprint, subject.fingerprint)];
    if (subject.companyId) blocks.push(eq(jobs.companyId, subject.companyId));
    if (subject.urlHash) blocks.push(eq(jobs.urlHash, subject.urlHash));

    const rows = await this.db
      .select({
        job: jobs,
        applicationTarget: jobEnrichments.applicationTarget,
        enrichmentRequirements: jobEnrichments.requirements,
      })
      .from(jobs)
      .leftJoin(jobEnrichments, eq(jobEnrichments.jobId, jobs.id))
      .where(and(or(...blocks), sql`${jobs.id} <> ${subject.jobId}`))
      .limit(limit);

    return rows.map((row) => this.toDedupRow(row.job, row.applicationTarget, row.enrichmentRequirements));
  }

  async getDedupCandidate(jobId: string): Promise<DedupCandidateRow | null> {
    const rows = await this.db
      .select({
        job: jobs,
        applicationTarget: jobEnrichments.applicationTarget,
        enrichmentRequirements: jobEnrichments.requirements,
      })
      .from(jobs)
      .leftJoin(jobEnrichments, eq(jobEnrichments.jobId, jobs.id))
      .where(eq(jobs.id, jobId))
      .limit(1);

    const row = rows[0];
    return row ? this.toDedupRow(row.job, row.applicationTarget, row.enrichmentRequirements) : null;
  }

  /**
   * The batched form of `getDedupCandidate`.
   *
   * Callers that need signals for a backlog were fetching one row per query,
   * and at cloud latency that is the difference between a stage that finishes
   * and one that never does: refreshing 1,469 jobs meant ~4,400 sequential
   * round trips, roughly ten minutes, so the task was reaped mid-flight on
   * every run and `job_signals` sat unchanged for twelve days while every pass
   * reported success.
   *
   * Chunked because a parameter list is not unbounded, and returned as a Map so
   * the caller keeps its own ordering.
   */
  async getDedupCandidates(jobIds: readonly string[]): Promise<Map<string, DedupCandidateRow>> {
    const out = new Map<string, DedupCandidateRow>();
    if (jobIds.length === 0) return out;

    const CHUNK = 500;

    for (let index = 0; index < jobIds.length; index += CHUNK) {
      const slice = jobIds.slice(index, index + CHUNK);

      const rows = await this.db
        .select({
          job: jobs,
          applicationTarget: jobEnrichments.applicationTarget,
          enrichmentRequirements: jobEnrichments.requirements,
        })
        .from(jobs)
        .leftJoin(jobEnrichments, eq(jobEnrichments.jobId, jobs.id))
        .where(inArray(jobs.id, [...slice]));

      for (const row of rows) {
        out.set(
          row.job.id,
          this.toDedupRow(row.job, row.applicationTarget, row.enrichmentRequirements),
        );
      }
    }

    return out;
  }

  /**
   * Latest verification per job, for many jobs at once.
   *
   * `DISTINCT ON` rather than a window function: Postgres can satisfy it
   * straight from the (job_id, checked_at) ordering without materialising a
   * rank for every historical check.
   */
  async latestVerifications(
    jobIds: readonly string[],
  ): Promise<Map<string, { outcome: string; httpStatus: number | null }>> {
    const out = new Map<string, { outcome: string; httpStatus: number | null }>();
    if (jobIds.length === 0) return out;

    const CHUNK = 500;

    for (let index = 0; index < jobIds.length; index += CHUNK) {
      const slice = jobIds.slice(index, index + CHUNK);

      const rows = await this.db
        .selectDistinctOn([jobVerifications.jobId], {
          jobId: jobVerifications.jobId,
          outcome: jobVerifications.outcome,
          httpStatus: jobVerifications.httpStatus,
        })
        .from(jobVerifications)
        .where(inArray(jobVerifications.jobId, [...slice]))
        .orderBy(jobVerifications.jobId, desc(jobVerifications.checkedAt));

      for (const row of rows) {
        out.set(row.jobId, { outcome: row.outcome, httpStatus: row.httpStatus });
      }
    }

    return out;
  }

  /** Records a verdict whether or not it reached the merge threshold. */
  async saveDuplicateVerdict(input: {
    jobId: string;
    duplicateOfJobId: string;
    verdict: DuplicateVerdict;
    merged: boolean;
  }): Promise<void> {
    const values = {
      jobId: input.jobId,
      duplicateOfJobId: input.duplicateOfJobId,
      tier: input.verdict.tier,
      duplicateConfidence: input.verdict.duplicateConfidence,
      duplicateReason: input.verdict.duplicateReason,
      merged: input.merged,
      signals: input.verdict.signals,
      conflicts: input.verdict.conflicts,
      detectedAt: new Date(),
    };

    await this.db
      .insert(jobDuplicates)
      .values(values)
      .onConflictDoUpdate({
        target: [jobDuplicates.jobId, jobDuplicates.duplicateOfJobId],
        set: values,
      });
  }

  /** The record this job was merged into, if any. */
  async getCanonicalFor(jobId: string): Promise<string | null> {
    const rows = await this.db
      .select({ target: jobDuplicates.duplicateOfJobId })
      .from(jobDuplicates)
      .where(and(eq(jobDuplicates.jobId, jobId), eq(jobDuplicates.merged, true)))
      .orderBy(desc(jobDuplicates.duplicateConfidence))
      .limit(1);
    return rows[0]?.target ?? null;
  }

  /** Every merged duplicate, as a map from member to canonical. */
  async loadMergeMap(): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ jobId: jobDuplicates.jobId, target: jobDuplicates.duplicateOfJobId })
      .from(jobDuplicates)
      .where(eq(jobDuplicates.merged, true));
    return new Map(rows.map((r) => [r.jobId, r.target]));
  }

  async assignGroup(jobId: string, groupId: string): Promise<void> {
    await this.db.update(jobs).set({ jobGroupId: groupId, updatedAt: new Date() }).where(eq(jobs.id, jobId));
  }

  async saveGroupMerge(input: {
    groupId: string;
    canonicalJobId: string;
    bestApplyUrl: string | null;
    bestApplyUrlSourceId: string | null;
    memberCount: number;
    provenance: unknown[];
    conflicts: unknown[];
  }): Promise<void> {
    const values = { ...input, conflicts: input.conflicts as never, mergedAt: new Date() };
    await this.db
      .insert(jobGroupMerges)
      .values(values)
      .onConflictDoUpdate({ target: jobGroupMerges.groupId, set: values });
  }

  async listGroupMembers(groupId: string): Promise<DedupCandidateRow[]> {
    const rows = await this.db
      .select({
        job: jobs,
        applicationTarget: jobEnrichments.applicationTarget,
        enrichmentRequirements: jobEnrichments.requirements,
      })
      .from(jobs)
      .leftJoin(jobEnrichments, eq(jobEnrichments.jobId, jobs.id))
      .where(eq(jobs.jobGroupId, groupId));
    return rows.map((r) => this.toDedupRow(r.job, r.applicationTarget, r.enrichmentRequirements));
  }

  // ── Signals ───────────────────────────────────────────────────────────────

  async saveSignals(
    jobId: string,
    signals: {
      quality: JobRecommendation['quality'];
      freshness: JobRecommendation['freshness'];
      lifecycle: JobRecommendation['lifecycle'];
      scam: JobRecommendation['scam'];
      repost: JobRecommendation['repost'];
      sourceAuthority: JobRecommendation['sourceAuthority'];
      absenceRuns?: number;
    },
  ): Promise<void> {
    const values = {
      jobId,
      qualityScore: signals.quality.score,
      qualityConfidence: signals.quality.confidence,
      quality: signals.quality,
      freshnessScore: signals.freshness.score,
      freshnessAgeHours: signals.freshness.ageHours,
      freshness: signals.freshness,
      lifecycleStatus: signals.lifecycle.status,
      lifecycle: signals.lifecycle,
      scamRisk: signals.scam.risk,
      scam: signals.scam,
      repostKind: signals.repost.kind,
      repost: signals.repost,
      sourceAuthority: signals.sourceAuthority,
      absenceRuns: signals.absenceRuns ?? 0,
      recommendationVersion: RECOMMENDATION_VERSION,
      computedAt: new Date(),
    };

    await this.db
      .insert(jobSignals)
      .values(values)
      .onConflictDoUpdate({ target: jobSignals.jobId, set: values });
  }

  async getSignals(jobId: string) {
    const rows = await this.db.select().from(jobSignals).where(eq(jobSignals.jobId, jobId)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Jobs whose signals are missing or computed by an older engine.
   *
   * Freshness decays continuously, so `staleAfterHours` also selects rows whose
   * cached freshness has drifted far enough to matter.
   */
  async findJobsNeedingSignals(options: { limit?: number; staleAfterHours?: number } = {}) {
    const cutoff = new Date(Date.now() - (options.staleAfterHours ?? 12) * 3_600_000);

    const rows = await this.db
      .select({ jobId: jobs.id })
      .from(jobs)
      .innerJoin(jobEnrichments, eq(jobEnrichments.jobId, jobs.id))
      .leftJoin(jobSignals, eq(jobSignals.jobId, jobs.id))
      .where(
        and(
          eq(jobEnrichments.status, 'enriched'),
          or(
            isNull(jobSignals.jobId),
            lt(jobSignals.computedAt, cutoff),
            sql`${jobSignals.recommendationVersion} <> ${RECOMMENDATION_VERSION}`,
          ),
        ),
      )
      .orderBy(desc(jobs.lastSeenAt))
      .limit(options.limit ?? 500);

    return rows.map((r) => r.jobId);
  }

  // ── Verification ──────────────────────────────────────────────────────────

  async recordVerification(jobId: string, result: VerificationResult): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(jobVerifications).values({
        jobId,
        url: result.url,
        outcome: result.outcome,
        httpStatus: result.httpStatus,
        durationMs: Math.round(result.durationMs),
        detail: result.detail,
        checkedAt: result.checkedAt,
      });

      // Only a *successful* check advances `lastVerifiedAt`. A timeout tells us
      // nothing about the job, and letting it count as verification would make
      // an unreachable host look freshly confirmed.
      if (result.outcome === 'reachable') {
        await tx
          .update(jobs)
          .set({ lastVerifiedAt: result.checkedAt, updatedAt: new Date() })
          .where(eq(jobs.id, jobId));
      }
    });
  }

  /** Most recent check per job, for the staleness model. */
  async latestVerification(jobId: string) {
    const rows = await this.db
      .select()
      .from(jobVerifications)
      .where(eq(jobVerifications.jobId, jobId))
      .orderBy(desc(jobVerifications.checkedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Exposure ──────────────────────────────────────────────────────────────

  async getExposure(profileId: string, jobId: string): Promise<Exposure | null> {
    const rows = await this.db
      .select()
      .from(candidateJobExposure)
      .where(
        and(eq(candidateJobExposure.profileId, profileId), eq(candidateJobExposure.jobId, jobId)),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      state: row.state as ExposureState,
      timesShown: row.timesShown,
      firstShownAt: row.firstShownAt,
      lastShownAt: row.lastShownAt,
      notifiedAt: row.notifiedAt,
      notifiedContentHash: row.notifiedContentHash,
      notifiedScore: row.notifiedScore,
    };
  }

  /** Batch read, so ranking N jobs is one query rather than N. */
  async loadExposures(profileId: string): Promise<Map<string, Exposure>> {
    const rows = await this.db
      .select()
      .from(candidateJobExposure)
      .where(eq(candidateJobExposure.profileId, profileId));

    return new Map(
      rows.map((row) => [
        row.jobId,
        {
          state: row.state as ExposureState,
          timesShown: row.timesShown,
          firstShownAt: row.firstShownAt,
          lastShownAt: row.lastShownAt,
          notifiedAt: row.notifiedAt,
          notifiedContentHash: row.notifiedContentHash,
          notifiedScore: row.notifiedScore,
        },
      ]),
    );
  }

  /**
   * The material-field snapshot taken when each job was notified.
   *
   * Separate from `loadExposures` because it is only needed on the
   * re-notification path and is far larger than the exposure row itself.
   */
  async loadNotifiedSnapshots(profileId: string): Promise<Map<string, Record<string, unknown>>> {
    const rows = await this.db
      .select({ jobId: candidateJobExposure.jobId, snapshot: candidateJobExposure.notifiedSnapshot })
      .from(candidateJobExposure)
      .where(eq(candidateJobExposure.profileId, profileId));

    const result = new Map<string, Record<string, unknown>>();
    for (const row of rows) if (row.snapshot) result.set(row.jobId, row.snapshot);
    return result;
  }

  async recordExposure(input: {
    profileId: string;
    jobId: string;
    state: ExposureState;
    at?: Date;
    notifiedContentHash?: string | null;
    notifiedScore?: number | null;
    notifiedSnapshot?: Record<string, unknown> | null;
  }): Promise<void> {
    const at = input.at ?? new Date();
    const notified = input.state === 'notified';

    await this.db
      .insert(candidateJobExposure)
      .values({
        profileId: input.profileId,
        jobId: input.jobId,
        state: input.state,
        timesShown: 1,
        firstShownAt: at,
        lastShownAt: at,
        notifiedAt: notified ? at : null,
        notifiedContentHash: input.notifiedContentHash ?? null,
        notifiedScore: input.notifiedScore ?? null,
        notifiedSnapshot: input.notifiedSnapshot ?? null,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [candidateJobExposure.profileId, candidateJobExposure.jobId],
        set: {
          state: input.state,
          timesShown: sql`${candidateJobExposure.timesShown} + 1`,
          lastShownAt: at,
          ...(notified
            ? {
                notifiedAt: at,
                notifiedContentHash: input.notifiedContentHash ?? null,
                notifiedScore: input.notifiedScore ?? null,
                notifiedSnapshot: input.notifiedSnapshot ?? null,
              }
            : {}),
          updatedAt: at,
        },
      });
  }

  // ── Recommendations ───────────────────────────────────────────────────────

  /**
   * Replaces a candidate's ranked list.
   *
   * Delete-then-insert inside one transaction rather than upsert-and-prune: a
   * ranking is a property of the *pool*, so leaving yesterday's leftovers
   * behind would produce a list that never existed as a whole.
   */
  async replaceRecommendations(
    profileId: string,
    recommendations: readonly JobRecommendation[],
  ): Promise<number> {
    if (recommendations.length === 0) {
      await this.db.delete(jobRecommendations).where(eq(jobRecommendations.profileId, profileId));
      return 0;
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(jobRecommendations).where(eq(jobRecommendations.profileId, profileId));

      // Chunked: a single insert of ten thousand rows exceeds the parameter
      // limit of the wire protocol.
      const chunkSize = 200;
      for (let i = 0; i < recommendations.length; i += chunkSize) {
        await tx.insert(jobRecommendations).values(
          recommendations.slice(i, i + chunkSize).map((r) => ({
            profileId,
            jobId: r.jobId,
            rank: r.rank,
            finalScore: r.score.finalScore,
            rawScore: r.score.rawScore,
            calibratedScore: r.score.calibratedScore,
            diversityPenalty: r.score.diversityPenalty,
            tier: r.score.tier,
            matchScore: r.matchScore,
            matchConfidence: r.matchConfidence,
            score: r.score,
            exposure: r.exposure,
            rankExplanation: r.rankExplanation,
            rankReasons: r.rankReasons,
            notificationEligible: r.notificationEligible,
            notificationBlockers: r.notificationBlockers,
            recommendationVersion: r.recommendationVersion,
            computedAt: r.computedAt,
          })),
        );
      }
    });

    return recommendations.length;
  }

  /**
   * Top-N, answered by the database.
   *
   * Every filter maps to an indexed column. Nothing is sorted in memory, which
   * is what keeps this constant-time as the corpus grows.
   */
  async topRecommendations(options: {
    profileId: string;
    limit?: number;
    offset?: number;
    minimumScore?: number;
    minimumConfidence?: number;
    tiers?: RecommendationTier[];
    notificationEligibleOnly?: boolean;
    lifecycleStatuses?: LifecycleStatus[];
    countries?: string[];
    sourceIds?: string[];
    companyIds?: string[];
    freshnessWindowHours?: number;
  }) {
    const conditions = [eq(jobRecommendations.profileId, options.profileId)];

    if (options.minimumScore !== undefined) {
      conditions.push(gte(jobRecommendations.finalScore, options.minimumScore));
    }
    if (options.minimumConfidence !== undefined) {
      conditions.push(gte(jobRecommendations.matchConfidence, options.minimumConfidence));
    }
    if (options.tiers?.length) conditions.push(inArray(jobRecommendations.tier, options.tiers));
    if (options.notificationEligibleOnly) {
      conditions.push(eq(jobRecommendations.notificationEligible, true));
    }
    if (options.lifecycleStatuses?.length) {
      conditions.push(inArray(jobSignals.lifecycleStatus, options.lifecycleStatuses));
    }
    if (options.freshnessWindowHours !== undefined) {
      conditions.push(lt(jobSignals.freshnessAgeHours, options.freshnessWindowHours));
    }
    if (options.countries?.length) conditions.push(inArray(jobs.countryCode, options.countries));
    if (options.sourceIds?.length) conditions.push(inArray(jobs.sourceId, options.sourceIds));
    if (options.companyIds?.length) conditions.push(inArray(jobs.companyId, options.companyIds));

    return this.db
      .select({
        recommendation: jobRecommendations,
        job: jobs,
        signals: jobSignals,
      })
      .from(jobRecommendations)
      .innerJoin(jobs, eq(jobs.id, jobRecommendations.jobId))
      .leftJoin(jobSignals, eq(jobSignals.jobId, jobRecommendations.jobId))
      .where(and(...conditions))
      .orderBy(desc(jobRecommendations.finalScore), jobRecommendations.rank)
      .limit(options.limit ?? 10)
      .offset(options.offset ?? 0);
  }

  async getRecommendation(profileId: string, jobId: string) {
    const rows = await this.db
      .select({ recommendation: jobRecommendations, job: jobs, signals: jobSignals })
      .from(jobRecommendations)
      .innerJoin(jobs, eq(jobs.id, jobRecommendations.jobId))
      .leftJoin(jobSignals, eq(jobSignals.jobId, jobRecommendations.jobId))
      .where(
        and(eq(jobRecommendations.profileId, profileId), eq(jobRecommendations.jobId, jobId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The ranking pool: every job with a current match for this candidate.
   *
   * Filtered in SQL down to eligible, non-closed matches before anything is
   * loaded, so the engine never sees the jobs it would only discard.
   */
  async loadRankingPool(profileId: string, options: { limit?: number; includeIneligible?: boolean } = {}) {
    const conditions = [eq(jobMatches.profileId, profileId)];
    if (!options.includeIneligible) conditions.push(eq(jobMatches.eligible, true));

    return this.db
      .select({
        job: jobs,
        match: jobMatches,
        enrichment: jobEnrichments,
        signals: jobSignals,
        duplicateOf: jobDuplicates.duplicateOfJobId,
      })
      .from(jobMatches)
      .innerJoin(jobs, eq(jobs.id, jobMatches.jobId))
      .leftJoin(jobEnrichments, eq(jobEnrichments.jobId, jobMatches.jobId))
      .leftJoin(jobSignals, eq(jobSignals.jobId, jobMatches.jobId))
      .leftJoin(
        jobDuplicates,
        and(eq(jobDuplicates.jobId, jobMatches.jobId), eq(jobDuplicates.merged, true)),
      )
      .where(and(...conditions))
      .orderBy(desc(jobMatches.overallScore))
      .limit(options.limit ?? 5000);
  }

  async recordRun(input: {
    profileId: string;
    considered: number;
    ranked: number;
    suppressed: number;
    notifiable: number;
    durationMs: number;
    distribution: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(recommendationRuns).values({
      ...input,
      durationMs: Math.round(input.durationMs),
      recommendationVersion: RECOMMENDATION_VERSION,
    });
  }

  async statistics(profileId: string) {
    const rows = await this.db
      .select({
        tier: jobRecommendations.tier,
        notifiable: jobRecommendations.notificationEligible,
        count: sql<number>`count(*)::int`,
        avgScore: sql<number>`avg(${jobRecommendations.finalScore})`,
      })
      .from(jobRecommendations)
      .where(eq(jobRecommendations.profileId, profileId))
      .groupBy(jobRecommendations.tier, jobRecommendations.notificationEligible);

    const byTier: Record<string, number> = {};
    let total = 0;
    let notifiable = 0;
    let scoreSum = 0;

    for (const row of rows) {
      byTier[row.tier] = (byTier[row.tier] ?? 0) + row.count;
      total += row.count;
      if (row.notifiable) notifiable += row.count;
      scoreSum += Number(row.avgScore ?? 0) * row.count;
    }

    return {
      total,
      notifiable,
      byTier,
      averageScore: total === 0 ? 0 : Math.round((scoreSum / total) * 100) / 100,
    };
  }

  private toDedupRow(
    job: typeof jobs.$inferSelect,
    applicationTarget: unknown,
    enrichmentRequirements: string[] | null,
  ): DedupCandidateRow {
    const target = applicationTarget as { atsVendor?: string | null; atsSlug?: string | null } | null;
    return {
      jobId: job.id,
      sourceId: job.sourceId,
      sourceType: '',
      externalId: job.externalId,
      sourceUrl: job.sourceUrl,
      canonicalUrl: job.canonicalUrl,
      applyUrl: job.applyUrl,
      companyName: job.companyNameRaw,
      companyId: job.companyId,
      companyDomain: job.companyWebsite,
      title: job.title,
      city: job.city,
      countryCode: job.countryCode,
      remoteType: job.remoteType,
      salaryAnnualUsd:
        job.salaryNormalizedAnnualUsd === null ? null : Number(job.salaryNormalizedAnnualUsd),
      postedAt: job.postedAt,
      description: job.description,
      requirements: enrichmentRequirements ?? job.requirements,
      atsVendor: target?.atsVendor ?? null,
      atsSlug: target?.atsSlug ?? null,
      simhash: job.simhash === null ? null : job.simhash.toString(),
      fingerprint: job.fingerprint,
      firstSeenAt: job.firstSeenAt,
      lastSeenAt: job.lastSeenAt,
    };
  }
}
