import { z } from 'zod';
import {
  EDUCATION_LEVELS,
  EMPLOYMENT_TYPES,
  SALARY_PERIODS,
  SENIORITY_LEVELS,
  countryCodeSchema,
  currencyCodeSchema,
} from './common';

/**
 * Candidate intelligence contracts.
 *
 * The whole point of this layer is that **nothing about the candidate lives in
 * code**. There is no country, technology, salary figure or work arrangement
 * anywhere in the matching path — only references to values stored here.
 * Changing a preference is a database write, never an edit and a redeploy.
 *
 * Three distinctions the model is built around, because collapsing any of them
 * produces a matching engine that is confidently wrong:
 *
 *  1. **Strength, not booleans.** "Germany preferred" and "Germany acceptable"
 *     are different instructions; `allowed: true` erases that.
 *  2. **Hard constraints vs soft preferences.** A violated hard constraint must
 *     dominate any amount of semantic similarity. A soft mismatch just costs
 *     points.
 *  3. **Explicit vs learned.** What the candidate told us and what their
 *     behaviour suggests are stored separately and never merged. The candidate
 *     always wins.
 */

// ── Preference strength ─────────────────────────────────────────────────────

/**
 * Ordered from most positive to most negative. `neutral` is the absence of an
 * opinion — deliberately distinct from `undesirable`, because "never mentioned
 * Angular" must not mean "refuses Angular".
 */
export const PREFERENCE_STRENGTHS = [
  'required',
  'strongly_preferred',
  'preferred',
  'neutral',
  'undesirable',
  'excluded',
] as const;
export type PreferenceStrength = (typeof PREFERENCE_STRENGTHS)[number];

/** Numeric weight per strength, used by scoring. Positive attracts, negative repels. */
export const STRENGTH_SCORES: Readonly<Record<PreferenceStrength, number>> = {
  required: 1,
  strongly_preferred: 0.75,
  preferred: 0.5,
  neutral: 0,
  undesirable: -0.5,
  excluded: -1,
};

/** `required` and `excluded` are absolute; everything else is a soft signal. */
export function isHardStrength(strength: PreferenceStrength): boolean {
  return strength === 'required' || strength === 'excluded';
}

/** Where a preference came from. Learned signals never overwrite explicit ones. */
export const PREFERENCE_SOURCES = ['explicit', 'imported', 'suggested'] as const;
export type PreferenceSource = (typeof PREFERENCE_SOURCES)[number];

/**
 * One weighted preference.
 *
 * `hard` lets a candidate escalate an ordinarily-soft dimension — "Germany, and
 * I mean it" — without changing the strength vocabulary.
 */
export const weightedPreferenceSchema = z.object({
  value: z.string().trim().min(1).max(200),
  strength: z.enum(PREFERENCE_STRENGTHS).default('preferred'),
  /** Forces hard-constraint treatment even for a non-absolute strength. */
  hard: z.boolean().default(false),
  note: z.string().trim().max(300).nullable().default(null),
  source: z.enum(PREFERENCE_SOURCES).default('explicit'),
});
export type WeightedPreference = z.infer<typeof weightedPreferenceSchema>;

// ── Skills ──────────────────────────────────────────────────────────────────

export const SKILL_PROFICIENCIES = ['beginner', 'intermediate', 'advanced', 'expert'] as const;
export type SkillProficiency = (typeof SKILL_PROFICIENCIES)[number];

/** How central a skill is to the roles the candidate wants. */
export const SKILL_IMPORTANCE = ['primary', 'secondary', 'peripheral'] as const;
export type SkillImportance = (typeof SKILL_IMPORTANCE)[number];

/**
 * A candidate skill.
 *
 * Proficiency is never inferred from mere presence — an imported CV listing a
 * technology says the candidate touched it, not that they are advanced. Imports
 * land as `beginner`/unset until a human confirms.
 */
export const candidateSkillEntrySchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Canonical taxonomy slug once resolved, e.g. "react". */
  slug: z.string().trim().max(80).nullable().default(null),
  category: z.string().trim().max(60).nullable().default(null),
  proficiency: z.enum(SKILL_PROFICIENCIES).nullable().default(null),
  yearsOfExperience: z.number().min(0).max(60).nullable().default(null),
  /** Recency matters: five years of React ending in 2018 is not current React. */
  lastUsedYear: z.number().int().min(1970).max(2100).nullable().default(null),
  importance: z.enum(SKILL_IMPORTANCE).default('secondary'),
  /** Where the claim came from: "CV", "self-reported", "certification". */
  evidence: z.string().trim().max(300).nullable().default(null),
  source: z.enum(PREFERENCE_SOURCES).default('explicit'),
});
export type CandidateSkillEntry = z.infer<typeof candidateSkillEntrySchema>;

/**
 * Skill relationship types.
 *
 * `implies` is directional and transitive-ish (Next.js implies React);
 * `related` is symmetric proximity (Vue ~ React); `alias` is identity.
 */
export const SKILL_RELATION_TYPES = ['implies', 'related', 'alias', 'part_of'] as const;
export type SkillRelationType = (typeof SKILL_RELATION_TYPES)[number];

export const skillRelationSchema = z.object({
  fromSlug: z.string().trim().min(1).max(80),
  toSlug: z.string().trim().min(1).max(80),
  type: z.enum(SKILL_RELATION_TYPES),
  /** 0-1. How strongly the relationship transfers credit during matching. */
  weight: z.number().min(0).max(1).default(0.5),
});
export type SkillRelation = z.infer<typeof skillRelationSchema>;

// ── Work arrangement ────────────────────────────────────────────────────────

/**
 * A spectrum, not a boolean.
 *
 * `REMOTE_ONLY` is a hard constraint; `REMOTE_PREFERRED` is not. Conflating
 * them is exactly the bug this enum exists to prevent — one excludes every
 * on-site role, the other merely ranks them lower.
 */
export const WORK_ARRANGEMENT_PREFERENCES = [
  'REMOTE_ONLY',
  'REMOTE_PREFERRED',
  'HYBRID_ACCEPTED',
  'ONSITE_ACCEPTED',
  'ONSITE_PREFERRED',
  'ANY',
] as const;
export type WorkArrangementPreference = (typeof WORK_ARRANGEMENT_PREFERENCES)[number];

// ── Visa ────────────────────────────────────────────────────────────────────

/**
 * `not_needed` means the candidate does not require sponsorship;
 * `irrelevant` means they do not want it considered at all. The difference
 * decides whether a silent posting is a risk or a non-issue.
 */
export const VISA_REQUIREMENTS = ['required', 'preferred', 'not_needed', 'irrelevant'] as const;
export type VisaRequirement = (typeof VISA_REQUIREMENTS)[number];

export const workAuthorizationPreferenceSchema = z.object({
  sponsorshipRequirement: z.enum(VISA_REQUIREMENTS).default('not_needed'),
  /** Countries where the candidate already holds the right to work. */
  authorizedCountries: z.array(countryCodeSchema).default([]),
  citizenships: z.array(countryCodeSchema).default([]),
  willingToRelocate: z.boolean().default(false),
  relocationCountries: z.array(countryCodeSchema).default([]),
  /** True when the candidate holds or can obtain a clearance. */
  hasSecurityClearance: z.boolean().default(false),
  securityClearanceLevel: z.string().trim().max(120).nullable().default(null),
  /**
   * When true, a posting that is *silent* about sponsorship is still eligible.
   * Defaults to true because most postings never mention it, and treating
   * silence as refusal discards the overwhelming majority of the corpus.
   */
  acceptUnknownSponsorship: z.boolean().default(true),
});
export type WorkAuthorizationPreference = z.infer<typeof workAuthorizationPreferenceSchema>;

// ── Salary ──────────────────────────────────────────────────────────────────

export const salaryPreferenceSchema = z.object({
  /** Below this the job is rejected when `minimumIsHard` is set. */
  minimum: z.number().nonnegative().nullable().default(null),
  target: z.number().nonnegative().nullable().default(null),
  ideal: z.number().nonnegative().nullable().default(null),
  /** Rarely used; some candidates avoid over-levelled roles. */
  maximum: z.number().nonnegative().nullable().default(null),
  currency: currencyCodeSchema.default('USD'),
  period: z.enum(SALARY_PERIODS).default('year'),
  minimumIsHard: z.boolean().default(false),
  /**
   * Whether a posting that states no salary is still eligible. Defaults to
   * true: most postings omit salary entirely.
   */
  acceptUnstatedSalary: z.boolean().default(true),
});
export type SalaryPreference = z.infer<typeof salaryPreferenceSchema>;

// ── Matching weights ────────────────────────────────────────────────────────

/**
 * Relative importance of each soft dimension.
 *
 * Stored as data so the candidate can retune what matters without a release.
 * Values are relative, not percentages — the scorer normalises them.
 */
export const matchingWeightsSchema = z.object({
  technicalSkills: z.number().min(0).max(100).default(30),
  experience: z.number().min(0).max(100).default(15),
  location: z.number().min(0).max(100).default(15),
  workArrangement: z.number().min(0).max(100).default(10),
  salary: z.number().min(0).max(100).default(10),
  visa: z.number().min(0).max(100).default(10),
  seniority: z.number().min(0).max(100).default(5),
  industry: z.number().min(0).max(100).default(5),
  companyPreference: z.number().min(0).max(100).default(5),
  titleMatch: z.number().min(0).max(100).default(10),

  // Added with the matching engine. Every dimension the engine scores has a
  // weight here rather than a constant in the scorer, so retuning stays a
  // database write. Existing stored payloads keep validating because each
  // field carries a default.
  education: z.number().min(0).max(100).default(3),
  employmentType: z.number().min(0).max(100).default(3),
  /** Posting quality and scam risk. Low by default: it breaks ties. */
  quality: z.number().min(0).max(100).default(5),
  /**
   * Embedding similarity. A genuine dimension, weighted like any other — never
   * an override, because a job that fails a hard constraint is ineligible no
   * matter how similar its text is to the candidate's profile.
   */
  semantic: z.number().min(0).max(100).default(15),
});
export type MatchingWeights = z.infer<typeof matchingWeightsSchema>;

// ── The preference payload ──────────────────────────────────────────────────

/**
 * Every preference dimension the matching engine reads.
 *
 * All list dimensions are `WeightedPreference[]` so that strength and hardness
 * are uniform across them; a caller never has to remember which dimension used
 * booleans and which used enums.
 */
export const candidatePreferencesSchema = z.object({
  schemaVersion: z.literal(1).default(1),

  /** Job titles, e.g. Frontend Engineer → strongly_preferred. */
  titles: z.array(weightedPreferenceSchema).default([]),
  /** Countries as ISO codes; strength expresses priority. */
  countries: z.array(weightedPreferenceSchema).default([]),
  cities: z.array(weightedPreferenceSchema).default([]),
  /** Free-form regions: EU, EMEA, APAC, Americas. */
  regions: z.array(weightedPreferenceSchema).default([]),
  /** Timezone constraints, e.g. "CET", "UTC+1".  */
  timezones: z.array(weightedPreferenceSchema).default([]),

  workArrangement: z.enum(WORK_ARRANGEMENT_PREFERENCES).default('ANY'),
  /** Maximum in-office days the candidate will accept, when hybrid. */
  maxOfficeDaysPerWeek: z.number().int().min(0).max(7).nullable().default(null),

  salary: salaryPreferenceSchema.default({}),
  workAuthorization: workAuthorizationPreferenceSchema.default({}),

  employmentTypes: z.array(weightedPreferenceSchema).default([]),
  industries: z.array(weightedPreferenceSchema).default([]),
  companies: z.array(weightedPreferenceSchema).default([]),
  companySizes: z.array(weightedPreferenceSchema).default([]),
  /** Technologies the candidate wants, tolerates, dislikes or refuses. */
  technologies: z.array(weightedPreferenceSchema).default([]),
  seniorityLevels: z.array(z.enum(SENIORITY_LEVELS)).default([]),

  weights: matchingWeightsSchema.default({}),

  /**
   * Free-form keyword exclusions applied to title and description.
   * Always hard: a candidate who bans a word means it.
   */
  excludedKeywords: z.array(z.string().trim().min(1).max(120)).default([]),

  /** Preferences the schema does not model yet, preserved verbatim. */
  custom: z.record(z.string(), z.unknown()).default({}),
});
export type CandidatePreferences = z.infer<typeof candidatePreferencesSchema>;

// ── Constraint evaluation ───────────────────────────────────────────────────

export const CONSTRAINT_KINDS = ['hard', 'soft'] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

/**
 * The outcome of checking one dimension against one job.
 *
 * `skipped` is a first-class result: it means the posting did not supply the
 * data, which is neither a pass nor a failure and must not be scored as either.
 */
export const constraintOutcomeSchema = z.object({
  dimension: z.string().max(60),
  kind: z.enum(CONSTRAINT_KINDS),
  passed: z.boolean(),
  skipped: z.boolean(),
  /** -1..1 for soft dimensions; ignored for hard ones. */
  score: z.number().min(-1).max(1),
  /** Human-readable reason, shown verbatim in the "why excluded" UI. */
  explanation: z.string().max(400),
  /** The preference value responsible, for traceability. */
  preferenceValue: z.string().max(200).nullable().default(null),
});
export type ConstraintOutcome = z.infer<typeof constraintOutcomeSchema>;

export const candidateEvaluationSchema = z.object({
  eligible: z.boolean(),
  /** Populated only when a hard constraint failed. */
  hardFailures: z.array(constraintOutcomeSchema).default([]),
  outcomes: z.array(constraintOutcomeSchema).default([]),
  /** 0-100 from soft dimensions only; 0 when ineligible. */
  softScore: z.number().min(0).max(100),
  profileVersion: z.number().int().positive(),
});
export type CandidateEvaluation = z.infer<typeof candidateEvaluationSchema>;

// ── Behavioural signals ─────────────────────────────────────────────────────

export const BEHAVIORAL_EVENTS = [
  'job_viewed',
  'job_saved',
  'job_ignored',
  'job_marked_irrelevant',
  'job_marked_interesting',
  'job_applied',
  'job_rejected',
  'job_hidden',
  'job_source_clicked',
  'job_dismissed',
] as const;
export type BehavioralEvent = (typeof BEHAVIORAL_EVENTS)[number];

/** Directional weight per event. Applying is far stronger evidence than viewing. */
export const EVENT_POLARITY: Readonly<Record<BehavioralEvent, number>> = {
  job_applied: 1,
  job_saved: 0.7,
  job_marked_interesting: 0.6,
  job_source_clicked: 0.3,
  job_viewed: 0.1,
  job_ignored: -0.2,
  job_dismissed: -0.4,
  job_hidden: -0.6,
  job_marked_irrelevant: -0.8,
  job_rejected: -0.3,
};

export const behavioralSignalSchema = z.object({
  jobId: z.string().uuid(),
  event: z.enum(BEHAVIORAL_EVENTS),
  /** Optional structured context, e.g. which list the click came from. */
  context: z.record(z.string(), z.unknown()).default({}),
});
/**
 * The *input* type, not `z.infer`.
 *
 * `context` has a default, so the parsed output has it required while a caller
 * legitimately omits it. Typing consumers against the output would force every
 * caller to pass `context: {}` — the same input/output confusion that has
 * bitten this codebase before.
 */
export type BehavioralSignalInput = z.input<typeof behavioralSignalSchema>;
export type BehavioralSignal = z.infer<typeof behavioralSignalSchema>;

/**
 * What behaviour suggests, kept strictly apart from what the candidate said.
 *
 * These are never written into `candidate_preferences`. The matching engine may
 * read them as an additional weak signal, and the UI may offer them as
 * suggestions, but only an explicit action by the candidate can change a
 * preference.
 */
export const learnedSignalSchema = z.object({
  dimension: z.string().max(60),
  value: z.string().max(200),
  /** -1..1. Positive means behaviour favours this value. */
  affinity: z.number().min(-1).max(1),
  /** How many events contributed. Low counts mean low confidence. */
  observations: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
  /** True when this contradicts an explicit preference — worth surfacing. */
  conflictsWithExplicit: z.boolean().default(false),
});
export type LearnedSignal = z.infer<typeof learnedSignalSchema>;

// ── Natural-language preference changes ─────────────────────────────────────

/**
 * A proposed change, never an applied one.
 *
 * The flow is deliberately: natural language → *proposal* → schema validation →
 * human confirmation → database write. A language model never touches the
 * database, and never produces anything but a value checked against these
 * schemas.
 */
export const preferenceProposalSchema = z.object({
  /** Dot path into the preference payload, e.g. "workArrangement". */
  path: z.string().min(1).max(120),
  operation: z.enum(['set', 'add', 'remove', 'update_strength']),
  value: z.unknown(),
  /** Restated in plain language for the confirmation dialog. */
  summary: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
  /** The phrase this was derived from. */
  sourceText: z.string().max(500).nullable().default(null),
});
export type PreferenceProposal = z.infer<typeof preferenceProposalSchema>;

export const proposalBundleSchema = z.object({
  proposals: z.array(preferenceProposalSchema).max(20),
  /** Text the parser could not interpret, surfaced rather than silently dropped. */
  unparsed: z.array(z.string().max(300)).default([]),
  requiresConfirmation: z.boolean().default(true),
});
export type ProposalBundle = z.infer<typeof proposalBundleSchema>;

// ── CV import ───────────────────────────────────────────────────────────────

export const CV_IMPORT_STATUSES = [
  'uploaded',
  'extracting',
  'extracted',
  'needs_review',
  'applied',
  'rejected',
  'failed',
] as const;
export type CvImportStatus = (typeof CV_IMPORT_STATUSES)[number];

/**
 * Extraction output, held separately from the live profile.
 *
 * Nothing here becomes authoritative candidate data until a human accepts it.
 * Overwriting a curated profile with model output would silently destroy work
 * the candidate did by hand.
 */
export const cvExtractionSchema = z.object({
  fullName: z.string().max(200).nullable().default(null),
  email: z.string().max(320).nullable().default(null),
  currentTitle: z.string().max(200).nullable().default(null),
  yearsOfExperience: z.number().min(0).max(60).nullable().default(null),
  seniority: z.enum(SENIORITY_LEVELS).nullable().default(null),
  summary: z.string().max(4000).nullable().default(null),

  skills: z.array(candidateSkillEntrySchema).max(200).default([]),
  experience: z
    .array(
      z.object({
        company: z.string().max(200),
        title: z.string().max(200),
        startDate: z.string().max(40).nullable().default(null),
        endDate: z.string().max(40).nullable().default(null),
        description: z.string().max(4000).nullable().default(null),
        achievements: z.array(z.string().max(500)).max(20).default([]),
      }),
    )
    .max(40)
    .default([]),
  education: z
    .array(
      z.object({
        institution: z.string().max(200),
        degree: z.string().max(200).nullable().default(null),
        field: z.string().max(200).nullable().default(null),
        level: z.enum(EDUCATION_LEVELS).nullable().default(null),
        endYear: z.number().int().min(1900).max(2100).nullable().default(null),
      }),
    )
    .max(20)
    .default([]),
  certifications: z
    .array(
      z.object({
        name: z.string().max(200),
        issuer: z.string().max(200).nullable().default(null),
        issuedYear: z.number().int().min(1900).max(2100).nullable().default(null),
        expiresYear: z.number().int().min(1900).max(2100).nullable().default(null),
      }),
    )
    .max(40)
    .default([]),
  links: z.array(z.string().max(500)).max(20).default([]),

  extractionConfidence: z.number().min(0).max(1).default(0),
  method: z.enum(['pattern', 'llm', 'mixed']).default('pattern'),
});
export type CvExtraction = z.infer<typeof cvExtractionSchema>;

// ── Employment-type helper ──────────────────────────────────────────────────

/** Employment types as preference values, so the UI can enumerate them. */
export const EMPLOYMENT_TYPE_VALUES = EMPLOYMENT_TYPES;
