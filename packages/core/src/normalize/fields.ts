import type {
  EmploymentType,
  RemoteType,
  SalaryPeriod,
  SeniorityLevel,
} from '@job-intel/contracts';
import {
  COUNTRY_ALIASES,
  CURRENCY_SYMBOLS,
  DEFAULT_FX_TO_USD,
  EMPLOYMENT_TERM_RULES,
  NIGERIAN_LOCATIONS,
  NON_LOCATION_TERMS,
  PERIOD_MULTIPLIERS,
  REMOTE_TERM_RULES,
  SENIORITY_TERM_RULES,
  type TermRule,
} from './vocabulary';
import { collapseWhitespace, stripDiacritics } from './text';

/**
 * Field-level normalization.
 *
 * Every function here returns **both** the normalized value and enough context
 * to explain it. The raw value is never discarded — it is carried on the job
 * alongside the interpretation, so a wrong mapping is diagnosable instead of
 * invisible.
 *
 * All functions are pure and total: unparseable input yields `unknown`/`null`
 * rather than an exception. Source data is untrusted, and a single malformed
 * salary string must never abort a source run.
 */

export interface Normalized<T> {
  value: T;
  /** 0–1. How much the caller should trust this interpretation. */
  confidence: number;
  /** The input this was derived from, preserved verbatim. */
  raw: string | null;
  /** Human-readable justification, surfaced in the debugging UI. */
  evidence: string | null;
}

function result<T>(
  value: T,
  confidence: number,
  raw: string | null,
  evidence: string | null,
): Normalized<T> {
  return { value, confidence, raw, evidence };
}

function bestMatch<T>(text: string, rules: ReadonlyArray<TermRule<T>>): {
  value: T;
  pattern: RegExp;
} | null {
  let best: { value: T; pattern: RegExp; weight: number } | null = null;
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (!pattern.test(text)) continue;
      if (!best || rule.weight > best.weight) {
        best = { value: rule.value, pattern, weight: rule.weight };
      }
      break;
    }
  }
  return best ? { value: best.value, pattern: best.pattern } : null;
}

// ── Remote type ─────────────────────────────────────────────────────────────

export interface RemoteNormalizeInput {
  /** An explicit boolean from the source, when it provides one. */
  explicitRemote?: boolean | null;
  /** Location string, e.g. "Remote (Europe)" or "Berlin". */
  location?: string | null;
  /** Title and/or tags — short, high-signal text. */
  title?: string | null;
  tags?: readonly string[];
  /** Long description. Lowest signal: consulted last and trusted least. */
  description?: string | null;
}

/**
 * Resolves "WFH" / "Work from home" / "100% remote" / "Remote-first" onto one
 * internal value.
 *
 * Signals are consulted strongest-first. A structured boolean from the source
 * beats any amount of prose, and prose in a long description is the weakest
 * evidence there is — descriptions routinely mention "remote" while describing
 * an on-site role's occasional flexibility.
 */
export function normalizeRemoteType(
  input: RemoteNormalizeInput,
  rules: ReadonlyArray<TermRule<RemoteType>> = REMOTE_TERM_RULES,
): Normalized<RemoteType> {
  const raw =
    input.location ?? (input.explicitRemote !== undefined && input.explicitRemote !== null
      ? String(input.explicitRemote)
      : null);

  // A short, structured signal is worth more than any prose.
  const shortText = collapseWhitespace(
    [input.location ?? '', input.title ?? '', (input.tags ?? []).join(' ')].join(' '),
  );
  const shortMatch = shortText ? bestMatch(shortText, rules) : null;
  if (shortMatch) {
    return result(shortMatch.value, 0.9, raw, `matched "${shortMatch.pattern.source}" in title/location/tags`);
  }

  if (input.explicitRemote === true) {
    return result('remote', 0.95, raw, 'source reported remote=true');
  }
  if (input.explicitRemote === false && input.location) {
    // remote=false plus a real location is a confident on-site signal.
    return result('onsite', 0.8, raw, 'source reported remote=false with a location');
  }

  if (input.description) {
    const match = bestMatch(input.description, rules);
    if (match) {
      return result(match.value, 0.45, raw, `matched "${match.pattern.source}" in description (weak signal)`);
    }
  }

  return result('unknown', 0, raw, 'no work-arrangement signal found');
}

// ── Employment type ─────────────────────────────────────────────────────────

/**
 * Maps "Full-time" / "Full Time" / "Permanent" / "Vollzeit" onto one value.
 * Returns every distinct type found, because a posting may genuinely be
 * "Full-time or Contract".
 */
export function normalizeEmploymentTypes(
  values: ReadonlyArray<string | null | undefined>,
  rules: ReadonlyArray<TermRule<EmploymentType>> = EMPLOYMENT_TERM_RULES,
): Normalized<EmploymentType[]> {
  const raw = values.filter((v): v is string => Boolean(v)).join(' | ') || null;
  if (!raw) return result([], 0, null, 'no employment-type information');

  const found = new Map<EmploymentType, string>();
  for (const value of values) {
    if (!value) continue;
    const match = bestMatch(value, rules);
    if (match && !found.has(match.value)) found.set(match.value, value);
  }

  if (found.size === 0) return result([], 0, raw, 'no employment-type term recognised');
  return result(
    [...found.keys()],
    0.85,
    raw,
    [...found.entries()].map(([type, src]) => `${type} ← "${src}"`).join('; '),
  );
}

// ── Seniority ───────────────────────────────────────────────────────────────

/** Infers seniority from a job title. Titles are the only reliable source. */
export function normalizeSeniority(
  title: string | null | undefined,
  rules: ReadonlyArray<TermRule<SeniorityLevel>> = SENIORITY_TERM_RULES,
): Normalized<SeniorityLevel | null> {
  if (!title) return result(null, 0, null, 'no title supplied');
  const match = bestMatch(title, rules);
  if (!match) return result(null, 0, title, 'no seniority term in title');
  return result(match.value, 0.75, title, `matched "${match.pattern.source}" in title`);
}

// ── Salary ──────────────────────────────────────────────────────────────────

export interface ParsedSalary {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: SalaryPeriod | null;
  normalizedAnnualUsd: number | null;
  fxRateUsed: number | null;
}

const PERIOD_PATTERNS: Array<[SalaryPeriod, RegExp]> = [
  ['hour', /\b(?:per\s+)?(?:hour|hr|hourly)\b|\/\s*h(?:r|our)?\b/i],
  ['day', /\b(?:per\s+)?(?:day|daily)\b|\/\s*day\b/i],
  ['week', /\b(?:per\s+)?(?:week|weekly)\b|\/\s*w(?:k|eek)?\b/i],
  ['month', /\b(?:per\s+)?(?:month|monthly|pcm)\b|\/\s*mo(?:nth)?\b/i],
  ['year', /\b(?:per\s+)?(?:year|annum|annually|yearly|p\.?a\.?)\b|\/\s*(?:yr|year)\b/i],
];

/**
 * Parses free-text salary strings such as:
 *   "$120 - $170 /hour", "€60,000–€80,000 per year", "₦250,000 monthly",
 *   "120k-170k USD", "Competitive"
 *
 * Returns nulls rather than guesses when the text is not a salary. "Not stated"
 * must stay distinguishable from "zero", because a salary floor that silently
 * treats absence as failure discards most of the corpus.
 */
export function parseSalaryText(
  text: string | null | undefined,
  options: { defaultCurrency?: string | null; fxRates?: Readonly<Record<string, number>> } = {},
): Normalized<ParsedSalary> {
  const empty: ParsedSalary = {
    min: null,
    max: null,
    currency: null,
    period: null,
    normalizedAnnualUsd: null,
    fxRateUsed: null,
  };
  if (!text) return result(empty, 0, null, 'no salary text');

  const raw = collapseWhitespace(text);
  // Reject prose that contains no digits at all ("Competitive", "Negotiable").
  if (!/\d/.test(raw)) return result(empty, 0, raw, 'no numeric salary in text');

  const currency = detectCurrency(raw) ?? options.defaultCurrency ?? null;
  const period = PERIOD_PATTERNS.find(([, pattern]) => pattern.test(raw))?.[0] ?? null;
  const amounts = extractAmounts(raw);
  if (amounts.length === 0) return result(empty, 0, raw, 'no parseable amounts');

  const min = amounts[0] ?? null;
  const max = amounts.length > 1 ? (amounts[1] ?? null) : null;

  const parsed: ParsedSalary = {
    min,
    max,
    currency,
    period,
    normalizedAnnualUsd: null,
    fxRateUsed: null,
  };

  const annual = toAnnualUsd(max ?? min, currency, period, options.fxRates);
  parsed.normalizedAnnualUsd = annual.value;
  parsed.fxRateUsed = annual.rate;

  // Confidence reflects how much was actually determined, not how much was guessed.
  const confidence = 0.4 + (currency ? 0.2 : 0) + (period ? 0.2 : 0) + (max !== null ? 0.1 : 0);
  return result(
    parsed,
    Math.min(confidence, 0.95),
    raw,
    `amounts=[${amounts.join(', ')}] currency=${currency ?? '?'} period=${period ?? '?'}`,
  );
}

function detectCurrency(text: string): string | null {
  const isoMatch = /\b(USD|EUR|GBP|NGN|CAD|AUD|CHF|SEK|PLN|INR|JPY|ZAR|KES|GHS)\b/i.exec(text);
  if (isoMatch?.[1]) return isoMatch[1].toUpperCase();

  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(symbol)) return code;
  }
  return null;
}

/**
 * Extracts numeric amounts, expanding `k` suffixes.
 * Bare years (1900–2100) are skipped so "posted 2026" is not read as a salary.
 */
function extractAmounts(text: string): number[] {
  const amounts: number[] = [];
  const pattern = /(\d[\d.,\s]*)\s*(k|m)?\b/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const digits = (match[1] ?? '').replace(/[,\s]/g, '');
    if (!digits) continue;
    let value = Number(digits.endsWith('.') ? digits.slice(0, -1) : digits);
    if (!Number.isFinite(value)) continue;

    const suffix = match[2]?.toLowerCase();
    if (suffix === 'k') value *= 1_000;
    else if (suffix === 'm') value *= 1_000_000;
    // A bare four-digit number in the year range is almost never a salary.
    else if (value >= 1900 && value <= 2100 && !/[.,]/.test(match[1] ?? '')) continue;

    if (value > 0) amounts.push(value);
    if (amounts.length >= 2) break;
  }
  return amounts;
}

/** Projects an amount onto an annual USD figure for cross-source comparison. */
export function toAnnualUsd(
  amount: number | null,
  currency: string | null,
  period: SalaryPeriod | null,
  fxRates: Readonly<Record<string, number>> = DEFAULT_FX_TO_USD,
): { value: number | null; rate: number | null } {
  if (amount === null || amount <= 0) return { value: null, rate: null };

  const code = (currency ?? 'USD').toUpperCase();
  const rate = fxRates[code];
  if (rate === undefined) return { value: null, rate: null };

  // With no stated period, infer from magnitude: an annual salary below ~1000
  // in any currency is implausible, and a five-figure hourly rate even more so.
  const effectivePeriod: SalaryPeriod =
    period ?? (amount < 1_000 ? 'hour' : amount < 30_000 ? 'month' : 'year');

  const multiplier = PERIOD_MULTIPLIERS[effectivePeriod] ?? 1;
  return { value: Math.round(amount * multiplier * rate), rate };
}

// ── Location ────────────────────────────────────────────────────────────────

export interface ParsedLocation {
  city: string | null;
  region: string | null;
  countryCode: string | null;
}

/**
 * Parses location strings such as "Berlin, Germany", "Lagos", "Remote, Europe",
 * "Americas, Europe, Israel".
 *
 * Returns nulls rather than inventing a city. "Anywhere" is not a place, and
 * recording it as one would make every location filter wrong.
 */
export function parseLocation(
  text: string | null | undefined,
  aliases: Readonly<Record<string, string>> = COUNTRY_ALIASES,
): Normalized<ParsedLocation> {
  const empty: ParsedLocation = { city: null, region: null, countryCode: null };
  if (!text) return result(empty, 0, null, 'no location text');

  const raw = collapseWhitespace(text);
  const cleaned = stripDiacritics(raw).toLowerCase();

  if (NON_LOCATION_TERMS.has(cleaned)) {
    return result(empty, 0.6, raw, 'location is a non-place term');
  }

  const parts = raw
    .split(/[,/|·—–-]/)
    .map((p) => collapseWhitespace(p))
    .filter((p) => p.length > 0 && !NON_LOCATION_TERMS.has(stripDiacritics(p).toLowerCase()));

  if (parts.length === 0) return result(empty, 0.4, raw, 'no usable location parts');

  // Country is conventionally last; scan from the end.
  let countryCode: string | null = null;
  let countryIndex = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const key = stripDiacritics(parts[i] ?? '').toLowerCase();
    const code = aliases[key] ?? (/^[a-z]{2}$/.test(key) ? key.toUpperCase() : null);
    if (code) {
      countryCode = code;
      countryIndex = i;
      break;
    }
  }

  // Nigerian boards routinely give a state or city with no country at all.
  if (!countryCode) {
    for (const part of parts) {
      if (NIGERIAN_LOCATIONS.has(stripDiacritics(part).toLowerCase())) {
        countryCode = 'NG';
        break;
      }
    }
  }

  const remaining = parts.filter((_, i) => i !== countryIndex);
  const city = remaining[0] ?? null;
  const region = remaining.length > 1 ? (remaining[remaining.length - 1] ?? null) : null;

  const confidence = countryCode ? (city ? 0.85 : 0.7) : city ? 0.4 : 0.2;
  return result(
    { city, region, countryCode },
    confidence,
    raw,
    `parts=[${parts.join(' | ')}] country=${countryCode ?? '?'}`,
  );
}
