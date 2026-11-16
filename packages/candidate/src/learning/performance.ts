import {
  engagementMetricsSchema,
  queryPerformanceSchema,
  rankingQualitySchema,
  sourceUserValueSchema,
  type EngagementMetrics,
  type QueryPerformance,
  type RankingQuality,
  type SourceUserValue,
} from '@job-intel/contracts';

/**
 * Query, source and recommendation performance.
 *
 * All three answer the same question — *did this produce something the
 * candidate wanted?* — and all three refuse to answer it with volume. A query
 * returning a hundred jobs and no interactions is worse than one returning
 * twenty with five saves, and a source that is technically flawless while
 * producing nothing relevant is a source to deprioritise, not to celebrate.
 *
 * The separation the brief asks for is preserved throughout: **technical source
 * quality and user value are different numbers**. Prompt 10 computes the first
 * from run history; this computes the second from interactions. A source can
 * score 95 on one and 12 on the other, and collapsing them would hide whichever
 * problem you were not looking for.
 */

export interface InteractionCounts {
  jobsDiscovered: number;
  jobsShown: number;
  views: number;
  clicks: number;
  saves: number;
  applications: number;
  rejections: number;
  jobsMatched?: number;
}

/**
 * Positive engagement, weighted by how much each action means.
 *
 * An application is not four clicks. The weights mirror the signal weights used
 * for affinity so a single notion of "engagement" runs through the system.
 */
function engagementPoints(counts: InteractionCounts): number {
  return (
    counts.views * 0.1 +
    counts.clicks * 0.35 +
    counts.saves * 0.7 +
    counts.applications * 1 -
    counts.rejections * 0.4
  );
}

/**
 * A 0–100 value score.
 *
 * Engagement per *discovered* job, not per shown job: a query that floods the
 * pipeline with 500 irrelevant postings has imposed a real cost — deduplication,
 * enrichment, storage — and measuring it only against what survived to be shown
 * would hide that cost entirely.
 */
function valueScore(counts: InteractionCounts): { score: number; engagementRate: number } {
  const denominator = Math.max(1, counts.jobsDiscovered);
  const positives = counts.clicks + counts.saves + counts.applications;
  const engagementRate = Math.min(1, positives / denominator);

  const points = engagementPoints(counts);
  if (points <= 0) {
    // Negative or zero engagement floors at zero rather than going negative:
    // "produced nothing useful" and "produced actively unwanted results" are
    // both reasons to deprioritise, and the distinction lives in the rejection
    // count rather than in a negative score nobody can interpret.
    return { score: 0, engagementRate };
  }

  // Diminishing returns on raw volume of engagement, so one very active week
  // does not permanently pin a query at the top.
  const raw = (points / denominator) * 100;
  const score = Math.min(100, Math.round(Math.log10(1 + raw * 9) * 50));

  return { score, engagementRate: Number(engagementRate.toFixed(4)) };
}

export function scoreQueryPerformance(input: {
  queryId: string;
  candidateId: string;
  counts: InteractionCounts;
  windowDays?: number;
  now?: Date;
}): QueryPerformance {
  const { counts } = input;
  const { score, engagementRate } = valueScore(counts);

  const explanation =
    counts.jobsDiscovered === 0
      ? 'Never executed, or produced nothing.'
      : `${counts.jobsDiscovered} job(s) discovered → ${counts.clicks} click(s), ` +
        `${counts.saves} save(s), ${counts.applications} application(s)` +
        (counts.rejections > 0 ? `, ${counts.rejections} rejection(s)` : '') +
        `. Engagement ${(engagementRate * 100).toFixed(1)}%.`;

  return queryPerformanceSchema.parse({
    queryId: input.queryId,
    candidateId: input.candidateId,
    jobsDiscovered: counts.jobsDiscovered,
    jobsMatched: counts.jobsMatched ?? 0,
    jobsShown: counts.jobsShown,
    views: counts.views,
    clicks: counts.clicks,
    saves: counts.saves,
    applications: counts.applications,
    rejections: counts.rejections,
    engagementRate,
    valueScore: score,
    explanation,
    windowDays: input.windowDays ?? 30,
    computedAt: input.now ?? new Date(),
  });
}

export function scoreSourceUserValue(input: {
  sourceId: string;
  candidateId: string;
  counts: InteractionCounts;
  windowDays?: number;
  now?: Date;
}): SourceUserValue {
  const { counts } = input;
  const { score, engagementRate } = valueScore(counts);

  const explanation =
    counts.jobsDiscovered === 0
      ? 'No jobs from this source in the window.'
      : `${counts.jobsDiscovered} job(s) → ${counts.clicks} click(s), ${counts.saves} save(s), ` +
        `${counts.applications} application(s). ` +
        (score < 20 && counts.jobsDiscovered > 50
          ? 'High volume, low interest — this source may be technically healthy but not useful to you.'
          : `Engagement ${(engagementRate * 100).toFixed(1)}%.`);

  return sourceUserValueSchema.parse({
    sourceId: input.sourceId,
    candidateId: input.candidateId,
    jobsDiscovered: counts.jobsDiscovered,
    jobsShown: counts.jobsShown,
    views: counts.views,
    clicks: counts.clicks,
    saves: counts.saves,
    applications: counts.applications,
    rejections: counts.rejections,
    engagementRate,
    userValueScore: score,
    explanation,
    windowDays: input.windowDays ?? 30,
    computedAt: input.now ?? new Date(),
  });
}

/** Funnel rates over a window. Every rate is against what was actually shown. */
export function computeEngagementMetrics(input: {
  candidateId: string;
  windowDays: number;
  recommendationsShown: number;
  views: number;
  clicks: number;
  saves: number;
  rejections: number;
  applications: number;
  /** Distinct jobs with at least one positive interaction. */
  acceptedJobs: number;
  now?: Date;
}): EngagementMetrics {
  const shown = Math.max(0, input.recommendationsShown);
  const rate = (value: number): number =>
    shown === 0 ? 0 : Number(Math.min(1, value / shown).toFixed(4));

  return engagementMetricsSchema.parse({
    candidateId: input.candidateId,
    windowDays: input.windowDays,
    recommendationsShown: shown,
    jobsViewed: input.views,
    jobsClicked: input.clicks,
    jobsSaved: input.saves,
    jobsRejected: input.rejections,
    jobsApplied: input.applications,
    viewRate: rate(input.views),
    clickRate: rate(input.clicks),
    saveRate: rate(input.saves),
    applicationRate: rate(input.applications),
    acceptanceRate: rate(input.acceptedJobs),
    rejectionRate: rate(input.rejections),
    computedAt: input.now ?? new Date(),
  });
}

export interface RankedInteraction {
  jobId: string;
  /** Rank at which it was shown. */
  rank: number;
  clicked: boolean;
  saved: boolean;
  applied: boolean;
}

/**
 * Precision@K and friends.
 *
 * `recallOfEngaged` is named for what it actually measures. True recall would
 * need the set of all jobs the candidate *would* have wanted, which nobody has;
 * what is computable is the share of everything they engaged with that the
 * ranking put in the top k. Calling that "recall" without qualification would
 * be a claim the data cannot support.
 */
export function computeRankingQuality(input: {
  candidateId: string;
  k: number;
  windowDays: number;
  interactions: readonly RankedInteraction[];
  /** Recommendations shown at rank ≤ k, whether or not engaged with. */
  shownAtK: number;
  now?: Date;
}): RankingQuality {
  const { k } = input;
  const topK = input.interactions.filter((interaction) => interaction.rank <= k);

  const relevant = topK.filter(
    (interaction) => interaction.clicked || interaction.saved || interaction.applied,
  );
  const engagedOverall = input.interactions.filter(
    (interaction) => interaction.clicked || interaction.saved || interaction.applied,
  );

  const ratio = (numerator: number, denominator: number): number =>
    denominator === 0 ? 0 : Number(Math.min(1, numerator / denominator).toFixed(4));

  return rankingQualitySchema.parse({
    candidateId: input.candidateId,
    k,
    windowDays: input.windowDays,
    shown: input.shownAtK,
    relevant: relevant.length,
    precisionAtK: ratio(relevant.length, input.shownAtK),
    saveAtK: ratio(topK.filter((interaction) => interaction.saved).length, input.shownAtK),
    clickAtK: ratio(topK.filter((interaction) => interaction.clicked).length, input.shownAtK),
    applyAtK: ratio(topK.filter((interaction) => interaction.applied).length, input.shownAtK),
    recallOfEngaged: ratio(relevant.length, engagedOverall.length),
    computedAt: input.now ?? new Date(),
  });
}
