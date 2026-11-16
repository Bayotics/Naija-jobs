import type { SalaryPeriod } from '@job-intel/contracts';
import { DEFAULT_FX_TO_USD, PERIOD_MULTIPLIERS } from '../normalize/vocabulary';

/**
 * Currency conversion, in one place.
 *
 * Three separate rate tables had grown up in this repo — one in `normalize`,
 * one in the compensation extractor and one private to the constraint
 * evaluator. They disagreed: the extractor knew twenty-two currencies, the
 * evaluator eleven, and a currency missing from a table was silently treated as
 * parity with the dollar. The visible symptom would be a salary that clears the
 * eligibility check and is then scored as below-minimum, or a ¥8,000,000 salary
 * read as $8,000,000. `DEFAULT_FX_TO_USD` in `normalize/vocabulary` is now the
 * single table and everything converts through here.
 */

export interface FxRateProvider {
  readonly source: string;
  readonly timestamp: Date;
  /** Units of USD per 1 unit of `currency`. Null when unknown. */
  rateToUsd(currency: string): number | null;
}

/**
 * Static rates, clearly labelled.
 *
 * Indicative only — enough to compare a salary floor across currencies, not to
 * be accurate to the cent. Because the rate and its timestamp are recorded on
 * every conversion, replacing this with a live feed changes nothing downstream.
 */
export class StaticFxRateProvider implements FxRateProvider {
  readonly source = 'static-indicative-table';
  readonly timestamp: Date;

  constructor(
    private readonly rates: Readonly<Record<string, number>> = DEFAULT_FX_TO_USD,
    timestamp = new Date('2026-01-01T00:00:00Z'),
  ) {
    this.timestamp = timestamp;
  }

  rateToUsd(currency: string): number | null {
    return this.rates[currency.toUpperCase()] ?? null;
  }
}

/**
 * Alias kept for the enrichment layer, which named the table this way.
 *
 * Same object, not a copy — so the two names cannot drift back apart.
 */
export const DEFAULT_FX_RATES = DEFAULT_FX_TO_USD;

/**
 * Projects an amount onto annual USD, as a plain number.
 *
 * Distinct from `toAnnualUsd` in `normalize/fields`, which returns the rate
 * alongside the value for provenance and infers a missing period from
 * magnitude. This one takes a known currency and period — the case where the
 * candidate stated both — and returns null for an unknown currency rather than
 * assuming parity, because a wrong number here silently mis-ranks every salary
 * comparison in the system.
 */
export function annualUsdAmount(
  amount: number | null | undefined,
  currency: string,
  period: SalaryPeriod,
  rates: Readonly<Record<string, number>> = DEFAULT_FX_TO_USD,
): number | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return null;
  const rate = rates[currency.toUpperCase()];
  if (rate === undefined) return null;
  return Math.round(amount * (PERIOD_MULTIPLIERS[period] ?? 1) * rate);
}
