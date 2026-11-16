import type { ComponentScore, EducationLevel, SeniorityLevel } from '@job-intel/contracts';
import type { ScorerInput } from '../types';
import { clamp, notApplicable, score } from './util';

/**
 * Experience, seniority and education.
 *
 * The shared theme is that all three are *ladders with two directions of
 * error*. Being under the bar and being far over it are both mismatches, and a
 * scorer that only penalises the former will happily recommend a principal
 * engineer an internship.
 */

// ── Experience ──────────────────────────────────────────────────────────────

/** Points lost per year short of the stated minimum. */
const SHORTFALL_PENALTY = 20;
/** Points lost per year beyond the stated maximum. */
const OVERSHOOT_PENALTY = 8;
/** Overqualification is a caveat, not a disqualification, so it has a floor. */
const OVERSHOOT_FLOOR = 45;

export function scoreExperience(input: ScorerInput): ComponentScore {
  const requirement = input.job.enrichment.experience;
  const years = input.candidate.profile.professional.yearsOfExperience;

  if (years === undefined) {
    return notApplicable('experience', 'Your years of experience are not recorded');
  }
  if (requirement.minimumYears === null && requirement.maximumYears === null) {
    return notApplicable(
      'experience',
      requirement.qualitativeOnly
        ? 'Posting describes experience only qualitatively'
        : 'Posting states no experience requirement',
    );
  }

  const minimum = requirement.minimumYears;
  const maximum = requirement.maximumYears;

  if (minimum !== null && years < minimum) {
    const shortfall = minimum - years;
    return score(
      'experience',
      100 - shortfall * SHORTFALL_PENALTY,
      requirement.confidence,
      `You have ${years} years against a stated minimum of ${minimum}` +
        (shortfall <= 1 ? ' — within the usual margin' : ''),
      [requirement.rawText ?? `minimum ${minimum} years`],
    );
  }

  if (maximum !== null && years > maximum) {
    const overshoot = years - maximum;
    return score(
      'experience',
      clamp(100 - overshoot * OVERSHOOT_PENALTY, OVERSHOOT_FLOOR),
      requirement.confidence,
      `You have ${years} years against a stated ceiling of ${maximum} — you may be over-qualified`,
      [requirement.rawText ?? `maximum ${maximum} years`],
    );
  }

  return score(
    'experience',
    100,
    requirement.confidence,
    minimum === null
      ? `Your ${years} years sit within the stated range`
      : `You meet the ${minimum}-year minimum with ${years} years`,
    [requirement.rawText ?? `minimum ${minimum ?? 0} years`],
  );
}

// ── Seniority ───────────────────────────────────────────────────────────────

/**
 * Seniority as an ordinal.
 *
 * Deliberately *not* derived from the order of `SENIORITY_LEVELS`: that tuple
 * mixes an individual-contributor ladder with a management one, so its index is
 * not a rank. Placing lead/manager alongside staff/principal reflects that
 * moving between the two tracks is a sideways step, not a promotion.
 */
const SENIORITY_RANK: Readonly<Record<SeniorityLevel, number>> = {
  intern: 0,
  entry: 1,
  junior: 2,
  mid: 3,
  senior: 4,
  staff: 5,
  lead: 5,
  principal: 6,
  manager: 6,
  director: 7,
  executive: 8,
};

/** Points lost per rung of distance. */
const SENIORITY_STEP_PENALTY = 22;

export function scoreSeniority(input: ScorerInput): ComponentScore {
  const jobLevel = input.job.enrichment.seniority;
  const wanted = input.candidate.preferences.seniorityLevels;
  const own = input.candidate.profile.professional.seniority;

  if (jobLevel === null) {
    return notApplicable('seniority', 'Posting does not state a seniority level');
  }
  if (wanted.length === 0 && own === undefined) {
    return notApplicable('seniority', 'No seniority preference or current level recorded');
  }

  const confidence = input.job.enrichment.seniorityConfidence;
  const jobRank = SENIORITY_RANK[jobLevel];

  // An explicit preference outranks the candidate's current level: wanting a
  // step up is exactly the kind of intent that must not be second-guessed.
  if (wanted.length > 0) {
    if (wanted.includes(jobLevel)) {
      return score('seniority', 100, confidence, `${jobLevel} matches a level you are targeting`, [
        jobLevel,
      ]);
    }
    const nearest = Math.min(...wanted.map((level) => Math.abs(SENIORITY_RANK[level] - jobRank)));
    return score(
      'seniority',
      100 - nearest * SENIORITY_STEP_PENALTY,
      confidence,
      `${jobLevel} is ${nearest} level(s) from your target of ${wanted.join(', ')}`,
      [jobLevel],
    );
  }

  const ownRank = SENIORITY_RANK[own as SeniorityLevel];
  const distance = jobRank - ownRank;
  if (distance === 0) {
    return score('seniority', 100, confidence, `${jobLevel} matches your current level`, [jobLevel]);
  }
  // One rung up is aspirational and normal; a drop is a step backwards.
  const penalty = distance > 0 ? Math.max(0, distance - 1) * SENIORITY_STEP_PENALTY : Math.abs(distance) * SENIORITY_STEP_PENALTY;
  return score(
    'seniority',
    100 - penalty,
    confidence,
    distance > 0
      ? `${jobLevel} is ${distance} level(s) above your current ${own}`
      : `${jobLevel} is ${Math.abs(distance)} level(s) below your current ${own}`,
    [jobLevel],
  );
}

// ── Education ───────────────────────────────────────────────────────────────

const EDUCATION_RANK: Readonly<Record<EducationLevel, number>> = {
  none: 0,
  high_school: 1,
  diploma: 2,
  bachelors: 3,
  masters: 4,
  doctorate: 5,
};

export function scoreEducation(input: ScorerInput): ComponentScore {
  const requirement = input.job.enrichment.education;
  const highest = input.candidate.profile.professional.highestEducationLevel;

  if (requirement.level === null || requirement.requirement === 'not_specified') {
    return notApplicable('education', 'Posting states no education requirement');
  }
  if (highest === undefined) {
    return notApplicable('education', 'Your education level is not recorded');
  }

  const gap = EDUCATION_RANK[requirement.level] - EDUCATION_RANK[highest];
  if (gap <= 0) {
    return score(
      'education',
      100,
      requirement.confidence,
      `Your ${highest} meets the ${requirement.level} requirement`,
      [requirement.evidence ?? requirement.level],
    );
  }

  // A "preferred" degree the candidate lacks is a soft signal; a "required" one
  // is a real obstacle — but still not an eligibility rule, because employers
  // routinely waive it and only the candidate can decide to apply anyway.
  const perLevel = requirement.requirement === 'required' ? 35 : 15;
  return score(
    'education',
    100 - gap * perLevel,
    requirement.confidence,
    `Posting ${requirement.requirement === 'required' ? 'requires' : 'prefers'} ` +
      `${requirement.level}; your highest recorded is ${highest}`,
    [requirement.evidence ?? requirement.level],
  );
}
