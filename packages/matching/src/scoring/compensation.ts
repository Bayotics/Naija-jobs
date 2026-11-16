import type { ComponentScore } from '@job-intel/contracts';
import { annualUsdAmount } from '@job-intel/core';
import type { ScorerInput } from '../types';
import { clamp, notApplicable, score } from './util';

/**
 * Money and the right to work.
 *
 * Both dimensions share the property that made them worth grouping: **the
 * common case is silence.** Most postings state no salary and say nothing about
 * sponsorship, and the honest answer there is "not applicable", not zero. The
 * live corpus bears this out — 202 of 210 enriched jobs said nothing at all
 * about visas — so a scorer that treated silence as refusal would suppress
 * almost every job in the system.
 */

// ── Salary ──────────────────────────────────────────────────────────────────

/** Score awarded when pay lands exactly on the candidate's minimum. */
const AT_MINIMUM = 55;
/** Score awarded at the stated target. */
const AT_TARGET = 90;

export function scoreSalary(input: ScorerInput): ComponentScore {
  const preference = input.candidate.preferences.salary;
  const compensation = input.job.enrichment.compensation;

  if (preference.minimum === null && preference.target === null && preference.ideal === null) {
    return notApplicable('salary', 'No salary expectation set');
  }
  if (!compensation.stated || compensation.conversion === null) {
    return notApplicable('salary', 'Posting states no salary');
  }

  const jobAnnualUsd = compensation.conversion.annualUsd;
  const minimum = annualUsdAmount(preference.minimum, preference.currency, preference.period);
  const target = annualUsdAmount(preference.target, preference.currency, preference.period);
  const ideal = annualUsdAmount(preference.ideal, preference.currency, preference.period);

  if (minimum === null && target === null && ideal === null) {
    // The currency has no rate. Refusing to guess beats inventing a comparison.
    return notApplicable(
      'salary',
      `No exchange rate available for ${preference.currency}; salary not compared`,
    );
  }

  const stated = compensation.rawText ?? `${jobAnnualUsd.toLocaleString()} USD/yr equivalent`;
  const evidence = [stated];
  // A range's floor is what the candidate is likely to be offered; scoring the
  // ceiling would flatter every wide band.
  const confidence = compensation.confidence * (compensation.isEstimated ? 0.7 : 1);

  if (minimum !== null && jobAnnualUsd < minimum) {
    // Eligibility already ran. Reaching here means the shortfall is tolerated,
    // so it costs points proportionally rather than excluding the job.
    const ratio = jobAnnualUsd / minimum;
    return score(
      'salary',
      clamp(ratio * AT_MINIMUM),
      confidence,
      `Pays about $${jobAnnualUsd.toLocaleString()}/yr, below your ` +
        `${preference.minimum?.toLocaleString()} ${preference.currency}/${preference.period} minimum`,
      evidence,
    );
  }

  const upper = ideal ?? target;
  if (upper !== null && upper > 0) {
    const floor = minimum ?? upper * 0.7;
    if (jobAnnualUsd >= upper) {
      // Above the target is good but not unboundedly better — 20% over ideal is
      // not twice as good as meeting it.
      const excess = Math.min(1, (jobAnnualUsd - upper) / Math.max(1, upper * 0.5));
      return score(
        'salary',
        AT_TARGET + excess * (100 - AT_TARGET),
        confidence,
        `Pays about $${jobAnnualUsd.toLocaleString()}/yr, at or above your target`,
        evidence,
      );
    }
    const progress = (jobAnnualUsd - floor) / Math.max(1, upper - floor);
    return score(
      'salary',
      AT_MINIMUM + clamp(progress, 0, 1) * (AT_TARGET - AT_MINIMUM),
      confidence,
      `Pays about $${jobAnnualUsd.toLocaleString()}/yr against your target of ` +
        `${(preference.ideal ?? preference.target)?.toLocaleString()} ${preference.currency}`,
      evidence,
    );
  }

  return score(
    'salary',
    AT_TARGET,
    confidence,
    `Pays about $${jobAnnualUsd.toLocaleString()}/yr, meeting your minimum`,
    evidence,
  );
}

// ── Visa ────────────────────────────────────────────────────────────────────

export function scoreVisa(input: ScorerInput): ComponentScore {
  const preference = input.candidate.preferences.workAuthorization;
  const authorization = input.job.enrichment.workAuthorization;
  const sponsorship = authorization.sponsorship;
  const confidence = authorization.sponsorshipConfidence;
  const evidence = [authorization.sponsorshipEvidence ?? `sponsorship: ${sponsorship}`];

  if (preference.sponsorshipRequirement === 'irrelevant') {
    return notApplicable('visa', 'Sponsorship is not a factor for you');
  }

  if (preference.sponsorshipRequirement === 'not_needed') {
    // Only an explicit refusal matters here, and only mildly: it says something
    // about the employer's willingness to hire internationally later.
    if (sponsorship === 'not_offered') {
      return score('visa', 70, confidence, 'Employer does not sponsor, which you do not need', evidence);
    }
    return notApplicable('visa', 'You do not need sponsorship');
  }

  switch (sponsorship) {
    case 'offered':
      return score('visa', 100, confidence, 'Employer explicitly offers visa sponsorship', evidence);
    case 'not_offered':
      // Eligibility already ran; reaching here means the candidate only
      // *prefers* sponsorship, so this is a serious minus, not a veto.
      return score('visa', 5, confidence, 'Employer explicitly states sponsorship is unavailable', evidence);
    case 'unclear':
      return score('visa', 45, confidence * 0.6, 'Sponsorship is mentioned but ambiguous', evidence);
    default:
      // `not_mentioned` is genuinely unknown. Scored mid-range with low
      // confidence, never as a refusal — conflating the two would be wrong
      // about the overwhelming majority of postings.
      return score(
        'visa',
        50,
        Math.min(confidence, 0.25),
        'Posting does not mention sponsorship',
        evidence,
      );
  }
}
