import type { ComponentScore } from '@job-intel/contracts';
import type { EmbeddingRef, ScorerInput } from '../types';
import { clamp, notApplicable, score } from './../scoring/util';

/**
 * Semantic similarity.
 *
 * Catches what structured matching cannot: a posting that never says "React"
 * but describes exactly the work the candidate has been doing. It is one
 * weighted dimension among many — **never a veto and never an override**. A job
 * that fails a hard constraint is ineligible at 0.99 similarity, and the engine
 * enforces that by not reaching this code at all for ineligible jobs.
 */

/**
 * Calibration window.
 *
 * Raw cosine similarity between two documents from the same embedding model
 * rarely drops below ~0.5 or exceeds ~0.9, so mapping [-1, 1] onto [0, 100]
 * would compress every real result into a narrow band around 70 and make the
 * dimension useless for ranking. These bounds stretch the range that actually
 * occurs; they are constants of the *metric*, not preferences, which is why
 * they live here rather than in the candidate's settings.
 */
export const SIMILARITY_FLOOR = 0.45;
export const SIMILARITY_CEILING = 0.9;

/** Cosine similarity. Returns null when the vectors cannot be compared. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return null;

  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Number.isFinite(similarity) ? similarity : null;
}

/** Projects a raw cosine onto the 0-100 dimension scale. */
export function similarityToScore(similarity: number): number {
  const span = SIMILARITY_CEILING - SIMILARITY_FLOOR;
  return clamp(((similarity - SIMILARITY_FLOOR) / span) * 100);
}

/**
 * Compares two vectors, refusing where comparison would be meaningless.
 *
 * Different models place text in different spaces, so their cosines are not
 * commensurable — comparing across them yields a confident-looking number with
 * no meaning. Same for a dimension mismatch, which means one of the two vectors
 * is stale from an older model version.
 */
export function compareEmbeddings(
  candidate: EmbeddingRef | null,
  job: EmbeddingRef | null,
): { similarity: number | null; reason: string } {
  if (!candidate) return { similarity: null, reason: 'no candidate embedding' };
  if (!job) return { similarity: null, reason: 'no job embedding' };
  if (candidate.model !== job.model) {
    return {
      similarity: null,
      reason: `embedding model mismatch (${candidate.model} vs ${job.model})`,
    };
  }
  if (candidate.vector.length !== job.vector.length) {
    return {
      similarity: null,
      reason: `embedding dimension mismatch (${candidate.vector.length} vs ${job.vector.length})`,
    };
  }

  const similarity = cosineSimilarity(candidate.vector, job.vector);
  return similarity === null
    ? { similarity: null, reason: 'vectors could not be compared' }
    : { similarity, reason: 'compared' };
}

export function scoreSemantic(input: ScorerInput): ComponentScore {
  const { similarity, reason } = compareEmbeddings(
    input.candidate.embedding,
    input.job.embedding,
  );

  if (similarity === null) {
    return notApplicable('semantic', `Semantic comparison skipped: ${reason}`);
  }

  // Confidence tapers at the edges of the calibration window: a cosine outside
  // the range the metric normally produces is more likely to be an artefact
  // than a genuinely perfect or perfectly-wrong match.
  const inWindow =
    similarity >= SIMILARITY_FLOOR && similarity <= SIMILARITY_CEILING ? 1 : 0.6;

  return score(
    'semantic',
    similarityToScore(similarity),
    0.7 * inWindow,
    `Description similarity ${similarity.toFixed(3)} against your profile`,
    [`cosine ${similarity.toFixed(3)}`, input.candidate.embedding?.model ?? 'unknown model'],
  );
}
