import {
  EXPLORATION_SHARE,
  learningConfigSchema,
  type FeatureAffinity,
  type JobFeature,
  type LearningConfig,
} from '@job-intel/contracts';
import { featureKey } from './features';

/**
 * Exploration.
 *
 * A recommender that only shows you more of what you already clicked is an echo
 * chamber, and for a job search that failure is expensive in a specific way:
 * the role that would change your career is by definition one you have not
 * clicked before. So a configurable share of every result set is reserved for
 * jobs the behavioural model would *not* have chosen.
 *
 * Two constraints on that, both hard:
 *
 *  - Exploration never bypasses a hard constraint. It picks among jobs that
 *    already passed eligibility; it cannot resurrect one that failed.
 *  - Exploration never contradicts an explicit exclusion. Showing someone a
 *    job they told the system to exclude is not serendipity, it is not
 *    listening.
 *
 * Within those bounds, novelty is measured against what the candidate has
 * actually seen: a company they have never interacted with is more exploratory
 * than one they have saved twice.
 */

export interface ExplorationCandidate {
  jobId: string;
  /** Rank from the exploitation ranking, 1-based. */
  rank: number;
  score: number;
  features: readonly JobFeature[];
  /** Set false for anything that failed eligibility — never explored. */
  eligible: boolean;
}

export interface ExplorationSelection {
  jobId: string;
  originalRank: number;
  /** 0–1. How unfamiliar this job is relative to the candidate's history. */
  noveltyScore: number;
  /** Which unfamiliar attributes earned it the slot. */
  novelDimensions: Array<{ dimension: string; value: string }>;
  reason: string;
}

export interface ExplorationResult {
  selected: ExplorationSelection[];
  /** Slots reserved, whether or not they were all filled. */
  slots: number;
  share: number;
  detail: string;
}

/** Effective share: an explicit override wins over the named level. */
export function explorationShare(config: LearningConfig): number {
  return config.explorationShare ?? EXPLORATION_SHARE[config.exploration];
}

/**
 * How unfamiliar a job is.
 *
 * Novelty is the share of a job's features the candidate has no affinity for at
 * all — not the share they dislike. A job full of things they have actively
 * rejected is not exploratory, it is a bad recommendation, and conflating the
 * two would make exploration a euphemism for noise.
 */
export function noveltyScore(
  features: readonly JobFeature[],
  affinities: readonly FeatureAffinity[],
): { score: number; novel: Array<{ dimension: string; value: string }> } {
  if (features.length === 0) return { score: 0, novel: [] };

  const known = new Map(
    affinities.map((affinity) => [featureKey(affinity.dimension, affinity.value), affinity]),
  );

  const novel: Array<{ dimension: string; value: string }> = [];
  let unseenWeight = 0;
  let totalWeight = 0;
  let disliked = 0;

  for (const feature of features) {
    const affinity = known.get(featureKey(feature.dimension, feature.value));
    totalWeight += feature.salience;

    if (!affinity) {
      unseenWeight += feature.salience;
      // Only the salient unknowns are worth naming to the candidate.
      if (feature.salience >= 0.6) novel.push({ dimension: feature.dimension, value: feature.value });
    } else if (affinity.affinity < -0.4 && affinity.confidence > 0.4) {
      disliked += 1;
    }
  }

  // Confidently disliked attributes disqualify a job from exploration: this is
  // not a discovery, it is something already judged and found wanting.
  if (disliked > 0) return { score: 0, novel: [] };

  return {
    score: totalWeight > 0 ? Number((unseenWeight / totalWeight).toFixed(4)) : 0,
    novel: novel.slice(0, 4),
  };
}

/**
 * Reserves slots for exploratory jobs.
 *
 * Picks from *below* the exploitation cut-off — a job already in the top-k does
 * not need an exploration slot, and spending one on it would reduce exploration
 * to relabelling.
 */
export function selectExploration(
  candidates: readonly ExplorationCandidate[],
  affinities: readonly FeatureAffinity[],
  options: { config?: Partial<LearningConfig>; resultSize: number } = { resultSize: 20 },
): ExplorationResult {
  const config = learningConfigSchema.parse(options.config ?? {});
  const share = explorationShare(config);
  const slots = Math.floor(options.resultSize * share);

  if (slots <= 0 || !config.enabled) {
    return {
      selected: [],
      slots: 0,
      share,
      detail: config.enabled
        ? 'Exploration is switched off.'
        : 'Personalization is off, so every result is already unpersonalised.',
    };
  }

  // Only jobs that would not otherwise be shown, and only eligible ones.
  const belowCut = candidates.filter(
    (candidate) => candidate.eligible && candidate.rank > options.resultSize - slots,
  );

  const scored = belowCut
    .map((candidate) => {
      const novelty = noveltyScore(candidate.features, affinities);
      return { candidate, novelty };
    })
    .filter((entry) => entry.novelty.score > 0.3)
    // Novelty first, then score: among genuinely new jobs, prefer the better one.
    .sort(
      (a, b) => b.novelty.score - a.novelty.score || b.candidate.score - a.candidate.score,
    );

  const selected = scored.slice(0, slots).map(
    ({ candidate, novelty }): ExplorationSelection => ({
      jobId: candidate.jobId,
      originalRank: candidate.rank,
      noveltyScore: novelty.score,
      novelDimensions: novelty.novel,
      reason:
        novelty.novel.length > 0
          ? `Shown to widen your search: ${novelty.novel
              .map((entry) => `${entry.value}`)
              .join(', ')} ${novelty.novel.length === 1 ? 'is' : 'are'} new to you.`
          : 'Shown to widen your search beyond your usual results.',
    }),
  );

  return {
    selected,
    slots,
    share,
    detail:
      selected.length === slots
        ? `${slots} of ${options.resultSize} slot(s) reserved for exploration (${config.exploration}).`
        : `${selected.length} of ${slots} exploration slot(s) filled — not enough sufficiently ` +
          `novel eligible jobs were available.`,
  };
}
