import {
  type CandidatePreferences,
  type ConstraintOutcome,
  type HardConstraintCheck,
  type HardConstraintResult,
  type JobEnrichment,
} from '@job-intel/contracts';
import { ConstraintEvaluator } from '@job-intel/candidate';
import type { ScorerInput } from '../types';

/**
 * Stage 1 of matching: eligibility.
 *
 * This stage runs **before** anything statistical and its verdict is final. No
 * embedding similarity, behavioural affinity or model opinion can overturn it,
 * because a job the candidate cannot legally or practically take is not a good
 * match no matter how much it reads like one.
 *
 * The comparison logic itself lives in `ConstraintEvaluator` (Prompt 5) and is
 * not reimplemented here. This module's job is to re-present that verdict in
 * the PASS / FAIL / UNKNOWN shape the matching engine and the UI need, which
 * the evaluator's pass/skip encoding does not expose directly.
 */

/**
 * Whether the candidate has configured a dimension at all.
 *
 * Needed to tell two different silences apart: "the posting does not say" (an
 * UNKNOWN worth surfacing) and "the candidate never asked" (not a constraint,
 * and reporting it as one would fill the UI with noise about things nobody
 * cares about). This is a lookup, not a duplicate of the comparison rules.
 */
const CONFIGURED: Readonly<Record<string, (p: CandidatePreferences) => boolean>> = {
  work_arrangement: (p) => p.workArrangement !== 'ANY',
  office_days: (p) => p.maxOfficeDaysPerWeek !== null,
  location: (p) => p.countries.length + p.cities.length + p.regions.length > 0,
  salary: (p) => p.salary.minimum !== null || p.salary.target !== null,
  visa: (p) => p.workAuthorization.sponsorshipRequirement !== 'irrelevant',
  employment_type: (p) => p.employmentTypes.length > 0,
  title: (p) => p.titles.length > 0,
  technologies: (p) => p.technologies.length > 0,
  industry: (p) => p.industries.length > 0,
  company: (p) => p.companies.length > 0,
  seniority: (p) => p.seniorityLevels.length > 0,
  keywords: (p) => p.excludedKeywords.length > 0,
};

/**
 * Whether the posting said anything on a dimension.
 *
 * The other half of telling silences apart. The evaluator encodes "no data" in
 * two different ways depending on the dimension — sometimes as a skip, and
 * sometimes (visas, where an unstated sponsorship is a real caveat) as a small
 * soft penalty. Neither encoding is wrong for its purpose, but the UI needs one
 * consistent answer to "did the posting tell us?", and that question is about
 * the job, not about the comparison rules.
 */
const HAS_DATA: Readonly<Record<string, (e: JobEnrichment) => boolean>> = {
  work_arrangement: (e) => e.workArrangement.mode !== 'unknown',
  office_days: (e) => e.workArrangement.officeDaysPerWeek !== null,
  location: (e) =>
    e.location.countryCode !== null ||
    e.location.city !== null ||
    e.workArrangement.remoteWorldwide ||
    e.workArrangement.remoteRegions.length > 0,
  salary: (e) => e.compensation.stated && e.compensation.conversion !== null,
  visa: (e) => e.workAuthorization.sponsorship === 'offered' || e.workAuthorization.sponsorship === 'not_offered',
  employment_type: (e) => e.employmentTypes.length > 0,
  title: (e) => e.normalizedTitle.length > 0,
  technologies: (e) => e.skills.length > 0,
  industry: (e) => e.classification.industries.length > 0,
  company: () => true,
  seniority: (e) => e.seniority !== null,
  keywords: () => true,
};

/** Human-facing labels; the evaluator's dimension keys are snake_case internals. */
const LABELS: Readonly<Record<string, string>> = {
  work_arrangement: 'Work arrangement',
  office_days: 'Office days per week',
  location: 'Location',
  salary: 'Salary',
  visa: 'Visa sponsorship',
  employment_type: 'Employment type',
  title: 'Job title',
  technologies: 'Technologies',
  industry: 'Industry',
  company: 'Company',
  seniority: 'Seniority',
  keywords: 'Excluded keywords',
};

function label(dimension: string): string {
  return LABELS[dimension] ?? dimension;
}

/**
 * Turns one evaluator outcome into a constraint check, or drops it.
 *
 * The order of the branches is the meaning. A hard failure is reported first
 * even when the data was thin, because the candidate explicitly asked to be
 * excluded in exactly that situation. Only after that does absent data become
 * UNKNOWN, and only for dimensions the candidate actually configured.
 */
function toCheck(
  outcome: ConstraintOutcome,
  preferences: CandidatePreferences,
  enrichment: JobEnrichment,
  actual: string | null,
): HardConstraintCheck | null {
  const configured = CONFIGURED[outcome.dimension]?.(preferences) ?? false;
  const base = {
    constraint: label(outcome.dimension),
    required: outcome.preferenceValue,
    actual,
    explanation: outcome.explanation,
  };

  if (outcome.kind === 'hard' && !outcome.passed) {
    return { ...base, severity: 'ABSOLUTE' as const, result: 'FAIL' as const };
  }

  // Nothing was asked for — not a constraint at all, and listing it would fill
  // the UI with commentary on things the candidate never mentioned.
  if (!configured) return null;

  const hasData = HAS_DATA[outcome.dimension]?.(enrichment) ?? true;
  if (!hasData || outcome.skipped) {
    return {
      ...base,
      // Reaching here means the candidate configured a tolerance for missing
      // data on this dimension — otherwise the branch above would have fired.
      // So an unknown is a caveat worth surfacing, not a blocker.
      severity: 'PREFERRED' as const,
      result: 'UNKNOWN' as const,
    };
  }

  return {
    ...base,
    severity: outcome.kind === 'hard' ? ('ABSOLUTE' as const) : ('PREFERRED' as const),
    result: 'PASS' as const,
  };
}

/**
 * What the posting actually says on a dimension, for the required/actual pair.
 *
 * Truncated to the contract's limit rather than left to fail validation later.
 * A live run found this the hard way: a salary line and an eight-skill list
 * both exceed 200 characters, and the resulting `ZodError` surfaced not at
 * write time but on the *read* path, where it took down a whole match listing
 * over one over-long display string.
 */
const MAX_DISPLAY = 200;

function truncate(value: string | null): string | null {
  if (value === null) return null;
  return value.length > MAX_DISPLAY ? `${value.slice(0, MAX_DISPLAY - 1)}…` : value;
}

function actualFor(dimension: string, input: ScorerInput): string | null {
  return truncate(rawActualFor(dimension, input));
}

function rawActualFor(dimension: string, input: ScorerInput): string | null {
  const e = input.job.enrichment;
  switch (dimension) {
    case 'work_arrangement':
      return e.workArrangement.mode;
    case 'office_days':
      return e.workArrangement.officeDaysPerWeek === null
        ? null
        : String(e.workArrangement.officeDaysPerWeek);
    case 'location':
      return [e.location.city, e.location.countryCode].filter(Boolean).join(', ') || null;
    case 'salary':
      return e.compensation.stated ? (e.compensation.rawText ?? 'stated') : null;
    case 'visa':
      return e.workAuthorization.sponsorship;
    case 'employment_type':
      return e.employmentTypes.join(', ') || null;
    case 'title':
      return e.normalizedTitle || input.job.title;
    case 'technologies':
      return e.skills.map((s) => s.displayName).slice(0, 8).join(', ') || null;
    case 'industry':
      return e.classification.industries.join(', ') || null;
    case 'company':
      return input.job.companyName;
    case 'seniority':
      return e.seniority;
    default:
      return null;
  }
}

/**
 * Evaluates eligibility.
 *
 * `eligible` comes straight from the evaluator's hard failures — deliberately,
 * so there is exactly one definition of "disqualified" in the system and it is
 * the one the candidate's preference screen configures.
 */
export function evaluateHardConstraints(input: ScorerInput): HardConstraintResult {
  const { preferences } = input.candidate;
  const evaluation = new ConstraintEvaluator(preferences).evaluate({
    preferences,
    profileVersion: input.candidate.profileVersion,
    enrichment: input.job.enrichment,
    job: {
      title: input.job.title,
      companyName: input.job.companyName,
      description: input.job.description,
    },
  });

  const checks: HardConstraintCheck[] = [];
  for (const outcome of evaluation.outcomes) {
    const check = toCheck(
      outcome,
      preferences,
      input.job.enrichment,
      actualFor(outcome.dimension, input),
    );
    if (check) checks.push(check);
  }

  /*
   * Remote geography (Prompt 18, Part 21).
   *
   * Appended here rather than added to the core evaluator because it is a
   * *matching* rule: it compares where a posting will hire from against where
   * the candidate can legally work, and the core evaluator deliberately knows
   * nothing about the candidate's authorisation.
   *
   * A live thirty-scenario run found the gap. A US-only remote role scored 77
   * for a Nigeria-based candidate who needs sponsorship — every other dimension
   * matched, and nothing in the system looked at the one field that decided it.
   * That is the most expensive kind of false positive this product can produce:
   * the candidate applies, and is rejected for a reason nobody surfaced.
   */
  const geography = checkRemoteGeography(input);
  if (geography) checks.push(geography);

  /*
   * On-site and hybrid geography.
   *
   * `checkRemoteGeography` returns null for anything that is not remote, so
   * until this existed a role requiring physical presence was never checked
   * against where the candidate can actually be. A Munich on-site position
   * reached a Nigeria-based candidate's inbox scoring 73 — every dimension
   * matched, because nothing compared the one field that decides it.
   *
   * Worse than the remote case it mirrors: a restricted remote role is at
   * least *doable* if authorisation changes, whereas on-site presence in a
   * country the candidate cannot enter is not a matching subtlety, it is
   * impossible.
   */
  const presence = checkOnsitePresence(input);
  if (presence) checks.push(presence);

  const violations = checks.filter((c) => c.severity === 'ABSOLUTE' && c.result === 'FAIL');

  return {
    /*
     * `eligible` is recomputed rather than taken from the evaluator, so a
     * geography failure actually disqualifies. Trusting the evaluator's flag
     * after appending a check would let a hard failure sit in the list while
     * the job stayed eligible — visible in the UI and ignored by the ranking.
     */
    eligible: evaluation.eligible && violations.length === 0,
    checks,
    violations,
    unknowns: checks.filter((c) => c.result === 'UNKNOWN'),
  };
}

/**
 * Whether a geographically restricted remote role can hire this candidate.
 *
 * Returns null when the question does not arise — a non-remote role, or a
 * posting that states no restriction. Silence is *not* treated as a
 * restriction: most remote postings say nothing, and failing them all would
 * discard most of the remote market on no evidence.
 */
function checkRemoteGeography(input: ScorerInput): HardConstraintCheck | null {
  const arrangement = input.job.enrichment.workArrangement;

  if (arrangement.mode !== 'remote') return null;
  if (arrangement.remoteWorldwide) return null;
  if (arrangement.remoteRegions.length === 0) return null;

  const authorization = input.candidate.preferences.workAuthorization;

  /*
   * Where the candidate can already work, which is the only thing that makes a
   * restriction passable. Relocation countries are excluded deliberately: a
   * remote role restricted to the US does not become available because someone
   * would be willing to move there.
   */
  const authorized = new Set(
    [...authorization.authorizedCountries, ...authorization.citizenships].map((code) =>
      code.toUpperCase(),
    ),
  );

  const restrictions = arrangement.remoteRegions.map((region) => region.toUpperCase());

  const base = {
    constraint: 'Remote geography',
    required:
      authorized.size > 0
        ? `Authorised to work in ${[...authorized].join(', ')}`
        : 'Your work authorisation is not recorded',
    actual: `Hires remotely from ${restrictions.join(', ')}`,
  };

  if (authorized.size === 0) {
    return {
      ...base,
      severity: 'PREFERRED' as const,
      result: 'UNKNOWN' as const,
      explanation:
        `This role only hires remotely from ${restrictions.join(', ')}. ` +
        'Your work authorisation is not recorded, so this could not be resolved.',
    };
  }

  const permitted = restrictions.some((region) => authorized.has(region));

  if (permitted) {
    return {
      ...base,
      severity: 'ABSOLUTE' as const,
      result: 'PASS' as const,
      explanation: `You are authorised to work in one of the regions this role hires from.`,
    };
  }

  /*
   * A sponsorship offer does not rescue this. Sponsorship changes whether an
   * employer will support a visa; it does not change a remote-hiring policy
   * that already excludes the candidate's country, and conflating the two
   * produces confident false positives.
   */
  return {
    ...base,
    severity: 'ABSOLUTE' as const,
    result: 'FAIL' as const,
    explanation:
      `This role hires remotely only from ${restrictions.join(', ')}, ` +
      `and you are authorised to work in ${[...authorized].join(', ')}.`,
  };
}

/**
 * Whether the candidate can physically be where an on-site role requires.
 *
 * The mirror of `checkRemoteGeography` for roles that require presence. Returns
 * null when the question does not arise — a fully remote role, or a posting
 * whose country could not be extracted.
 *
 * ── Why relocation is treated differently here ────────────────────────────
 *
 * The remote check deliberately ignores relocation: a US-only remote role does
 * not open up because someone would move there. Presence is the opposite case —
 * relocating is precisely how an on-site role in another country becomes
 * possible — so a candidate who has said they will relocate, and named the
 * country, passes.
 *
 * That willingness has to be *stated*. Inferring it from silence would rebuild
 * the bug this fixes, one step further along.
 */
function checkOnsitePresence(input: ScorerInput): HardConstraintCheck | null {
  const arrangement = input.job.enrichment.workArrangement;

  /* Remote roles are the other function's problem. */
  if (arrangement.mode === 'remote') return null;

  const jobCountry = input.job.enrichment.location.countryCode?.toUpperCase() ?? null;

  /*
   * No extractable country means no judgement. Failing these would discard
   * every posting with a vague location line, which is a large share of them,
   * on no evidence at all.
   */
  if (!jobCountry) return null;

  const authorization = input.candidate.preferences.workAuthorization;

  const authorized = new Set(
    [...authorization.authorizedCountries, ...authorization.citizenships].map((code) =>
      code.toUpperCase(),
    ),
  );

  if (authorized.size === 0) {
    return {
      constraint: 'On-site presence',
      required: 'Your work authorisation is not recorded',
      actual: `Requires presence in ${jobCountry}`,
      severity: 'PREFERRED' as const,
      result: 'UNKNOWN' as const,
      explanation:
        `This role requires being in ${jobCountry}. Your work authorisation is not ` +
        'recorded, so this could not be resolved.',
    };
  }

  const base = {
    constraint: 'On-site presence',
    required: `Able to work on-site in ${jobCountry}`,
    actual: `Authorised in ${[...authorized].join(', ')}`,
  };

  if (authorized.has(jobCountry)) {
    return {
      ...base,
      severity: 'ABSOLUTE' as const,
      result: 'PASS' as const,
      explanation: `You are authorised to work in ${jobCountry}, where this role is based.`,
    };
  }

  /*
   * Relocation named explicitly. `willingToRelocate` alone is not enough: a
   * general willingness to move is not a statement that the candidate will move
   * to *this* country, and treating it as one puts roles on other continents in
   * front of someone who meant "elsewhere in my region".
   */
  const relocationCountries = new Set(
    authorization.relocationCountries.map((code) => code.toUpperCase()),
  );

  if (authorization.willingToRelocate && relocationCountries.has(jobCountry)) {
    return {
      ...base,
      required: `Able to work on-site in ${jobCountry}`,
      actual: `Willing to relocate to ${jobCountry}`,
      severity: 'ABSOLUTE' as const,
      result: 'PASS' as const,
      explanation:
        `You listed ${jobCountry} as a country you would relocate to. ` +
        'Confirm the employer supports relocation before applying.',
    };
  }

  return {
    ...base,
    severity: 'ABSOLUTE' as const,
    result: 'FAIL' as const,
    explanation:
      `This role requires working on-site in ${jobCountry}. You are authorised in ` +
      `${[...authorized].join(', ')} and have not listed ${jobCountry} as a relocation target.`,
  };
}
