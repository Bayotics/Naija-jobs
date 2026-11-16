import { STRENGTH_SCORES, type ComponentScore, type WeightedPreference } from '@job-intel/contracts';

/**
 * Helpers shared by the dimension scorers.
 *
 * Kept deliberately small: anything that encodes *what* a good match looks like
 * belongs in a scorer, not here. This file only holds arithmetic and text
 * normalisation that would otherwise be copy-pasted twelve times.
 */

export function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Contract limits, enforced here so no scorer can violate them. */
const MAX_EXPLANATION = 400;
const MAX_EVIDENCE_ITEM = 200;

function cap(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * Builds a scored dimension.
 *
 * Every scorer funnels through here, which makes this the one place to enforce
 * the contract's length limits. A live run found the alternative the hard way:
 * a salary line quoted verbatim from a posting exceeded the evidence limit, and
 * the resulting validation failure surfaced on the *read* path, taking down a
 * whole match listing rather than the one field that was too long.
 */
export function score(
  dimension: string,
  value: number,
  confidence: number,
  explanation: string,
  evidence: string[] = [],
): ComponentScore {
  return {
    dimension,
    score: round(clamp(value)),
    confidence: round(clamp(confidence, 0, 1), 3),
    applicable: true,
    explanation: cap(explanation, MAX_EXPLANATION),
    evidence: evidence.map((item) => cap(item, MAX_EVIDENCE_ITEM)),
  };
}

/**
 * A dimension that does not apply.
 *
 * Excluded from the weighted average entirely — neither credited nor penalised.
 * The alternative, scoring silence as zero, would rank a posting that simply
 * omits its salary below one that states a bad salary, which is backwards.
 */
export function notApplicable(dimension: string, explanation: string): ComponentScore {
  return {
    dimension,
    score: 0,
    confidence: 0,
    applicable: false,
    explanation: cap(explanation, MAX_EXPLANATION),
    evidence: [],
  };
}

/** Lowercase, collapse whitespace, drop punctuation. For loose text comparison. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value: string): string[] {
  return normalizeText(value).split(' ').filter(Boolean);
}

/** Jaccard overlap of two token sets. 0-1. */
export function tokenOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Maps a preference strength (-1..1) onto a 0-100 dimension score.
 *
 * `neutral` lands on 50 rather than 0: expressing no opinion about a value the
 * job happens to have is not a complaint about it.
 */
export function strengthToScore(strength: WeightedPreference['strength']): number {
  return clamp((STRENGTH_SCORES[strength] + 1) * 50);
}

/** Case-insensitive exact lookup. */
export function findPreference(
  list: readonly WeightedPreference[],
  value: string | null | undefined,
): WeightedPreference | null {
  if (!value) return null;
  const needle = value.trim().toLowerCase();
  return list.find((p) => p.value.trim().toLowerCase() === needle) ?? null;
}

/** Substring lookup, for dimensions where postings phrase things loosely. */
export function findPreferenceLoose(
  list: readonly WeightedPreference[],
  haystack: string | null | undefined,
): WeightedPreference | null {
  if (!haystack) return null;
  const text = haystack.toLowerCase();
  return list.find((p) => text.includes(p.value.trim().toLowerCase())) ?? null;
}

/**
 * The best (most positive) preference matching any of several job values.
 *
 * Postings often carry several industries or employment types; the candidate's
 * strongest reaction to any of them is the honest summary.
 */
export function bestPreference(
  list: readonly WeightedPreference[],
  values: readonly string[],
): { preference: WeightedPreference; matched: string } | null {
  let best: { preference: WeightedPreference; matched: string } | null = null;
  for (const value of values) {
    const found = findPreference(list, value);
    if (!found) continue;
    if (!best || STRENGTH_SCORES[found.strength] > STRENGTH_SCORES[best.preference.strength]) {
      best = { preference: found, matched: value };
    }
  }
  return best;
}

/** The most *negative* preference matching any job value, if any is negative. */
export function worstPreference(
  list: readonly WeightedPreference[],
  values: readonly string[],
): { preference: WeightedPreference; matched: string } | null {
  let worst: { preference: WeightedPreference; matched: string } | null = null;
  for (const value of values) {
    const found = findPreference(list, value);
    if (!found || STRENGTH_SCORES[found.strength] >= 0) continue;
    if (!worst || STRENGTH_SCORES[found.strength] < STRENGTH_SCORES[worst.preference.strength]) {
      worst = { preference: found, matched: value };
    }
  }
  return worst;
}

/** Annualisation factors, so periods can be compared without a currency table. */
const PERIOD_FACTORS: Readonly<Record<string, number>> = {
  hour: 2080,
  day: 260,
  week: 52,
  month: 12,
  year: 1,
};

export function toAnnual(amount: number, period: string | null | undefined): number | null {
  const factor = PERIOD_FACTORS[period ?? 'year'];
  return factor === undefined ? null : amount * factor;
}
