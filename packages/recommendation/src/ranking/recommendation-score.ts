import {
  AUTHORITY_WEIGHTS,
  type FreshnessScore,
  type JobQuality,
  type RecommendationFactor,
  type RecommendationWeights,
  type RepostAssessment,
  type ScamAssessment,
  type SourceAuthorityLevel,
  type StalenessVerdict,
} from '@job-intel/contracts';
import { LIFECYCLE_MULTIPLIERS } from '../freshness/staleness';

/**
 * The recommendation formula.
 *
 * Deliberately a weighted mean of seven named factors, each of which reports
 * its own value, its weight and what it actually contributed. Nothing here is
 * learned, hidden or fitted — a candidate who disagrees with a ranking can read
 * the arithmetic and point at the term they think is wrong.
 *
 * The **match score is an input, never an output**. This function never
 * modifies it. Job A can match at 96 and be ranked below Job B matching at 91,
 * and both statements survive intact in the record — that separation is the
 * entire reason this layer exists apart from the matching engine.
 *
 * Two things sit outside the weighted mean, as multipliers, because they are
 * not opinions to be traded off against a good match:
 *
 *   - **lifecycle** — a closed job is worth nothing regardless of fit.
 *   - **scam risk** — a fraudulent posting is not a 60% good opportunity.
 */

export interface RecommendationScoreInput {
  matchScore: number;
  matchConfidence: number;
  quality: JobQuality;
  freshness: FreshnessScore;
  lifecycle: StalenessVerdict;
  scam: ScamAssessment;
  repost: RepostAssessment;
  sourceAuthority: SourceAuthorityLevel;
  /** Null when never checked — treated as neither proven nor broken. */
  applicationUrlReachable: boolean | null;
  applicationUrlPresent: boolean;
  /** From the matching engine. A hard-constraint failure is absolute. */
  matchEligible?: boolean;
  /** -1..1, from the candidate's own behaviour. Never overrides preferences. */
  behavioralAffinity?: number;
}

export interface RawRecommendationScore {
  factors: RecommendationFactor[];
  weightsUsed: Record<string, number>;
  rawScore: number;
  /** Multipliers applied after the weighted mean, with their reasons. */
  multipliers: Array<{ name: string; value: number; reason: string }>;
}

function sanitize(weight: number | undefined): number {
  return weight === undefined || !Number.isFinite(weight) || weight <= 0 ? 0 : weight;
}

export function computeRawScore(
  input: RecommendationScoreInput,
  weights: RecommendationWeights,
): RawRecommendationScore {
  const applicationValue = !input.applicationUrlPresent
    ? 10
    : input.applicationUrlReachable === true
      ? 100
      : input.applicationUrlReachable === false
        ? 0
        : 70;

  const terms: Array<{ key: keyof RecommendationWeights; value: number; explanation: string }> = [
    {
      key: 'match',
      value: input.matchScore,
      explanation: `Candidate match ${Math.round(input.matchScore)}/100`,
    },
    {
      key: 'matchConfidence',
      value: input.matchConfidence * 100,
      explanation: `Match confidence ${Math.round(input.matchConfidence * 100)}%`,
    },
    {
      key: 'quality',
      value: input.quality.score,
      explanation: input.quality.explanation,
    },
    {
      key: 'freshness',
      value: input.freshness.score,
      explanation: input.freshness.explanation,
    },
    {
      key: 'sourceAuthority',
      value: AUTHORITY_WEIGHTS[input.sourceAuthority] * 100,
      explanation: `Source authority: ${input.sourceAuthority}`,
    },
    {
      key: 'applicationAvailability',
      value: applicationValue,
      explanation: !input.applicationUrlPresent
        ? 'No application URL'
        : input.applicationUrlReachable === true
          ? 'Application URL verified'
          : input.applicationUrlReachable === false
            ? 'Application URL is broken'
            : 'Application URL present, unverified',
    },
    {
      key: 'novelty',
      value: input.repost.noveltyFactor * 100,
      explanation: input.repost.explanation,
    },
  ];

  const weightsUsed: Record<string, number> = {};
  const factors: RecommendationFactor[] = [];
  let totalWeight = 0;
  let weighted = 0;

  for (const term of terms) {
    const weight = sanitize(weights[term.key]);
    if (weight === 0) continue;
    weightsUsed[term.key] = weight;
    totalWeight += weight;
    weighted += weight * term.value;
  }

  for (const term of terms) {
    const weight = weightsUsed[term.key];
    if (weight === undefined) continue;
    factors.push({
      factor: term.key,
      value: Math.round(Math.max(0, Math.min(100, term.value)) * 100) / 100,
      weight,
      contribution: Math.round(((weight / totalWeight) * term.value) * 100) / 100,
      explanation: term.explanation.slice(0, 300),
    });
  }

  // All-zero weights are a configuration mistake, not an instruction to rank
  // everything at zero.
  let raw = totalWeight === 0 ? input.matchScore : weighted / totalWeight;

  const multipliers: RawRecommendationScore['multipliers'] = [];

  // A job the candidate cannot take is still listed — the brief asks for an
  // EXCLUDED category — but it must never occupy a slot above one they can.
  // Found in the fifty-job run: an ineligible role sat at rank 8 purely on its
  // match score, pushing a workable job out of the visible list.
  if (input.matchEligible === false) {
    multipliers.push({
      name: 'eligibility',
      value: 0.15,
      reason: 'fails one of your non-negotiable requirements',
    });
    raw *= 0.15;
  }

  const lifecycle = LIFECYCLE_MULTIPLIERS[input.lifecycle.status];
  if (lifecycle !== 1) {
    multipliers.push({
      name: 'lifecycle',
      value: lifecycle,
      reason: `${input.lifecycle.status}: ${input.lifecycle.explanation}`,
    });
    raw *= lifecycle;
  }

  if (input.scam.risk > 0.2) {
    // Scales to zero at maximum risk rather than subtracting points: a likely
    // scam is not "a slightly worse opportunity".
    const factor = Math.max(0, 1 - input.scam.risk * 1.25);
    multipliers.push({
      name: 'scam_risk',
      value: Math.round(factor * 1000) / 1000,
      reason: input.scam.explanation,
    });
    raw *= factor;
  }

  // Behaviour is a small trim applied last, and only ±5%. Explicit preferences
  // already shaped the match score; letting clicks move a ranking more than
  // this would quietly override what the candidate actually said.
  if (input.behavioralAffinity !== undefined && input.behavioralAffinity !== 0) {
    const factor = 1 + Math.max(-1, Math.min(1, input.behavioralAffinity)) * 0.05;
    multipliers.push({
      name: 'behavioral',
      value: Math.round(factor * 1000) / 1000,
      reason:
        input.behavioralAffinity > 0
          ? 'your past activity leans towards jobs like this'
          : 'your past activity leans away from jobs like this',
    });
    raw *= factor;
  }

  return {
    factors,
    weightsUsed,
    rawScore: Math.round(Math.max(0, Math.min(100, raw)) * 100) / 100,
    multipliers,
  };
}
