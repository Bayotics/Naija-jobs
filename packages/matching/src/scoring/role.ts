import type { ComponentScore } from '@job-intel/contracts';
import type { ScorerInput } from '../types';
import {
  bestPreference,
  findPreferenceLoose,
  notApplicable,
  score,
  strengthToScore,
  tokenize,
  tokenOverlap,
  worstPreference,
} from './util';

/**
 * Role-shaped dimensions: title, industry, employment type, company.
 *
 * All four compare a posting attribute against a list of weighted preferences,
 * and all four share one rule: **the candidate's most negative reaction wins.**
 * A job that is both in a preferred industry and at an excluded company is not
 * an average of the two — the exclusion is the salient fact.
 */

// ── Title ───────────────────────────────────────────────────────────────────

/** Below this overlap the titles are simply different jobs. */
const TITLE_FLOOR = 0.15;

export function scoreTitle(input: ScorerInput): ComponentScore {
  const stated = input.candidate.preferences.titles;
  const normalized = input.job.enrichment.normalizedTitle || input.job.title;

  // Fall back to the candidate's *current* title when they have set no targets.
  //
  // Found in a live run over 331 real postings: a candidate with an untouched
  // preference set had no applicable title dimension, so a Laundry Attendant
  // and a Pastry Chef scored 89 for a software engineer purely on experience
  // and seniority. Their recorded current title is a stated fact about them,
  // not an inferred preference, and using it as a weak signal is far closer to
  // the truth than declaring role fit unknowable.
  const current = input.candidate.profile.professional.currentTitle;
  const wanted =
    stated.length > 0
      ? stated
      : current
        ? [
            {
              value: current,
              strength: 'preferred' as const,
              hard: false,
              note: null,
              source: 'explicit' as const,
            },
          ]
        : [];

  if (wanted.length === 0) {
    return notApplicable('title', 'No target job titles set and no current title recorded');
  }

  // Substring first: "Senior Frontend Engineer" contains "frontend engineer",
  // and token overlap alone would dilute that to a middling number because of
  // the extra word.
  const usingCurrentTitle = stated.length === 0;
  const describe = (value: string) =>
    usingCurrentTitle ? `your current title "${value}"` : `your target title "${value}"`;

  const contained = findPreferenceLoose(wanted, normalized);
  if (contained) {
    return score(
      'title',
      strengthToScore(contained.strength),
      input.job.enrichment.titleConfidence,
      `"${normalized}" matches ${describe(contained.value)}`,
      [normalized],
    );
  }

  const jobTokens = tokenize(normalized);
  let best = { overlap: 0, value: '' };
  for (const preference of wanted) {
    const overlap = tokenOverlap(jobTokens, tokenize(preference.value));
    if (overlap > best.overlap) best = { overlap, value: preference.value };
  }

  if (best.overlap < TITLE_FLOOR) {
    return score(
      'title',
      10,
      input.job.enrichment.titleConfidence,
      usingCurrentTitle
        ? `"${normalized}" is a different kind of role from your current "${current}"`
        : `"${normalized}" does not resemble any of your target titles`,
      [normalized],
    );
  }

  return score(
    'title',
    best.overlap * 100,
    input.job.enrichment.titleConfidence,
    `"${normalized}" partially overlaps ${describe(best.value)}`,
    [normalized],
  );
}

// ── Industry ────────────────────────────────────────────────────────────────

export function scoreIndustry(input: ScorerInput): ComponentScore {
  const wanted = input.candidate.preferences.industries;
  const industries = input.job.enrichment.classification.industries;

  if (wanted.length === 0) return notApplicable('industry', 'No industry preference set');
  if (industries.length === 0) {
    return notApplicable('industry', 'Posting does not identify an industry');
  }

  const confidence = input.job.enrichment.classification.industryConfidence;
  const negative = worstPreference(wanted, industries);
  if (negative) {
    return score(
      'industry',
      strengthToScore(negative.preference.strength),
      confidence,
      `Industry "${negative.matched}" is one you marked ${negative.preference.strength}`,
      industries,
    );
  }

  const positive = bestPreference(wanted, industries);
  if (positive) {
    return score(
      'industry',
      strengthToScore(positive.preference.strength),
      confidence,
      `Industry "${positive.matched}" is one you marked ${positive.preference.strength}`,
      industries,
    );
  }

  // Listed preferences with no match: mildly negative, not neutral. The
  // candidate did express an interest and this is not it.
  return score('industry', 40, confidence, `Industry ${industries.join(', ')} is not on your list`, industries);
}

// ── Employment type ─────────────────────────────────────────────────────────

export function scoreEmploymentType(input: ScorerInput): ComponentScore {
  const wanted = input.candidate.preferences.employmentTypes;
  const types = input.job.enrichment.employmentTypes;

  if (wanted.length === 0) return notApplicable('employmentType', 'No employment-type preference set');
  if (types.length === 0) return notApplicable('employmentType', 'Posting does not state an employment type');

  const negative = worstPreference(wanted, types);
  if (negative) {
    return score(
      'employmentType',
      strengthToScore(negative.preference.strength),
      0.8,
      `${negative.matched.replace('_', ' ')} is an employment type you marked ${negative.preference.strength}`,
      types,
    );
  }

  const positive = bestPreference(wanted, types);
  if (positive) {
    return score(
      'employmentType',
      strengthToScore(positive.preference.strength),
      0.8,
      `${positive.matched.replace('_', ' ')} matches your preferred employment type`,
      types,
    );
  }

  return score(
    'employmentType',
    35,
    0.8,
    `${types.map((t) => t.replace('_', ' ')).join(', ')} is not among your preferred employment types`,
    types,
  );
}

// ── Company ─────────────────────────────────────────────────────────────────

export function scoreCompany(input: ScorerInput): ComponentScore {
  const wanted = input.candidate.preferences.companies;
  const name = input.job.companyName;

  if (wanted.length === 0) return notApplicable('company', 'No company preference set');
  if (!name) return notApplicable('company', 'Posting does not name a company');

  const match = findPreferenceLoose(wanted, name);
  if (!match) {
    // Absence from a preference list is not an opinion about the company —
    // most employers are simply unknown to the candidate.
    return score('company', 50, 0.9, `${name} is not on your company list`, [name]);
  }

  return score(
    'company',
    strengthToScore(match.strength),
    0.9,
    `${name} is a company you marked ${match.strength}`,
    [name],
  );
}
