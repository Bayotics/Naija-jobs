import {
  applicationAnalyticsSchema,
  type ApplicationAnalytics,
  type ApplicationIntelligence,
  type ApplicationRecommendation,
  type ApplicationRecord,
  type ApplicationStatus,
  type CalibrationReport,
  type OpportunityState,
  type ResumePerformance,
} from '@job-intel/contracts';
import type {
  ApplicationRepository,
  CandidateRepository,
  EnrichmentRepository,
  IntelligenceRepository,
  JobRepository,
  MatchRepository,
  ProfileRepository,
} from '@job-intel/db';
import type { EventRecorder, Logger } from '@job-intel/observability';
import { SkillGraph, aggregateSignals, type ObservedEvent } from '@job-intel/candidate';
import {
  computeAnalytics,
  computeCalibration,
  computeFunnel,
  computeResumePerformance,
  runApplicationIntelligence,
} from '@job-intel/application';

/**
 * The application intelligence service.
 *
 * Loads everything the pure engine needs, runs it, and persists the result. The
 * engine itself has no database, no clock and no network, which is what makes
 * the twenty-fixture simulation a real test of the policy rather than a test of
 * the plumbing.
 *
 * One rule is enforced here and nowhere else: **nothing in this service
 * submits an application.** `analyse` can move an opportunity as far as
 * RECOMMENDED. Everything past that is a method a person's click calls, and the
 * repository refuses a `system` actor on those transitions regardless.
 */

export interface ApplicationServiceDependencies {
  applications: ApplicationRepository;
  intelligence: IntelligenceRepository;
  candidates: CandidateRepository;
  profiles: ProfileRepository;
  matches: MatchRepository;
  jobs: JobRepository;
  enrichments: EnrichmentRepository;
  logger: Logger;
  events: EventRecorder;
  graph?: SkillGraph;
}

export interface AnalyseResult {
  intelligence: ApplicationIntelligence;
  state: OpportunityState;
}

export interface AnalyseRunResult {
  candidateId: string;
  considered: number;
  analysed: number;
  failed: number;
  byRecommendation: Record<string, number>;
  durationMs: number;
  errors: Array<{ jobId: string; error: string }>;
}

export class ApplicationService {
  private readonly graph: SkillGraph;

  constructor(private readonly deps: ApplicationServiceDependencies) {
    this.graph = deps.graph ?? new SkillGraph();
  }

  /**
   * Analyses one job for one candidate.
   *
   * Everything the engine reads is loaded here rather than inside it, so a
   * failure to load one optional input — a missing profile, an unenriched job —
   * degrades the answer rather than throwing. `UNKNOWN` with a stated reason is
   * a legitimate output; an exception is not.
   */
  async analyse(
    candidateId: string,
    jobId: string,
    options: { now?: Date } = {},
  ): Promise<AnalyseResult> {
    const now = options.now ?? new Date();

    const job = await this.deps.jobs.getById(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const [
      enrichment,
      profile,
      preferencesRow,
      documents,
      match,
      duplicate,
      acknowledged,
      policy,
    ] = await Promise.all([
      this.deps.enrichments.getEnrichment(jobId).catch(() => null),
      this.deps.intelligence.getActiveProfile(candidateId).catch(() => null),
      this.deps.candidates.getActivePreferences(candidateId).catch(() => null),
      this.deps.intelligence.listExtractions(candidateId).catch(() => []),
      this.deps.matches.get(jobId, candidateId).catch(() => null),
      this.deps.applications.checkDuplicate(candidateId, jobId).catch(() => null),
      this.deps.applications.acknowledgedFor(candidateId, jobId).catch(() => []),
      this.deps.applications.getPolicy(candidateId).catch(() => undefined),
    ]);

    const companyHistory = await this.deps.applications
      .companyHistory(candidateId, job.companyNameRaw)
      .catch(() => null);

    /*
     * Behavioural signals, read but never allowed to lead.
     *
     * They reach the engine only through `scorePreferenceAlignment`, which caps
     * their influence and refuses to apply any signal that contradicts an
     * explicit preference. Passing them in here is safe because the ceiling is
     * enforced downstream rather than by whoever assembles this object.
     */
    const signalRows = await this.deps.candidates
      .listSignalsWithAttributes(candidateId)
      .catch(() => []);

    const observed: ObservedEvent[] = signalRows.map((row) => ({
      event: row.event,
      occurredAt: row.occurredAt,
      attributes: {
        countryCode: row.countryCode,
        workMode: row.workMode,
        companyName: row.companyName,
        jobFunction: row.jobFunction,
        seniority: row.seniority,
        technologies: row.techStack ?? [],
        industries: (row.classification as { industries?: string[] } | null)?.industries ?? [],
      },
    }));

    const learnedSignals = preferencesRow
      ? aggregateSignals(observed, preferencesRow.preferences)
      : [];

    const intelligence = runApplicationIntelligence({
      jobId,
      candidateId,
      jobTitle: job.title,
      companyName: job.companyNameRaw,
      companyWebsite: job.companyWebsite,
      description: enrichment?.cleanedDescription ?? job.description,
      postedAt: job.postedAt,
      validThrough: job.validThrough,
      closed: job.status === 'closed' || job.status === 'expired',
      applyUrl: job.applyUrl,
      sourceCount: 1,
      enrichment: enrichment ?? null,
      profile,
      preferences: preferencesRow?.preferences ?? null,
      // The constraint evaluation lives on the match; absent when unmatched.
      evaluation: null,
      learnedSignals,
      documents,
      matchScore: match?.overallScore ?? null,
      jobQualityScore: enrichment?.quality.qualityScore ?? null,
      scamScore: enrichment?.quality.scamScore ?? null,
      duplicate,
      companyHistory,
      // Left null unless a connector genuinely reported applicant numbers.
      reportedApplicants: null,
      acknowledgedBlockerIds: acknowledged,
      hasPortfolio: false,
      graph: this.graph,
      policy,
      now,
    });

    await this.deps.applications.saveIntelligence(intelligence);

    /*
     * The opportunity advances to RECOMMENDED and stops.
     *
     * SKIP and BLOCKED stay at ANALYZED rather than moving to SKIPPED: the
     * system has formed an opinion, not made a decision, and SKIPPED is a state
     * a person enters.
     */
    const state: OpportunityState =
      intelligence.overallRecommendation === 'APPLY_NOW' ||
      intelligence.overallRecommendation === 'APPLY' ||
      intelligence.overallRecommendation === 'CONSIDER'
        ? 'RECOMMENDED'
        : 'ANALYZED';

    await this.deps.applications.upsertOpportunity({
      candidateId,
      jobId,
      state,
      recommendation: intelligence.overallRecommendation,
      applicationValueScore: intelligence.applicationValueScore,
    });

    return { intelligence, state };
  }

  /**
   * Analyses every job that needs it.
   *
   * A failure on one job is recorded and the run continues, for the same reason
   * the matching run does it: one malformed posting must not cost the candidate
   * the other four hundred results.
   */
  async analyseAll(
    candidateId: string,
    options: { limit?: number; now?: Date } = {},
  ): Promise<AnalyseRunResult> {
    const startedAt = Date.now();
    const profile = await this.deps.intelligence.getActiveProfile(candidateId).catch(() => null);

    const jobIds = await this.deps.applications.jobsNeedingAnalysis(
      candidateId,
      profile?.profileVersion ?? null,
      options.limit ?? 200,
    );

    const result: AnalyseRunResult = {
      candidateId,
      considered: jobIds.length,
      analysed: 0,
      failed: 0,
      byRecommendation: {},
      durationMs: 0,
      errors: [],
    };

    for (const jobId of jobIds) {
      try {
        const { intelligence } = await this.analyse(candidateId, jobId, options);
        result.analysed += 1;
        result.byRecommendation[intelligence.overallRecommendation] =
          (result.byRecommendation[intelligence.overallRecommendation] ?? 0) + 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push({
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    result.durationMs = Date.now() - startedAt;

    await this.deps.events.emit('APPLICATION_ANALYSIS_COMPLETED', {
      message: `Analysed ${result.analysed} of ${result.considered} jobs`,
      data: {
        candidateId,
        analysed: result.analysed,
        failed: result.failed,
        ...result.byRecommendation,
      },
    });

    return result;
  }

  /** The ranked list for the dashboard. */
  async opportunities(
    candidateId: string,
    options: { recommendations?: ApplicationRecommendation[]; limit?: number } = {},
  ) {
    return this.deps.applications.topOpportunities(candidateId, options);
  }

  async counts(candidateId: string) {
    return this.deps.applications.recommendationCounts(candidateId);
  }

  async commonGaps(candidateId: string, limit = 15) {
    return this.deps.applications.commonGaps(candidateId, limit);
  }

  async intelligenceFor(candidateId: string, jobId: string) {
    return this.deps.applications.getIntelligence(candidateId, jobId);
  }

  // ── Human decisions (Part 39) ─────────────────────────────────────────────

  /**
   * A person's decision about an opportunity.
   *
   * The only path into REVIEWED, APPROVED, APPLIED, SKIPPED and WITHDRAWN.
   * Every call carries `actor: 'user'` because there is no caller that is not a
   * person clicking something — and the repository rejects the alternative.
   */
  async decide(input: {
    candidateId: string;
    jobId: string;
    to: OpportunityState;
    note?: string | null;
  }) {
    const result = await this.deps.applications.transition({
      candidateId: input.candidateId,
      jobId: input.jobId,
      to: input.to,
      actor: 'user',
      reason: input.note ?? null,
    });

    if (result.ok) {
      await this.deps.events.emit('APPLICATION_OPPORTUNITY_UPDATED', {
        message: `Opportunity moved to ${input.to}`,
        data: { candidateId: input.candidateId, jobId: input.jobId, state: input.to },
      });
    }

    return result;
  }

  /** Records an application the candidate says they made. */
  async recordApplication(input: {
    candidateId: string;
    jobId: string;
    appliedAt: Date;
    documentId?: string | null;
    applicationUrl?: string | null;
    coverLetterUsed?: boolean;
    referral?: string | null;
    contactName?: string | null;
    notes?: string | null;
  }): Promise<ApplicationRecord> {
    // Freeze what the system said, so calibration knows what they were shown.
    const intelligence = await this.deps.applications
      .getIntelligence(input.candidateId, input.jobId)
      .catch(() => null);

    const record = await this.deps.applications.recordApplication({
      ...input,
      recommendationAtApply: intelligence?.overallRecommendation ?? null,
      valueScoreAtApply: intelligence?.applicationValueScore ?? null,
    });

    // Best-effort: the record is the thing that matters, not the workflow row.
    const opportunity = await this.deps.applications
      .getOpportunity(input.candidateId, input.jobId)
      .catch(() => null);

    if (opportunity && opportunity.state !== 'APPLIED') {
      if (opportunity.state !== 'APPROVED') {
        await this.deps.applications
          .transition({
            candidateId: input.candidateId,
            jobId: input.jobId,
            to: 'REVIEWED',
            actor: 'user',
            reason: 'Recorded an application',
          })
          .catch(() => undefined);

        await this.deps.applications
          .transition({
            candidateId: input.candidateId,
            jobId: input.jobId,
            to: 'APPROVED',
            actor: 'user',
            reason: 'Recorded an application',
          })
          .catch(() => undefined);
      }

      await this.deps.applications
        .transition({
          candidateId: input.candidateId,
          jobId: input.jobId,
          to: 'APPLIED',
          actor: 'user',
          reason: 'Recorded an application',
        })
        .catch(() => undefined);
    }

    await this.deps.events.emit('APPLICATION_RECORDED', {
      message: 'Application recorded',
      data: { candidateId: input.candidateId, jobId: input.jobId },
    });

    return record;
  }

  async updateStatus(input: {
    applicationId: string;
    status: ApplicationStatus;
    note?: string | null;
    occurredAt?: Date;
  }) {
    return this.deps.applications.updateApplicationStatus(input);
  }

  async applications(candidateId: string) {
    return this.deps.applications.listApplications(candidateId);
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  async analytics(candidateId: string): Promise<ApplicationAnalytics> {
    const [rows, labels] = await Promise.all([
      this.deps.applications.applicationsWithJobFacts(candidateId),
      this.deps.applications.documentLabels(candidateId),
    ]);

    const records = await this.deps.applications.listApplications(candidateId);

    if (records.length === 0) {
      /*
       * An empty funnel is still a funnel.
       *
       * `overall` has no schema default on purpose — an analytics record with
       * no funnel would be a broken record rather than an empty one — so the
       * zero case is constructed explicitly instead of being left undefined.
       */
      return applicationAnalyticsSchema.parse({
        candidateId,
        overall: computeFunnel([]),
        byDimension: {},
      });
    }

    const jobFacts = new Map(
      rows.map((row) => [
        row.record.jobId,
        {
          companyName: row.companyName,
          sourceId: row.sourceId,
          seniority: row.seniority,
          countryCode: row.countryCode,
          roleSlug: null,
        },
      ]),
    );

    return computeAnalytics({ candidateId, records, jobFacts, documentLabels: labels });
  }

  async resumePerformance(candidateId: string): Promise<ResumePerformance[]> {
    const [records, labels] = await Promise.all([
      this.deps.applications.listApplications(candidateId),
      this.deps.applications.documentLabels(candidateId),
    ]);

    return computeResumePerformance({ records, documentLabels: labels });
  }

  /**
   * Whether the recommendations are any good.
   *
   * Uses the only ground truth available — what the candidate did, and what
   * happened next. Note what counts as a decision: an opportunity the candidate
   * explicitly skipped, or one they applied to. Ones they simply have not
   * opened are not evidence of anything and are excluded.
   */
  async calibration(candidateId: string): Promise<CalibrationReport> {
    const rows = await this.deps.applications.calibrationDecisions(candidateId);

    const decisions = rows
      .filter((row) => row.status !== null || row.state === 'SKIPPED')
      .map((row) => ({
        recommendation: row.recommendation as ApplicationRecommendation,
        applied: row.status !== null,
        skipped: row.state === 'SKIPPED',
        responded:
          row.firstResponseAt !== null ||
          ['recruiter_contacted', 'screening', 'interview', 'technical_interview', 'final_interview', 'offer', 'rejected'].includes(
            row.status ?? '',
          ),
        interviewed: ['interview', 'technical_interview', 'final_interview', 'offer'].includes(
          row.status ?? '',
        ),
      }));

    return computeCalibration({ candidateId, decisions });
  }
}
