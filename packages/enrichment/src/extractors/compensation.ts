/**
 * Compensation extraction.
 *
 * Handles the forms postings actually use:
 *   "$120k-$150k", "EUR 70,000-90,000/year", "£500/day", "N300,000 monthly",
 *   "up to $150k", "competitive salary", "120000 USD per annum"
 *
 * Three rules the rest of the system depends on:
 *
 *  1. **Never invent.** "Competitive salary" yields `stated: false` with no
 *     numbers. A salary filter must be able to tell "not stated" from "low".
 *  2. **Never destroy.** `rawText` keeps the original wording verbatim.
 *  3. **Never silently convert.** A USD figure is produced only when a rate is
 *     supplied, and it carries the rate, its source and its timestamp so a
 *     comparison is auditable and a stale rate is recomputable.
 */

import type { Compensation, SalaryPeriod } from '@job-intel/contracts';
import {
  DEFAULT_FX_RATES,
  PERIOD_MULTIPLIERS,
  StaticFxRateProvider,
  collapseWhitespace,
  type FxRateProvider,
} from '@job-intel/core';

// Re-exported so existing importers keep working. The single definition now
// lives in `@job-intel/core`, so the candidate layer compares salary floors
// against exactly the same table the extractor converted with.
export { DEFAULT_FX_RATES, StaticFxRateProvider, type FxRateProvider };

/** Symbols and codes. `N`/`₦` matter: Nigerian postings state naira. */
const CURRENCY_TOKENS: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /\bUSD\b|\bUS\$|\$(?!\s*[A-Z]{2})/i, code: 'USD' },
  { pattern: /\bEUR\b|€/i, code: 'EUR' },
  { pattern: /\bGBP\b|£/i, code: 'GBP' },
  { pattern: /\bNGN\b|₦|\bN(?=\s?[\d,]{4,})/, code: 'NGN' },
  { pattern: /\bCAD\b|\bC\$/i, code: 'CAD' },
  { pattern: /\bAUD\b|\bA\$/i, code: 'AUD' },
  { pattern: /\bCHF\b/i, code: 'CHF' },
  { pattern: /\bSEK\b|\bkr\b/i, code: 'SEK' },
  { pattern: /\bPLN\b|\bzł/i, code: 'PLN' },
  { pattern: /\bINR\b|₹/i, code: 'INR' },
  { pattern: /\bJPY\b|¥/i, code: 'JPY' },
  { pattern: /\bZAR\b/i, code: 'ZAR' },
  { pattern: /\bKES\b/i, code: 'KES' },
  { pattern: /\bBRL\b|\bR\$/i, code: 'BRL' },
  { pattern: /\bSGD\b/i, code: 'SGD' },
];

const PERIOD_TOKENS: Array<{ pattern: RegExp; period: SalaryPeriod }> = [
  { pattern: /\/\s*(?:hr|hour)\b|\bper\s+hour\b|\bhourly\b|\ban\s+hour\b/i, period: 'hour' },
  { pattern: /\/\s*day\b|\bper\s+day\b|\bdaily\b|\ba\s+day\b|\bday\s+rate\b/i, period: 'day' },
  { pattern: /\/\s*(?:wk|week)\b|\bper\s+week\b|\bweekly\b/i, period: 'week' },
  { pattern: /\/\s*(?:mo|month)\b|\bper\s+month\b|\bmonthly\b|\bpcm\b|\ba\s+month\b/i, period: 'month' },
  { pattern: /\/\s*(?:yr|year|annum)\b|\bper\s+(?:year|annum)\b|\bannual(?:ly)?\b|\byearly\b|\bp\.?a\.?\b/i, period: 'year' },
];

/** Non-salary components worth recording. */
const COMPONENT_TOKENS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bequity\b|\bstock options?\b|\brsus?\b|\bshares?\b/i, label: 'equity' },
  { pattern: /\bbonus(?:es)?\b|\bcommission\b/i, label: 'bonus' },
  { pattern: /\bprofit[\s-]sharing\b/i, label: 'profit_sharing' },
  { pattern: /\bsigning bonus\b/i, label: 'signing_bonus' },
  { pattern: /\bpension\b|\b401\s?k\b/i, label: 'retirement' },
];

/** Phrases that state compensation exists without stating an amount. */
const UNSPECIFIED_PATTERNS: RegExp[] = [
  /\bcompetitive\s+(?:salary|compensation|package|pay)\b/i,
  /\bsalary\s+(?:is\s+)?(?:negotiable|commensurate|depending on experience|doe)\b/i,
  /\battractive\s+(?:salary|package)\b/i,
  /\bmarket[\s-]rate\b/i,
];

const RANGE_PATTERN =
  /([$£€₦¥]|\b(?:USD|EUR|GBP|NGN|CAD|AUD|CHF|SEK|PLN|INR|JPY|ZAR|KES|BRL|SGD)\b)?\s*([\d][\d,.\s]*)\s*(k|m)?(?![a-z])\s*(?:-|–|—|to|until)\s*([$£€₦¥]|\b(?:USD|EUR|GBP|NGN)\b)?\s*([\d][\d,.\s]*)\s*(k|m)?(?![a-z])/i;
/**
 * A currency marker.
 *
 * The trailing word boundary is deliberately omitted so codes written flush
 * against the amount ("GBP500") still parse. Bare "N" is accepted only when
 * followed by naira-scale digits, so it cannot swallow an ordinary initial.
 */
const CURRENCY_PREFIX =
  '[$£€₦¥]|\\b(?:USD|EUR|GBP|NGN|CAD|AUD|CHF|SEK|PLN|INR|JPY|ZAR|KES|BRL|SGD)|\\bN(?=\\s?[\\d,]{4,})';

const SINGLE_PATTERN = new RegExp(
  // The (?![a-z]) guard is essential: without it the optional k/m suffix
  // consumes the "m" of "monthly", turning 300,000 into 300 billion.
  `(?:(up\\s+to|from|starting\\s+at|minimum\\s+of|at\\s+least)\\s+)?(${CURRENCY_PREFIX})\\s*([\\d][\\d,.\\s]*)\\s*(k|m)?(?![a-z])`,
  'i',
);

/** A bare amount is only a salary when a period word makes it one. */
const BARE_NUMBER_WITH_PERIOD =
  /([\d][\d,.\s]{3,})\s*(k|m)?(?![a-z])\s*(?:\b(?:USD|EUR|GBP|NGN)\b)?\s*(?:(?:per|\/)\s*(?:hour|day|week|month|year|annum)|hourly|daily|weekly|monthly|yearly|annually)/i;

export interface CompensationInput {
  /** The source's dedicated salary field, when it has one. */
  salaryText: string | null;
  /** Structured figures from the source — always preferred over parsing. */
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: SalaryPeriod | null;
  title: string;
  description: string | null;
}

export function extractCompensation(
  input: CompensationInput,
  fx: FxRateProvider | null = new StaticFxRateProvider(DEFAULT_FX_RATES),
): Compensation {
  const base: Compensation = {
    stated: false,
    minimum: null,
    maximum: null,
    currency: null,
    period: null,
    isOpenEnded: false,
    isEstimated: false,
    rawText: null,
    components: [],
    confidence: 0,
    method: 'default',
    conversion: null,
  };

  // ── 1. Structured figures always beat parsing prose ───────────────────────
  if (input.salaryMin !== null || input.salaryMax !== null) {
    const currency = normalizeCurrency(input.salaryCurrency) ?? 'USD';
    const result: Compensation = {
      ...base,
      stated: true,
      minimum: input.salaryMin,
      maximum: input.salaryMax,
      currency,
      period: input.salaryPeriod,
      isOpenEnded: input.salaryMin === null || input.salaryMax === null,
      rawText: input.salaryText,
      confidence: 0.95,
      method: 'source_structured',
      components: findComponents(input.description ?? ''),
    };
    return withConversion(result, fx);
  }

  // ── 2. Parse the salary field, then the description ───────────────────────
  const salaryField = input.salaryText ? collapseWhitespace(input.salaryText) : null;
  const descriptionWindow = findCompensationWindow(input.description);

  for (const [text, confidenceBase, method] of [
    [salaryField, 0.85, 'pattern' as const],
    [descriptionWindow, 0.65, 'pattern' as const],
  ] as const) {
    if (!text) continue;
    const parsed = parseCompensationText(text);
    if (!parsed) continue;

    const result: Compensation = {
      ...base,
      ...parsed,
      stated: true,
      rawText: text.slice(0, 400),
      confidence: Math.min(0.95, confidenceBase + (parsed.currency ? 0.05 : 0) + (parsed.period ? 0.05 : 0)),
      method,
      components: findComponents(`${text} ${input.description ?? ''}`),
    };
    return withConversion(result, fx);
  }

  // ── 3. Compensation mentioned but unquantified ────────────────────────────
  const haystack = `${salaryField ?? ''} ${input.description ?? ''}`;
  const unspecified = UNSPECIFIED_PATTERNS.find((p) => p.test(haystack));
  if (unspecified) {
    return {
      ...base,
      stated: false,
      rawText: collapseWhitespace(unspecified.exec(haystack)?.[0] ?? '').slice(0, 400),
      // High confidence in the *observation* that no figure was given.
      confidence: 0.9,
      method: 'pattern',
      components: findComponents(haystack),
    };
  }

  return { ...base, components: findComponents(haystack) };
}

interface ParsedFigures {
  minimum: number | null;
  maximum: number | null;
  currency: string | null;
  period: SalaryPeriod | null;
  isOpenEnded: boolean;
}

export function parseCompensationText(text: string): ParsedFigures | null {
  const currency = detectCurrency(text);
  const period = detectPeriod(text);

  const range = RANGE_PATTERN.exec(text);
  if (range) {
    const min = toAmount(range[2], range[3]);
    const max = toAmount(range[5], range[6]);
    if (min !== null && max !== null && max >= min) {
      return { minimum: min, maximum: max, currency, period, isOpenEnded: false };
    }
  }

  const single = SINGLE_PATTERN.exec(text);
  if (single) {
    const amount = toAmount(single[3], single[4]);
    if (amount !== null) {
      const qualifier = single[1]?.toLowerCase() ?? '';
      const isUpperBound = qualifier.startsWith('up to');
      return {
        minimum: isUpperBound ? null : amount,
        maximum: isUpperBound ? amount : null,
        currency,
        period,
        isOpenEnded: true,
      };
    }
  }

  // A bare number is only a salary when a period makes it one.
  const bare = BARE_NUMBER_WITH_PERIOD.exec(text);
  if (bare) {
    const amount = toAmount(bare[1], bare[2]);
    if (amount !== null) {
      return { minimum: amount, maximum: null, currency, period, isOpenEnded: true };
    }
  }

  return null;
}

/**
 * Converts to annual USD, recording exactly how.
 *
 * When the period is absent it is inferred from magnitude, and that inference
 * is flagged — an unflagged guess is indistinguishable from a stated fact.
 */
function withConversion(comp: Compensation, fx: FxRateProvider | null): Compensation {
  if (!fx || !comp.stated) return comp;
  const amount = comp.maximum ?? comp.minimum;
  if (amount === null || amount <= 0) return comp;

  const currency = comp.currency ?? 'USD';
  const rate = fx.rateToUsd(currency);
  if (rate === null) return comp; // unknown currency: no silent assumption

  const periodInferred = comp.period === null;
  const period: SalaryPeriod = comp.period ?? inferPeriod(amount, currency);

  return {
    ...comp,
    conversion: {
      annualUsd: Math.round(amount * (PERIOD_MULTIPLIERS[period] ?? 1) * rate),
      rate,
      rateSource: fx.source,
      rateTimestamp: fx.timestamp,
      periodInferred,
    },
  };
}

/**
 * Infers a period from magnitude when none was stated.
 *
 * Thresholds are currency-aware: 300,000 is a plausible monthly salary in naira
 * and an implausible one in USD, so a single global cutoff misreads one of them.
 */
function inferPeriod(amount: number, currency: string): SalaryPeriod {
  const rate = DEFAULT_FX_RATES[currency.toUpperCase()] ?? 1;
  const usd = amount * rate;
  if (usd < 500) return 'hour';
  if (usd < 3_000) return 'day';
  if (usd < 15_000) return 'month';
  return 'year';
}

function detectCurrency(text: string): string | null {
  for (const { pattern, code } of CURRENCY_TOKENS) {
    if (pattern.test(text)) return code;
  }
  return null;
}

function detectPeriod(text: string): SalaryPeriod | null {
  for (const { pattern, period } of PERIOD_TOKENS) {
    if (pattern.test(text)) return period;
  }
  return null;
}

function normalizeCurrency(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(trimmed)) return trimmed;
  return detectCurrency(value);
}

function toAmount(digits: string | undefined, suffix: string | undefined): number | null {
  if (!digits) return null;
  const cleaned = digits.replace(/[,\s]/g, '');
  let value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = suffix?.toLowerCase();
  if (unit === 'k') value *= 1_000;
  else if (unit === 'm') value *= 1_000_000;

  // A bare four-digit number in the year range is a date, not a salary.
  if (!unit && value >= 1900 && value <= 2100 && !/[.,]/.test(digits)) return null;
  return value;
}

function findComponents(text: string): string[] {
  return COMPONENT_TOKENS.filter((c) => c.pattern.test(text)).map((c) => c.label);
}

/**
 * Narrows the description to the neighbourhood of a compensation cue.
 *
 * Scanning the whole body would match any number; a window around "salary",
 * "compensation" or "pay" keeps the parse anchored to the right sentence.
 */
function findCompensationWindow(description: string | null): string | null {
  if (!description) return null;
  const cue = /\b(?:salary|compensation|pay(?:\s+range)?|remuneration|package|rate)\b/i.exec(description);
  if (!cue) return null;
  const index = cue.index;
  return collapseWhitespace(description.slice(Math.max(0, index - 120), index + 260));
}
