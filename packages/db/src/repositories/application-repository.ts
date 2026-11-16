import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  OPPORTUNITY_TRANSITIONS,
  applicationIntelligenceSchema,
  applicationOpportunitySchema,
  applicationPolicySchema,
  applicationRecordSchema,
  duplicateCheckSchema,
  companyHistorySchema,
  type ApplicationIntelligence,
  type ApplicationOpportunity,
  type ApplicationPolicy,
  type ApplicationRecord,
  type ApplicationRecommendation,
  type ApplicationStatus,
  type CompanyHistory,
  type DuplicateCheck,
  type OpportunityState,
} from '@job-intel/contracts';
import type { Database } from '../client';
import {
  acknowledgedBlockers,
  applicationIntelligence,
  applicationOpportunities,
  applicationPolicies,
  applicationRecords,
  applicationStatusEvents,
  opportunityTransitions,
} from '../schema/application-intelligence';
import { jobs } from '../schema/jobs';
import { candidateDocuments } from '../schema/candidate-intelligence';

/**
 * Application intelligence persistence.
 *
 * The invariant this class exists to hold is the one in Part 39: **the system
 * never records that an application was submitted.** `transition` refuses any
 * move the state machine does not allow, and every move past RECOMMENDED
 * requires an explicit `actor: 'user'`. A background job physically cannot
 * advance an opportunity to APPLIED, because the code path that would do so
 * rejects its own actor.
 */
export class ApplicationRepository {
  constructor(private readonly db: Database) {}

  // ── Computed intelligence ─────────────────────────────────────────────────

  async saveIntelligence(intelligence: ApplicationIntelligence): Promise<void> {
    const unknowns = intelligence.eligibility.assessments
      .filter((entry) => entry.support === 'UNKNOWN' && entry.requirement.importance === 'required')
      .map((entry) => entry.requirement.text)
      .slice(0, 40);

    const row = {
      candidateId: intelligence.candidateId,
      jobId: intelligence.jobId,
      overallRecommendation: intelligence.overallRecommendation,
      confidence: intelligence.confidence,
      applicationValueScore: intelligence.applicationValueScore,
      matchScore: intelligence.matchScore,
      profileVersion: intelligence.profileVersion,
      eligibility: intelligence.eligibility,
      requirements: intelligence.eligibility.assessments.map((entry) => entry.requirement),
      qualification: intelligence.qualification,
      skillAlignment: intelligence.skillAlignment,
      experienceAlignment: intelligence.experienceAlignment,
      preferenceAlignment: intelligence.preferenceAlignment,
      careerAlignment: intelligence.careerAlignment,
      jobQuality: intelligence.jobQuality,
      experience: intelligence.experience,
      seniority: intelligence.seniority,
      compensation: intelligence.compensation,
      authorization: intelligence.authorization,
      language: intelligence.language,
      location: intelligence.location,
      friction: intelligence.friction,
      competitiveness: intelligence.competitiveness,
      timing: intelligence.timing,
      legitimacy: intelligence.legitimacy,
      blockers: intelligence.blockers,
      resume: intelligence.resume,
      positioning: intelligence.positioning,
      checklist: intelligence.checklist,
      explanation: intelligence.explanation,
      unknownRequirements: unknowns,
      algorithmVersion: intelligence.algorithmVersion,
      generatedAt: intelligence.generatedAt,
    };

    await this.db
      .insert(applicationIntelligence)
      .values(row)
      .onConflictDoUpdate({
        target: [
          applicationIntelligence.candidateId,
          applicationIntelligence.jobId,
          applicationIntelligence.profileVersion,
        ],
        set: row,
      });
  }

  async getIntelligence(
    candidateId: string,
    jobId: string,
  ): Promise<ApplicationIntelligence | null> {
    const [row] = await this.db
      .select()
      .from(applicationIntelligence)
      .where(
        and(
          eq(applicationIntelligence.candidateId, candidateId),
          eq(applicationIntelligence.jobId, jobId),
        ),
      )
      // Newest profile version first: the current reading, not a historic one.
      .orderBy(desc(applicationIntelligence.profileVersion), desc(applicationIntelligence.generatedAt))
      .limit(1);

    if (!row) return null;

    const parsed = applicationIntelligenceSchema.safeParse({
      ...row,
      companyHistory: companyHistorySchema.parse({}),
      duplicate: duplicateCheckSchema.parse({}),
      strengths: row.explanation.strengths,
      gaps: [...row.explanation.missing, ...row.explanation.unknowns],
    });

    return parsed.success ? parsed.data : null;
  }

  /** Ranked opportunities for the dashboard. */
  async topOpportunities(
    candidateId: string,
    options: {
      recommendations?: ApplicationRecommendation[];
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const conditions = [eq(applicationIntelligence.candidateId, candidateId)];

    if (options.recommendations?.length) {
      conditions.push(
        inArray(applicationIntelligence.overallRecommendation, options.recommendations),
      );
    }

    return this.db
      .select({
        jobId: applicationIntelligence.jobId,
        title: jobs.title,
        companyName: jobs.companyNameRaw,
        applyUrl: jobs.applyUrl,
        recommendation: applicationIntelligence.overallRecommendation,
        confidence: applicationIntelligence.confidence,
        valueScore: applicationIntelligence.applicationValueScore,
        matchScore: applicationIntelligence.matchScore,
        explanation: applicationIntelligence.explanation,
        timing: applicationIntelligence.timing,
        resume: applicationIntelligence.resume,
        blockers: applicationIntelligence.blockers,
        generatedAt: applicationIntelligence.generatedAt,
      })
      .from(applicationIntelligence)
      .innerJoin(jobs, eq(jobs.id, applicationIntelligence.jobId))
      .where(and(...conditions))
      .orderBy(desc(applicationIntelligence.applicationValueScore))
      .limit(options.limit ?? 25)
      .offset(options.offset ?? 0);
  }

  /** Counts per recommendation, for the dashboard header. */
  async recommendationCounts(candidateId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({
        recommendation: applicationIntelligence.overallRecommendation,
        total: sql<number>`count(*)::int`,
      })
      .from(applicationIntelligence)
      .where(eq(applicationIntelligence.candidateId, candidateId))
      .groupBy(applicationIntelligence.overallRecommendation);

    return Object.fromEntries(rows.map((row) => [row.recommendation, row.total]));
  }

  /**
   * Requirements the candidate's opportunities keep asking for and their
   * profile keeps not answering.
   *
   * Counted per job rather than per mention, so a posting that names Kubernetes
   * four times is one job that wants Kubernetes.
   */
  async commonGaps(candidateId: string, limit = 15) {
    const rows = await this.db
      .select({ unknowns: applicationIntelligence.unknownRequirements })
      .from(applicationIntelligence)
      .where(eq(applicationIntelligence.candidateId, candidateId));

    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const requirement of new Set(row.unknowns)) {
        counts.set(requirement, (counts.get(requirement) ?? 0) + 1);
      }
    }

    const total = Math.max(1, rows.length);

    return [...counts.entries()]
      .map(([requirement, jobCount]) => ({
        requirement,
        jobs: jobCount,
        share: Math.round((jobCount / total) * 100) / 100,
      }))
      .sort((a, b) => b.jobs - a.jobs)
      .slice(0, limit);
  }

  // ── Acknowledged blockers ─────────────────────────────────────────────────

  /**
   * Blocker ids the candidate has dismissed for this job.
   *
   * Includes globally dismissed ones: someone who says "I do have US work
   * authorisation" is telling us about themselves, not about one posting, and
   * making them repeat it on every job would train them to ignore the control.
   */
  async acknowledgedFor(candidateId: string, jobId: string): Promise<string[]> {
    const rows = await this.db
      .select({ blockerId: acknowledgedBlockers.blockerId })
      .from(acknowledgedBlockers)
      .where(
        and(
          eq(acknowledgedBlockers.candidateId, candidateId),
          or(eq(acknowledgedBlockers.jobId, jobId), isNull(acknowledgedBlockers.jobId)),
        ),
      );

    return rows.map((row) => row.blockerId);
  }

  async acknowledgeBlocker(input: {
    candidateId: string;
    jobId: string | null;
    blockerId: string;
    note?: string | null;
  }): Promise<void> {
    await this.db
      .insert(acknowledgedBlockers)
      .values({
        candidateId: input.candidateId,
        jobId: input.jobId,
        blockerId: input.blockerId,
        note: input.note ?? null,
      })
      .onConflictDoNothing();
  }

  async unacknowledgeBlocker(input: {
    candidateId: string;
    jobId: string | null;
    blockerId: string;
  }): Promise<void> {
    await this.db
      .delete(acknowledgedBlockers)
      .where(
        and(
          eq(acknowledgedBlockers.candidateId, input.candidateId),
          input.jobId === null
            ? isNull(acknowledgedBlockers.jobId)
            : eq(acknowledgedBlockers.jobId, input.jobId),
          eq(acknowledgedBlockers.blockerId, input.blockerId),
        ),
      );
  }

  // ── Opportunities ─────────────────────────────────────────────────────────

  async upsertOpportunity(input: {
    candidateId: string;
    jobId: string;
    state?: OpportunityState;
    recommendation?: ApplicationRecommendation | null;
    applicationValueScore?: number | null;
  }): Promise<ApplicationOpportunity> {
    const [row] = await this.db
      .insert(applicationOpportunities)
      .values({
        candidateId: input.candidateId,
        jobId: input.jobId,
        state: input.state ?? 'ANALYZED',
        recommendation: input.recommendation ?? null,
        applicationValueScore: input.applicationValueScore ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [applicationOpportunities.candidateId, applicationOpportunities.jobId],
        set: {
          recommendation: input.recommendation ?? null,
          applicationValueScore: input.applicationValueScore ?? null,
          updatedAt: new Date(),
          /*
           * Re-analysis must not rewind a decision.
           *
           * Once a person has reviewed, approved, applied or skipped, a
           * recomputed score updates the numbers and leaves the state alone —
           * otherwise a nightly job would silently undo what they did.
           */
          state: sql`CASE WHEN ${applicationOpportunities.state} IN ('DISCOVERED','ANALYZED','RECOMMENDED')
                          THEN ${input.state ?? 'ANALYZED'}
                          ELSE ${applicationOpportunities.state} END`,
        },
      })
      .returning();

    return applicationOpportunitySchema.parse(row);
  }

  async getOpportunity(candidateId: string, jobId: string): Promise<ApplicationOpportunity | null> {
    const [row] = await this.db
      .select()
      .from(applicationOpportunities)
      .where(
        and(
          eq(applicationOpportunities.candidateId, candidateId),
          eq(applicationOpportunities.jobId, jobId),
        ),
      )
      .limit(1);

    return row ? applicationOpportunitySchema.parse(row) : null;
  }

  async listOpportunities(
    candidateId: string,
    options: { states?: OpportunityState[]; limit?: number } = {},
  ) {
    const conditions = [eq(applicationOpportunities.candidateId, candidateId)];
    if (options.states?.length) {
      conditions.push(inArray(applicationOpportunities.state, options.states));
    }

    return this.db
      .select({
        id: applicationOpportunities.id,
        jobId: applicationOpportunities.jobId,
        title: jobs.title,
        companyName: jobs.companyNameRaw,
        state: applicationOpportunities.state,
        recommendation: applicationOpportunities.recommendation,
        valueScore: applicationOpportunities.applicationValueScore,
        reviewedAt: applicationOpportunities.reviewedAt,
        reviewNote: applicationOpportunities.reviewNote,
        updatedAt: applicationOpportunities.updatedAt,
      })
      .from(applicationOpportunities)
      .innerJoin(jobs, eq(jobs.id, applicationOpportunities.jobId))
      .where(and(...conditions))
      .orderBy(desc(applicationOpportunities.applicationValueScore))
      .limit(options.limit ?? 100);
  }

  /**
   * Advances an opportunity, refusing anything the state machine disallows.
   *
   * The human-approval boundary from Part 39 is enforced here rather than in a
   * caller, because a caller can be replaced by another caller. `system` may
   * move a row as far as RECOMMENDED; every state beyond that requires a
   * person, and the attempt is rejected rather than logged and allowed.
   */
  async transition(input: {
    candidateId: string;
    jobId: string;
    to: OpportunityState;
    actor: 'system' | 'user';
    reason?: string | null;
  }): Promise<{ ok: true; opportunity: ApplicationOpportunity } | { ok: false; error: string }> {
    const current = await this.getOpportunity(input.candidateId, input.jobId);
    if (!current) return { ok: false, error: 'No opportunity exists for this job.' };

    const allowed = OPPORTUNITY_TRANSITIONS[current.state] ?? [];
    if (!allowed.includes(input.to)) {
      return {
        ok: false,
        error: `Cannot move from ${current.state} to ${input.to}. Allowed: ${allowed.join(', ') || 'none'}.`,
      };
    }

    const humanOnly: readonly OpportunityState[] = ['REVIEWED', 'APPROVED', 'APPLIED', 'WITHDRAWN'];
    if (humanOnly.includes(input.to) && input.actor !== 'user') {
      return {
        ok: false,
        error: `${input.to} can only be set by a person. The system does not apply on your behalf.`,
      };
    }

    const now = new Date();

    const [row] = await this.db
      .update(applicationOpportunities)
      .set({
        state: input.to,
        updatedAt: now,
        ...(input.actor === 'user' ? { reviewedAt: now, reviewNote: input.reason ?? null } : {}),
      })
      .where(eq(applicationOpportunities.id, current.id))
      .returning();

    await this.db.insert(opportunityTransitions).values({
      opportunityId: current.id,
      fromState: current.state,
      toState: input.to,
      actor: input.actor,
      reason: input.reason ?? null,
      occurredAt: now,
    });

    return { ok: true, opportunity: applicationOpportunitySchema.parse(row) };
  }

  async transitionHistory(opportunityId: string) {
    return this.db
      .select()
      .from(opportunityTransitions)
      .where(eq(opportunityTransitions.opportunityId, opportunityId))
      .orderBy(desc(opportunityTransitions.occurredAt))
      .limit(50);
  }

  // ── Applications ──────────────────────────────────────────────────────────

  /** Records an application the candidate says they made. */
  async recordApplication(input: {
    candidateId: string;
    jobId: string;
    appliedAt: Date;
    status?: ApplicationStatus;
    applicationUrl?: string | null;
    documentId?: string | null;
    coverLetterUsed?: boolean;
    referral?: string | null;
    contactName?: string | null;
    notes?: string | null;
    recommendationAtApply?: ApplicationRecommendation | null;
    valueScoreAtApply?: number | null;
  }): Promise<ApplicationRecord> {
    const now = new Date();

    const [row] = await this.db
      .insert(applicationRecords)
      .values({
        candidateId: input.candidateId,
        jobId: input.jobId,
        status: input.status ?? 'applied',
        appliedAt: input.appliedAt,
        applicationUrl: input.applicationUrl ?? null,
        documentId: input.documentId ?? null,
        coverLetterUsed: input.coverLetterUsed ?? false,
        referral: input.referral ?? null,
        contactName: input.contactName ?? null,
        notes: input.notes ?? null,
        recommendationAtApply: input.recommendationAtApply ?? null,
        valueScoreAtApply: input.valueScoreAtApply ?? null,
        lastStatusChangeAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [applicationRecords.candidateId, applicationRecords.jobId],
        set: {
          appliedAt: input.appliedAt,
          applicationUrl: input.applicationUrl ?? null,
          documentId: input.documentId ?? null,
          coverLetterUsed: input.coverLetterUsed ?? false,
          notes: input.notes ?? null,
          updatedAt: now,
        },
      })
      .returning();

    await this.db.insert(applicationStatusEvents).values({
      applicationId: row!.id,
      fromStatus: null,
      toStatus: input.status ?? 'applied',
      occurredAt: input.appliedAt,
    });

    return applicationRecordSchema.parse(row);
  }

  async updateApplicationStatus(input: {
    applicationId: string;
    status: ApplicationStatus;
    note?: string | null;
    occurredAt?: Date;
  }): Promise<ApplicationRecord | null> {
    const [current] = await this.db
      .select()
      .from(applicationRecords)
      .where(eq(applicationRecords.id, input.applicationId))
      .limit(1);

    if (!current) return null;

    const occurredAt = input.occurredAt ?? new Date();

    /*
     * First response is recorded once and never moved.
     *
     * Time-to-response is measured from the *first* sign of life, and letting a
     * later status overwrite it would quietly turn a two-day reply into a
     * six-week one.
     */
    const responded: readonly ApplicationStatus[] = [
      'recruiter_contacted',
      'screening',
      'interview',
      'technical_interview',
      'final_interview',
      'offer',
      'rejected',
    ];

    const firstResponseAt =
      current.firstResponseAt ?? (responded.includes(input.status) ? occurredAt : null);

    const [row] = await this.db
      .update(applicationRecords)
      .set({
        status: input.status,
        firstResponseAt,
        lastStatusChangeAt: occurredAt,
        updatedAt: new Date(),
      })
      .where(eq(applicationRecords.id, input.applicationId))
      .returning();

    await this.db.insert(applicationStatusEvents).values({
      applicationId: input.applicationId,
      fromStatus: current.status,
      toStatus: input.status,
      note: input.note ?? null,
      occurredAt,
    });

    return applicationRecordSchema.parse(row);
  }

  async listApplications(candidateId: string, limit = 500): Promise<ApplicationRecord[]> {
    const rows = await this.db
      .select()
      .from(applicationRecords)
      .where(eq(applicationRecords.candidateId, candidateId))
      .orderBy(desc(applicationRecords.appliedAt))
      .limit(limit);

    return rows
      .map((row) => applicationRecordSchema.safeParse(row))
      .filter((parsed): parsed is { success: true; data: ApplicationRecord } => parsed.success)
      .map((parsed) => parsed.data);
  }

  async applicationsWithJobFacts(candidateId: string, limit = 500) {
    return this.db
      .select({
        record: applicationRecords,
        companyName: jobs.companyNameRaw,
        sourceId: jobs.sourceId,
        seniority: jobs.seniority,
        countryCode: jobs.countryCode,
        title: jobs.title,
      })
      .from(applicationRecords)
      .innerJoin(jobs, eq(jobs.id, applicationRecords.jobId))
      .where(eq(applicationRecords.candidateId, candidateId))
      .orderBy(desc(applicationRecords.appliedAt))
      .limit(limit);
  }

  async documentLabels(candidateId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ id: candidateDocuments.id, label: candidateDocuments.label })
      .from(candidateDocuments)
      .where(eq(candidateDocuments.candidateId, candidateId));

    return new Map(rows.map((row) => [row.id, row.label]));
  }

  // ── Duplicate detection (Part 25) ─────────────────────────────────────────

  /**
   * Whether the candidate has already dealt with this job.
   *
   * Checks the job's duplicate group as well as the job itself, so the same
   * posting syndicated to four boards does not produce four recommendations
   * after the candidate has applied through one of them.
   */
  async checkDuplicate(candidateId: string, jobId: string): Promise<DuplicateCheck> {
    const [job] = await this.db
      .select({ groupId: jobs.jobGroupId })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    const siblingIds = job?.groupId
      ? (
          await this.db
            .select({ id: jobs.id })
            .from(jobs)
            .where(eq(jobs.jobGroupId, job.groupId))
            .limit(50)
        ).map((row) => row.id)
      : [jobId];

    const ids = siblingIds.length > 0 ? siblingIds : [jobId];

    const [existing] = await this.db
      .select()
      .from(applicationRecords)
      .where(
        and(eq(applicationRecords.candidateId, candidateId), inArray(applicationRecords.jobId, ids)),
      )
      .orderBy(desc(applicationRecords.appliedAt))
      .limit(1);

    if (!existing) return duplicateCheckSchema.parse({});

    const sameJob = existing.jobId === jobId;
    const when = existing.appliedAt.toISOString().slice(0, 10);

    if (existing.status === 'rejected') {
      return duplicateCheckSchema.parse({
        reason: 'already_rejected',
        relatedJobId: existing.jobId,
        relatedAppliedAt: existing.appliedAt,
        suppresses: true,
        explanation: sameJob
          ? `You applied to this role on ${when} and were not taken forward.`
          : `You applied to the same role through another listing on ${when} and were not taken forward.`,
      });
    }

    return duplicateCheckSchema.parse({
      reason: sameJob ? 'already_applied' : 'same_job_other_url',
      relatedJobId: existing.jobId,
      relatedAppliedAt: existing.appliedAt,
      suppresses: true,
      explanation: sameJob
        ? `You applied to this role on ${when}.`
        : `This is the same role you applied to through another listing on ${when}.`,
    });
  }

  /**
   * The candidate's history with a company.
   *
   * `sentiment` is bounded small and deliberately forgiving: one rejection from
   * a company that runs a good process is noise, and a system that closes a
   * door on it narrows someone's search without ever telling them.
   */
  async companyHistory(candidateId: string, companyName: string | null): Promise<CompanyHistory> {
    if (!companyName) return companyHistorySchema.parse({});

    const rows = await this.db
      .select({
        status: applicationRecords.status,
        appliedAt: applicationRecords.appliedAt,
        firstResponseAt: applicationRecords.firstResponseAt,
      })
      .from(applicationRecords)
      .innerJoin(jobs, eq(jobs.id, applicationRecords.jobId))
      .where(
        and(
          eq(applicationRecords.candidateId, candidateId),
          eq(jobs.companyNameRaw, companyName),
        ),
      )
      .limit(50);

    if (rows.length === 0) return companyHistorySchema.parse({ companyName });

    const rejections = rows.filter((row) => row.status === 'rejected').length;
    const interviews = rows.filter((row) =>
      ['interview', 'technical_interview', 'final_interview', 'offer'].includes(row.status),
    ).length;

    const lastInteractionAt = rows.reduce<Date | null>(
      (latest, row) => (latest === null || row.appliedAt > latest ? row.appliedAt : latest),
      null,
    );

    /*
     * Interviews outweigh rejections.
     *
     * A company that has interviewed you twice and rejected you twice is a
     * company that likes your profile. Only a run of rejections with no
     * engagement at all should discourage another application, and even then
     * only slightly.
     */
    const sentiment = Math.max(
      -0.6,
      Math.min(0.6, interviews * 0.25 - Math.max(0, rejections - interviews) * 0.12),
    );

    const parts = [`${rows.length} previous application${rows.length === 1 ? '' : 's'} here`];
    if (interviews > 0) parts.push(`${interviews} reached interview`);
    if (rejections > 0) parts.push(`${rejections} rejected`);

    return companyHistorySchema.parse({
      companyName,
      applications: rows.length,
      rejections,
      interviews,
      saves: 0,
      lastInteractionAt,
      sentiment,
      explanation: `${parts.join(', ')}.`,
    });
  }

  // ── Calibration ───────────────────────────────────────────────────────────

  /**
   * What the system recommended against what the candidate did.
   *
   * A left join from intelligence to applications: every recommendation shown,
   * with the application if one followed. Opportunities the candidate explicitly
   * skipped count as a decision; ones they simply have not looked at do not.
   */
  async calibrationDecisions(candidateId: string, sinceDays = 180) {
    const since = new Date(Date.now() - sinceDays * 86_400_000);

    return this.db
      .select({
        recommendation: applicationIntelligence.overallRecommendation,
        jobId: applicationIntelligence.jobId,
        state: applicationOpportunities.state,
        status: applicationRecords.status,
        firstResponseAt: applicationRecords.firstResponseAt,
      })
      .from(applicationIntelligence)
      .leftJoin(
        applicationOpportunities,
        and(
          eq(applicationOpportunities.candidateId, applicationIntelligence.candidateId),
          eq(applicationOpportunities.jobId, applicationIntelligence.jobId),
        ),
      )
      .leftJoin(
        applicationRecords,
        and(
          eq(applicationRecords.candidateId, applicationIntelligence.candidateId),
          eq(applicationRecords.jobId, applicationIntelligence.jobId),
        ),
      )
      .where(
        and(
          eq(applicationIntelligence.candidateId, candidateId),
          gte(applicationIntelligence.generatedAt, since),
        ),
      )
      .limit(2_000);
  }

  // ── Policy ────────────────────────────────────────────────────────────────

  async getPolicy(candidateId: string): Promise<ApplicationPolicy> {
    const [row] = await this.db
      .select()
      .from(applicationPolicies)
      .where(eq(applicationPolicies.candidateId, candidateId))
      .limit(1);

    return applicationPolicySchema.parse(row?.policy ?? {});
  }

  async setPolicy(candidateId: string, policy: ApplicationPolicy): Promise<void> {
    await this.db
      .insert(applicationPolicies)
      .values({ candidateId, policy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: applicationPolicies.candidateId,
        set: { policy, updatedAt: new Date() },
      });
  }

  /** Jobs with a match but no current application intelligence. */
  async jobsNeedingAnalysis(
    candidateId: string,
    profileVersion: number | null,
    limit = 200,
  ): Promise<string[]> {
    const analysed = await this.db
      .select({ jobId: applicationIntelligence.jobId })
      .from(applicationIntelligence)
      .where(
        and(
          eq(applicationIntelligence.candidateId, candidateId),
          profileVersion === null
            ? isNull(applicationIntelligence.profileVersion)
            : eq(applicationIntelligence.profileVersion, profileVersion),
        ),
      );

    const done = new Set(analysed.map((row) => row.jobId));

    const candidates = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.status, 'active'))
      .orderBy(desc(jobs.firstSeenAt))
      .limit(limit * 3);

    return candidates
      .map((row) => row.id)
      .filter((id) => !done.has(id))
      .slice(0, limit);
  }
}
