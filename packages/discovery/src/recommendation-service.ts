import { randomUUID } from 'node:crypto';
import {
  jobEnrichmentSchema,
  qualityAssessmentSchema,
  type CandidatePreferences,
  type FeatureAffinity,
  type LearningConfig,
  type RecommendationConfig,
  type TopRecommendationsQuery,
} from '@job-intel/contracts';
import type {
  CandidateRepository,
  DedupCandidateRow,
  LearningRepository,
  ProfileRepository,
  RecommendationRepository,
  SourceRepository,
} from '@job-intel/db';
import type { EventRecorder, Logger } from '@job-intel/observability';
import {
  computeBehavioralAdjustment,
  extractFeatures,
  type JobAttributes,
} from '@job-intel/candidate';
import {
  CanonicalJobBuilder,
  type RecommendationEngineOptions,
  DuplicateDetector,
  NullUrlVerifier,
  RecommendationEngine,
  SourceAuthorityResolver,
  behavioralAffinity,
  detectMaterialChanges,
  verifyBatch,
  type DedupCandidate,
  type RecommendationInput,
  type UrlVerifier,
} from '@job-intel/recommendation';

/**
 * Recommendation orchestration.
 *
 * Binds the pure engine to persistence and runs the pipeline stages the brief
 * lays out — dedup → signals → verify → rank — in that order, because each one
 * consumes what the previous produced.
 *
 * Nothing is cached across runs. Ranking depends on the *current* pool, the
 * *current* preferences and the *current* time, and a cache at this level would
 * be the mechanism by which yesterday's digest quietly became today's.
 */

export interface RecommendationServiceDependencies {
  recommendations: RecommendationRepository;
  candidates: CandidateRepository;
  profiles: ProfileRepository;
  sources: SourceRepository;
  logger: Logger;
  events: EventRecorder;
  config?: RecommendationEngineOptions['config'];
  verifier?: UrlVerifier;
  /**
   * The feedback loop, when it is available.
   *
   * Optional so ranking works before any behaviour has been recorded, and so a
   * deployment can switch personalisation off by not wiring it at all.
   */
  learning?: LearningRepository;
}

export interface DedupRunResult {
  examined: number;
  merged: number;
  recorded: number;
  groups: number;
  conflicts: number;
  durationMs: number;
}

export interface RankingRunResult {
  profileId: string;
  considered: number;
  ranked: number;
  suppressed: number;
  notifiable: number;
  durationMs: number;
  distribution: Record<string, unknown>;
  topJobIds: string[];
}

export class RecommendationService {
  private readonly engine: RecommendationEngine;
  private readonly detector: DuplicateDetector;
  private readonly authority: SourceAuthorityResolver;
  private readonly canonicalBuilder: CanonicalJobBuilder;
  private readonly verifier: UrlVerifier;

  constructor(private readonly deps: RecommendationServiceDependencies) {
    this.engine = new RecommendationEngine({
      ...(deps.config ? { config: deps.config } : {}),
    });
    this.detector = new DuplicateDetector({ config: this.engine.config.dedup });
    this.authority = new SourceAuthorityResolver(this.engine.config.authority);
    this.canonicalBuilder = new CanonicalJobBuilder(this.authority);
    this.verifier = deps.verifier ?? new NullUrlVerifier();
  }

  get config(): RecommendationConfig {
    return this.engine.config;
  }

  // ── Stage: deduplication ──────────────────────────────────────────────────

  /**
   * Deduplicates a batch of jobs.
   *
   * Every verdict is recorded, merged or not. A near-miss is exactly what
   * someone needs when asking "why weren't these merged?", and discarding
   * everything below the threshold leaves that unanswerable.
   */
  async deduplicate(jobIds: readonly string[]): Promise<DedupRunResult> {
    const startedAt = Date.now();
    const result: DedupRunResult = {
      examined: 0,
      merged: 0,
      recorded: 0,
      groups: 0,
      conflicts: 0,
      durationMs: 0,
    };

    const sourceTypes = await this.sourceTypeMap();
    const groupsTouched = new Set<string>();

    for (const jobId of jobIds) {
      const subject = await this.deps.recommendations.getDedupCandidate(jobId);
      if (!subject) continue;
      result.examined += 1;

      const candidates = await this.deps.recommendations.findDedupCandidates({
        jobId,
        fingerprint: subject.fingerprint,
        companyId: subject.companyId,
        urlHash: null,
      });

      const best = this.detector.findBest(
        this.toDedupCandidate(subject),
        candidates.map((c) => this.toDedupCandidate(c)),
      );
      if (!best) continue;

      const target = candidates.find((c) => c.jobId === best.candidate.jobId);
      if (!target) continue;

      const merged = best.verdict.isDuplicate;
      await this.deps.recommendations.saveDuplicateVerdict({
        jobId,
        duplicateOfJobId: target.jobId,
        verdict: best.verdict,
        merged,
      });
      result.recorded += 1;

      if (!merged) continue;
      result.merged += 1;

      // Members share a group so the canonical view can be assembled from it.
      const groupId = randomUUID();
      await this.deps.recommendations.assignGroup(jobId, groupId);
      await this.deps.recommendations.assignGroup(target.jobId, groupId);

      const members = await this.deps.recommendations.listGroupMembers(groupId);
      const assembly = this.canonicalBuilder.build(
        groupId,
        members.map((member) => ({
          candidate: this.toDedupCandidate(member),
          sourceType: sourceTypes.get(member.sourceId) ?? '',
          firstSeenAt: member.firstSeenAt,
          lastSeenAt: member.lastSeenAt,
          duplicateConfidence:
            member.jobId === jobId ? best.verdict.duplicateConfidence : 1,
          duplicateReason: member.jobId === jobId ? best.verdict.duplicateReason : 'canonical member',
        })),
      );

      await this.deps.recommendations.saveGroupMerge({
        groupId,
        canonicalJobId: assembly.canonical.canonicalJobId,
        bestApplyUrl: assembly.canonical.bestApplyUrl,
        bestApplyUrlSourceId: assembly.canonical.bestApplyUrlSourceId,
        memberCount: assembly.canonical.members.length,
        provenance: assembly.canonical.provenance,
        conflicts: assembly.canonical.conflicts,
      });

      groupsTouched.add(groupId);
      result.conflicts += assembly.canonical.conflicts.length;
    }

    result.groups = groupsTouched.size;
    result.durationMs = Date.now() - startedAt;
    this.deps.logger.info('Deduplication complete', { ...result });
    return result;
  }

  // ── Stage: signals ────────────────────────────────────────────────────────

  /** Recomputes the per-job signals every candidate's ranking will read. */
  async refreshSignals(options: { limit?: number; staleAfterHours?: number } = {}): Promise<number> {
    const jobIds = await this.deps.recommendations.findJobsNeedingSignals(options);
    if (jobIds.length === 0) return 0;

    const pool = await this.buildSignalInputs(jobIds);
    let updated = 0;

    for (const input of pool) {
      const signals = this.engine.computeSignals(input);
      await this.deps.recommendations.saveSignals(input.jobId, {
        ...signals,
        absenceRuns: input.absenceRuns,
      });
      updated += 1;
    }

    this.deps.logger.info('Job signals refreshed', { updated, requested: jobIds.length });
    return updated;
  }

  // ── Stage: verification ───────────────────────────────────────────────────

  /**
   * Re-verifies the highest-value application URLs.
   *
   * Budgeted and score-ordered: a truncated run checks the jobs about to be
   * emailed rather than whichever happened to be first.
   */
  async verifyHighValue(profileId: string): Promise<{ checked: number; skipped: number }> {
    if (!this.verifier || this.verifier.id === 'null') return { checked: 0, skipped: 0 };

    const rows = await this.deps.recommendations.topRecommendations({
      profileId,
      limit: this.config.verification.maxChecksPerRun * 3,
      minimumScore: this.config.verification.highValueScore * 0.8,
    });

    const run = await verifyBatch(
      rows.map((row) => ({
        jobId: row.job.id,
        url: row.job.applyUrl ?? row.job.canonicalUrl ?? row.job.sourceUrl,
        recommendationScore: row.recommendation.finalScore,
        lastVerifiedAt: row.job.lastVerifiedAt,
      })),
      this.verifier,
      this.config.verification,
    );

    for (const { jobId, result } of run.results) {
      await this.deps.recommendations.recordVerification(jobId, result);
    }

    this.deps.logger.info('High-value verification complete', {
      profileId,
      checked: run.checked,
      skipped: run.skipped,
    });
    return { checked: run.checked, skipped: run.skipped };
  }

  // ── Stage: ranking ────────────────────────────────────────────────────────

  /**
   * Ranks everything matched for a candidate and stores the result.
   *
   * One pass over the pool with no per-job model call, which is what lets ten
   * thousand jobs be ranked inside a scheduled run rather than a budget.
   */
  async rank(
    profileId: string,
    query: Partial<TopRecommendationsQuery> = {},
  ): Promise<RankingRunResult> {
    const pool = await this.buildRankingPool(profileId);
    const result = this.engine.rank(profileId, pool, query);

    await this.deps.recommendations.replaceRecommendations(profileId, result.recommendations);

    const notifiable = result.recommendations.filter((r) => r.notificationEligible).length;
    await this.deps.recommendations.recordRun({
      profileId,
      considered: pool.length,
      ranked: result.recommendations.length,
      suppressed: result.suppressed.length,
      notifiable,
      durationMs: result.durationMs,
      distribution: result.distribution as unknown as Record<string, unknown>,
    });

    await this.deps.events.emit('RECOMMENDATIONS_RANKED', {
      message: `Ranked ${result.recommendations.length} of ${pool.length} jobs`,
      data: {
        profileId,
        ranked: result.recommendations.length,
        notifiable,
        suppressed: result.suppressed.length,
        durationMs: result.durationMs,
        clustered: result.distribution.clustered,
      },
    });

    return {
      profileId,
      considered: pool.length,
      ranked: result.recommendations.length,
      suppressed: result.suppressed.length,
      notifiable,
      durationMs: result.durationMs,
      distribution: result.distribution as unknown as Record<string, unknown>,
      topJobIds: result.recommendations.slice(0, 10).map((r) => r.jobId),
    };
  }

  /** `getTopRecommendations(candidateId, options)` — the Part 25 entry point. */
  async getTopRecommendations(profileId: string, query: Partial<TopRecommendationsQuery> = {}) {
    return this.deps.recommendations.topRecommendations({
      profileId,
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
      ...(query.minimumScore !== undefined ? { minimumScore: query.minimumScore } : {}),
      ...(query.minimumConfidence !== undefined
        ? { minimumConfidence: query.minimumConfidence }
        : {}),
      ...(query.tiers ? { tiers: query.tiers } : {}),
      ...(query.notificationEligibleOnly
        ? { notificationEligibleOnly: query.notificationEligibleOnly }
        : {}),
      ...(query.lifecycleStatuses ? { lifecycleStatuses: query.lifecycleStatuses } : {}),
      ...(query.countries ? { countries: query.countries } : {}),
      ...(query.sourceIds ? { sourceIds: query.sourceIds } : {}),
      ...(query.companyIds ? { companyIds: query.companyIds } : {}),
      ...(query.freshnessWindowHours !== undefined
        ? { freshnessWindowHours: query.freshnessWindowHours }
        : {}),
    });
  }

  /** Records that a job reached the candidate, so it is not sent twice. */
  async recordShown(profileId: string, jobIds: readonly string[]): Promise<void> {
    for (const jobId of jobIds) {
      await this.deps.recommendations.recordExposure({ profileId, jobId, state: 'shown' });
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async sourceTypeMap(): Promise<Map<string, string>> {
    const sources = await this.deps.sources.list({ includeArchived: true });
    return new Map(sources.map((s) => [s.id, s.sourceType]));
  }

  private toDedupCandidate(row: DedupCandidateRow): DedupCandidate {
    return {
      jobId: row.jobId,
      sourceId: row.sourceId,
      externalId: row.externalId,
      sourceUrl: row.sourceUrl,
      canonicalUrl: row.canonicalUrl,
      applyUrl: row.applyUrl,
      companyName: row.companyName,
      companyDomain: row.companyDomain,
      title: row.title,
      city: row.city,
      countryCode: row.countryCode,
      remoteType: row.remoteType,
      salaryAnnualUsd: row.salaryAnnualUsd,
      postedAt: row.postedAt,
      description: row.description,
      requirements: row.requirements,
      atsVendor: row.atsVendor,
      atsSlug: row.atsSlug,
      simhash: row.simhash,
    };
  }

  /** Signal inputs for jobs with no candidate involved. */
  private async buildSignalInputs(jobIds: readonly string[]): Promise<RecommendationInput[]> {
    const sourceTypes = await this.sourceTypeMap();

    /*
     * Two queries for the whole batch, not two per job.
     *
     * This loop used to issue `getDedupCandidate` and `latestVerification`
     * inside it. Against a local database that is merely wasteful; against a
     * hosted one it is fatal — a 1,469-job refresh became ~4,400 sequential
     * round trips, overran its task lease every time, and left the signals
     * table frozen while each pass still reported success.
     */
    const rows = await this.deps.recommendations.getDedupCandidates(jobIds);
    const verifications = await this.deps.recommendations.latestVerifications(jobIds);

    const inputs: RecommendationInput[] = [];

    for (const jobId of jobIds) {
      const row = rows.get(jobId);
      if (!row) continue;

      inputs.push(
        this.baseInput(row, sourceTypes, { verification: verifications.get(jobId) ?? null }),
      );
    }

    return inputs;
  }

  private baseInput(
    row: DedupCandidateRow,
    sourceTypes: Map<string, string>,
    extra: {
      verification: { outcome: string; httpStatus: number | null } | null;
    },
  ): RecommendationInput {
    const reachable =
      extra.verification === null
        ? null
        : extra.verification.outcome === 'reachable'
          ? true
          : extra.verification.outcome === 'not_found' || extra.verification.outcome === 'gone'
            ? false
            : null;

    return {
      jobId: row.jobId,
      title: row.title,
      companyName: row.companyName,
      companyId: row.companyId,
      companyDomain: row.companyDomain,
      roleSlug: null,
      technologies: [],
      sourceId: row.sourceId,
      sourceType: sourceTypes.get(row.sourceId) ?? '',

      matchScore: 0,
      matchConfidence: 0,
      matchEligible: true,
      matchExplanation: '',
      matchedRequirements: [],
      concerns: [],

      enrichmentQuality: qualityAssessmentSchema.parse({
        qualityScore: 0.5,
        scamScore: 0,
        qualityConfidence: 0.3,
      }),
      description: row.description,
      descriptionLength: row.description?.length ?? 0,
      requirements: row.requirements,
      responsibilities: [],
      salaryAnnualUsd: row.salaryAnnualUsd,
      minYearsExperience: null,
      contactEmails: extractEmails(row.description),

      applyUrl: row.applyUrl,
      postingUrl: row.canonicalUrl ?? row.sourceUrl,
      applicationUrlReachable: reachable,
      verification: extra.verification,

      postedAt: row.postedAt,
      validThrough: null,
      updatedAt: null,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      lastVerifiedAt: null,
      absenceRuns: 0,
      removedFromSource: false,

      duplicateSourceCount: 1,
      duplicateOf: null,
      copiedDescriptionCount: 0,

      sightings: distinctSightings(row.firstSeenAt, row.lastSeenAt),
      contentHashes: [],
      claimedPostingDates: row.postedAt ? [row.postedAt] : [],

      exposure: null,
      materialChange: null,
    };
  }

  /**
   * Assembles the ranking pool for one candidate.
   *
   * Two batch reads rather than per-job queries: exposure and merged-duplicate
   * maps are loaded once, because N round trips inside a ranking loop is the
   * difference between a ranking that scales and one that does not.
   */
  /**
   * One behavioural number for the ranker, from two sources.
   *
   * Per-job history dominates when it exists — someone who dismissed this exact
   * posting has said something specific and unambiguous. Generalised affinity
   * fills in for the far more common case of a job they have never seen.
   *
   * The learned half is scaled from the adjustment's point budget into the
   * -1..1 range the ranker expects, so the same configured ceiling governs how
   * far behaviour can move a result whichever path produced it.
   */
  private combinedAffinity(input: {
    jobId: string;
    events: ReadonlyArray<{ event: never; occurredAt: Date }>;
    affinities: readonly FeatureAffinity[];
    preferences: CandidatePreferences | null;
    learningConfig: LearningConfig | undefined;
    hasHistory: boolean;
    attributes: Omit<JobAttributes, 'jobId' | 'companySize'>;
  }): number {
    const direct = input.events.length > 0 ? behavioralAffinity(input.events) : 0;

    // Direct evidence about this posting outranks a generalisation about
    // postings like it.
    if (direct !== 0) return direct;
    if (!input.hasHistory || input.affinities.length === 0) return 0;

    const features = extractFeatures({
      jobId: input.jobId,
      companySize: null,
      ...input.attributes,
    });

    const adjustment = computeBehavioralAdjustment({
      jobId: input.jobId,
      features,
      affinities: input.affinities,
      preferences: input.preferences,
      ...(input.learningConfig ? { config: input.learningConfig } : {}),
      hasSufficientData: input.hasHistory,
    });

    const ceiling = input.learningConfig?.maxBehavioralAdjustment ?? 12;
    if (ceiling <= 0) return 0;

    return Math.max(-1, Math.min(1, adjustment.adjustment / ceiling));
  }

  private async buildRankingPool(profileId: string): Promise<RecommendationInput[]> {
    const [rows, exposures, snapshots, sourceTypes] = await Promise.all([
      this.deps.recommendations.loadRankingPool(profileId),
      this.deps.recommendations.loadExposures(profileId),
      this.deps.recommendations.loadNotifiedSnapshots(profileId),
      this.sourceTypeMap(),
    ]);

    const signalRows = await this.deps.candidates.listSignalsWithAttributes(profileId);
    const affinityByJob = new Map<string, Array<{ event: never; occurredAt: Date }>>();
    for (const row of signalRows) {
      const list = affinityByJob.get(row.jobId) ?? [];
      list.push({ event: row.event as never, occurredAt: row.occurredAt });
      affinityByJob.set(row.jobId, list);
    }

    /*
     * Learned affinities from the feedback loop.
     *
     * Two behavioural inputs exist and they answer different questions. The
     * per-job signal above asks "what did you do with *this* posting"; the
     * affinities here ask "what do you consistently engage with". The second is
     * what generalises to a job the candidate has never seen.
     *
     * Everything is routed through `computeBehavioralAdjustment` rather than
     * applied directly, because that function is where the authority hierarchy
     * is enforced: it refuses to move a job on a dimension the candidate has
     * stated explicitly, and returns a zero adjustment with a stated reason
     * when learning is switched off or there is not enough history.
     */
    const learning = this.deps.learning ?? null;

    const [affinities, learningConfig, preferences] = learning
      ? await Promise.all([
          learning.listAffinities(profileId).catch(() => []),
          learning.getConfig(profileId).catch(() => undefined),
          this.deps.candidates
            .getActivePreferences(profileId)
            .then((row) => row?.preferences ?? null)
            .catch(() => null),
        ])
      : [[], undefined, null];

    const hasHistory = affinities.length > 0;

    // Duplicate members of the same group, counted once so `sourceCount` is
    // corroboration rather than a tally of how noisy the aggregators are.
    const groupCounts = new Map<string, number>();
    for (const row of rows) {
      if (!row.job.jobGroupId) continue;
      groupCounts.set(row.job.jobGroupId, (groupCounts.get(row.job.jobGroupId) ?? 0) + 1);
    }

    return rows.map((row) => {
      const enrichment = row.enrichment
        ? safeParseEnrichmentQuality(row.enrichment.quality)
        : qualityAssessmentSchema.parse({ qualityScore: 0.5, scamScore: 0, qualityConfidence: 0.3 });

      const exposure = exposures.get(row.job.id) ?? null;
      const events = affinityByJob.get(row.job.id) ?? [];

      const snapshot = snapshots.get(row.job.id);
      const materialChange =
        exposure?.notifiedAt && snapshot
          ? detectMaterialChanges(snapshot as never, {
              salaryAnnualUsd:
                row.job.salaryNormalizedAnnualUsd === null
                  ? null
                  : Number(row.job.salaryNormalizedAnnualUsd),
              city: row.job.city,
              countryCode: row.job.countryCode,
              remoteType: row.job.remoteType,
              visaSponsorship: row.job.visaSponsorship,
              seniority: row.job.seniority,
              employmentTypes: row.job.employmentTypes,
              requirements: row.job.requirements,
              applyUrl: row.job.applyUrl,
            })
          : null;

      return {
        jobId: row.job.id,
        title: row.job.title,
        companyName: row.job.companyNameRaw,
        companyId: row.job.companyId,
        companyDomain: row.job.companyWebsite,
        roleSlug: row.enrichment?.roleSlug ?? null,
        technologies: row.job.techStack,
        sourceId: row.job.sourceId,
        sourceType: sourceTypes.get(row.job.sourceId) ?? '',

        matchScore: row.match.overallScore,
        matchConfidence: row.match.confidence,
        matchEligible: row.match.eligible,
        matchExplanation: row.match.explanation,
        matchedRequirements: row.match.matchedRequirements,
        concerns: row.match.concerns,

        enrichmentQuality: enrichment,
        description: row.enrichment?.cleanedDescription ?? row.job.description,
        descriptionLength: (row.enrichment?.cleanedDescription ?? row.job.description ?? '').length,
        requirements: row.enrichment?.requirements ?? row.job.requirements,
        responsibilities: row.enrichment?.responsibilities ?? row.job.responsibilities,
        salaryAnnualUsd:
          row.job.salaryNormalizedAnnualUsd === null
            ? null
            : Number(row.job.salaryNormalizedAnnualUsd),
        minYearsExperience: row.job.minYearsExperience,
        contactEmails: extractEmails(row.job.description),

        applyUrl: row.job.applyUrl,
        postingUrl: row.job.canonicalUrl ?? row.job.sourceUrl,
        applicationUrlReachable: null,
        verification: null,

        postedAt: row.job.postedAt,
        validThrough: row.job.validThrough,
        updatedAt: row.job.updatedAt,
        firstSeenAt: row.job.firstSeenAt,
        lastSeenAt: row.job.lastSeenAt,
        lastVerifiedAt: row.job.lastVerifiedAt,
        absenceRuns: row.signals?.absenceRuns ?? 0,
        removedFromSource: row.job.status === 'closed' || row.job.status === 'expired',

        duplicateSourceCount: row.job.jobGroupId
          ? (groupCounts.get(row.job.jobGroupId) ?? 1)
          : 1,
        duplicateOf: row.duplicateOf ?? null,
        copiedDescriptionCount: 0,

        sightings: distinctSightings(row.job.firstSeenAt, row.job.lastSeenAt),
        contentHashes: [row.job.contentHash],
        claimedPostingDates: row.job.postedAt ? [row.job.postedAt] : [],

        exposure,
        materialChange,
        behavioralAffinity: this.combinedAffinity({
          jobId: row.job.id,
          events,
          affinities,
          preferences,
          learningConfig,
          hasHistory,
          attributes: {
            technologies: row.job.techStack ?? [],
            companyName: row.job.companyNameRaw,
            city: row.job.city,
            countryCode: row.job.countryCode,
            remoteType: row.job.remoteType,
            seniority: row.job.seniority,
            employmentTypes: row.job.employmentTypes,
            title: row.job.title,
            sourceId: row.job.sourceId,
            salaryAnnualUsd:
              row.job.salaryNormalizedAnnualUsd === null
                ? null
                : Number(row.job.salaryNormalizedAnnualUsd),
            industries:
              (row.enrichment?.classification as { industries?: string[] } | null)?.industries ?? [],
          },
        }),
      } satisfies RecommendationInput;
    });
  }
}

/**
 * First- and last-seen as *sightings*, but only when they are genuinely apart.
 *
 * Passing both unconditionally made every job in a live run report "seen 2
 * times within 0 days — routine re-listing", flagging the entire corpus as
 * reposts. A job discovered once has one sighting; the two timestamps merely
 * bracket the same observation.
 */
function distinctSightings(firstSeenAt: Date, lastSeenAt: Date): Date[] {
  const apartHours = Math.abs(lastSeenAt.getTime() - firstSeenAt.getTime()) / 3_600_000;
  return apartHours >= 24 ? [firstSeenAt, lastSeenAt] : [firstSeenAt];
}

/** Contact addresses in the posting body, for the scam heuristics. */
function extractEmails(text: string | null): string[] {
  if (!text) return [];
  const matches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
  return matches ? [...new Set(matches.map((m) => m.toLowerCase()))].slice(0, 5) : [];
}

/** A malformed stored quality block must not take down a whole ranking run. */
function safeParseEnrichmentQuality(value: unknown) {
  const parsed = qualityAssessmentSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : qualityAssessmentSchema.parse({ qualityScore: 0.5, scamScore: 0, qualityConfidence: 0.2 });
}

/** Re-exported so callers can validate an enrichment payload the same way. */
export { jobEnrichmentSchema };
