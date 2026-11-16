import { dominates, type Tradeoff } from '@job-intel/contracts';

/**
 * Why one job ranks above another, in the dimensions that differ.
 *
 * Ranking by a single blended score hides the shape of a choice. A 95-match
 * with an unknown salary and an 88-match paying well are not comparable by
 * arithmetic — the blend just picks whichever dimension happened to carry more
 * weight, and the result feels arbitrary to the person reading it because it
 * *is* arbitrary in the dimension they cared about.
 *
 * So the ranking stays as it is, and this module explains what it cost. Two
 * things come out of it: which options genuinely dominate others (those can be
 * ranked with confidence), and for the rest, a sentence naming the trade.
 */

export interface RankedOption {
  id: string;
  label: string;
  /** Scores per dimension. `null` means unknown, which is not a low score. */
  dimensions: Readonly<Record<string, number | null>>;
  overallScore: number;
}

export interface DominanceResult {
  id: string;
  /** Options this one beats on every comparable dimension. */
  dominates: string[];
  /** Options that beat this one on every comparable dimension. */
  dominatedBy: string[];
  /** True when nothing dominates it — it is on the frontier. */
  onFrontier: boolean;
}

/**
 * Which options are genuinely better than which.
 *
 * An unknown dimension blocks dominance in both directions, deliberately. If
 * job A scores 95 on skills and job B scores 88 but A's salary is unknown, A
 * does not dominate B — the unknown might be terrible. Treating unknowns as
 * neutral would let a job with no information dominate one with disappointing
 * information, which is precisely backwards.
 */
export function computeFrontier(options: readonly RankedOption[]): DominanceResult[] {
  return options.map((option) => {
    const beats: string[] = [];
    const beatenBy: string[] = [];

    for (const other of options) {
      if (other.id === option.id) continue;

      if (dominates(option.dimensions, other.dimensions)) beats.push(other.id);
      if (dominates(other.dimensions, option.dimensions)) beatenBy.push(other.id);
    }

    return {
      id: option.id,
      dominates: beats,
      dominatedBy: beatenBy,
      onFrontier: beatenBy.length === 0,
    };
  });
}

/** Dimensions worth mentioning, with how to phrase each. */
const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  skills: 'skills match',
  experience: 'experience',
  salary: 'salary',
  location: 'location',
  workArrangement: 'work arrangement',
  seniority: 'seniority',
  title: 'role',
  visa: 'work authorisation',
  quality: 'posting quality',
  careerTrajectory: 'career fit',
};

const STRENGTH_THRESHOLD = 75;
const COST_THRESHOLD = 55;

/**
 * The dimensions that make an option good or costly.
 *
 * Only the extremes are reported. A dimension sitting at 64 is neither a
 * selling point nor a problem, and listing it would bury the two facts that
 * actually distinguish this job from the next one.
 */
export function describeTradeoffs(option: RankedOption): Tradeoff[] {
  const tradeoffs: Tradeoff[] = [];

  for (const [dimension, score] of Object.entries(option.dimensions)) {
    const label = DIMENSION_LABELS[dimension] ?? dimension;

    if (score === null) {
      tradeoffs.push({
        dimension,
        kind: 'unknown',
        score: null,
        summary: `${label} is not stated in this posting`,
      });
      continue;
    }

    if (score >= STRENGTH_THRESHOLD) {
      tradeoffs.push({
        dimension,
        kind: 'strength',
        score,
        summary: `strong ${label} (${Math.round(score)})`,
      });
      continue;
    }

    if (score <= COST_THRESHOLD) {
      tradeoffs.push({
        dimension,
        kind: 'cost',
        score,
        summary: `weak ${label} (${Math.round(score)})`,
      });
    }
  }

  return tradeoffs;
}

/**
 * One sentence explaining a rank.
 *
 * Written to be read by someone who has not seen the score breakdown, and
 * built to always name the *cost* when there is one. A ranking explanation that
 * only lists strengths is marketing; naming what the job gives up is what makes
 * it useful for deciding.
 */
export function explainRank(
  option: RankedOption,
  position: number,
  frontier: DominanceResult,
): string {
  const tradeoffs = describeTradeoffs(option);

  const strengths = tradeoffs.filter((entry) => entry.kind === 'strength');
  const costs = tradeoffs.filter((entry) => entry.kind === 'cost');
  const unknowns = tradeoffs.filter((entry) => entry.kind === 'unknown');

  const parts: string[] = [];

  parts.push(`Ranks #${position}`);

  if (strengths.length > 0) {
    parts.push(`because of ${joinNaturally(strengths.slice(0, 3).map((entry) => entry.summary))}`);
  } else {
    parts.push(`on an overall score of ${Math.round(option.overallScore)}`);
  }

  if (costs.length > 0) {
    parts.push(`despite ${joinNaturally(costs.slice(0, 2).map((entry) => entry.summary))}`);
  }

  if (unknowns.length > 0 && costs.length === 0) {
    parts.push(`with ${joinNaturally(unknowns.slice(0, 2).map((entry) => entry.summary))}`);
  }

  /*
   * Dominance is worth saying out loud when it holds, because it is the one
   * case where the ranking involves no judgement at all: this job is better in
   * every dimension we can compare, so there is nothing to weigh.
   */
  if (frontier.dominates.length > 0 && costs.length === 0) {
    parts.push(
      `— it beats ${frontier.dominates.length} other option(s) on every dimension we can compare`,
    );
  }

  return `${parts.join(' ')}.`;
}

function joinNaturally(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * Explains a whole ranked list.
 *
 * Runs the frontier once and reuses it, because dominance is pairwise and
 * recomputing it per option would be quadratic work for an answer that does not
 * change.
 */
export function explainRanking(options: readonly RankedOption[]): Array<{
  id: string;
  position: number;
  explanation: string;
  tradeoffs: Tradeoff[];
  onFrontier: boolean;
}> {
  const frontier = computeFrontier(options);
  const byId = new Map(frontier.map((entry) => [entry.id, entry]));

  return options.map((option, index) => {
    const dominance = byId.get(option.id)!;

    return {
      id: option.id,
      position: index + 1,
      explanation: explainRank(option, index + 1, dominance),
      tradeoffs: describeTradeoffs(option),
      onFrontier: dominance.onFrontier,
    };
  });
}
