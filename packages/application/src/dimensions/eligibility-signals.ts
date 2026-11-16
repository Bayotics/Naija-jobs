import {
  authorizationAssessmentSchema,
  languageAssessmentSchema,
  type AuthorizationAssessment,
  type CandidateIntelligence,
  type CandidatePreferences,
  type JobEnrichment,
  type LanguageAssessment,
  type ParsedRequirementRecord,
  type SupportState,
} from '@job-intel/contracts';

/**
 * Work authorisation and language.
 *
 * Two requirements that resumes are systematically bad at answering, and where
 * guessing does the most harm.
 *
 * Nobody writes "I am authorised to work in the EU" on a CV, so a resume that
 * is silent about work authorisation tells you nothing — and a system that
 * reads that silence as *not authorised* will filter someone out of their own
 * job market. The same goes for languages: a German speaker applying to a
 * German company routinely does not list German.
 *
 * So both resolve from *stated* candidate data — the work-authorisation
 * preferences and the language records the person entered — and fall back to
 * UNKNOWN, never to a failure.
 */

/** CEFR ladder, for comparing a stated level with a demanded one. */
const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

/** Free-text proficiency terms mapped onto the ladder. */
const PROFICIENCY_TO_CEFR: Readonly<Record<string, string>> = {
  NATIVE: 'C2',
  FLUENT: 'C1',
  PROFESSIONAL: 'B2',
  CONVERSATIONAL: 'B1',
  BASIC: 'A2',
  ELEMENTARY: 'A1',
};

const cefrIndex = (level: string | null): number =>
  level === null ? -1 : CEFR_ORDER.indexOf(level.toUpperCase() as (typeof CEFR_ORDER)[number]);

export interface AuthorizationInput {
  enrichment: JobEnrichment | null;
  preferences: CandidatePreferences | null;
  requirements: readonly ParsedRequirementRecord[];
}

export function analyseAuthorization(input: AuthorizationInput): AuthorizationAssessment {
  const authorization = input.enrichment?.workAuthorization ?? null;
  const candidate = input.preferences?.workAuthorization ?? null;

  const requirement = input.requirements.find(
    (entry) => entry.type === 'work_authorization',
  );

  const evidenceText =
    authorization?.workAuthorizationRequirement ?? requirement?.evidence ?? requirement?.text ?? null;

  /*
   * Sponsorship, as three states.
   *
   * The enrichment layer's vocabulary is finer than yes/no because postings are
   * — "case by case" and "not specified" are different from a flat no. Anything
   * that is not an affirmative offer or an explicit refusal lands on unknown,
   * because inventing sponsorship availability would send someone through a
   * whole application on a false premise.
   */
  const sponsorshipRaw = authorization?.sponsorship ?? null;
  const sponsorshipAvailable: AuthorizationAssessment['sponsorshipAvailable'] =
    sponsorshipRaw === 'offered'
      ? 'yes'
      : sponsorshipRaw === 'not_offered'
        ? 'no'
        : // `unclear` and `not_mentioned` both mean the posting did not commit.
          'unknown';

  const countryCode =
    input.enrichment?.location.countryCode ??
    (evidenceText ? countryFromText(evidenceText) : null);

  const authorizationRequired: AuthorizationAssessment['authorizationRequired'] =
    authorization?.citizenshipRequired === true || Boolean(authorization?.workAuthorizationRequirement)
      ? 'yes'
      : requirement
        ? 'yes'
        : 'unknown';

  // ── Where the candidate stands ──────────────────────────────────────────
  let candidateAuthorized: SupportState = 'UNKNOWN';
  let needsSponsorship: boolean | null = null;
  const parts: string[] = [];

  if (evidenceText) parts.push(`The posting says: "${evidenceText.slice(0, 200)}"`);

  if (candidate) {
    needsSponsorship = candidate.sponsorshipRequirement !== 'not_needed';

    if (countryCode) {
      const authorised = candidate.authorizedCountries.map((code) => code.toUpperCase());
      const citizenships = candidate.citizenships.map((code) => code.toUpperCase());
      const target = countryCode.toUpperCase();

      if (authorised.includes(target) || citizenships.includes(target)) {
        candidateAuthorized = 'SUPPORTED';
        parts.push(`You are authorised to work in ${target}.`);
      } else if (authorised.length > 0 || citizenships.length > 0) {
        /*
         * The candidate has told us where they can work, and this is not on
         * the list. That is a real negative — but only a blocker when the
         * posting also refuses sponsorship.
         */
        candidateAuthorized = 'NOT_SUPPORTED';
        parts.push(`You have not listed ${target} among the places you can work.`);

        if (sponsorshipAvailable === 'yes') {
          parts.push('The posting offers sponsorship, so this may still be workable.');
        } else if (sponsorshipAvailable === 'unknown') {
          parts.push('The posting does not say whether it sponsors, so this is worth asking about.');
        }
      } else {
        parts.push('Your profile does not list which countries you can work in.');
      }
    } else if (authorizationRequired === 'yes') {
      parts.push('The posting requires work authorisation but does not say where.');
    }
  } else {
    parts.push('Your work-authorisation preferences have not been set, so this cannot be checked.');
  }

  if (needsSponsorship && sponsorshipAvailable === 'no') {
    parts.push('You need sponsorship and this posting states it does not sponsor.');
  }

  return authorizationAssessmentSchema.parse({
    sponsorshipAvailable,
    authorizationRequired,
    countryCode,
    candidateAuthorized,
    candidateNeedsSponsorship: needsSponsorship,
    evidenceText: evidenceText === null ? null : evidenceText.slice(0, 400),
    explanation: (parts.join(' ') || 'Nothing in this posting addresses work authorisation.').slice(
      0,
      400,
    ),
    confidence: authorization?.sponsorshipConfidence ?? (requirement ? 0.5 : 0.1),
  });
}

/** Two-letter country from a phrase, where the phrase names one plainly. */
function countryFromText(text: string): string | null {
  const patterns: ReadonlyArray<[RegExp, string]> = [
    [/\b(united states|u\.?s\.?a?\b|usa)\b/i, 'US'],
    [/\b(united kingdom|u\.?k\.?\b|britain)\b/i, 'GB'],
    [/\bgermany|deutschland\b/i, 'DE'],
    [/\bcanada\b/i, 'CA'],
    [/\baustralia\b/i, 'AU'],
    [/\bnetherlands|holland\b/i, 'NL'],
    [/\bfrance\b/i, 'FR'],
    [/\bspain\b/i, 'ES'],
    [/\bireland\b/i, 'IE'],
    [/\bswitzerland\b/i, 'CH'],
    [/\bindia\b/i, 'IN'],
    [/\bsingapore\b/i, 'SG'],
  ];

  for (const [pattern, code] of patterns) {
    if (pattern.test(text)) return code;
  }
  return null;
}

// ── Languages (Part 19) ─────────────────────────────────────────────────────

export interface LanguageInput {
  requirements: readonly ParsedRequirementRecord[];
  profile: CandidateIntelligence | null;
}

export function analyseLanguages(input: LanguageInput): LanguageAssessment {
  const demands = input.requirements.filter((entry) => entry.type === 'language');

  if (demands.length === 0) {
    return languageAssessmentSchema.parse({
      requirements: [],
      explanation: 'This posting states no language requirement.',
    });
  }

  const spoken = new Map(
    (input.profile?.languages ?? []).map((record) => [record.language.toLowerCase(), record]),
  );

  const results = demands.slice(0, 10).map((demand) => {
    const language = (demand.matchedText ?? demand.text).toLowerCase();
    const record = [...spoken.entries()].find(([name]) => language.includes(name))?.[1] ?? null;

    const required = demand.importance === 'required';
    const demanded = demand.languageLevel;

    if (!record) {
      /*
       * The case the brief calls out by name: German C1 required, candidate's
       * German unknown. UNKNOWN, not FAIL. People routinely omit languages they
       * speak, especially the local one.
       */
      return {
        language: demand.matchedText ?? demand.text,
        level: demanded,
        required,
        candidateLevel: null,
        support: 'UNKNOWN' as SupportState,
        explanation: `Your profile does not record ${demand.matchedText ?? 'this language'}. That is not evidence you do not speak it — add it to your profile to resolve this.`,
      };
    }

    const stated =
      record.proficiency === 'UNKNOWN'
        ? null
        : (PROFICIENCY_TO_CEFR[record.proficiency] ?? record.proficiency);

    if (!demanded) {
      return {
        language: record.language,
        level: null,
        required,
        candidateLevel: stated,
        support: 'SUPPORTED' as SupportState,
        explanation: `You list ${record.language} and the posting does not state a level.`,
      };
    }

    if (!stated) {
      return {
        language: record.language,
        level: demanded,
        required,
        candidateLevel: null,
        support: 'UNKNOWN' as SupportState,
        explanation: `You list ${record.language} but not at what level, and the posting asks for ${demanded}.`,
      };
    }

    const have = cefrIndex(stated);
    const need = cefrIndex(demanded);

    if (have < 0 || need < 0) {
      return {
        language: record.language,
        level: demanded,
        required,
        candidateLevel: stated,
        support: 'UNKNOWN' as SupportState,
        explanation: `Your ${record.language} (${stated}) could not be compared with the ${demanded} asked for.`,
      };
    }

    if (have >= need) {
      return {
        language: record.language,
        level: demanded,
        required,
        candidateLevel: stated,
        support: 'SUPPORTED' as SupportState,
        explanation: `Your ${record.language} is ${stated}, at or above the ${demanded} asked for.`,
      };
    }

    // One level short is a partial, and the brief asks for it to read that way.
    const oneShort = need - have === 1;

    return {
      language: record.language,
      level: demanded,
      required,
      candidateLevel: stated,
      support: (oneShort ? 'UNKNOWN' : 'NOT_SUPPORTED') as SupportState,
      explanation: oneShort
        ? `Your ${record.language} is ${stated} and the posting asks for ${demanded} — one level short, which is often negotiable.`
        : `Your ${record.language} is ${stated}, below the ${demanded} asked for.`,
    };
  });

  const unmet = results.filter((entry) => entry.support === 'NOT_SUPPORTED' && entry.required);
  const unknown = results.filter((entry) => entry.support === 'UNKNOWN');

  const parts: string[] = [];
  if (unmet.length > 0) parts.push(`${unmet.length} required language level is not met.`);
  if (unknown.length > 0) parts.push(`${unknown.length} language requirement cannot be checked from your profile.`);
  if (parts.length === 0) parts.push('All stated language requirements are met.');

  return languageAssessmentSchema.parse({
    requirements: results,
    explanation: parts.join(' '),
  });
}
