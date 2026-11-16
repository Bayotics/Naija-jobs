import type { RecommendationCategory, RecommendationThresholds } from '@job-intel/contracts';

/**
 * Turning a number into a label.
 *
 * The order of the checks is the design. Eligibility is tested first and short-
 * circuits everything, so no score and no model opinion can produce anything
 * but INELIGIBLE for a job that violates a hard constraint. Confidence is
 * tested second, so a high score built on almost no information is reported as
 * UNCERTAIN rather than promoted — the label has to mean something, or the
 * candidate learns to ignore all of them.
 */
export function classify(
  input: { eligible: boolean; score: number; confidence: number },
  thresholds: RecommendationThresholds,
): RecommendationCategory {
  if (!input.eligible) return 'INELIGIBLE';
  if (input.confidence < thresholds.minConfidence) return 'UNCERTAIN';
  if (input.score >= thresholds.exceptional) return 'EXCEPTIONAL_MATCH';
  if (input.score >= thresholds.strong) return 'STRONG_MATCH';
  if (input.score >= thresholds.good) return 'GOOD_MATCH';
  if (input.score >= thresholds.possible) return 'POSSIBLE_MATCH';
  return 'WEAK_MATCH';
}

/** Human-facing label for a category. */
export const RECOMMENDATION_LABELS: Readonly<Record<RecommendationCategory, string>> = {
  EXCEPTIONAL_MATCH: 'Exceptional match',
  STRONG_MATCH: 'Strong match',
  GOOD_MATCH: 'Good match',
  POSSIBLE_MATCH: 'Possible match',
  WEAK_MATCH: 'Weak match',
  UNCERTAIN: 'Not enough information',
  INELIGIBLE: 'Ineligible',
};
