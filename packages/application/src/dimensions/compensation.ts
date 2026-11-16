import {
  compensationAssessmentSchema,
  type CandidatePreferences,
  type CompensationAssessment,
  type JobEnrichment,
  type SalaryVerdict,
} from '@job-intel/contracts';

/**
 * Compensation.
 *
 * The rule that shapes this module: **a posting that says nothing about pay is
 * `unknown`, never `below_preference`.** Most postings are silent, and a system
 * that reads silence as bad pay will steer someone away from most of the market
 * on no evidence at all.
 *
 * The second rule follows from the first: a below-preference salary is a
 * *reason to think*, not a reason to skip. It only becomes disqualifying when
 * the candidate explicitly marked their minimum as hard — which is a setting
 * they have to reach for, precisely because most people would rather see the
 * job and decide for themselves.
 */

/**
 * Below this annual USD figure, a stated salary is treated as unreadable.
 *
 * Live postings produced "1–2 NGN per month" and "from 0.55 USD per year",
 * which are parse failures wearing the shape of a salary. Blocking a candidate
 * out of a job because an extractor misread a number is far worse than
 * admitting the figure could not be read — and `unknown` is what "we could not
 * read it" already means here.
 */
const IMPLAUSIBLE_ANNUAL_USD = 3_000;

/** Annualisation factors. Approximate by nature, and used only as such. */
const PERIOD_TO_ANNUAL: Readonly<Record<string, number>> = {
  hour: 2080,
  day: 260,
  week: 52,
  month: 12,
  year: 1,
};

export interface CompensationInput {
  enrichment: JobEnrichment | null;
  preferences: CandidatePreferences | null;
}

export function analyseCompensation(input: CompensationInput): CompensationAssessment {
  const compensation = input.enrichment?.compensation ?? null;
  const salaryPreference = input.preferences?.salary ?? null;

  const candidateMinimum = salaryPreference?.minimum ?? null;
  const candidateTarget = salaryPreference?.target ?? null;
  const minimumIsHard = salaryPreference?.minimumIsHard ?? false;

  if (!compensation || !compensation.stated) {
    return compensationAssessmentSchema.parse({
      verdict: 'unknown',
      stated: false,
      candidateMinimum,
      candidateTarget,
      belowHardMinimum: false,
      explanation:
        'This posting does not state a salary. That is not a signal about the pay — most postings are silent — ' +
        'it just means this cannot be judged until you ask.',
      confidence: 0,
    });
  }

  /*
   * Annualising.
   *
   * Prefer the conversion the enrichment layer already did, which carries the
   * exchange rate and its timestamp. Fall back to the raw numbers only when the
   * currency is already USD — inventing a rate here would produce a figure
   * nobody could reproduce.
   */
  const converted = compensation.conversion !== null;
  let annualUsd = compensation.conversion?.annualUsd ?? null;

  if (annualUsd === null && compensation.currency === 'USD') {
    const factor = PERIOD_TO_ANNUAL[compensation.period ?? 'year'] ?? 1;
    const midpoint =
      compensation.minimum !== null && compensation.maximum !== null
        ? (compensation.minimum + compensation.maximum) / 2
        : (compensation.maximum ?? compensation.minimum);

    annualUsd = midpoint === null ? null : midpoint * factor;
  }

  const parts: string[] = [];

  const range =
    compensation.minimum !== null && compensation.maximum !== null
      ? `${compensation.minimum.toLocaleString()}–${compensation.maximum.toLocaleString()}`
      : compensation.maximum !== null
        ? `up to ${compensation.maximum.toLocaleString()}`
        : compensation.minimum !== null
          ? `from ${compensation.minimum.toLocaleString()}`
          : null;

  if (range) {
    parts.push(
      `States ${range} ${compensation.currency ?? ''} per ${compensation.period ?? 'year'}`.trim() + '.',
    );
  }

  if (compensation.components.length > 0) {
    parts.push(`Also mentions ${compensation.components.join(', ')}.`);
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  let verdict: SalaryVerdict = 'unknown';
  let belowHardMinimum = false;

  const implausible = annualUsd !== null && annualUsd < IMPLAUSIBLE_ANNUAL_USD;

  if (implausible) {
    parts.push(
      'That figure is too low to be a real annual salary, so it is more likely the posting was ' +
        'misread than that the job pays it. Treated as unstated.',
    );

    return compensationAssessmentSchema.parse({
      verdict: 'unknown',
      stated: true,
      minimum: compensation.minimum,
      maximum: compensation.maximum,
      currency: compensation.currency,
      period: compensation.period,
      annualUsd,
      converted,
      components: compensation.components.slice(0, 10),
      candidateMinimum,
      candidateTarget,
      belowHardMinimum: false,
      explanation: parts.join(' ').slice(0, 400),
      confidence: 0,
    });
  }

  if (annualUsd === null || candidateMinimum === null) {
    verdict = 'unknown';
    parts.push(
      annualUsd === null
        ? 'It could not be converted to a comparable annual figure.'
        : 'You have not set a salary expectation, so there is nothing to compare against.',
    );
  } else {
    const ideal = salaryPreference?.ideal ?? null;
    const target = candidateTarget ?? candidateMinimum * 1.2;

    if (ideal !== null && annualUsd >= ideal) {
      verdict = 'excellent';
      parts.push('That is at or above the figure you called ideal.');
    } else if (annualUsd >= target) {
      verdict = 'good';
      parts.push('That is at or above your target.');
    } else if (annualUsd >= candidateMinimum) {
      verdict = 'acceptable';
      parts.push('That clears your minimum but sits below your target.');
    } else {
      verdict = 'below_preference';
      belowHardMinimum = minimumIsHard;

      parts.push(
        minimumIsHard
          ? 'That is below the minimum you marked as non-negotiable.'
          : 'That is below your stated minimum. You did not mark it as a hard limit, so this is worth knowing rather than disqualifying.',
      );
    }
  }

  /*
   * A one-sided range is weaker evidence than a two-sided one.
   *
   * "Up to $180k" is a ceiling almost nobody reaches, and treating it as the
   * offer would systematically overstate what these jobs pay.
   */
  let confidence = compensation.confidence;
  if (compensation.isOpenEnded) {
    confidence *= 0.6;
    parts.push('Only one end of the range is given, so the real figure is uncertain.');
  }
  if (compensation.isEstimated) {
    confidence *= 0.7;
    parts.push('The figure is an estimate rather than a stated range.');
  }
  if (converted) {
    parts.push(`Converted to USD at the rate recorded when the job was enriched.`);
  }

  return compensationAssessmentSchema.parse({
    verdict,
    stated: true,
    minimum: compensation.minimum,
    maximum: compensation.maximum,
    currency: compensation.currency,
    period: compensation.period,
    annualUsd,
    converted,
    components: compensation.components.slice(0, 10),
    candidateMinimum,
    candidateTarget,
    belowHardMinimum,
    explanation: parts.join(' ').slice(0, 400),
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100,
  });
}

/** 0–100 for the value score. Unknown pay scores neutrally, never zero. */
export function compensationScore(assessment: CompensationAssessment): {
  score: number;
  applicable: boolean;
} {
  switch (assessment.verdict) {
    case 'excellent':
      return { score: 100, applicable: true };
    case 'good':
      return { score: 82, applicable: true };
    case 'acceptable':
      return { score: 62, applicable: true };
    case 'below_preference':
      return { score: 28, applicable: true };
    default:
      // Excluded from the aggregate rather than scored as mediocre.
      return { score: 50, applicable: false };
  }
}
