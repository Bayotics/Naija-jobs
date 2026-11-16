import type {
  Exposure,
  FreshnessScore,
  JobQuality,
  RecommendationScore,
  RepostAssessment,
  SourceAuthorityLevel,
  StalenessVerdict,
} from '@job-intel/contracts';
import { TIER_LABELS } from '../ranking/categories';

/**
 * Ranking explanations.
 *
 * Assembled **entirely from the structured values that produced the ranking**.
 * No model writes any of this, which is the point: an explanation generated
 * separately from the arithmetic is free to be persuasive and wrong, and the
 * first time a candidate catches it claiming "salary meets your target" for a
 * job with no stated salary, every other explanation becomes worthless too.
 *
 * The output answers the question people actually ask — "why is this #1?" —
 * which is a question about *relative* position, so the strongest contributing
 * factors lead and the caveats follow.
 */

export interface RankExplanationInput {
  rank: number;
  jobTitle: string;
  companyName: string;
  score: RecommendationScore;
  matchScore: number;
  matchConfidence: number;
  matchExplanation: string;
  quality: JobQuality;
  freshness: FreshnessScore;
  lifecycle: StalenessVerdict;
  repost: RepostAssessment;
  exposure: Exposure;
  sourceAuthority: SourceAuthorityLevel;
  sourceId: string;
  applicationUrlReachable: boolean | null;
  duplicateSourceCount: number;
  /** Factual bullets from the match, e.g. "React (direct)". */
  matchedRequirements: string[];
  concerns: string[];
}

export interface RankExplanation {
  explanation: string;
  reasons: string[];
}

/** Human wording for a factor key. */
const FACTOR_LABELS: Readonly<Record<string, string>> = {
  match: 'how well it matches you',
  matchConfidence: 'how much we know about it',
  quality: 'posting quality',
  freshness: 'how recently it was posted',
  sourceAuthority: 'the authority of the source',
  applicationAvailability: 'a working application path',
  novelty: 'being genuinely new',
};

export function explainRank(input: RankExplanationInput): RankExplanation {
  const reasons: string[] = [];

  // ── The factual bullets ─────────────────────────────────────────────────
  reasons.push(
    `${Math.round(input.matchScore)}% candidate match (${Math.round(input.matchConfidence * 100)}% confidence)`,
  );

  reasons.push(input.freshness.explanation);

  if (input.sourceAuthority === 'authoritative' || input.sourceAuthority === 'high') {
    reasons.push(`From ${input.sourceId}, a ${input.sourceAuthority} source`);
  }

  if (input.duplicateSourceCount > 1) {
    reasons.push(`Corroborated across ${input.duplicateSourceCount} sources`);
  }

  if (input.applicationUrlReachable === true) {
    reasons.push('Application URL verified reachable');
  } else if (input.applicationUrlReachable === false) {
    reasons.push('Application URL did not resolve when checked');
  }

  if (input.matchedRequirements.length > 0) {
    reasons.push(`Covers ${input.matchedRequirements.slice(0, 5).join(', ')}`);
  }

  if (input.quality.flags.length > 0) {
    reasons.push(`Posting caveats: ${input.quality.flags.slice(0, 3).join(', ')}`);
  }

  if (input.lifecycle.status !== 'ACTIVE') {
    reasons.push(`Lifecycle: ${input.lifecycle.explanation}`);
  }

  if (input.repost.kind !== 'new') {
    reasons.push(input.repost.explanation);
  }

  if (input.exposure.state !== 'never_shown') {
    reasons.push(`You have seen this before (${input.exposure.state.replace('_', ' ')})`);
  }

  for (const concern of input.concerns.slice(0, 3)) reasons.push(concern);

  // ── The paragraph ───────────────────────────────────────────────────────
  const contributors = input.score.factors
    .slice()
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map((f) => FACTOR_LABELS[f.factor] ?? f.factor);

  const sentences: string[] = [
    `Ranked #${input.rank} — ${TIER_LABELS[input.score.tier]} at ${Math.round(input.score.finalScore)}/100.`,
  ];

  if (contributors.length > 0) {
    sentences.push(`It is here mainly on ${joinList(contributors)}.`);
  }

  sentences.push(input.matchExplanation.split('. ').slice(0, 2).join('. '));

  if (input.score.diversityPenalty > 0) {
    sentences.push(
      `Pushed down ${Math.round(input.score.diversityPenalty)} points for variety: ${input.score.diversityReason}.`,
    );
  }

  const weakest = input.score.factors
    .slice()
    .sort((a, b) => a.value - b.value)[0];
  if (weakest && weakest.value < 45) {
    sentences.push(`Held back by ${FACTOR_LABELS[weakest.factor] ?? weakest.factor}: ${weakest.explanation}.`);
  }

  return {
    explanation: sentences.filter(Boolean).join(' ').slice(0, 1500),
    reasons: [...new Set(reasons.filter((r) => r.trim().length > 0))].map((r) => r.slice(0, 200)),
  };
}

function joinList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
