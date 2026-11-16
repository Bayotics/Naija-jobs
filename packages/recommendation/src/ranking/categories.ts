import {
  TIER_ICONS,
  type LifecycleStatus,
  type RecommendationThresholdConfig,
  type RecommendationTier,
} from '@job-intel/contracts';

/**
 * Turning a score into a tier.
 *
 * The order of the checks is the meaning. Lifecycle and eligibility are tested
 * before the score, so nothing can be labelled `HIGHLY_RECOMMENDED` when it is
 * closed or when the candidate's hard constraints exclude it — the score would
 * have to be ignored anyway, and a label that contradicts the eligibility
 * verdict teaches the reader to distrust every label.
 *
 * Confidence is tested next: a high score built on a posting that states almost
 * nothing is a guess, and calling it `EXCEPTIONAL` is how a scale loses its
 * meaning one plausible-looking recommendation at a time.
 */

export interface TierInput {
  score: number;
  confidence: number;
  eligible: boolean;
  lifecycle: LifecycleStatus;
}

export function classifyTier(
  input: TierInput,
  thresholds: RecommendationThresholdConfig,
): RecommendationTier {
  if (!input.eligible) return 'EXCLUDED';
  if (input.lifecycle === 'CLOSED' || input.lifecycle === 'EXPIRED') return 'STALE';
  if (input.confidence < thresholds.minimumConfidence) return 'LOW_PRIORITY';

  if (input.score >= thresholds.exceptional) return 'EXCEPTIONAL';
  if (input.score >= thresholds.highlyRecommended) return 'HIGHLY_RECOMMENDED';
  if (input.score >= thresholds.strong) return 'STRONG';
  if (input.score >= thresholds.worthConsidering) return 'WORTH_CONSIDERING';
  return 'LOW_PRIORITY';
}

export const TIER_LABELS: Readonly<Record<RecommendationTier, string>> = {
  EXCEPTIONAL: 'Exceptional',
  HIGHLY_RECOMMENDED: 'Highly recommended',
  STRONG: 'Strong opportunity',
  WORTH_CONSIDERING: 'Worth considering',
  LOW_PRIORITY: 'Low priority',
  EXCLUDED: 'Excluded',
  STALE: 'Stale or closed',
};

/** Tiers that may reach a notification at all. */
export const NOTIFIABLE_TIERS: ReadonlySet<RecommendationTier> = new Set<RecommendationTier>([
  'EXCEPTIONAL',
  'HIGHLY_RECOMMENDED',
  'STRONG',
  'WORTH_CONSIDERING',
]);

export function tierLabel(tier: RecommendationTier): string {
  return `${TIER_ICONS[tier]} ${TIER_LABELS[tier]}`;
}
