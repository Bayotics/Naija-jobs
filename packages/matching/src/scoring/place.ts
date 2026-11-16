import type { ComponentScore, RemoteType, WorkArrangementPreference } from '@job-intel/contracts';
import type { ScorerInput } from '../types';
import { findPreference, notApplicable, score, strengthToScore } from './util';

/**
 * Where the work happens: location and work arrangement.
 *
 * Kept together because they interact — a fully-remote role with no geographic
 * restriction makes the location question largely moot, and scoring the two
 * independently would double-count the same fact.
 */

// ── Work arrangement ────────────────────────────────────────────────────────

/**
 * Preference × actual mode, as data.
 *
 * A table rather than a chain of conditionals so the asymmetries are visible:
 * someone who accepts on-site is usually still happy with remote, but someone
 * who prefers on-site is not automatically happy working alone from home.
 * `REMOTE_ONLY` is absent because it is an eligibility rule, decided by the
 * constraint stage; by the time this scorer runs it has already passed.
 */
const ARRANGEMENT_SCORES: Readonly<
  Record<WorkArrangementPreference, Readonly<Record<RemoteType, number>>>
> = {
  REMOTE_ONLY: { remote: 100, hybrid: 0, onsite: 0, unknown: 50 },
  REMOTE_PREFERRED: { remote: 100, hybrid: 55, onsite: 20, unknown: 50 },
  HYBRID_ACCEPTED: { remote: 90, hybrid: 100, onsite: 40, unknown: 50 },
  ONSITE_ACCEPTED: { remote: 70, hybrid: 85, onsite: 90, unknown: 50 },
  ONSITE_PREFERRED: { remote: 40, hybrid: 75, onsite: 100, unknown: 50 },
  ANY: { remote: 100, hybrid: 100, onsite: 100, unknown: 100 },
};

export function scoreWorkArrangement(input: ScorerInput): ComponentScore {
  const preference = input.candidate.preferences.workArrangement;
  const arrangement = input.job.enrichment.workArrangement;

  if (preference === 'ANY') {
    return notApplicable('workArrangement', 'No work-arrangement preference set');
  }
  if (arrangement.mode === 'unknown') {
    return notApplicable('workArrangement', 'Posting does not state a work arrangement');
  }

  let value = ARRANGEMENT_SCORES[preference][arrangement.mode];
  const evidence: string[] = [arrangement.mode];

  // Office cadence refines a hybrid role: three days in is a materially
  // different job from one, and the mode alone cannot express that.
  const limit = input.candidate.preferences.maxOfficeDaysPerWeek;
  const days = arrangement.officeDaysPerWeek;
  if (limit !== null && days !== null && arrangement.mode === 'hybrid') {
    evidence.push(`${days} office day(s)/week`);
    if (days < limit) value = Math.min(100, value + 10);
    else if (days === limit) value = Math.min(100, value + 5);
  }

  return score(
    'workArrangement',
    value,
    arrangement.confidence,
    `Role is ${arrangement.mode}; your preference is ${preference.toLowerCase().replace(/_/g, ' ')}`,
    evidence,
  );
}

// ── Location ────────────────────────────────────────────────────────────────

export function scoreLocation(input: ScorerInput): ComponentScore {
  const { countries, cities, regions } = input.candidate.preferences;
  const arrangement = input.job.enrichment.workArrangement;
  const location = input.job.enrichment.location;

  if (countries.length + cities.length + regions.length === 0) {
    return notApplicable('location', 'No location preference set');
  }

  // Remote with no restriction: the candidate's location list does not apply.
  if (arrangement.mode === 'remote' && arrangement.remoteWorldwide) {
    return score('location', 95, arrangement.confidence, 'Remote worldwide — no location restriction', [
      'worldwide',
    ]);
  }

  if (arrangement.mode === 'remote' && arrangement.remoteRegions.length > 0) {
    for (const region of arrangement.remoteRegions) {
      const match = findPreference(countries, region) ?? findPreference(regions, region);
      if (match) {
        return score(
          'location',
          strengthToScore(match.strength),
          arrangement.confidence,
          `Remote within ${match.value}, which you marked ${match.strength}`,
          arrangement.remoteRegions,
        );
      }
    }
    return score(
      'location',
      25,
      arrangement.confidence,
      `Remote but restricted to ${arrangement.remoteRegions.join(', ')}, none of which you listed`,
      arrangement.remoteRegions,
    );
  }

  if (location.countryCode === null && location.city === null) {
    return notApplicable('location', 'Posting does not state a location');
  }

  const evidence = [location.city, location.region, location.countryCode].filter(
    (v): v is string => Boolean(v),
  );

  // City beats country: it is the more specific statement of intent.
  const cityMatch = findPreference(cities, location.city);
  if (cityMatch) {
    return score(
      'location',
      strengthToScore(cityMatch.strength),
      location.confidence,
      `${cityMatch.value} is a city you marked ${cityMatch.strength}`,
      evidence,
    );
  }

  const countryMatch = findPreference(countries, location.countryCode);
  if (countryMatch) {
    return score(
      'location',
      strengthToScore(countryMatch.strength),
      location.confidence,
      `${countryMatch.value} is a country you marked ${countryMatch.strength}`,
      evidence,
    );
  }

  const regionMatch = findPreference(regions, location.region);
  if (regionMatch) {
    return score(
      'location',
      strengthToScore(regionMatch.strength),
      location.confidence,
      `${regionMatch.value} is a region you marked ${regionMatch.strength}`,
      evidence,
    );
  }

  return score(
    'location',
    20,
    location.confidence,
    `${evidence.join(', ')} is not among your preferred locations`,
    evidence,
  );
}
