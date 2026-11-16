import {
  dimensionScoreSchema,
  locationAssessmentSchema,
  type CandidateEvaluation,
  type CandidatePreferences,
  type DimensionScore,
  type JobEnrichment,
  type LearnedSignal,
  type LocationAssessment,
} from '@job-intel/contracts';

/**
 * Preference and behavioural alignment.
 *
 * The authority rule from prompt 11 applies here without exception, and this is
 * the layer where breaking it would do the most damage: a recommendation to
 * apply is an ask for an hour of someone's evening, and one produced by
 * overriding what they explicitly said is worse than no recommendation.
 *
 * So the arithmetic is deliberately asymmetric. Explicit preferences set the
 * score. Behavioural signals may nudge it, bounded, and only in the direction
 * the explicit preference already permits. Where the two disagree, the explicit
 * one wins and the disagreement is *reported* rather than averaged away.
 */

/** Maximum points behaviour may move preference alignment, in either direction. */
const MAX_BEHAVIOURAL_NUDGE = 6;

export interface PreferenceInput {
  preferences: CandidatePreferences | null;
  /** The constraint evaluation from the matching layer, already computed. */
  evaluation: CandidateEvaluation | null;
  learnedSignals: readonly LearnedSignal[];
  enrichment: JobEnrichment | null;
}

/**
 * Location, read carefully.
 *
 * "Remote" is not one thing. A posting that says "Remote (US only)" and one
 * that says "Remote worldwide" are different opportunities, and collapsing both
 * to `remote` is how a candidate in Lagos gets recommended a job they cannot
 * legally hold. `remoteWorldwide` is set only when the posting actually says
 * so.
 */
export function analyseLocation(input: {
  enrichment: JobEnrichment | null;
  preferences: CandidatePreferences | null;
}): LocationAssessment {
  const enrichment = input.enrichment;

  if (!enrichment) {
    return locationAssessmentSchema.parse({
      support: 'UNKNOWN',
      explanation: 'The posting has not been enriched, so its location terms are unknown.',
    });
  }

  const arrangement = enrichment.workArrangement;
  const location = enrichment.location;

  /*
   * The enrichment layer stores country codes and region names in one list,
   * because postings mix them freely ("Remote — EU, UK, CH"). They are split
   * apart here: a two-letter code can be checked mechanically against where the
   * candidate may work, and a region name cannot.
   */
  const restrictions = arrangement.remoteRegions ?? [];
  const remoteCountries = restrictions.filter((entry) => /^[A-Za-z]{2}$/.test(entry)).slice(0, 40);
  const remoteRegions = restrictions.filter((entry) => !/^[A-Za-z]{2}$/.test(entry)).slice(0, 20);
  const worldwide = arrangement.remoteWorldwide === true;

  const preferences = input.preferences;
  const parts: string[] = [];
  let support: LocationAssessment['support'] = 'UNKNOWN';

  const mode = arrangement.mode ?? null;

  if (mode) parts.push(`This is a ${mode.replace(/_/g, ' ')} role.`);

  if (mode === 'remote') {
    if (worldwide) {
      parts.push('It is open to candidates anywhere.');
      support = 'SUPPORTED';
    } else if (remoteCountries.length > 0 || remoteRegions.length > 0) {
      const where = [...remoteCountries, ...remoteRegions].slice(0, 6).join(', ');
      parts.push(`Remote, but restricted to ${where}.`);

      const authorised = preferences?.workAuthorization.authorizedCountries ?? [];
      const countryPreferences = (preferences?.countries ?? [])
        .filter((entry) => entry.strength !== 'excluded')
        .map((entry) => entry.value.toUpperCase());

      const eligible = [...authorised, ...countryPreferences];

      if (eligible.length === 0) {
        support = 'UNKNOWN';
        parts.push('Your profile does not say where you can work from, so this cannot be checked.');
      } else if (remoteCountries.some((code) => eligible.includes(code.toUpperCase()))) {
        support = 'SUPPORTED';
        parts.push('That includes somewhere you can work from.');
      } else if (remoteRegions.length > 0 && remoteCountries.length === 0) {
        // A region without a country list cannot be checked mechanically.
        support = 'UNKNOWN';
        parts.push('The region given cannot be checked against your locations automatically.');
      } else {
        support = 'NOT_SUPPORTED';
        parts.push('None of the countries listed match where you can work from.');
      }
    } else {
      support = 'UNKNOWN';
      parts.push('It does not say which countries it will hire remotely from.');
    }
  } else if (mode === 'hybrid' || mode === 'onsite') {
    const city = location.city ?? null;
    const country = location.countryCode ?? null;

    if (city || country) parts.push(`Based in ${[city, country].filter(Boolean).join(', ')}.`);

    const wantedCities = (preferences?.cities ?? [])
      .filter((entry) => entry.strength !== 'excluded')
      .map((entry) => entry.value.toLowerCase());
    const wantedCountries = (preferences?.countries ?? [])
      .filter((entry) => entry.strength !== 'excluded')
      .map((entry) => entry.value.toUpperCase());

    if (wantedCities.length === 0 && wantedCountries.length === 0) {
      support = 'UNKNOWN';
    } else if (
      (city && wantedCities.includes(city.toLowerCase())) ||
      (country && wantedCountries.includes(country.toUpperCase()))
    ) {
      support = 'SUPPORTED';
    } else if (preferences?.workAuthorization.willingToRelocate) {
      support = 'UNKNOWN';
      parts.push('It is outside your stated locations, but you are open to relocating.');
    } else {
      support = 'NOT_SUPPORTED';
      parts.push('It is outside the locations you said you would work in.');
    }

    if (mode === 'hybrid' && arrangement.officeDaysPerWeek !== null) {
      const days = arrangement.officeDaysPerWeek;
      parts.push(`${days} day${days === 1 ? '' : 's'} a week in the office.`);

      const maxDays = preferences?.maxOfficeDaysPerWeek ?? null;
      if (maxDays !== null && days > maxDays) {
        support = 'NOT_SUPPORTED';
        parts.push(`You said at most ${maxDays}.`);
      }
    }
  }

  return locationAssessmentSchema.parse({
    arrangement: mode,
    remoteCountries,
    remoteRegions,
    remoteWorldwide: worldwide,
    city: location.city,
    countryCode: location.countryCode,
    officeDaysPerWeek: arrangement.officeDaysPerWeek ?? null,
    support,
    explanation: parts.join(' '),
  });
}

/**
 * Scores how well the job matches what the candidate said they want.
 *
 * Built on the existing constraint evaluation rather than re-deriving it: that
 * evaluator is where hard constraints are enforced in code, and having two
 * implementations of "does this violate a preference" is how they drift apart.
 */
export function scorePreferenceAlignment(input: PreferenceInput): DimensionScore {
  const { evaluation } = input;

  if (!evaluation) {
    return dimensionScoreSchema.parse({
      dimension: 'preferenceAlignment',
      score: 50,
      confidence: 0,
      applicable: false,
      inapplicableReason: 'No preference evaluation was available for this job.',
      explanation: 'Your preferences could not be checked against this posting.',
      evidence: [],
    });
  }

  const applicable = evaluation.outcomes.filter((outcome) => !outcome.skipped);
  const skipped = evaluation.outcomes.filter((outcome) => outcome.skipped);

  // The evaluator already produced a 0–100 soft score from explicit preferences.
  let score = evaluation.softScore;
  const evidence: string[] = [];
  const parts: string[] = [];

  const matched = applicable.filter((outcome) => outcome.score > 0.2);
  const missed = applicable.filter((outcome) => outcome.score < -0.2);

  if (matched.length > 0) {
    parts.push(`Matches your stated preferences on ${matched.map((o) => o.dimension).join(', ')}.`);
    evidence.push(...matched.slice(0, 4).map((o) => o.explanation));
  }

  if (missed.length > 0) {
    parts.push(`Does not match on ${missed.map((o) => o.dimension).join(', ')}.`);
    evidence.push(...missed.slice(0, 4).map((o) => o.explanation));
  }

  if (skipped.length > 0) {
    // Silence in the posting, not a mismatch. Named so the reader knows the
    // score rests on less than it looks like.
    parts.push(
      `The posting says nothing about ${skipped.map((o) => o.dimension).slice(0, 4).join(', ')}, so those were not scored.`,
    );
  }

  /*
   * The behavioural nudge.
   *
   * Applied only where behaviour agrees with, or is silent on, an explicit
   * position — and capped hard. Where they conflict the nudge is dropped
   * entirely and the conflict is surfaced, because the alternative is a system
   * that quietly re-weights someone's stated requirements based on what they
   * clicked.
   */
  let nudge = 0;
  const conflicts: string[] = [];

  for (const signal of input.learnedSignals) {
    if (signal.conflictsWithExplicit) {
      conflicts.push(
        `Your activity suggests ${signal.value}, which differs from what you told us. Your stated preference is being used.`,
      );
      continue;
    }

    nudge += signal.affinity * signal.confidence * 2;
  }

  nudge = Math.max(-MAX_BEHAVIOURAL_NUDGE, Math.min(MAX_BEHAVIOURAL_NUDGE, nudge));
  score = Math.max(0, Math.min(100, score + nudge));

  if (nudge !== 0) {
    parts.push(
      `Your past activity ${nudge > 0 ? 'supports' : 'runs against'} this by ${Math.abs(nudge).toFixed(1)} points.`,
    );
  }

  parts.push(...conflicts);

  const confidence = Math.min(
    0.9,
    0.2 + (applicable.length / Math.max(1, evaluation.outcomes.length)) * 0.6,
  );

  return dimensionScoreSchema.parse({
    dimension: 'preferenceAlignment',
    score: Math.round(score),
    confidence: Math.round(confidence * 100) / 100,
    applicable: true,
    inapplicableReason: null,
    explanation: parts.join(' ') || 'No preference dimensions applied to this posting.',
    evidence: evidence.slice(0, 8),
  });
}
