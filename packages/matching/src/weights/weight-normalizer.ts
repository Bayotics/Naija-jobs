import type { ComponentScore, MatchingWeights, ScoreDimension } from '@job-intel/contracts';

/**
 * Weighted aggregation.
 *
 * Two failure modes this guards against, both of which produce a plausible-
 * looking number rather than an error and are therefore worth code:
 *
 *  1. **Garbage weights.** A NaN or Infinity anywhere in the map poisons the
 *     whole average, and every job in the system then scores NaN. Non-finite
 *     and negative weights are dropped, not propagated.
 *  2. **Nothing to weigh.** If every dimension is inapplicable, or the
 *     candidate zeroed every weight, there is no honest average. Returning 50
 *     with zero confidence says "no opinion"; returning 0 would say "terrible",
 *     which is a different and false claim.
 */

/** Maps the engine's dimension names onto the candidate's weight fields. */
const WEIGHT_FIELDS: Readonly<Record<ScoreDimension, keyof MatchingWeights | null>> = {
  skills: 'technicalSkills',
  experience: 'experience',
  seniority: 'seniority',
  title: 'titleMatch',
  location: 'location',
  workArrangement: 'workArrangement',
  salary: 'salary',
  visa: 'visa',
  education: 'education',
  industry: 'industry',
  employmentType: 'employmentType',
  company: 'companyPreference',
  semantic: 'semantic',
  quality: 'quality',
  // Behaviour is a bounded adjustment applied after aggregation, never a
  // weighted dimension — that is what stops it overriding stated preferences.
  behavioral: null,
};

/** Score used when there is nothing to average. Neutral, not negative. */
export const NEUTRAL_SCORE = 50;

export interface WeightedResult {
  score: number;
  /** Weights that actually contributed, for the trace. */
  weightsUsed: Record<string, number>;
  /** Dimensions excluded because they did not apply. */
  skipped: string[];
}

function sanitize(weight: number | undefined): number {
  if (weight === undefined || !Number.isFinite(weight) || weight <= 0) return 0;
  return weight;
}

export function weightFor(dimension: string, weights: MatchingWeights): number {
  const field = WEIGHT_FIELDS[dimension as ScoreDimension];
  return field ? sanitize(weights[field]) : 0;
}

/**
 * Weighted mean of the applicable components.
 *
 * Inapplicable dimensions leave both numerator and denominator untouched, so
 * "the posting did not say" neither helps nor hurts. That is the single most
 * consequential decision in this file: the alternative systematically ranks
 * detailed postings below vague ones.
 */
export function aggregate(
  components: readonly ComponentScore[],
  weights: MatchingWeights,
): WeightedResult {
  const weightsUsed: Record<string, number> = {};
  const skipped: string[] = [];
  let weighted = 0;
  let total = 0;

  for (const component of components) {
    if (!component.applicable) {
      skipped.push(component.dimension);
      continue;
    }
    const weight = weightFor(component.dimension, weights);
    if (weight === 0) {
      skipped.push(component.dimension);
      continue;
    }
    weightsUsed[component.dimension] = weight;
    weighted += weight * component.score;
    total += weight;
  }

  if (total === 0) return { score: NEUTRAL_SCORE, weightsUsed, skipped };

  const score = weighted / total;
  return {
    score: Number.isFinite(score) ? Math.round(score * 100) / 100 : NEUTRAL_SCORE,
    weightsUsed,
    skipped,
  };
}

/** Weights as fractions of one, for display. */
export function normalize(weights: MatchingWeights): Record<string, number> {
  const entries = Object.entries(WEIGHT_FIELDS)
    .filter((entry): entry is [string, keyof MatchingWeights] => entry[1] !== null)
    .map(([dimension, field]) => [dimension, sanitize(weights[field])] as const);

  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total === 0) {
    // All-zero weights are a configuration mistake, not an instruction to
    // score everything zero. Fall back to equal say.
    const share = Math.round((1 / entries.length) * 1000) / 1000;
    return Object.fromEntries(entries.map(([dimension]) => [dimension, share]));
  }
  return Object.fromEntries(
    entries.map(([dimension, weight]) => [dimension, Math.round((weight / total) * 1000) / 1000]),
  );
}
