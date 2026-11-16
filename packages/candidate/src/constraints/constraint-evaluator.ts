import {
  STRENGTH_SCORES,
  isHardStrength,
  type CandidateEvaluation,
  type CandidatePreferences,
  type ConstraintOutcome,
  type JobEnrichment,
  type WeightedPreference,
} from '@job-intel/contracts';
import { annualUsdAmount } from '@job-intel/core';

/**
 * Constraint evaluation.
 *
 * Reads a job's structured enrichment against the candidate's stored
 * preferences and produces (a) an eligibility verdict, (b) a soft score, and
 * (c) a plain-language explanation for every dimension — which is what makes
 * "why was this excluded?" answerable.
 *
 * There is not a single country, technology, salary figure or work arrangement
 * literal in this file. Every comparison is against a value loaded from the
 * candidate's preference payload. That is the property that makes preference
 * changes a database write rather than a code change.
 *
 * Two semantics that the rest of the system depends on:
 *
 *  - **A hard failure is absolute.** No amount of semantic similarity rescues a
 *    job that violates one. `eligible: false` and the soft score is zeroed.
 *  - **Missing data is not failure.** A posting that omits salary or says
 *    nothing about sponsorship is `skipped`, never `failed` — most postings
 *    omit both, and scoring silence as a violation discards the corpus.
 */

export interface EvaluationInput {
  preferences: CandidatePreferences;
  profileVersion: number;
  enrichment: JobEnrichment;
  /** Raw job fields the enrichment does not carry. */
  job: {
    title: string;
    companyName: string;
    description: string | null;
  };
}

/** Case-insensitive lookup of a preference entry by value. */
function findPreference(
  list: readonly WeightedPreference[],
  value: string | null | undefined,
): WeightedPreference | null {
  if (!value) return null;
  const needle = value.trim().toLowerCase();
  return list.find((p) => p.value.trim().toLowerCase() === needle) ?? null;
}

/** Substring match, for dimensions where postings phrase things loosely. */
function findPreferenceLoose(
  list: readonly WeightedPreference[],
  haystack: string,
): WeightedPreference | null {
  const text = haystack.toLowerCase();
  return list.find((p) => text.includes(p.value.trim().toLowerCase())) ?? null;
}

function outcome(
  dimension: string,
  kind: 'hard' | 'soft',
  passed: boolean,
  score: number,
  explanation: string,
  preferenceValue: string | null = null,
  skipped = false,
): ConstraintOutcome {
  return { dimension, kind, passed, skipped, score, explanation, preferenceValue };
}

/** A dimension the candidate expressed no opinion on. Neither pass nor fail. */
function neutral(dimension: string, explanation: string): ConstraintOutcome {
  return outcome(dimension, 'soft', true, 0, explanation, null, true);
}

export class ConstraintEvaluator {
  constructor(private readonly preferences: CandidatePreferences) {}

  evaluate(input: EvaluationInput): CandidateEvaluation {
    const outcomes: ConstraintOutcome[] = [
      this.evaluateWorkArrangement(input),
      this.evaluateOfficeDays(input),
      this.evaluateLocation(input),
      this.evaluateSalary(input),
      this.evaluateVisa(input),
      this.evaluateEmploymentType(input),
      this.evaluateTitle(input),
      this.evaluateTechnologies(input),
      this.evaluateIndustry(input),
      this.evaluateCompany(input),
      this.evaluateSeniority(input),
      this.evaluateKeywords(input),
    ];

    const hardFailures = outcomes.filter((o) => o.kind === 'hard' && !o.passed);
    const eligible = hardFailures.length === 0;

    return {
      eligible,
      hardFailures,
      outcomes,
      softScore: eligible ? this.softScore(outcomes) : 0,
      profileVersion: input.profileVersion,
    };
  }

  /**
   * Weighted average of the soft dimensions, mapped to 0-100.
   *
   * Skipped dimensions are excluded from both numerator and denominator so an
   * unanswerable dimension neither helps nor hurts — averaging a missing salary
   * in as zero would systematically punish postings that simply omit it.
   */
  private softScore(outcomes: ConstraintOutcome[]): number {
    const weights = this.preferences.weights;
    const weightFor: Record<string, number> = {
      work_arrangement: weights.workArrangement,
      office_days: weights.workArrangement,
      location: weights.location,
      salary: weights.salary,
      visa: weights.visa,
      employment_type: weights.experience,
      title: weights.titleMatch,
      technologies: weights.technicalSkills,
      industry: weights.industry,
      company: weights.companyPreference,
      seniority: weights.seniority,
      keywords: weights.technicalSkills,
    };

    let weighted = 0;
    let total = 0;
    for (const o of outcomes) {
      if (o.kind === 'hard' || o.skipped) continue;
      const weight = weightFor[o.dimension] ?? 0;
      if (weight <= 0) continue;
      weighted += weight * o.score;
      total += weight;
    }
    if (total === 0) return 50; // nothing to judge on: neither good nor bad
    // score is -1..1; map onto 0..100.
    return Math.round(((weighted / total + 1) / 2) * 100);
  }

  // ── Work arrangement ──────────────────────────────────────────────────────

  private evaluateWorkArrangement(input: EvaluationInput): ConstraintOutcome {
    const preference = this.preferences.workArrangement;
    const mode = input.enrichment.workArrangement.mode;

    if (preference === 'ANY') return neutral('work_arrangement', 'No work-arrangement preference set');
    if (mode === 'unknown') {
      return outcome(
        'work_arrangement',
        'soft',
        true,
        0,
        'Posting does not state a work arrangement',
        preference,
        true,
      );
    }

    // Only REMOTE_ONLY is absolute. The rest express ranking, not eligibility.
    if (preference === 'REMOTE_ONLY') {
      const passed = mode === 'remote';
      return outcome(
        'work_arrangement',
        'hard',
        passed,
        passed ? 1 : -1,
        passed
          ? 'Remote role, matching your remote-only requirement'
          : `Role is ${mode}, but you require remote-only`,
        preference,
      );
    }

    const scores: Record<string, Record<string, number>> = {
      REMOTE_PREFERRED: { remote: 1, hybrid: 0.2, onsite: -0.6 },
      HYBRID_ACCEPTED: { remote: 0.8, hybrid: 1, onsite: -0.2 },
      ONSITE_ACCEPTED: { remote: 0.4, hybrid: 0.7, onsite: 0.8 },
      ONSITE_PREFERRED: { remote: -0.2, hybrid: 0.5, onsite: 1 },
    };
    const score = scores[preference]?.[mode] ?? 0;
    return outcome(
      'work_arrangement',
      'soft',
      true,
      score,
      `Role is ${mode}; your preference is ${preference}`,
      preference,
    );
  }

  /** Hybrid cadence: a hard limit only when the candidate set one. */
  private evaluateOfficeDays(input: EvaluationInput): ConstraintOutcome {
    const max = this.preferences.maxOfficeDaysPerWeek;
    const days = input.enrichment.workArrangement.officeDaysPerWeek;

    if (max === null) return neutral('office_days', 'No office-days limit set');
    if (days === null) {
      return outcome('office_days', 'soft', true, 0, 'Posting does not state office days', String(max), true);
    }
    const passed = days <= max;
    return outcome(
      'office_days',
      'hard',
      passed,
      passed ? 1 : -1,
      passed
        ? `Requires ${days} office day(s), within your limit of ${max}`
        : `Requires ${days} office day(s) per week, above your limit of ${max}`,
      String(max),
    );
  }

  // ── Location ──────────────────────────────────────────────────────────────

  private evaluateLocation(input: EvaluationInput): ConstraintOutcome {
    const { countries, cities, regions } = this.preferences;
    const enrichment = input.enrichment;
    const country = enrichment.location.countryCode;
    const city = enrichment.location.city;

    if (countries.length === 0 && cities.length === 0 && regions.length === 0) {
      return neutral('location', 'No location preference set');
    }

    // A fully-remote role the candidate accepts is location-independent unless
    // the posting restricts the region.
    const isRemote = enrichment.workArrangement.mode === 'remote';
    const remoteRegions = enrichment.workArrangement.remoteRegions;
    if (isRemote && enrichment.workArrangement.remoteWorldwide) {
      return outcome('location', 'soft', true, 0.8, 'Remote worldwide — no location restriction', null);
    }
    if (isRemote && remoteRegions.length > 0) {
      const match = remoteRegions
        .map((region) => findPreference(countries, region) ?? findPreference(regions, region))
        .find((p): p is WeightedPreference => p !== null);
      if (match) {
        return this.strengthOutcome('location', match, `Remote within ${match.value}`);
      }
      const excluded = remoteRegions.some((r) => {
        const p = findPreference(countries, r) ?? findPreference(regions, r);
        return p?.strength === 'excluded';
      });
      if (excluded) {
        return outcome('location', 'hard', false, -1, `Remote restricted to an excluded region`, null);
      }
      return outcome(
        'location',
        'soft',
        true,
        -0.3,
        `Remote but restricted to ${remoteRegions.join(', ')}, none of which you listed`,
        null,
      );
    }

    const cityMatch = findPreference(cities, city);
    const countryMatch = findPreference(countries, country);
    const match = cityMatch ?? countryMatch;

    if (!match) {
      if (!country && !city) {
        return outcome('location', 'soft', true, 0, 'Posting does not state a location', null, true);
      }
      // A listed set with no match is a mild negative, not an exclusion —
      // unless the candidate made the list itself hard.
      const anyHard = [...countries, ...cities].some((p) => p.hard && p.strength === 'required');
      if (anyHard) {
        return outcome(
          'location',
          'hard',
          false,
          -1,
          `Location ${city ?? country} is not among your required locations`,
          null,
        );
      }
      return outcome(
        'location',
        'soft',
        true,
        -0.4,
        `Location ${[city, country].filter(Boolean).join(', ')} is not in your preferred list`,
        null,
      );
    }

    return this.strengthOutcome('location', match, `Location ${match.value}`);
  }

  // ── Salary ────────────────────────────────────────────────────────────────

  private evaluateSalary(input: EvaluationInput): ConstraintOutcome {
    const preference = this.preferences.salary;
    const compensation = input.enrichment.compensation;

    if (preference.minimum === null && preference.target === null) {
      return neutral('salary', 'No salary preference set');
    }

    if (!compensation.stated || compensation.conversion === null) {
      if (!preference.acceptUnstatedSalary) {
        return outcome(
          'salary',
          'hard',
          false,
          -1,
          'Posting states no salary and you require a stated salary',
          String(preference.minimum ?? ''),
        );
      }
      return outcome('salary', 'soft', true, 0, 'Posting states no salary', null, true);
    }

    // Compare in the candidate's currency via the annualised USD figure the
    // enrichment already computed, which carries its own rate provenance.
    const jobAnnualUsd = compensation.conversion.annualUsd;
    const minimumUsd = this.toAnnualUsd(preference.minimum, preference);
    const targetUsd = this.toAnnualUsd(preference.target, preference);

    if (minimumUsd !== null && jobAnnualUsd < minimumUsd) {
      const kind = preference.minimumIsHard ? 'hard' : 'soft';
      return outcome(
        'salary',
        kind,
        kind === 'soft',
        -1,
        `Pays about $${jobAnnualUsd.toLocaleString()}/yr, below your minimum of ` +
          `${preference.minimum?.toLocaleString()} ${preference.currency}/${preference.period}`,
        String(preference.minimum ?? ''),
      );
    }

    if (targetUsd !== null) {
      // Linear from minimum (0) to target (1), capped above target.
      const floor = minimumUsd ?? targetUsd * 0.7;
      const ratio = (jobAnnualUsd - floor) / Math.max(1, targetUsd - floor);
      const score = Math.max(-1, Math.min(1, ratio));
      return outcome(
        'salary',
        'soft',
        true,
        score,
        `Pays about $${jobAnnualUsd.toLocaleString()}/yr against your target of ` +
          `${preference.target?.toLocaleString()} ${preference.currency}`,
        String(preference.target ?? ''),
      );
    }

    return outcome('salary', 'soft', true, 0.5, 'Salary meets your minimum', null);
  }

  /**
   * Projects a candidate salary figure onto annual USD for comparison.
   *
   * Delegates to the shared table in `@job-intel/core` — the same one the
   * enrichment layer used to annualise the posting. When each layer kept its
   * own table the two could disagree, and a currency missing from one of them
   * was silently treated as dollars.
   */
  private toAnnualUsd(
    amount: number | null,
    preference: CandidatePreferences['salary'],
  ): number | null {
    return annualUsdAmount(amount, preference.currency, preference.period);
  }

  // ── Visa ──────────────────────────────────────────────────────────────────

  private evaluateVisa(input: EvaluationInput): ConstraintOutcome {
    const preference = this.preferences.workAuthorization;
    const sponsorship = input.enrichment.workAuthorization.sponsorship;

    if (preference.sponsorshipRequirement === 'irrelevant') {
      return neutral('visa', 'Sponsorship is not a factor for you');
    }
    if (preference.sponsorshipRequirement === 'not_needed') {
      // An explicit refusal still matters slightly: it signals the employer
      // will not consider anyone needing sponsorship later.
      return outcome('visa', 'soft', true, 0, 'You do not need sponsorship', null, true);
    }

    if (sponsorship === 'offered') {
      return outcome('visa', 'soft', true, 1, 'Employer explicitly offers visa sponsorship', null);
    }
    if (sponsorship === 'not_offered') {
      const kind = preference.sponsorshipRequirement === 'required' ? 'hard' : 'soft';
      return outcome(
        'visa',
        kind,
        kind === 'soft',
        -1,
        'Employer explicitly states sponsorship is unavailable',
        preference.sponsorshipRequirement,
      );
    }

    // `unclear` and `not_mentioned` are unknowns, never refusals.
    if (!preference.acceptUnknownSponsorship && preference.sponsorshipRequirement === 'required') {
      return outcome(
        'visa',
        'hard',
        false,
        -1,
        `Sponsorship is ${sponsorship.replace('_', ' ')} and you require it to be stated`,
        'required',
      );
    }
    return outcome(
      'visa',
      'soft',
      true,
      -0.2,
      `Sponsorship is ${sponsorship.replace('_', ' ')} — worth confirming before applying`,
      preference.sponsorshipRequirement,
      false,
    );
  }

  // ── Simple weighted dimensions ────────────────────────────────────────────

  private evaluateEmploymentType(input: EvaluationInput): ConstraintOutcome {
    const list = this.preferences.employmentTypes;
    if (list.length === 0) return neutral('employment_type', 'No employment-type preference set');

    const types = input.enrichment.employmentTypes;
    if (types.length === 0) {
      return outcome('employment_type', 'soft', true, 0, 'Posting does not state an employment type', null, true);
    }

    const matches = types
      .map((t) => findPreference(list, t))
      .filter((p): p is WeightedPreference => p !== null);

    const excluded = matches.find((m) => m.strength === 'excluded');
    if (excluded) {
      return outcome('employment_type', 'hard', false, -1, `Employment type "${excluded.value}" is excluded`, excluded.value);
    }
    const best = matches.sort((a, b) => STRENGTH_SCORES[b.strength] - STRENGTH_SCORES[a.strength])[0];
    if (!best) {
      const hasRequired = list.some((p) => p.strength === 'required');
      if (hasRequired) {
        return outcome(
          'employment_type',
          'hard',
          false,
          -1,
          `Employment type ${types.join(', ')} is not among your required types`,
          null,
        );
      }
      return outcome('employment_type', 'soft', true, -0.3, `Employment type ${types.join(', ')} is not preferred`, null);
    }
    return this.strengthOutcome('employment_type', best, `Employment type ${best.value}`);
  }

  private evaluateTitle(input: EvaluationInput): ConstraintOutcome {
    const list = this.preferences.titles;
    if (list.length === 0) return neutral('title', 'No title preference set');

    const haystack = `${input.job.title} ${input.enrichment.normalizedTitle}`;
    const match = findPreferenceLoose(list, haystack);
    if (!match) {
      return outcome('title', 'soft', true, -0.3, `Title "${input.job.title}" is not among your preferred titles`, null);
    }
    if (match.strength === 'excluded') {
      return outcome('title', 'hard', false, -1, `Title matches your excluded term "${match.value}"`, match.value);
    }
    return this.strengthOutcome('title', match, `Title matches "${match.value}"`);
  }

  private evaluateTechnologies(input: EvaluationInput): ConstraintOutcome {
    const list = this.preferences.technologies;
    if (list.length === 0) return neutral('technologies', 'No technology preference set');

    const skills = input.enrichment.skills;
    if (skills.length === 0) {
      return outcome('technologies', 'soft', true, 0, 'No technologies extracted from posting', null, true);
    }

    const matched = skills
      .map((s) => ({ skill: s, pref: findPreference(list, s.slug) ?? findPreference(list, s.displayName) }))
      .filter((m): m is { skill: (typeof skills)[number]; pref: WeightedPreference } => m.pref !== null);

    // An excluded technology that the posting *requires* is a hard failure.
    // The same technology merely inferred is a soft negative — the posting did
    // not actually ask for it.
    const excluded = matched.find((m) => m.pref.strength === 'excluded');
    if (excluded) {
      const required = excluded.skill.requirement === 'required';
      return outcome(
        'technologies',
        required ? 'hard' : 'soft',
        !required,
        -1,
        required
          ? `Requires "${excluded.pref.value}", which you have excluded`
          : `Mentions "${excluded.pref.value}", which you have excluded (not a stated requirement)`,
        excluded.pref.value,
      );
    }

    if (matched.length === 0) {
      return outcome('technologies', 'soft', true, -0.2, 'None of your preferred technologies appear', null);
    }

    // Average the strengths, weighting required skills more heavily.
    let weighted = 0;
    let total = 0;
    for (const m of matched) {
      const w = m.skill.requirement === 'required' ? 1 : m.skill.requirement === 'inferred' ? 0.3 : 0.6;
      weighted += STRENGTH_SCORES[m.pref.strength] * w;
      total += w;
    }
    const score = total > 0 ? weighted / total : 0;
    const names = matched.slice(0, 4).map((m) => m.pref.value).join(', ');
    return outcome('technologies', 'soft', true, score, `Matches your technologies: ${names}`, names);
  }

  private evaluateIndustry(input: EvaluationInput): ConstraintOutcome {
    const list = this.preferences.industries;
    if (list.length === 0) return neutral('industry', 'No industry preference set');

    const industries = input.enrichment.classification.industries;
    if (industries.length === 0) {
      return outcome('industry', 'soft', true, 0, 'Industry could not be determined', null, true);
    }

    const matches = industries
      .map((i) => findPreference(list, i))
      .filter((p): p is WeightedPreference => p !== null);

    const excluded = matches.find((m) => m.strength === 'excluded');
    if (excluded) {
      return outcome('industry', 'hard', false, -1, `Industry "${excluded.value}" is excluded`, excluded.value);
    }
    const best = matches.sort((a, b) => STRENGTH_SCORES[b.strength] - STRENGTH_SCORES[a.strength])[0];
    if (!best) {
      return outcome('industry', 'soft', true, -0.2, `Industry ${industries.join(', ')} is not in your list`, null);
    }
    return this.strengthOutcome('industry', best, `Industry ${best.value}`);
  }

  private evaluateCompany(input: EvaluationInput): ConstraintOutcome {
    const list = this.preferences.companies;
    if (list.length === 0) return neutral('company', 'No company preference set');

    const match = findPreference(list, input.job.companyName);
    if (!match) return outcome('company', 'soft', true, 0, 'Company is not in your list', null, true);
    if (match.strength === 'excluded') {
      return outcome('company', 'hard', false, -1, `Company "${match.value}" is excluded`, match.value);
    }
    return this.strengthOutcome('company', match, `Company ${match.value}`);
  }

  private evaluateSeniority(input: EvaluationInput): ConstraintOutcome {
    const accepted = this.preferences.seniorityLevels;
    if (accepted.length === 0) return neutral('seniority', 'No seniority preference set');

    const seniority = input.enrichment.seniority;
    if (!seniority) {
      return outcome('seniority', 'soft', true, 0, 'Posting does not state a seniority level', null, true);
    }
    const passed = accepted.includes(seniority);
    return outcome(
      'seniority',
      'soft',
      true,
      passed ? 1 : -0.5,
      passed
        ? `Seniority "${seniority}" matches your target levels`
        : `Seniority "${seniority}" is outside your target levels`,
      accepted.join(', '),
    );
  }

  /** Keyword bans are always hard — a candidate who bans a word means it. */
  private evaluateKeywords(input: EvaluationInput): ConstraintOutcome {
    const keywords = this.preferences.excludedKeywords;
    if (keywords.length === 0) return neutral('keywords', 'No excluded keywords set');

    const haystack = `${input.job.title} ${input.job.companyName} ${input.job.description ?? ''}`.toLowerCase();
    const hit = keywords.find((k) => haystack.includes(k.trim().toLowerCase()));
    if (hit) {
      return outcome('keywords', 'hard', false, -1, `Contains your excluded keyword "${hit}"`, hit);
    }
    return outcome('keywords', 'soft', true, 0.1, 'No excluded keywords found', null);
  }

  /** Converts a matched preference into an outcome, honouring hard escalation. */
  private strengthOutcome(
    dimension: string,
    preference: WeightedPreference,
    description: string,
  ): ConstraintOutcome {
    const score = STRENGTH_SCORES[preference.strength];

    if (preference.strength === 'excluded') {
      return outcome(dimension, 'hard', false, -1, `${description} — excluded`, preference.value);
    }
    // `required` (or an explicit hard flag) that *matched* is a hard pass.
    if (isHardStrength(preference.strength) || preference.hard) {
      return outcome(dimension, 'hard', true, score, `${description} — satisfies a hard requirement`, preference.value);
    }
    return outcome(dimension, 'soft', true, score, `${description} — ${preference.strength.replace('_', ' ')}`, preference.value);
  }
}

/**
 * Human-readable exclusion summary.
 *
 * Deliberately lists *every* hard failure rather than only the first: a job may
 * be excluded for several independent reasons, and showing one implies fixing
 * it would make the job eligible.
 */
export function explainExclusion(evaluation: CandidateEvaluation): string[] {
  if (evaluation.eligible) return [];
  return evaluation.hardFailures.map((f) => f.explanation);
}

/** The positive reasons a job scored well, strongest first. */
export function explainMatch(evaluation: CandidateEvaluation, limit = 5): string[] {
  return evaluation.outcomes
    .filter((o) => !o.skipped && o.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((o) => o.explanation);
}
