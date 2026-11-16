import type { RecommendationConfig, RecommendationTier } from '@job-intel/contracts';

/**
 * Score calibration.
 *
 * A weighted mean of factors that are individually generous clusters hard: real
 * runs put most eligible jobs between 55 and 75 and almost nothing above 90.
 * Left alone, "88" would mean "slightly above average" and the top tier would
 * be permanently empty — or, with the thresholds lowered to compensate,
 * everything would be exceptional, which is the same failure wearing a
 * different hat.
 *
 * So the raw range is stretched onto the reporting scale using two fixed
 * reference points from configuration. This is a **monotonic** transform:
 * it never reorders anything, only respaces it. Ranking is decided on the raw
 * score; calibration exists so the *number the candidate reads* carries
 * information.
 *
 * The ceiling is below 100 on purpose. A score should have somewhere left to
 * go, and "100/100" invites a scrutiny no automated system survives.
 */

export interface CalibrationResult {
  calibrated: number;
  explanation: string;
}

export function calibrate(
  rawScore: number,
  config: RecommendationConfig['calibration'],
): CalibrationResult {
  if (!config.enabled) {
    return { calibrated: rawScore, explanation: 'calibration disabled' };
  }

  const { referenceLow, referenceHigh, ceiling } = config;
  if (referenceHigh <= referenceLow) {
    // A misconfiguration must not silently produce nonsense.
    return { calibrated: rawScore, explanation: 'calibration references are inverted; skipped' };
  }

  const position = (rawScore - referenceLow) / (referenceHigh - referenceLow);

  // Below the low reference, compress rather than clip: an ordering among poor
  // jobs is still an ordering, and flattening them all to zero would lose it.
  const mapped = position < 0 ? Math.max(0, rawScore * (referenceLow / 100)) : position * ceiling;

  const calibrated = Math.round(Math.max(0, Math.min(ceiling, mapped)) * 100) / 100;

  return {
    calibrated,
    explanation:
      `raw ${rawScore.toFixed(1)} mapped through [${referenceLow}, ${referenceHigh}] ` +
      `onto [0, ${ceiling}]`,
  };
}

/**
 * Distribution health, for the run report.
 *
 * The number to watch is `share90Plus`. If a large fraction of a realistic
 * corpus lands above 90, the scale has stopped discriminating and the reference
 * points need moving — which is the whole reason this is measured rather than
 * assumed.
 */
export interface ScoreDistribution {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p90: number;
  share90Plus: number;
  share75Plus: number;
  byTier: Record<string, number>;
  /** True when the distribution looks degenerate and needs retuning. */
  clustered: boolean;
  note: string;
}

export function describeDistribution(
  scores: ReadonlyArray<{ score: number; tier: RecommendationTier }>,
): ScoreDistribution {
  if (scores.length === 0) {
    return {
      count: 0, min: 0, max: 0, mean: 0, median: 0, p90: 0,
      share90Plus: 0, share75Plus: 0, byTier: {}, clustered: false,
      note: 'no scores',
    };
  }

  const values = scores.map((s) => s.score).sort((a, b) => a - b);
  const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;

  const byTier: Record<string, number> = {};
  for (const { tier } of scores) byTier[tier] = (byTier[tier] ?? 0) + 1;

  const share90Plus = values.filter((v) => v >= 90).length / values.length;
  const share75Plus = values.filter((v) => v >= 75).length / values.length;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  // More than a fifth of a realistic corpus above 90 means "exceptional" has
  // stopped meaning anything.
  const clustered = share90Plus > 0.2;

  return {
    count: values.length,
    min: Math.round((values[0] ?? 0) * 100) / 100,
    max: Math.round((values[values.length - 1] ?? 0) * 100) / 100,
    mean: Math.round(mean * 100) / 100,
    median: Math.round(at(0.5) * 100) / 100,
    p90: Math.round(at(0.9) * 100) / 100,
    share90Plus: Math.round(share90Plus * 1000) / 1000,
    share75Plus: Math.round(share75Plus * 1000) / 1000,
    byTier,
    clustered,
    note: clustered
      ? `${Math.round(share90Plus * 100)}% of jobs score 90+; raise calibration.referenceHigh`
      : 'distribution is discriminating',
  };
}
