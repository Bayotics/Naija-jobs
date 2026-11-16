import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  MATCHING_VERSION,
  jobMatchSchema,
  type JobMatch,
  type RecommendationCategory,
} from '@job-intel/contracts';
import type { Database } from '../client';
import { jobMatchHistory, jobMatches } from '../schema/matching';
import { jobs } from '../schema/jobs';
import { jobEnrichments } from '../schema/enrichment';
import { candidatePreferenceVersions } from '../schema/candidate';

/**
 * Match persistence.
 *
 * Two behaviours worth naming, because both are easy to get subtly wrong:
 *
 *  - **Upsert plus history.** The current score is one row per (job, candidate)
 *    so "the score" is unambiguous, and every write also appends to
 *    `job_match_history`. Without the append, recomputation silently destroys
 *    the evidence that the number moved, and "why is this suddenly a weak
 *    match?" becomes unanswerable.
 *  - **Staleness is a query, not a guess.** A match is stale when any of its
 *    recorded input versions no longer matches the current one. That makes
 *    targeted recomputation possible instead of rescoring the whole corpus
 *    every time one preference changes.
 */

export interface PersistMatchInput {
  match: JobMatch;
  profileVersionId: string;
  preferenceVersionId: string | null;
  /** Why this recomputation happened, recorded on the history row. */
  reason?: string;
}

export interface StoredMatch extends JobMatch {
  id: string;
  computedAt: Date;
}

export interface MatchListOptions {
  profileId: string;
  limit?: number;
  offset?: number;
  minScore?: number;
  eligibleOnly?: boolean;
  recommendations?: RecommendationCategory[];
}

export class MatchRepository {
  constructor(private readonly db: Database) {}

  /** Upserts the current match and appends to history, in one transaction. */
  async save(input: PersistMatchInput): Promise<{ id: string }> {
    const { match } = input;

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(jobMatches)
        .values({
          jobId: match.jobId,
          profileId: match.candidateProfileId,
          profileVersionId: input.profileVersionId,
          preferenceVersionId: input.preferenceVersionId,
          overallScore: match.overallScore,
          confidence: match.confidence,
          recommendation: match.recommendation,
          eligible: match.eligible,
          structuredScore: match.trace.structuredScore,
          semanticScore: match.trace.semanticScore,
          behavioralAdjustment: match.trace.behavioralAdjustment,
          llmAdjustment: match.trace.llmAdjustment,
          hardConstraintResult: match.hardConstraintResult,
          componentScores: match.componentScores,
          skillMatches: match.skillMatches,
          matchedRequirements: match.matchedRequirements,
          missingRequirements: match.missingRequirements,
          concerns: match.concerns,
          positiveSignals: match.positiveSignals,
          negativeSignals: match.negativeSignals,
          explanation: match.explanation,
          trace: match.trace,
          matchingVersion: match.trace.matchingVersion,
          enrichmentVersion: match.trace.enrichmentVersion,
          modelId: match.llmUsage?.model ?? null,
          inputTokens: match.llmUsage?.inputTokens ?? null,
          outputTokens: match.llmUsage?.outputTokens ?? null,
          costUsd: match.llmUsage?.costUsd?.toString() ?? null,
          latencyMs: match.trace.durationMs,
          computedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [jobMatches.jobId, jobMatches.profileId],
          set: {
            profileVersionId: input.profileVersionId,
            preferenceVersionId: input.preferenceVersionId,
            overallScore: match.overallScore,
            confidence: match.confidence,
            recommendation: match.recommendation,
            eligible: match.eligible,
            structuredScore: match.trace.structuredScore,
            semanticScore: match.trace.semanticScore,
            behavioralAdjustment: match.trace.behavioralAdjustment,
            llmAdjustment: match.trace.llmAdjustment,
            hardConstraintResult: match.hardConstraintResult,
            componentScores: match.componentScores,
            skillMatches: match.skillMatches,
            matchedRequirements: match.matchedRequirements,
            missingRequirements: match.missingRequirements,
            concerns: match.concerns,
            positiveSignals: match.positiveSignals,
            negativeSignals: match.negativeSignals,
            explanation: match.explanation,
            trace: match.trace,
            matchingVersion: match.trace.matchingVersion,
            enrichmentVersion: match.trace.enrichmentVersion,
            modelId: match.llmUsage?.model ?? null,
            inputTokens: match.llmUsage?.inputTokens ?? null,
            outputTokens: match.llmUsage?.outputTokens ?? null,
            costUsd: match.llmUsage?.costUsd?.toString() ?? null,
            latencyMs: match.trace.durationMs,
            computedAt: new Date(),
          },
        })
        .returning({ id: jobMatches.id });

      await tx.insert(jobMatchHistory).values({
        jobId: match.jobId,
        profileId: match.candidateProfileId,
        overallScore: match.overallScore,
        confidence: match.confidence,
        recommendation: match.recommendation,
        eligible: match.eligible,
        matchingVersion: match.trace.matchingVersion,
        profileVersion: match.trace.profileVersion,
        preferenceVersion: match.trace.preferenceVersion,
        enrichmentVersion: match.trace.enrichmentVersion,
        reason: input.reason ?? null,
      });

      return { id: row!.id };
    });
  }

  /** Re-validated on read, so a payload written by an older engine fails loudly. */
  async get(jobId: string, profileId: string): Promise<StoredMatch | null> {
    const rows = await this.db
      .select()
      .from(jobMatches)
      .where(and(eq(jobMatches.jobId, jobId), eq(jobMatches.profileId, profileId)))
      .limit(1);

    const row = rows[0];
    return row ? this.toStoredMatch(row) : null;
  }

  async list(options: MatchListOptions): Promise<StoredMatch[]> {
    const conditions = [eq(jobMatches.profileId, options.profileId)];
    if (options.eligibleOnly) conditions.push(eq(jobMatches.eligible, true));
    if (options.minScore !== undefined) {
      conditions.push(gte(jobMatches.overallScore, options.minScore));
    }
    if (options.recommendations && options.recommendations.length > 0) {
      conditions.push(inArray(jobMatches.recommendation, options.recommendations));
    }

    const rows = await this.db
      .select()
      .from(jobMatches)
      .where(and(...conditions))
      .orderBy(desc(jobMatches.overallScore), desc(jobMatches.computedAt))
      .limit(options.limit ?? 50)
      .offset(options.offset ?? 0);

    return rows.map((row) => this.toStoredMatch(row));
  }

  async history(
    jobId: string,
    profileId: string,
    limit = 20,
  ): Promise<
    Array<{
      overallScore: number;
      confidence: number;
      recommendation: RecommendationCategory;
      eligible: boolean;
      matchingVersion: string;
      profileVersion: number;
      preferenceVersion: number;
      enrichmentVersion: number;
      reason: string | null;
      computedAt: Date;
    }>
  > {
    const rows = await this.db
      .select()
      .from(jobMatchHistory)
      .where(and(eq(jobMatchHistory.jobId, jobId), eq(jobMatchHistory.profileId, profileId)))
      .orderBy(desc(jobMatchHistory.computedAt))
      .limit(limit);

    return rows.map((row) => ({
      overallScore: row.overallScore,
      confidence: row.confidence,
      recommendation: row.recommendation as RecommendationCategory,
      eligible: row.eligible,
      matchingVersion: row.matchingVersion,
      profileVersion: row.profileVersion,
      preferenceVersion: row.preferenceVersion,
      enrichmentVersion: row.enrichmentVersion,
      reason: row.reason,
      computedAt: row.computedAt,
    }));
  }

  /**
   * Enriched jobs with no current, up-to-date match for this candidate.
   *
   * Drives incremental matching: a nightly run scores what changed rather than
   * everything, which is the difference between a job that finishes in seconds
   * and one that re-reads the entire corpus.
   */
  async findJobsNeedingMatch(
    profileId: string,
    options: { limit?: number; force?: boolean } = {},
  ): Promise<string[]> {
    const active = await this.db
      .select({ version: candidatePreferenceVersions.version })
      .from(candidatePreferenceVersions)
      .where(
        and(
          eq(candidatePreferenceVersions.profileId, profileId),
          eq(candidatePreferenceVersions.isActive, true),
        ),
      )
      .limit(1);
    const preferenceVersion = active[0]?.version ?? 0;

    const rows = await this.db
      .select({ jobId: jobs.id })
      .from(jobs)
      .innerJoin(jobEnrichments, eq(jobEnrichments.jobId, jobs.id))
      .leftJoin(
        jobMatches,
        and(eq(jobMatches.jobId, jobs.id), eq(jobMatches.profileId, profileId)),
      )
      .where(
        options.force
          ? eq(jobEnrichments.status, 'enriched')
          : and(
              eq(jobEnrichments.status, 'enriched'),
              or(
                // Never matched.
                isNull(jobMatches.id),
                // Any recorded input version has moved on since.
                ne(jobMatches.matchingVersion, MATCHING_VERSION),
                ne(jobMatches.enrichmentVersion, jobEnrichments.enrichmentVersion),
                sql`(${jobMatches.trace} ->> 'preferenceVersion')::int <> ${preferenceVersion}`,
              ),
            ),
      )
      .orderBy(desc(jobs.postedAt))
      .limit(options.limit ?? 500);

    return rows.map((row) => row.jobId);
  }

  /** Score distribution, for the run report and the dashboard. */
  async statistics(profileId: string): Promise<{
    total: number;
    eligible: number;
    byRecommendation: Record<string, number>;
    averageScore: number;
    averageConfidence: number;
  }> {
    const rows = await this.db
      .select({
        recommendation: jobMatches.recommendation,
        eligible: jobMatches.eligible,
        count: sql<number>`count(*)::int`,
        avgScore: sql<number>`avg(${jobMatches.overallScore})`,
        avgConfidence: sql<number>`avg(${jobMatches.confidence})`,
      })
      .from(jobMatches)
      .where(eq(jobMatches.profileId, profileId))
      .groupBy(jobMatches.recommendation, jobMatches.eligible);

    const byRecommendation: Record<string, number> = {};
    let total = 0;
    let eligible = 0;
    let scoreSum = 0;
    let confidenceSum = 0;

    for (const row of rows) {
      byRecommendation[row.recommendation] = (byRecommendation[row.recommendation] ?? 0) + row.count;
      total += row.count;
      if (row.eligible) eligible += row.count;
      scoreSum += Number(row.avgScore ?? 0) * row.count;
      confidenceSum += Number(row.avgConfidence ?? 0) * row.count;
    }

    return {
      total,
      eligible,
      byRecommendation,
      averageScore: total === 0 ? 0 : Math.round((scoreSum / total) * 100) / 100,
      averageConfidence: total === 0 ? 0 : Math.round((confidenceSum / total) * 1000) / 1000,
    };
  }

  /** Removes matches for a candidate. Used when a rebuild must start clean. */
  async deleteForProfile(profileId: string): Promise<number> {
    const deleted = await this.db
      .delete(jobMatches)
      .where(eq(jobMatches.profileId, profileId))
      .returning({ id: jobMatches.id });
    return deleted.length;
  }

  private toStoredMatch(row: typeof jobMatches.$inferSelect): StoredMatch {
    const match = jobMatchSchema.parse({
      jobId: row.jobId,
      candidateProfileId: row.profileId,
      overallScore: row.overallScore,
      confidence: row.confidence,
      recommendation: row.recommendation,
      eligible: row.eligible,
      hardConstraintResult: row.hardConstraintResult,
      componentScores: row.componentScores,
      skillMatches: row.skillMatches,
      matchedRequirements: row.matchedRequirements,
      missingRequirements: row.missingRequirements,
      concerns: row.concerns,
      positiveSignals: row.positiveSignals,
      negativeSignals: row.negativeSignals,
      explanation: row.explanation,
      trace: row.trace,
      llmUsage: row.modelId
        ? {
            model: row.modelId,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            costUsd: row.costUsd === null ? null : Number(row.costUsd),
            latencyMs: row.latencyMs,
            cached: false,
          }
        : null,
    });

    return { ...match, id: row.id, computedAt: row.computedAt };
  }
}
