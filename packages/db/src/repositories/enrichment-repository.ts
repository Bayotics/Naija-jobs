import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { jobEnrichmentSchema, type JobEnrichment } from '@job-intel/contracts';
import type { Database } from '../client';
import { jobEnrichments, jobSkillExtractions } from '../schema/enrichment';
import { jobs } from '../schema/jobs';
import { skills } from '../schema/identity';

/**
 * Enrichment persistence.
 *
 * The defining property is **idempotence**: enriching the same job twice must
 * produce the same row, not a duplicate and not a half-updated mixture. Both
 * writes are keyed on natural unique constraints and the skill rows are
 * replaced wholesale inside the same transaction, so a re-run either fully
 * lands or leaves the previous state intact.
 */
export class EnrichmentRepository {
  constructor(private readonly db: Database) {}

  /**
   * Jobs awaiting enrichment.
   *
   * Selects both never-enriched jobs and those enriched by an older extractor
   * version, which is what makes an extractor improvement replayable over the
   * whole corpus without a bespoke migration.
   */
  async findPending(options: { limit?: number; currentVersion: number } = { currentVersion: 1 }) {
    const limit = options.limit ?? 100;
    return this.db
      .select({
        id: jobs.id,
        title: jobs.title,
        companyNameRaw: jobs.companyNameRaw,
        companyWebsite: jobs.companyWebsite,
        description: jobs.description,
        descriptionHtml: jobs.descriptionHtml,
        locationRaw: jobs.locationRaw,
        remoteType: jobs.remoteType,
        sourceUrl: jobs.sourceUrl,
        applyUrl: jobs.applyUrl,
        salaryMin: jobs.salaryMin,
        salaryMax: jobs.salaryMax,
        salaryCurrency: jobs.salaryCurrency,
        salaryPeriod: jobs.salaryPeriod,
        techStack: jobs.techStack,
        sourceId: jobs.sourceId,
      })
      .from(jobs)
      .leftJoin(jobEnrichments, eq(jobEnrichments.jobId, jobs.id))
      .where(
        and(
          eq(jobs.status, 'active'),
          or(
            isNull(jobEnrichments.id),
            lt(jobEnrichments.enrichmentVersion, options.currentVersion),
          ),
        ),
      )
      .orderBy(asc(jobs.firstSeenAt))
      .limit(limit);
  }

  async get(jobId: string) {
    const rows = await this.db
      .select()
      .from(jobEnrichments)
      .where(eq(jobEnrichments.jobId, jobId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Writes an enrichment and its skill rows atomically.
   *
   * Skills are deleted and reinserted rather than merged: a re-extraction that
   * no longer finds a skill must remove it, and a merge would leave stale
   * requirements behind that the matching engine would keep trusting.
   */
  async save(jobId: string, enrichment: JobEnrichment): Promise<{ skillCount: number }> {
    const row = toRow(jobId, enrichment);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(jobEnrichments)
        .values(row)
        .onConflictDoUpdate({
          target: jobEnrichments.jobId,
          set: { ...row, updatedAt: new Date() },
        });

      await tx.delete(jobSkillExtractions).where(eq(jobSkillExtractions.jobId, jobId));

      if (enrichment.skills.length > 0) {
        // Reconcile against the canonical vocabulary where possible. A slug
        // with no matching row is still recorded; the vocabulary can catch up.
        const slugs = enrichment.skills.map((s) => s.slug);
        const known = await tx
          .select({ id: skills.id, slug: skills.slug })
          .from(skills)
          .where(inArray(skills.slug, slugs));
        const skillIdBySlug = new Map(known.map((k) => [k.slug, k.id]));

        await tx.insert(jobSkillExtractions).values(
          enrichment.skills.map((skill) => ({
            jobId,
            skillId: skillIdBySlug.get(skill.slug) ?? null,
            slug: skill.slug,
            displayName: skill.displayName,
            category: skill.category,
            requirement: skill.requirement,
            confidence: skill.confidence,
            method: skill.method,
            matchedText: skill.matchedText,
            evidence: skill.evidence,
          })),
        );
      }

      // Mirror the two scores onto the job so existing job queries and the
      // dashboard can filter without joining.
      await tx
        .update(jobs)
        .set({
          qualityScore: enrichment.quality.qualityScore,
          scamScore: enrichment.quality.scamScore,
          scamFlags: { flags: enrichment.quality.flags },
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));
    });

    return { skillCount: enrichment.skills.length };
  }

  /** Records a failure without discarding any previous successful enrichment. */
  async markFailed(jobId: string, error: string): Promise<void> {
    await this.db
      .update(jobEnrichments)
      .set({ status: 'failed', aiError: error.slice(0, 400), updatedAt: new Date() })
      .where(eq(jobEnrichments.jobId, jobId));
  }

  /**
   * Rebuilds a full, validated `JobEnrichment` from storage.
   *
   * The write path decomposes the object across promoted scalar columns, JSONB
   * blocks and a separate skills table — good for querying, useless for the
   * matching engine, which needs the whole shape back. Reconstructing here
   * rather than in each consumer keeps the decomposition an implementation
   * detail of this repository, and re-validating on the way out means a row
   * written by an older extractor either upgrades cleanly or fails loudly.
   */
  async getEnrichment(jobId: string): Promise<JobEnrichment | null> {
    const rows = await this.db
      .select({ enrichment: jobEnrichments, employmentTypes: jobs.employmentTypes })
      .from(jobEnrichments)
      .innerJoin(jobs, eq(jobs.id, jobEnrichments.jobId))
      .where(eq(jobEnrichments.jobId, jobId))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const extracted = await this.skillsFor(jobId);
    const e = row.enrichment;

    return jobEnrichmentSchema.parse({
      enrichmentVersion: e.enrichmentVersion,
      normalizedTitle: e.normalizedTitle,
      titleConfidence: e.titleConfidence ?? 0,
      roleSlug: e.roleSlug,
      seniority: e.seniority,
      seniorityConfidence: e.seniorityConfidence ?? 0,
      // Not promoted to a column; the JSONB blocks carry their own evidence.
      seniorityEvidence: null,
      seniorityConflict: e.seniorityConflict,
      experience: e.experience,
      employmentTypes: row.employmentTypes,
      workArrangement: e.workArrangement,
      location: e.location,
      compensation: e.compensation,
      workAuthorization: e.workAuthorization,
      education: e.education,
      classification: e.classification,
      quality: e.quality,
      applicationTarget: e.applicationTarget,
      skills: extracted.map((skill) => ({
        slug: skill.slug,
        displayName: skill.displayName,
        category: skill.category,
        requirement: skill.requirement,
        confidence: skill.confidence,
        method: skill.method,
        matchedText: skill.matchedText,
        evidence: skill.evidence,
      })),
      responsibilities: e.responsibilities,
      requirements: e.requirements,
      preferredQualifications: e.preferredQualifications,
      benefits: e.benefits,
      cleanedDescription: e.cleanedDescription,
      cleaningRemovedChars: e.cleaningRemovedChars,
      applicationDeadline: null,
      stageReports: e.stageReports,
      aiUsed: e.aiUsed,
      aiModel: e.aiModel,
      aiInputTokens: e.aiInputTokens,
      aiOutputTokens: e.aiOutputTokens,
      aiCostUsd: e.aiCostUsd === null ? null : Number(e.aiCostUsd),
      aiError: e.aiError,
      totalDurationMs: e.totalDurationMs,
    });
  }

  async skillsFor(jobId: string) {
    return this.db
      .select()
      .from(jobSkillExtractions)
      .where(eq(jobSkillExtractions.jobId, jobId))
      .orderBy(asc(jobSkillExtractions.requirement));
  }

  /** Aggregate counters for the enrichment dashboard. */
  async stats(currentVersion: number) {
    const [totals] = await this.db
      .select({
        jobs: sql<number>`count(*)::int`,
        enriched: sql<number>`count(${jobEnrichments.id})::int`,
        stale: sql<number>`count(*) FILTER (WHERE ${jobEnrichments.enrichmentVersion} < ${currentVersion})::int`,
        avgDurationMs: sql<number>`coalesce(round(avg(${jobEnrichments.totalDurationMs})), 0)::int`,
        aiCalls: sql<number>`count(*) FILTER (WHERE ${jobEnrichments.aiUsed})::int`,
        aiFailures: sql<number>`count(*) FILTER (WHERE ${jobEnrichments.aiError} IS NOT NULL)::int`,
        avgQuality: sql<number>`coalesce(round(avg(${jobEnrichments.qualityScore})::numeric, 3), 0)::float8`,
        flaggedScam: sql<number>`count(*) FILTER (WHERE ${jobEnrichments.scamScore} > 0.5)::int`,
      })
      .from(jobs)
      .leftJoin(jobEnrichments, eq(jobEnrichments.jobId, jobs.id))
      .where(eq(jobs.status, 'active'));

    return (
      totals ?? {
        jobs: 0, enriched: 0, stale: 0, avgDurationMs: 0,
        aiCalls: 0, aiFailures: 0, avgQuality: 0, flaggedScam: 0,
      }
    );
  }

  /** Skill frequency across enriched jobs, split by requirement strength. */
  async topSkills(limit = 20) {
    return this.db
      .select({
        slug: jobSkillExtractions.slug,
        displayName: jobSkillExtractions.displayName,
        category: jobSkillExtractions.category,
        total: sql<number>`count(*)::int`,
        required: sql<number>`count(*) FILTER (WHERE ${jobSkillExtractions.requirement} = 'required')::int`,
        inferred: sql<number>`count(*) FILTER (WHERE ${jobSkillExtractions.requirement} = 'inferred')::int`,
      })
      .from(jobSkillExtractions)
      .groupBy(jobSkillExtractions.slug, jobSkillExtractions.displayName, jobSkillExtractions.category)
      .orderBy(sql`count(*) DESC`)
      .limit(limit);
  }
}

function toRow(jobId: string, e: JobEnrichment) {
  return {
    jobId,
    enrichmentVersion: e.enrichmentVersion,
    status: 'enriched' as const,

    normalizedTitle: e.normalizedTitle,
    roleSlug: e.roleSlug,
    titleConfidence: e.titleConfidence,

    seniority: e.seniority,
    seniorityConfidence: e.seniorityConfidence,
    seniorityConflict: e.seniorityConflict,

    minYearsExperience: e.experience.minimumYears,
    maxYearsExperience: e.experience.maximumYears,

    workMode: e.workArrangement.mode,
    workModeConfidence: e.workArrangement.confidence,
    remoteWorldwide: e.workArrangement.remoteWorldwide,
    remoteRegions: e.workArrangement.remoteRegions,

    countryCode: e.location.countryCode,
    city: e.location.city,

    visaSponsorship: e.workAuthorization.sponsorship,
    visaConfidence: e.workAuthorization.sponsorshipConfidence,

    salaryStated: e.compensation.stated,
    salaryAnnualUsd:
      e.compensation.conversion !== null ? String(e.compensation.conversion.annualUsd) : null,

    jobFunction: e.classification.jobFunction,
    qualityScore: e.quality.qualityScore,
    scamScore: e.quality.scamScore,

    experience: e.experience,
    workArrangement: e.workArrangement,
    location: e.location,
    compensation: e.compensation,
    workAuthorization: e.workAuthorization,
    education: e.education,
    classification: e.classification,
    quality: e.quality,
    applicationTarget: e.applicationTarget,

    responsibilities: e.responsibilities,
    requirements: e.requirements,
    preferredQualifications: e.preferredQualifications,
    benefits: e.benefits,

    cleanedDescription: e.cleanedDescription,
    cleaningRemovedChars: e.cleaningRemovedChars,

    stageReports: e.stageReports,
    totalDurationMs: Math.round(e.totalDurationMs),
    aiUsed: e.aiUsed,
    aiModel: e.aiModel,
    aiInputTokens: e.aiInputTokens,
    aiOutputTokens: e.aiOutputTokens,
    aiCostUsd: e.aiCostUsd !== null ? String(e.aiCostUsd) : null,
    aiError: e.aiError,
  };
}
