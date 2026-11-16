import type {
  CandidateProfilePayload,
  ConstraintEvaluation,
  NormalizedJob,
} from '@job-intel/contracts';
import { normalizeCompanyName } from '../normalize/text';

/**
 * The preference engine.
 *
 * This is the component that makes the system's central promise true: changing
 * "remote" to "onsite", "Germany" to "Netherlands", "React" to "Vue", a salary
 * floor, or a visa requirement must take effect with **no code change**.
 *
 * It achieves that by never referring to a concrete preference value. Every
 * check reads the profile payload it was constructed with, which comes from the
 * active `profile_versions` row. There is not a single country, technology or
 * salary figure in this file.
 *
 * Three semantics that matter more than they look:
 *
 *  - **An empty list means "no constraint", not "matches nothing".** A candidate
 *    who has not named any countries must not have every job rejected.
 *  - **Missing data never fails a check.** Most postings omit salary or visa
 *    status; treating absence as failure discards most of the corpus. Such
 *    checks are recorded as `skipped` and surfaced as concerns downstream.
 *  - **Exclusions are absolute.** Positive preferences are permissive by
 *    default, but an explicit exclusion is always a hard failure.
 */

export interface ConstraintCheck {
  constraint: string;
  passed: boolean;
  skipped: boolean;
  detail: string;
}

interface CheckContext {
  job: NormalizedJob;
  profile: CandidateProfilePayload;
  haystack: string;
}

type CheckFn = (ctx: CheckContext) => ConstraintCheck;

const pass = (constraint: string, detail: string): ConstraintCheck => ({
  constraint,
  passed: true,
  skipped: false,
  detail,
});
const fail = (constraint: string, detail: string): ConstraintCheck => ({
  constraint,
  passed: false,
  skipped: false,
  detail,
});
const skip = (constraint: string, detail: string): ConstraintCheck => ({
  constraint,
  passed: true,
  skipped: true,
  detail,
});

const lower = (values: readonly string[]): string[] => values.map((v) => v.toLowerCase().trim());

function containsAny(haystack: string, needles: readonly string[]): string | null {
  for (const needle of needles) {
    const term = needle.toLowerCase().trim();
    if (term.length > 0 && haystack.includes(term)) return needle;
  }
  return null;
}

// ── Hard constraints ────────────────────────────────────────────────────────
// Each entry is independent and declarative; adding a preference dimension is
// one function, not a change to the evaluation loop.

const HARD_CHECKS: CheckFn[] = [
  function excludedCompanies({ job, profile }) {
    const excluded = profile.exclusions.companies;
    if (excluded.length === 0) return skip('excluded_companies', 'No excluded companies set');
    const jobCompany = normalizeCompanyName(job.company.name);
    const hit = excluded.find((c) => normalizeCompanyName(c) === jobCompany);
    return hit
      ? fail('excluded_companies', `Company "${job.company.name}" is excluded`)
      : pass('excluded_companies', 'Company is not excluded');
  },

  function excludedTitles({ job, profile }) {
    const excluded = profile.exclusions.titles;
    if (excluded.length === 0) return skip('excluded_titles', 'No excluded titles set');
    const hit = containsAny(job.title.toLowerCase(), excluded);
    return hit
      ? fail('excluded_titles', `Title contains excluded term "${hit}"`)
      : pass('excluded_titles', 'Title contains no excluded terms');
  },

  function excludedTechnologies({ job, profile, haystack }) {
    const excluded = profile.exclusions.technologies;
    if (excluded.length === 0)
      return skip('excluded_technologies', 'No excluded technologies set');
    const stack = lower([...job.techStack, ...job.skills]);
    const inStack = excluded.find((t) => stack.includes(t.toLowerCase().trim()));
    if (inStack) return fail('excluded_technologies', `Uses excluded technology "${inStack}"`);
    const inText = containsAny(haystack, excluded);
    return inText
      ? fail('excluded_technologies', `Mentions excluded technology "${inText}"`)
      : pass('excluded_technologies', 'No excluded technologies found');
  },

  function excludedKeywords({ profile, haystack }) {
    const excluded = profile.exclusions.keywords;
    if (excluded.length === 0) return skip('excluded_keywords', 'No excluded keywords set');
    const hit = containsAny(haystack, excluded);
    return hit
      ? fail('excluded_keywords', `Contains excluded keyword "${hit}"`)
      : pass('excluded_keywords', 'No excluded keywords found');
  },

  function excludedLocations({ job, profile }) {
    const { countries, cities } = profile.exclusions;
    if (countries.length === 0 && cities.length === 0)
      return skip('excluded_locations', 'No excluded locations set');

    if (job.location.countryCode && lower(countries).includes(job.location.countryCode.toLowerCase())) {
      return fail('excluded_locations', `Country ${job.location.countryCode} is excluded`);
    }
    if (job.location.city && lower(cities).includes(job.location.city.toLowerCase())) {
      return fail('excluded_locations', `City ${job.location.city} is excluded`);
    }
    return pass('excluded_locations', 'Location is not excluded');
  },

  function remoteArrangement({ job, profile }) {
    const accepted = profile.preferences.location.remoteTypes;
    if (accepted.length === 0) return skip('remote_type', 'No work-arrangement constraint set');
    if (job.remoteType === 'unknown') {
      return skip('remote_type', 'Posting does not state a work arrangement');
    }
    return accepted.includes(job.remoteType)
      ? pass('remote_type', `Work arrangement "${job.remoteType}" is accepted`)
      : fail('remote_type', `Work arrangement "${job.remoteType}" is not in accepted list`);
  },

  function country({ job, profile }) {
    const { countries, relocationCountries, willingToRelocate, remoteTypes } =
      profile.preferences.location;
    if (countries.length === 0) return skip('country', 'No country constraint set');

    // A fully-remote role the candidate accepts is location-independent.
    if (job.remoteType === 'remote' && (remoteTypes.length === 0 || remoteTypes.includes('remote'))) {
      return pass('country', 'Remote role — country constraint not applied');
    }
    if (!job.location.countryCode) {
      return skip('country', 'Posting does not state a country');
    }

    const allowed = lower([...countries, ...(willingToRelocate ? relocationCountries : [])]);
    return allowed.includes(job.location.countryCode.toLowerCase())
      ? pass('country', `Country ${job.location.countryCode} is accepted`)
      : fail('country', `Country ${job.location.countryCode} is not in preferred list`);
  },

  function salaryFloor({ job, profile }) {
    const { minimum, requireStatedSalary } = profile.preferences.salary;
    if (minimum === undefined) return skip('salary_floor', 'No minimum salary set');

    const stated = job.salary.normalizedAnnualUsd;
    if (stated === null) {
      return requireStatedSalary
        ? fail('salary_floor', 'Posting states no salary and a stated salary is required')
        : skip('salary_floor', 'Posting states no salary');
    }
    // Compare against the top of the band: a range of 60–100k satisfies a 90k floor.
    return stated >= minimum
      ? pass('salary_floor', `Salary ${stated} USD/yr meets the ${minimum} minimum`)
      : fail('salary_floor', `Salary ${stated} USD/yr is below the ${minimum} minimum`);
  },

  function employmentType({ job, profile }) {
    const accepted = profile.preferences.employmentTypes;
    if (accepted.length === 0) return skip('employment_type', 'No employment-type constraint set');
    if (job.employmentTypes.length === 0) {
      return skip('employment_type', 'Posting does not state an employment type');
    }
    const overlap = job.employmentTypes.filter((t) => accepted.includes(t));
    return overlap.length > 0
      ? pass('employment_type', `Employment type ${overlap.join(', ')} is accepted`)
      : fail('employment_type', `Employment type ${job.employmentTypes.join(', ')} is not accepted`);
  },

  function seniority({ job, profile }) {
    const accepted = profile.preferences.seniorityLevels;
    if (accepted.length === 0) return skip('seniority', 'No seniority constraint set');
    if (!job.seniority) return skip('seniority', 'Posting does not state a seniority level');
    return accepted.includes(job.seniority)
      ? pass('seniority', `Seniority "${job.seniority}" is accepted`)
      : fail('seniority', `Seniority "${job.seniority}" is not in accepted list`);
  },

  function visaSponsorship({ job, profile }) {
    const requirement = profile.preferences.visaSponsorship;
    if (requirement !== 'required') {
      return skip('visa_sponsorship', `Sponsorship is "${requirement}" — not a hard constraint`);
    }
    // `unknown` passes deliberately: most postings are silent about sponsorship,
    // and rejecting silence would discard nearly everything. Downstream stages
    // raise it as a concern instead.
    if (job.visaSponsorship === 'not_offered') {
      return fail('visa_sponsorship', 'Posting explicitly does not offer sponsorship');
    }
    return job.visaSponsorship === 'offered'
      ? pass('visa_sponsorship', 'Posting offers visa sponsorship')
      : skip('visa_sponsorship', 'Posting does not state a sponsorship policy');
  },

  function excludedIndustries({ profile, haystack }) {
    const excluded = profile.exclusions.industries;
    if (excluded.length === 0) return skip('excluded_industries', 'No excluded industries set');
    const hit = containsAny(haystack, excluded);
    return hit
      ? fail('excluded_industries', `Appears to be in excluded industry "${hit}"`)
      : pass('excluded_industries', 'No excluded industry detected');
  },
];

// ── Soft signals ────────────────────────────────────────────────────────────
// Contribute to the deterministic score but never reject. The full weighted
// scoring model, including learned weights, arrives in prompts 14–16.

interface SoftSignal {
  id: string;
  weight: number;
  evaluate(ctx: CheckContext): number; // 0..1
}

const SOFT_SIGNALS: SoftSignal[] = [
  {
    id: 'title_match',
    weight: 30,
    evaluate: ({ job, profile }) => {
      const desired = profile.preferences.desiredTitles;
      if (desired.length === 0) return 0.5;
      const title = job.title.toLowerCase();
      return desired.some((d) => title.includes(d.toLowerCase().trim())) ? 1 : 0;
    },
  },
  {
    id: 'skill_overlap',
    weight: 35,
    evaluate: ({ job, profile }) => {
      const candidate = new Set(
        lower([
          ...profile.professional.technologies,
          ...profile.professional.skills.map((s) => s.name),
        ]),
      );
      if (candidate.size === 0) return 0.5;
      const jobSkills = new Set(lower([...job.techStack, ...job.skills]));
      if (jobSkills.size === 0) return 0.5;
      let overlap = 0;
      for (const skill of jobSkills) if (candidate.has(skill)) overlap += 1;
      return overlap / jobSkills.size;
    },
  },
  {
    id: 'preferred_company',
    weight: 15,
    evaluate: ({ job, profile }) => {
      const preferred = profile.preferences.preferredCompanies;
      if (preferred.length === 0) return 0.5;
      const name = normalizeCompanyName(job.company.name);
      return preferred.some((c) => normalizeCompanyName(c) === name) ? 1 : 0.3;
    },
  },
  {
    id: 'preferred_technology',
    weight: 20,
    evaluate: ({ job, profile, haystack }) => {
      const preferred = profile.preferences.preferredTechnologies;
      if (preferred.length === 0) return 0.5;
      const stack = lower([...job.techStack, ...job.skills]);
      const direct = preferred.filter((t) => stack.includes(t.toLowerCase().trim())).length;
      if (direct > 0) return Math.min(1, direct / preferred.length + 0.5);
      return containsAny(haystack, preferred) ? 0.6 : 0.2;
    },
  },
];

export class PreferenceEngine {
  private readonly profile: CandidateProfilePayload;

  constructor(profile: CandidateProfilePayload) {
    this.profile = profile;
  }

  /**
   * Evaluates every hard constraint and computes the deterministic score.
   *
   * All checks run even after the first failure: the dashboard shows *why* a
   * job was rejected, and one reason is rarely the whole story.
   */
  evaluate(job: NormalizedJob): ConstraintEvaluation {
    const ctx: CheckContext = {
      job,
      profile: this.profile,
      haystack: buildHaystack(job),
    };

    const checks = HARD_CHECKS.map((check) => check(ctx));
    const failures = checks.filter((c) => !c.passed);
    const passed = failures.length === 0;

    return {
      passed,
      rejectionReason: passed ? null : 'hard_rule',
      checks,
      score: passed ? this.score(ctx) : 0,
    };
  }

  /** Weighted 0–100 score from the soft signals. */
  private score(ctx: CheckContext): number {
    const totalWeight = SOFT_SIGNALS.reduce((sum, s) => sum + s.weight, 0);
    if (totalWeight === 0) return 0;
    const weighted = SOFT_SIGNALS.reduce(
      (sum, signal) => sum + signal.weight * clamp01(signal.evaluate(ctx)),
      0,
    );
    return Math.round((weighted / totalWeight) * 100);
  }

  /** Per-signal breakdown, for the score explanation in the UI. */
  explainScore(job: NormalizedJob): Array<{ id: string; weight: number; value: number }> {
    const ctx: CheckContext = { job, profile: this.profile, haystack: buildHaystack(job) };
    return SOFT_SIGNALS.map((s) => ({
      id: s.id,
      weight: s.weight,
      value: clamp01(s.evaluate(ctx)),
    }));
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Lower-cased searchable text for keyword-style checks. */
function buildHaystack(job: NormalizedJob): string {
  return [
    job.title,
    job.company.name,
    job.description ?? '',
    job.requirements.join(' '),
    job.responsibilities.join(' '),
    job.techStack.join(' '),
    job.skills.join(' '),
  ]
    .join(' ')
    .toLowerCase();
}
