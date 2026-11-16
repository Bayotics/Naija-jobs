import type { z } from 'zod';
import {
  RECOMMENDATION_VERSION,
  recommendationConfigSchema,
  type Exposure,
  type FreshnessScore,
  type JobQuality,
  type JobRecommendation,
  type MaterialChangeResult,
  type QualityAssessment,
  type RecommendationConfig,
  type RepostAssessment,
  type ScamAssessment,
  type SourceAuthorityLevel,
  type StalenessVerdict,
  type TopRecommendationsQuery,
} from '@job-intel/contracts';
import { normalizeCompanyName, normalizeTitle } from '@job-intel/core';
import { SourceAuthorityResolver } from '../authority/source-authority';
import { scoreFreshness, withinFreshnessWindow } from '../freshness/freshness';
import { detectStaleness } from '../freshness/staleness';
import { scoreJobQuality } from '../quality/job-quality';
import { detectScamDeterministic } from '../quality/scam-detector';
import { detectRepost } from '../quality/repost-detector';
import { computeRawScore } from '../ranking/recommendation-score';
import { calibrate, describeDistribution, type ScoreDistribution } from '../ranking/calibration';
import { classifyTier } from '../ranking/categories';
import { diversify, type DiversifiableItem } from '../ranking/diversifier';
import {
  evaluateNotificationEligibility,
  applyDigestCaps,
} from '../eligibility/notification-eligibility';
import { emptyExposure } from '../eligibility/exposure';
import { explainRank } from '../explanation/rank-explainer';

/**
 * The recommendation engine.
 *
 * Turns a pool of matched jobs into an ordered, explained, notification-ready
 * list. The stages run in a fixed order and each is a pure function of what
 * came before:
 *
 *   quality → freshness → lifecycle → scam → repost → score → calibrate
 *   → tier → diversify → re-rank → eligibility → explain
 *
 * Two properties are enforced structurally rather than by convention:
 *
 *  - **The match score is never modified.** It is copied onto the result
 *    untouched. Everything ranking does happens in `recommendationScore`.
 *  - **No per-job model call.** Every stage above is deterministic arithmetic
 *    over already-computed data, which is what lets ten thousand jobs be ranked
 *    in one pass. The only optional model in this layer is scam reasoning, and
 *    it is gated to the ambiguous middle band.
 */

/** Everything the engine needs about one job. Assembled by the caller. */
export interface RecommendationInput {
  jobId: string;
  title: string;
  companyName: string;
  companyId: string | null;
  companyDomain: string | null;
  roleSlug: string | null;
  technologies: string[];
  sourceId: string;
  sourceType: string;
  sourceReliability?: number;

  matchScore: number;
  matchConfidence: number;
  matchEligible: boolean;
  matchExplanation: string;
  matchedRequirements: string[];
  concerns: string[];

  enrichmentQuality: QualityAssessment;
  description: string | null;
  descriptionLength: number;
  requirements: string[];
  responsibilities: string[];
  salaryAnnualUsd: number | null;
  minYearsExperience: number | null;
  contactEmails: string[];

  applyUrl: string | null;
  /**
   * The posting's own page, when there is no direct apply link.
   *
   * Distinct from `applyUrl` on purpose — one is the employer's application
   * form, the other is a page a human can apply from. Eligibility cares only
   * that *some* path exists; scoring still prefers the direct link.
   */
  postingUrl: string | null;
  applicationUrlReachable: boolean | null;
  verification: { outcome: string; httpStatus: number | null } | null;

  postedAt: Date | null;
  validThrough: Date | null;
  updatedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastVerifiedAt: Date | null;
  absenceRuns: number;
  removedFromSource: boolean;

  /** Members of the same canonical group, this record included. */
  duplicateSourceCount: number;
  duplicateOf: string | null;
  copiedDescriptionCount: number;

  sightings: Date[];
  contentHashes: string[];
  claimedPostingDates: Date[];

  exposure: Exposure | null;
  materialChange: MaterialChangeResult | null;
  behavioralAffinity?: number;
}

/** The per-job signals, kept so callers can persist them without recomputing. */
export interface JobSignals {
  quality: JobQuality;
  freshness: FreshnessScore;
  lifecycle: StalenessVerdict;
  scam: ScamAssessment;
  repost: RepostAssessment;
  sourceAuthority: SourceAuthorityLevel;
}

export interface RankingResult {
  recommendations: JobRecommendation[];
  signals: Map<string, JobSignals>;
  distribution: ScoreDistribution;
  /** Jobs excluded before ranking, with the reason. */
  suppressed: Array<{ jobId: string; reason: string }>;
  durationMs: number;
  recommendationVersion: string;
}

/**
 * `config` is the schema's *input* type, not `Partial<RecommendationConfig>`.
 *
 * They are not the same: every field has a default, so the output type has all
 * of them required while a caller legitimately supplies
 * `{ notification: { minimumScore: 70 } }`. Typing it as a partial of the
 * output would reject that and force callers to spell out ten fields they have
 * no opinion about.
 */
export interface RecommendationEngineOptions {
  config?: z.input<typeof recommendationConfigSchema>;
  now?: Date;
}


/**
 * Whether there is anywhere to send the candidate.
 *
 * Previously `input.applyUrl !== null`, which silently blocked notifications
 * for every posting whose source does not publish a separate application link —
 * 159 of 447 in a live corpus, including the highest-scoring matches. Those
 * postings all had a perfectly good page to apply from; the eligibility rule
 * simply was not looking at it, and the resulting blocker read "No application
 * URL — there is nowhere to send you", which was untrue.
 *
 * The notification service already resolved the URL this way. The engine that
 * decided eligibility did not, and the two disagreeing is what made a
 * reasonable rule behave like a bug.
 */
function hasApplicationPath(input: Pick<RecommendationInput, 'applyUrl' | 'postingUrl'>): boolean {
  return input.applyUrl !== null || input.postingUrl !== null;
}

export class RecommendationEngine {
  readonly config: RecommendationConfig;
  private readonly authority: SourceAuthorityResolver;

  constructor(options: RecommendationEngineOptions = {}) {
    this.config = recommendationConfigSchema.parse(options.config ?? {});
    this.authority = new SourceAuthorityResolver(this.config.authority);
  }

  /** Computes the per-job signals. Pure; no candidate involved. */
  computeSignals(input: RecommendationInput, now = new Date()): JobSignals {
    const sourceAuthority = this.authority.level({
      id: input.sourceId,
      sourceType: input.sourceType,
    });

    const freshness = scoreFreshness(
      {
        postedAt: input.postedAt,
        updatedAt: input.updatedAt,
        lastVerifiedAt: input.lastVerifiedAt,
        firstSeenAt: input.firstSeenAt,
        ...(input.sourceReliability !== undefined
          ? { sourceReliability: input.sourceReliability }
          : {}),
        now,
      },
      this.config.freshness,
    );

    const lifecycle = detectStaleness(
      {
        postedAt: input.postedAt,
        validThrough: input.validThrough,
        lastSeenAt: input.lastSeenAt,
        lastVerifiedAt: input.lastVerifiedAt,
        absenceRuns: input.absenceRuns,
        verification: input.verification as never,
        description: input.description,
        removedFromSource: input.removedFromSource,
        now,
      },
      this.config.freshness,
    );

    const repost = detectRepost({
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.lastSeenAt,
      sightings: input.sightings,
      contentHashes: input.contentHashes,
      claimedPostingDates: input.claimedPostingDates,
      now,
    });

    const scam = detectScamDeterministic({
      title: input.title,
      companyName: input.companyName,
      description: input.description,
      applyUrl: input.applyUrl,
      contactEmails: input.contactEmails,
      salaryAnnualUsd: input.salaryAnnualUsd,
      minYearsExperience: input.minYearsExperience,
      copiedDescriptionCount: input.copiedDescriptionCount,
    });

    const quality = scoreJobQuality({
      enrichmentQuality: input.enrichmentQuality,
      // Identification is about the posting naming an employer, not about our
      // company registry having caught up. A live run over 351 real jobs
      // flagged almost every one "No identifiable employer" purely because the
      // registry is unpopulated — which dragged the whole quality distribution
      // down and would have suppressed the entire corpus.
      companyIdentified: input.companyName.trim().length > 0,
      companyDomainKnown: input.companyDomain !== null || input.companyId !== null,
      descriptionLength: input.descriptionLength,
      requirementsCount: input.requirements.length,
      responsibilitiesCount: input.responsibilities.length,
      salaryStated: input.salaryAnnualUsd !== null,
      applicationUrlPresent: hasApplicationPath(input),
      applicationUrlReachable: input.applicationUrlReachable,
      sourceAuthority,
      sourceCount: input.duplicateSourceCount,
      isRepost: repost.kind === 'refresh' || repost.kind === 'repost',
    });

    return { quality, freshness, lifecycle, scam, repost, sourceAuthority };
  }

  /**
   * Ranks a pool.
   *
   * Batch by design: diversification and the digest caps are decisions about
   * the *set*, and neither can be made one job at a time.
   */
  rank(
    candidateProfileId: string,
    pool: readonly RecommendationInput[],
    query: Partial<TopRecommendationsQuery> = {},
  ): RankingResult {
    const startedAt = Date.now();
    const now = new Date();
    const suppressed: Array<{ jobId: string; reason: string }> = [];
    const signals = new Map<string, JobSignals>();

    // ── 1-5. Per-job signals and the raw score ──────────────────────────────
    interface Scored extends DiversifiableItem {
      input: RecommendationInput;
      signal: JobSignals;
      rawFactors: ReturnType<typeof computeRawScore>;
      calibrated: number;
      exposure: Exposure;
    }

    const scored: Scored[] = [];

    for (const input of pool) {
      // A merged duplicate never competes: its canonical sibling represents it.
      if (input.duplicateOf !== null) {
        suppressed.push({ jobId: input.jobId, reason: `duplicate of ${input.duplicateOf}` });
        continue;
      }

      const signal = this.computeSignals(input, now);
      signals.set(input.jobId, signal);

      if (signal.lifecycle.status === 'CLOSED') {
        suppressed.push({ jobId: input.jobId, reason: signal.lifecycle.explanation });
        continue;
      }

      const exposure = input.exposure ?? emptyExposure();

      if (query.unseenOnly && exposure.state !== 'never_shown') {
        suppressed.push({ jobId: input.jobId, reason: `already seen (${exposure.state})` });
        continue;
      }

      const windowHours = query.freshnessWindowHours ?? this.config.notification.freshnessWindowHours;
      if (!withinFreshnessWindow(signal.freshness, windowHours ?? null)) {
        suppressed.push({
          jobId: input.jobId,
          reason: `outside the ${windowHours}h freshness window`,
        });
        continue;
      }

      const rawFactors = computeRawScore(
        {
          matchScore: input.matchScore,
          matchConfidence: input.matchConfidence,
          quality: signal.quality,
          freshness: signal.freshness,
          lifecycle: signal.lifecycle,
          scam: signal.scam,
          repost: signal.repost,
          sourceAuthority: signal.sourceAuthority,
          applicationUrlReachable: input.applicationUrlReachable,
          applicationUrlPresent: hasApplicationPath(input),
          matchEligible: input.matchEligible,
          ...(input.behavioralAffinity !== undefined
            ? { behavioralAffinity: input.behavioralAffinity }
            : {}),
        },
        this.config.weights,
      );

      const { calibrated } = calibrate(rawFactors.rawScore, this.config.calibration);

      scored.push({
        jobId: input.jobId,
        // Ranking uses the *raw* score. Calibration is monotonic, so this
        // changes nothing about the order — it just keeps the comparison in the
        // space the weights were tuned in.
        score: rawFactors.rawScore,
        companyKey: normalizeCompanyName(input.companyName) || input.companyName,
        sourceId: input.sourceId,
        roleKey: input.roleSlug ?? normalizeTitle(input.title),
        technologies: input.technologies,
        input,
        signal,
        rawFactors,
        calibrated,
        exposure,
      });
    }

    // ── 6. Diversify ────────────────────────────────────────────────────────
    const diversified =
      query.diversify === false
        ? scored
            .slice()
            .sort((a, b) => b.score - a.score)
            .map((item) => ({
              item,
              originalScore: item.score,
              penalty: 0,
              penalizedScore: item.score,
              reason: 'diversification disabled for this query',
              cappedBy: null as null,
            }))
        : diversify(scored, this.config.diversification);

    // ── 7. Final scores ─────────────────────────────────────────────────────
    // Scored before ranking, then sorted by the *final* score. The diversity
    // penalty is applied as a ratio in calibrated space, so the calibrated
    // ordering can differ slightly from the raw one — and a stored rank that
    // disagreed with the score printed beside it was visible in the first live
    // run as a list numbered 1, 2, 5, 4, 3.
    const scoredEntries = diversified.map((entry) => {
      const { item } = entry;
      const penaltyRatio =
        entry.originalScore === 0 ? 0 : entry.penalty / Math.max(1, entry.originalScore);
      const calibratedPenalty = Math.round(item.calibrated * penaltyRatio * 100) / 100;
      const finalScore = Math.round(Math.max(0, item.calibrated - calibratedPenalty) * 100) / 100;

      const confidence = Math.min(
        item.input.matchConfidence,
        (item.signal.quality.confidence + item.signal.freshness.confidence) / 2,
      );

      const tier = classifyTier(
        {
          score: finalScore,
          confidence,
          eligible: item.input.matchEligible,
          lifecycle: item.signal.lifecycle.status,
        },
        this.config.thresholds,
      );

      const score = {
        factors: item.rawFactors.factors,
        weightsUsed: item.rawFactors.weightsUsed,
        rawScore: item.rawFactors.rawScore,
        calibratedScore: item.calibrated,
        diversityPenalty: calibratedPenalty,
        diversityReason: entry.penalty > 0 ? entry.reason : '',
        finalScore,
        tier,
      };

      return { entry, item, score, confidence, finalScore, tier };
    });

    scoredEntries.sort((a, b) => b.finalScore - a.finalScore);

    // ── 8. Assemble ─────────────────────────────────────────────────────────
    const recommendations: JobRecommendation[] = [];

    scoredEntries.forEach((scored, index) => {
      const { item, score, confidence, tier, finalScore } = scored;
      const rank = index + 1;

      const eligibility = evaluateNotificationEligibility(
        {
          tier,
          score: finalScore,
          confidence,
          matchEligible: item.input.matchEligible,
          lifecycle: item.signal.lifecycle.status,
          freshness: item.signal.freshness,
          scam: item.signal.scam,
          exposure: item.exposure,
          duplicateOf: item.input.duplicateOf,
          applicationUrlPresent: hasApplicationPath(item.input),
          applicationUrlReachable: item.input.applicationUrlReachable,
          materialChange: item.input.materialChange,
          now,
        },
        this.config.notification,
      );

      const explanation = explainRank({
        rank,
        jobTitle: item.input.title,
        companyName: item.input.companyName,
        score,
        matchScore: item.input.matchScore,
        matchConfidence: item.input.matchConfidence,
        matchExplanation: item.input.matchExplanation,
        quality: item.signal.quality,
        freshness: item.signal.freshness,
        lifecycle: item.signal.lifecycle,
        repost: item.signal.repost,
        exposure: item.exposure,
        sourceAuthority: item.signal.sourceAuthority,
        sourceId: item.input.sourceId,
        applicationUrlReachable: item.input.applicationUrlReachable,
        duplicateSourceCount: item.input.duplicateSourceCount,
        matchedRequirements: item.input.matchedRequirements,
        concerns: item.input.concerns,
      });

      recommendations.push({
        jobId: item.jobId,
        candidateProfileId,
        rank,
        score,
        // Copied, never modified. The whole separation lives on this line.
        matchScore: item.input.matchScore,
        matchConfidence: item.input.matchConfidence,
        quality: item.signal.quality,
        freshness: item.signal.freshness,
        lifecycle: item.signal.lifecycle,
        scam: item.signal.scam,
        repost: item.signal.repost,
        exposure: item.exposure,
        sourceAuthority: item.signal.sourceAuthority,
        duplicateOf: item.input.duplicateOf,
        rankExplanation: explanation.explanation,
        rankReasons: explanation.reasons,
        notificationEligible: eligibility.eligible,
        // Truncated to the contract limit: a scam explanation quoting the
        // posting can run well past it, and the failure would surface on read.
        notificationBlockers: eligibility.reasons.map((r) => r.slice(0, 200)),
        recommendationVersion: RECOMMENDATION_VERSION,
        computedAt: now,
      });
    });

    return {
      recommendations,
      signals,
      distribution: describeDistribution(
        recommendations.map((r) => ({ score: r.score.finalScore, tier: r.score.tier })),
      ),
      suppressed,
      durationMs: Date.now() - startedAt,
      recommendationVersion: RECOMMENDATION_VERSION,
    };
  }

  /**
   * `getTopRecommendations`, over an already-ranked list.
   *
   * The filters are applied *after* ranking so that "top 10 remote jobs" means
   * the ten best remote jobs, not the remote subset of the overall top ten.
   */
  selectTop(
    ranked: readonly JobRecommendation[],
    query: Partial<TopRecommendationsQuery> = {},
  ): JobRecommendation[] {
    let items = [...ranked];

    if (query.minimumScore !== undefined) {
      items = items.filter((r) => r.score.finalScore >= (query.minimumScore as number));
    }
    if (query.minimumConfidence !== undefined) {
      items = items.filter((r) => r.matchConfidence >= (query.minimumConfidence as number));
    }
    if (query.tiers && query.tiers.length > 0) {
      const tiers = new Set(query.tiers);
      items = items.filter((r) => tiers.has(r.score.tier));
    }
    if (query.lifecycleStatuses && query.lifecycleStatuses.length > 0) {
      const statuses = new Set(query.lifecycleStatuses);
      items = items.filter((r) => statuses.has(r.lifecycle.status));
    }
    if (query.notificationEligibleOnly) {
      items = items.filter((r) => r.notificationEligible);
    }

    const offset = query.offset ?? 0;
    const limit = query.limit ?? 10;
    return items.slice(offset, offset + limit).map((r, index) => ({ ...r, rank: offset + index + 1 }));
  }

  /**
   * The notification-ready subset.
   *
   * Per-job eligibility has already run; this applies the caps that depend on
   * the composition of the digest itself.
   */
  selectForDigest(ranked: readonly JobRecommendation[], companyKeyFor: (jobId: string) => string) {
    const eligible = ranked.filter((r) => r.notificationEligible);
    return applyDigestCaps(
      eligible.map((r) => ({
        jobId: r.jobId,
        companyKey: companyKeyFor(r.jobId),
        sourceId: r.jobId,
        score: r.score.finalScore,
        recommendation: r,
      })),
      this.config.notification,
    );
  }
}
