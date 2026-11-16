import type { ComponentScore, HardConstraintResult, MatchingWeights } from '@job-intel/contracts';
import { weightFor } from '../weights/weight-normalizer';
import { clamp, round } from '../scoring/util';

/**
 * Confidence.
 *
 * Deliberately a *separate* number from the score, because they answer
 * different questions: the score says how good the fit looks, confidence says
 * how much of that is actually known. A posting that states nothing but a title
 * can easily score 80 on the two dimensions it does fill in — reporting that as
 * a strong match would be dishonest, and the recommendation layer uses this
 * number to label it UNCERTAIN instead.
 */

export interface ConfidenceInput {
  components: readonly ComponentScore[];
  constraints: HardConstraintResult;
  weights: MatchingWeights;
  /** The enrichment's own confidence in the fields it extracted. */
  extractionConfidence: number;
  /** Set when a model reviewed the match. */
  llmConfidence: number | null;
}

/** Each unresolved constraint shaves this much off. */
const UNKNOWN_PENALTY = 0.06;
/** Floor for the unknown penalty, so many unknowns cannot zero confidence. */
const UNKNOWN_FLOOR = 0.6;

export interface ConfidenceResult {
  confidence: number;
  /** Share of the candidate's total weight that had data behind it. */
  coverage: number;
  notes: string[];
}

export function estimateConfidence(input: ConfidenceInput): ConfidenceResult {
  const notes: string[] = [];

  // 1. Coverage: how much of what the candidate cares about could be judged.
  let applicableWeight = 0;
  let totalWeight = 0;
  let weightedComponentConfidence = 0;

  for (const component of input.components) {
    const weight = weightFor(component.dimension, input.weights);
    if (weight === 0) continue;
    totalWeight += weight;
    if (!component.applicable) continue;
    applicableWeight += weight;
    weightedComponentConfidence += weight * component.confidence;
  }

  const coverage = totalWeight === 0 ? 0 : applicableWeight / totalWeight;
  const meanComponentConfidence =
    applicableWeight === 0 ? 0 : weightedComponentConfidence / applicableWeight;

  if (coverage < 0.5) {
    notes.push(
      `Only ${Math.round(coverage * 100)}% of your weighted criteria could be evaluated`,
    );
  }

  // 2. Unresolved constraints. Each one is a question the posting left open.
  const unknownFactor = clamp(
    1 - input.constraints.unknowns.length * UNKNOWN_PENALTY,
    UNKNOWN_FLOOR,
    1,
  );
  if (input.constraints.unknowns.length > 0) {
    notes.push(
      `${input.constraints.unknowns.length} constraint(s) could not be resolved from the posting`,
    );
  }

  // 3. How well the enrichment layer believes it read the posting.
  const extraction = clamp(input.extractionConfidence, 0, 1);

  // Coverage dominates: a confident reading of very little is still very little.
  let confidence = (coverage * 0.45 + meanComponentConfidence * 0.35 + extraction * 0.2) * unknownFactor;

  // 4. A model that reviewed the match moves confidence, but only partly — it
  // is one more opinion, not the arbiter of how much we know.
  if (input.llmConfidence !== null) {
    confidence = confidence * 0.75 + clamp(input.llmConfidence, 0, 1) * 0.25;
    notes.push('Adjusted by model review');
  }

  return {
    confidence: round(clamp(confidence, 0, 1), 3),
    coverage: round(coverage, 3),
    notes,
  };
}

/**
 * Mean extraction confidence across the fields matching actually reads.
 *
 * Averaged over a fixed field list rather than everything the enrichment
 * produced, so adding new extractors elsewhere cannot silently move every
 * existing match's confidence.
 */
export function extractionConfidenceOf(enrichment: {
  titleConfidence: number;
  seniorityConfidence: number;
  experience: { confidence: number };
  workArrangement: { confidence: number };
  location: { confidence: number };
  compensation: { confidence: number };
  workAuthorization: { sponsorshipConfidence: number };
  classification: { functionConfidence: number };
  skills: ReadonlyArray<{ confidence: number }>;
}): number {
  const values = [
    enrichment.titleConfidence,
    enrichment.seniorityConfidence,
    enrichment.experience.confidence,
    enrichment.workArrangement.confidence,
    enrichment.location.confidence,
    enrichment.compensation.confidence,
    enrichment.workAuthorization.sponsorshipConfidence,
    enrichment.classification.functionConfidence,
    enrichment.skills.length === 0
      ? 0
      : enrichment.skills.reduce((sum, s) => sum + s.confidence, 0) / enrichment.skills.length,
  ];
  return round(values.reduce((sum, v) => sum + clamp(v, 0, 1), 0) / values.length, 3);
}
