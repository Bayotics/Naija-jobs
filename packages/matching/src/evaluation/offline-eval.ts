import {
  ndcgAtK,
  precisionAtK,
  rankingEvaluationSchema,
  recallAtK,
  type RankingEvaluation,
} from '@job-intel/contracts';

/**
 * Offline evaluation and the naive baseline.
 *
 * Two jobs, both about not fooling ourselves.
 *
 * The first is comparing scoring versions. A new version that produces higher
 * average scores has not been shown to be better — it has been shown to be more
 * generous, which is trivially easy and usually worse. What matters is whether
 * the *ordering* improved against a set where someone has said what the right
 * answer is, and that requires a graded dataset and metrics that care about
 * rank rather than magnitude.
 *
 * The second is the keyword baseline. Every matching system claims to be more
 * than keyword overlap; the only way to know is to implement the keyword
 * version and see where the two disagree. The disagreements are the product.
 */

// ── Naive baseline ──────────────────────────────────────────────────────────

export interface BaselineInput {
  candidateSkills: readonly string[];
  jobText: string;
  jobTitle: string;
  candidateTitles?: readonly string[];
}

/**
 * The thing this engine claims to beat.
 *
 * Deliberately a *fair* implementation of the naive approach rather than a
 * strawman: it lowercases, tokenises on word boundaries, and gives credit for
 * title overlap as well as skills. A rigged baseline would prove nothing.
 *
 * What it cannot do is the point. It has no notion of a hard constraint, so it
 * will happily score an onsite-in-Denver role 90 for someone who cannot
 * relocate. It has no notion of evidence, so a skills-list mention counts the
 * same as four years of production work. It has no notion of relatedness, so
 * Next.js earns nothing for a React developer and "Vue" earns nothing at all
 * even though it says a great deal about whether this person can do the job.
 */
export function naiveKeywordScore(input: BaselineInput): number {
  const haystack = `${input.jobTitle}\n${input.jobText}`.toLowerCase();

  if (input.candidateSkills.length === 0) return 0;

  const matched = input.candidateSkills.filter((skill) => {
    const escaped = skill.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(haystack);
  }).length;

  const skillRatio = matched / input.candidateSkills.length;

  const titleTokens = new Set(
    input.jobTitle
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );

  const candidateTokens = new Set(
    (input.candidateTitles ?? [])
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );

  const titleOverlap =
    titleTokens.size === 0
      ? 0
      : [...titleTokens].filter((token) => candidateTokens.has(token)).length / titleTokens.size;

  return Math.round(Math.min(100, (skillRatio * 0.7 + titleOverlap * 0.3) * 100));
}

// ── Graded dataset ──────────────────────────────────────────────────────────

/**
 * What a human says the answer should be.
 *
 * `expectedBand` rather than an exact number, because nobody can say a job is a
 * 79 rather than an 81 and a dataset that pretends otherwise measures noise.
 * Bands are wide enough to be judged consistently and narrow enough to catch a
 * real regression.
 *
 * The EXCELLENT floor sits at 72 rather than somewhere in the eighties, and
 * that is a statement about the engine rather than a concession. A candidate
 * who requires visa sponsorship cannot have a 90 match on a posting that is
 * silent about sponsorship — the uncertainty cap is doing precisely its job,
 * and a band that demanded 90 would be asking the engine to overclaim.
 */
export const EXPECTED_BANDS = {
  EXCELLENT: { min: 72, max: 100 },
  GOOD: { min: 58, max: 82 },
  BORDERLINE: { min: 38, max: 68 },
  POOR: { min: 0, max: 52 },
  /*
   * Ineligible jobs are graded on eligibility alone, so the band spans the
   * whole range. A blocked job's score is not a claim about anything — the
   * engine stopped evaluating — and asserting a range on it would test noise.
   */
  INELIGIBLE: { min: 0, max: 100 },
} as const;

export type ExpectedBand = keyof typeof EXPECTED_BANDS;

export interface GradedCase {
  id: string;
  label: string;
  expectedBand: ExpectedBand;
  /** True when the job must be rejected outright, whatever it scores. */
  expectIneligible?: boolean;
  /** Graded relevance for NDCG: 4 = offer-worthy, 0 = irrelevant. */
  relevance: number;
}

export interface ScoredCase extends GradedCase {
  actualScore: number;
  actualEligible: boolean;
  confidence: number;
}

export interface BandReport {
  id: string;
  label: string;
  expectedBand: ExpectedBand;
  actualScore: number;
  inBand: boolean;
  eligibilityCorrect: boolean;
  note: string;
}

/**
 * Whether each case landed where a person said it should.
 *
 * Eligibility is checked separately from the band and reported separately,
 * because they fail for different reasons. A job scored 88 that should have
 * been ineligible is not a scoring problem — it is a constraint problem, and
 * conflating the two sends whoever is debugging it to the wrong module.
 */
export function evaluateBands(cases: readonly ScoredCase[]): {
  reports: BandReport[];
  inBand: number;
  eligibilityCorrect: number;
  meanAbsoluteError: number;
} {
  const reports: BandReport[] = [];
  let totalError = 0;

  for (const entry of cases) {
    const band = EXPECTED_BANDS[entry.expectedBand];
    const inBand = entry.actualScore >= band.min && entry.actualScore <= band.max;

    const eligibilityCorrect = entry.expectIneligible
      ? !entry.actualEligible
      : entry.actualEligible;

    /*
     * Error is measured to the nearest band edge, not to a midpoint. A score
     * inside the band is exactly right by definition, and measuring it against
     * a made-up centre would manufacture error where none exists.
     */
    const error = inBand
      ? 0
      : entry.actualScore < band.min
        ? band.min - entry.actualScore
        : entry.actualScore - band.max;

    totalError += error;

    reports.push({
      id: entry.id,
      label: entry.label,
      expectedBand: entry.expectedBand,
      actualScore: entry.actualScore,
      inBand,
      eligibilityCorrect,
      note: inBand
        ? 'Within the expected band.'
        : `Expected ${band.min}–${band.max}, scored ${entry.actualScore}.`,
    });
  }

  return {
    reports,
    inBand: reports.filter((report) => report.inBand).length,
    eligibilityCorrect: reports.filter((report) => report.eligibilityCorrect).length,
    meanAbsoluteError: cases.length === 0 ? 0 : Number((totalError / cases.length).toFixed(2)),
  };
}

/**
 * Ranking metrics for one scoring version.
 *
 * Cases are ranked by the score the engine produced, then measured against the
 * grades a person assigned. That is the whole method: the engine's job is to
 * put the good ones first, and these numbers say whether it did.
 */
export function evaluateRanking(
  cases: readonly ScoredCase[],
  scoringVersion: string,
): RankingEvaluation {
  const ranked = [...cases].sort((a, b) => b.actualScore - a.actualScore);

  const relevanceEntries = ranked.map((entry) => ({ relevance: entry.relevance }));
  const relevantEntries = ranked.map((entry) => ({ relevant: entry.relevance >= 2 }));

  const bands = evaluateBands(cases);

  return rankingEvaluationSchema.parse({
    scoringVersion,
    sampleSize: cases.length,
    precisionAt5: Number(precisionAtK(relevantEntries, 5).toFixed(4)),
    precisionAt10: Number(precisionAtK(relevantEntries, 10).toFixed(4)),
    recallAt10: Number(recallAtK(relevantEntries, 10).toFixed(4)),
    ndcgAt10: ndcgAtK(relevanceEntries, 10),
    meanAbsoluteError: bands.meanAbsoluteError,
  });
}

export interface VersionComparison {
  incumbent: RankingEvaluation;
  challenger: RankingEvaluation;
  /** True only when the challenger is better on ranking *and* not worse on error. */
  challengerWins: boolean;
  verdict: string;
}

/**
 * Compares two scoring versions.
 *
 * The gate is deliberately hard to pass, because the default outcome of a
 * scoring change should be "not proven". A challenger must improve ranking
 * quality *and* not degrade band accuracy; a version that ranks marginally
 * better while scoring everything ten points higher has not earned production.
 *
 * Average score is not consulted at all, and that is the point — it is the
 * metric a careless change moves most and means least.
 */
export function compareVersions(
  incumbent: RankingEvaluation,
  challenger: RankingEvaluation,
  options: { minNdcgGain?: number; maxErrorRegression?: number } = {},
): VersionComparison {
  const minGain = options.minNdcgGain ?? 0.01;
  const maxRegression = options.maxErrorRegression ?? 1;

  const ndcgGain = challenger.ndcgAt10 - incumbent.ndcgAt10;
  const errorChange =
    (challenger.meanAbsoluteError ?? 0) - (incumbent.meanAbsoluteError ?? 0);

  const rankingBetter = ndcgGain >= minGain;
  const errorAcceptable = errorChange <= maxRegression;

  const challengerWins = rankingBetter && errorAcceptable;

  const verdict = challengerWins
    ? `Challenger improves NDCG@10 by ${ndcgGain.toFixed(3)} with error change ${errorChange.toFixed(2)}. Promote.`
    : !rankingBetter
      ? `Challenger's NDCG@10 gain of ${ndcgGain.toFixed(3)} is below the ${minGain} threshold. Not proven.`
      : `Challenger ranks better but band error worsened by ${errorChange.toFixed(2)}. Hold.`;

  return { incumbent, challenger, challengerWins, verdict };
}
