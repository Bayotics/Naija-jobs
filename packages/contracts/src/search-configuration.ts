import { z } from 'zod';
import {
  EMPLOYMENT_TYPES,
  SALARY_PERIODS,
  SENIORITY_LEVELS,
  countryCodeSchema,
  currencyCodeSchema,
  timezoneSchema,
} from './common';

/**
 * The dynamic search configuration layer.
 *
 * The requirement this exists to satisfy is a single sentence: **the person
 * using this must be able to change what they are looking for, at any time,
 * without anyone touching the source code.** Nigeria to Germany, React to Vue,
 * remote to hybrid, hourly to every thirty minutes — all of it a database
 * write, and every downstream stage reads the change on its next pass.
 *
 * That forces one structural decision above all others: **these five things
 * must never merge into one object.**
 *
 *   SYSTEM CONFIGURATION      operational limits, budgets, feature switches
 *   USER SEARCH PREFERENCES   what to look for  ← this file
 *   CANDIDATE FACTS           what is true about the person
 *   BEHAVIOURAL SIGNALS       what they actually click
 *   NOTIFICATION PREFERENCES  when to interrupt them
 *
 * They have different owners, different lifetimes and different authority. A
 * search profile saying "Germany" is a statement of intent that changes weekly;
 * a candidate fact saying "seven years of React" is a statement about reality
 * that changes never. Merging them means a search change quietly rewriting
 * someone's CV, which is the failure the whole separation exists to prevent.
 *
 * A `SearchProfile` is therefore a *named strategy*, not a person. Several run
 * at once — "Remote Frontend", "Germany Full Stack" — each with its own
 * criteria, sources and cadence, and each scoring the same job differently.
 */

export const SEARCH_CONFIG_VERSION = '1.0.0';

// ── Work arrangement (Part 3) ───────────────────────────────────────────────

/**
 * Deliberately six values rather than a boolean.
 *
 * "Remote" is not the opposite of "onsite" — a great many people will take
 * either but not hybrid, or hybrid but not full onsite. Collapsing this to a
 * flag forces those people to choose a lie.
 */
export const REMOTE_PREFERENCES = [
  'REMOTE_ONLY',
  'HYBRID_ONLY',
  'ONSITE_ONLY',
  'REMOTE_OR_HYBRID',
  'REMOTE_OR_ONSITE',
  'HYBRID_OR_ONSITE',
  'ANY',
] as const;
export type RemotePreference = (typeof REMOTE_PREFERENCES)[number];

/** Which arrangements each preference accepts. Data, not a switch statement. */
export const REMOTE_PREFERENCE_ACCEPTS: Readonly<Record<RemotePreference, readonly string[]>> = {
  REMOTE_ONLY: ['remote'],
  HYBRID_ONLY: ['hybrid'],
  ONSITE_ONLY: ['onsite'],
  REMOTE_OR_HYBRID: ['remote', 'hybrid'],
  REMOTE_OR_ONSITE: ['remote', 'onsite'],
  HYBRID_OR_ONSITE: ['hybrid', 'onsite'],
  ANY: ['remote', 'hybrid', 'onsite', 'unknown'],
};

// ── Locations (Parts 4, 5, 6) ───────────────────────────────────────────────

export const LOCATION_KINDS = ['country', 'region', 'state', 'city', 'timezone'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export const LOCATION_PRIORITIES = ['primary', 'secondary', 'acceptable'] as const;
export type LocationPriority = (typeof LOCATION_PRIORITIES)[number];

/**
 * One place the candidate will work.
 *
 * `priority` is what makes ranking meaningful: Berlin preferred, Munich
 * secondary and Hamburg excluded are three different answers, and a flat list
 * of "acceptable locations" cannot express any of them.
 */
export const locationSpecSchema = z.object({
  kind: z.enum(LOCATION_KINDS),
  /** ISO code for countries; free text for regions and cities. */
  value: z.string().trim().min(1).max(120),
  /** Human label, when the value is a code. */
  label: z.string().trim().max(160).nullable().default(null),
  priority: z.enum(LOCATION_PRIORITIES).default('primary'),
  /** Kilometres around a city that also count. Null means the city itself. */
  radiusKm: z.number().int().min(0).max(500).nullable().default(null),
  /** For timezone entries: the zone the role must overlap. */
  timezone: timezoneSchema.nullable().default(null),
});
export type LocationSpec = z.infer<typeof locationSpecSchema>;

/**
 * How literally the location list should be read.
 *
 * `strict` refuses anything outside it. `preferred` ranks outsiders lower but
 * still shows them, which is what most people actually want — a spectacular
 * role one country over is worth seeing.
 */
export const LOCATION_STRICTNESS = ['strict', 'preferred', 'flexible'] as const;
export type LocationStrictness = (typeof LOCATION_STRICTNESS)[number];

/**
 * Where a remote role may be worked from.
 *
 * The Part 6 requirement in one field. "Remote — US only", "Remote — EU" and
 * "Remote worldwide" are three different jobs, and a candidate in Lagos needs
 * the system to know that before it recommends the first one.
 */
export const remoteScopeSchema = z.object({
  /** Accept remote roles restricted to these countries. */
  countries: z.array(countryCodeSchema).max(60).default([]),
  /** Accept remote roles restricted to these named regions. */
  regions: z.array(z.string().trim().max(80)).max(20).default([]),
  /** Accept roles open to candidates anywhere. */
  worldwide: z.boolean().default(true),
  /**
   * Accept a remote role that does not say where it hires from.
   *
   * True by default: most postings are silent, and refusing all of them would
   * discard most of the remote market on no evidence.
   */
  acceptUnspecified: z.boolean().default(true),
});
export type RemoteScope = z.infer<typeof remoteScopeSchema>;

// ── Roles and titles (Parts 7, 8) ───────────────────────────────────────────

export const ROLE_PRIORITIES = ['primary', 'secondary', 'exploratory'] as const;
export type RolePriority = (typeof ROLE_PRIORITIES)[number];

export const roleTargetSchema = z.object({
  title: z.string().trim().min(1).max(160),
  priority: z.enum(ROLE_PRIORITIES).default('primary'),
  /** Order within the priority band, so the user can drag to reorder. */
  rank: z.number().int().min(0).max(100).default(0),
  /** Titles the user has said mean the same thing here. */
  alternatives: z.array(z.string().trim().max(160)).max(12).default([]),
});
export type RoleTarget = z.infer<typeof roleTargetSchema>;

/**
 * A title normalised against the canonical vocabulary.
 *
 * `similarity` and `confidence` are separate on purpose. "Frontend Engineer"
 * and "UI Engineer" are highly similar and the system is confident about that;
 * "Software Engineer — Frontend" is similar to several things and the system is
 * much less sure which. Reporting one number would hide the difference.
 */
export const normalisedTitleSchema = z.object({
  originalTitle: z.string().max(200),
  canonicalRole: z.string().max(120).nullable().default(null),
  /** 0–1 string/semantic closeness. */
  similarity: z.number().min(0).max(1).default(0),
  /** 0–1 belief that the canonical mapping is the right one. */
  confidence: z.number().min(0).max(1).default(0),
  /** Why it mapped, so a surprising result is explainable. */
  rationale: z.string().max(200).default(''),
});
export type NormalisedTitle = z.infer<typeof normalisedTitleSchema>;

// ── Skills and keywords (Parts 9–12) ────────────────────────────────────────

export const SKILL_TIERS = ['required', 'preferred', 'bonus'] as const;
export type SkillTier = (typeof SKILL_TIERS)[number];

/** Relative weight per tier. Bonus barely moves anything, by design. */
export const SKILL_TIER_WEIGHT: Readonly<Record<SkillTier, number>> = {
  required: 1,
  preferred: 0.45,
  bonus: 0.15,
};

export const skillRequirementSchema = z.object({
  /** Canonical slug where one exists, else the raw term. */
  value: z.string().trim().min(1).max(80),
  label: z.string().trim().max(120).nullable().default(null),
  tier: z.enum(SKILL_TIERS).default('preferred'),
});
export type SkillRequirement = z.infer<typeof skillRequirementSchema>;

/**
 * How literally the required-skills list should be read.
 *
 * The brief is explicit that not every listed skill should become a hard
 * blocker. Someone who lists five required skills usually means "these matter
 * most", not "reject anything missing one" — and a system that reads it the
 * second way will show them almost nothing.
 */
export const SKILL_STRICTNESS = ['strict', 'near_hard', 'preferred'] as const;
export type SkillStrictness = (typeof SKILL_STRICTNESS)[number];

export const keywordRulesSchema = z.object({
  /** The posting must contain every one of these. */
  mustContain: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  /** Any of these raises the ranking. */
  mayContain: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
  /** Any of these excludes the posting outright. */
  mustNotContain: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
});
export type KeywordRules = z.infer<typeof keywordRulesSchema>;

// ── Salary (Parts 15–17) ────────────────────────────────────────────────────

export const SALARY_STRICTNESS = ['strict', 'preferred', 'flexible'] as const;
export type SalaryStrictness = (typeof SALARY_STRICTNESS)[number];

export const SALARY_BASIS = ['gross', 'net', 'unspecified'] as const;
export type SalaryBasis = (typeof SALARY_BASIS)[number];

export const salaryConfigSchema = z.object({
  minimum: z.number().nonnegative().max(10_000_000).nullable().default(null),
  maximum: z.number().nonnegative().max(10_000_000).nullable().default(null),
  currency: currencyCodeSchema.default('USD'),
  period: z.enum(SALARY_PERIODS).default('year'),
  basis: z.enum(SALARY_BASIS).default('unspecified'),
  /**
   * `strict` excludes; `preferred` ranks lower; `flexible` barely moves it.
   *
   * Three settings rather than a boolean because "I need at least €60k" and
   * "I would rather have €60k" are different statements and both are common.
   */
  strictness: z.enum(SALARY_STRICTNESS).default('preferred'),
  /**
   * What to do with a posting that states no salary.
   *
   * True by default, and it matters: most postings say nothing, and excluding
   * them would discard the majority of the market to enforce a number that was
   * never in conflict.
   */
  acceptUnstated: z.boolean().default(true),
});
export type SalaryConfig = z.infer<typeof salaryConfigSchema>;

// ── Companies and industries (Parts 19, 20) ─────────────────────────────────

export const COMPANY_SIZES = [
  'seed',
  'startup',
  'scaleup',
  'midsize',
  'large',
  'enterprise',
] as const;
export type CompanySize = (typeof COMPANY_SIZES)[number];

export const COMPANY_TYPES = [
  'startup',
  'public',
  'private',
  'nonprofit',
  'government',
  'agency',
  'remote_first',
] as const;
export type CompanyType = (typeof COMPANY_TYPES)[number];

export const companyRulesSchema = z.object({
  /** Boosted, but still evaluated on the job's own merits. */
  favourites: z.array(z.string().trim().max(200)).max(200).default([]),
  preferred: z.array(z.string().trim().max(200)).max(200).default([]),
  excluded: z.array(z.string().trim().max(200)).max(200).default([]),
  sizes: z.array(z.enum(COMPANY_SIZES)).max(6).default([]),
  types: z.array(z.enum(COMPANY_TYPES)).max(7).default([]),
  excludedTypes: z.array(z.enum(COMPANY_TYPES)).max(7).default([]),
});
export type CompanyRules = z.infer<typeof companyRulesSchema>;

export const industryRulesSchema = z.object({
  preferred: z.array(z.string().trim().max(80)).max(40).default([]),
  excluded: z.array(z.string().trim().max(80)).max(40).default([]),
});
export type IndustryRules = z.infer<typeof industryRulesSchema>;

// ── Visa and languages (Parts 21, 22) ───────────────────────────────────────

export const VISA_STANCES = [
  'sponsorship_required',
  'sponsorship_preferred',
  'sponsorship_not_required',
  'already_authorized',
] as const;
export type VisaStance = (typeof VISA_STANCES)[number];

export const visaConfigSchema = z.object({
  stance: z.enum(VISA_STANCES).default('sponsorship_not_required'),
  /** Countries the candidate may already work in. */
  authorisedCountries: z.array(countryCodeSchema).max(40).default([]),
  /** Accept a posting that says nothing about sponsorship. */
  acceptUnknown: z.boolean().default(true),
  /** Exclude postings that explicitly refuse to sponsor. */
  rejectNoSponsorship: z.boolean().default(false),
});
export type VisaConfig = z.infer<typeof visaConfigSchema>;

export const LANGUAGE_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native'] as const;
export type LanguageLevel = (typeof LANGUAGE_LEVELS)[number];

export const languageRequirementSchema = z.object({
  language: z.string().trim().min(1).max(60),
  /** The level the candidate has, not the level a job demands. */
  level: z.enum(LANGUAGE_LEVELS),
  required: z.boolean().default(false),
});
export type LanguageRequirement = z.infer<typeof languageRequirementSchema>;

// ── Sources and cadence (Parts 23–25) ───────────────────────────────────────

export const SOURCE_PRIORITIES = ['very_high', 'high', 'medium', 'low'] as const;
export type SourcePriority = (typeof SOURCE_PRIORITIES)[number];

/**
 * Ranking multiplier per priority.
 *
 * Bounded well above zero on purpose: the brief is explicit that a lower
 * priority must not make a source useless. A great job found on a
 * medium-priority board is still a great job.
 */
export const SOURCE_PRIORITY_WEIGHT: Readonly<Record<SourcePriority, number>> = {
  very_high: 1.15,
  high: 1.07,
  medium: 1,
  low: 0.92,
};

export const sourceSelectionSchema = z.object({
  sourceId: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  priority: z.enum(SOURCE_PRIORITIES).default('medium'),
});
export type SourceSelection = z.infer<typeof sourceSelectionSchema>;

export const SEARCH_FREQUENCIES = [
  'every_15_minutes',
  'every_30_minutes',
  'hourly',
  'every_2_hours',
  'every_6_hours',
  'daily',
  'manual',
] as const;
export type SearchFrequency = (typeof SEARCH_FREQUENCIES)[number];

/** Minutes per frequency. `manual` never schedules itself. */
export const FREQUENCY_INTERVAL_MINUTES: Readonly<Record<SearchFrequency, number>> = {
  every_15_minutes: 15,
  every_30_minutes: 30,
  hourly: 60,
  every_2_hours: 120,
  every_6_hours: 360,
  daily: 1440,
  manual: Number.POSITIVE_INFINITY,
};

// ── The search profile (Parts 1, 2) ─────────────────────────────────────────

export const PROFILE_STATES = ['active', 'paused', 'archived'] as const;
export type ProfileState = (typeof PROFILE_STATES)[number];

/**
 * One named search strategy.
 *
 * Not a person and not a set of facts — a *strategy*, of which someone may run
 * several at once. "Remote Frontend" and "Germany Full Stack" can both be
 * active, find the same posting, and score it completely differently, which is
 * the correct answer rather than a conflict to resolve.
 */
export const searchProfileSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  profileName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).nullable().default(null),
  state: z.enum(PROFILE_STATES).default('active'),
  enabled: z.boolean().default(true),

  roles: z.array(roleTargetSchema).max(20).default([]),

  locations: z.array(locationSpecSchema).max(60).default([]),
  excludedLocations: z.array(locationSpecSchema).max(60).default([]),
  locationStrictness: z.enum(LOCATION_STRICTNESS).default('preferred'),
  remotePreference: z.enum(REMOTE_PREFERENCES).default('ANY'),
  remoteScope: remoteScopeSchema.prefault({}),

  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).max(10).default([]),
  seniorityLevels: z.array(z.enum(SENIORITY_LEVELS)).max(12).default([]),

  minimumExperienceYears: z.number().min(0).max(60).nullable().default(null),
  maximumExperienceYears: z.number().min(0).max(60).nullable().default(null),

  salary: salaryConfigSchema.prefault({}),

  skills: z.array(skillRequirementSchema).max(80).default([]),
  excludedSkills: z.array(z.string().trim().max(80)).max(40).default([]),
  skillStrictness: z.enum(SKILL_STRICTNESS).default('near_hard'),
  keywords: keywordRulesSchema.prefault({}),

  companies: companyRulesSchema.prefault({}),
  industries: industryRulesSchema.prefault({}),
  visa: visaConfigSchema.prefault({}),
  languages: z.array(languageRequirementSchema).max(20).default([]),

  sources: z.array(sourceSelectionSchema).max(200).default([]),
  /** Sources excluded whatever else says. Checked before `sources`. */
  excludedSources: z.array(z.string().trim().max(120)).max(200).default([]),

  searchFrequency: z.enum(SEARCH_FREQUENCIES).default('hourly'),
  /** Notification behaviour for jobs found by *this* profile. */
  notificationPolicy: z
    .object({
      enabled: z.boolean().default(true),
      /** Overrides the global instant threshold for this profile only. */
      instantThreshold: z.number().min(0).max(100).nullable().default(null),
      digestOnly: z.boolean().default(false),
    })
    .prefault({}),

  createdAt: z.coerce.date().default(() => new Date()),
  updatedAt: z.coerce.date().default(() => new Date()),
});
export type SearchProfile = z.infer<typeof searchProfileSchema>;

// ── Temporary overrides (Parts 32, 33) ──────────────────────────────────────

/**
 * A time-boxed change that reverts itself.
 *
 * "For the next seven days, only Germany." The base profile is never touched,
 * so nothing has to be remembered and undone by hand — the override simply
 * stops applying, and the configuration underneath is exactly what it was.
 */
export const searchOverrideSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  /** Null applies the override to every active profile. */
  profileId: z.string().uuid().nullable().default(null),

  /** Dot path into the profile, e.g. `remotePreference` or `salary.minimum`. */
  field: z.string().trim().min(1).max(120),
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),

  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  reason: z.string().trim().max(300).nullable().default(null),
  active: z.boolean().default(true),
  createdAt: z.coerce.date().default(() => new Date()),
});
export type SearchOverride = z.infer<typeof searchOverrideSchema>;

// ── Configuration intent (Parts 34, 35) ─────────────────────────────────────

export const CONFIG_OPERATIONS = [
  'UPDATE_SEARCH_PROFILE',
  'CREATE_SEARCH_PROFILE',
  'ENABLE_PROFILE',
  'DISABLE_PROFILE',
  'ARCHIVE_PROFILE',
  'ENABLE_SOURCE',
  'DISABLE_SOURCE',
  'CREATE_OVERRIDE',
  'PAUSE_SEARCH',
  'RESUME_SEARCH',
] as const;
export type ConfigOperation = (typeof CONFIG_OPERATIONS)[number];

export const CHANGE_ACTIONS = ['set', 'add', 'remove', 'clear'] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

/**
 * One proposed field change.
 *
 * Every path is checked against an allowlist before anything is written. A
 * model may propose `salary.minimum`; it may not propose
 * `candidateFacts.experience`, and the allowlist — not the model's restraint —
 * is what guarantees that.
 */
export const configChangeSchema = z.object({
  field: z.string().trim().min(1).max(120),
  action: z.enum(CHANGE_ACTIONS).default('set'),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  /** Plain language, shown in the preview the user confirms. */
  summary: z.string().trim().min(1).max(300),
  confidence: z.number().min(0).max(1).default(0.5),
  /** The phrase this was derived from, so a wrong parse is traceable. */
  sourceText: z.string().max(400).nullable().default(null),
});
export type ConfigChange = z.infer<typeof configChangeSchema>;

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const configIntentSchema = z.object({
  operation: z.enum(CONFIG_OPERATIONS),
  profileId: z.string().uuid().nullable().default(null),
  changes: z.array(configChangeSchema).max(30).default([]),
  /** Highest risk among the changes. Drives whether confirmation is needed. */
  risk: z.enum(RISK_LEVELS).default('low'),
  requiresConfirmation: z.boolean().default(true),
  /** Text the parser could not interpret, surfaced rather than dropped. */
  unparsed: z.array(z.string().max(300)).max(10).default([]),
  /** For CREATE_OVERRIDE. */
  overrideWindow: z
    .object({ startTime: z.coerce.date(), endTime: z.coerce.date() })
    .nullable()
    .default(null),
});
export type ConfigIntent = z.infer<typeof configIntentSchema>;

/**
 * Which fields a natural-language instruction may touch.
 *
 * The security boundary of this whole feature. A model's output is a
 * *suggestion about these paths and no others*; anything else is discarded
 * before validation, so a prompt injection that asks to modify candidate facts
 * or system credentials has nothing to land on.
 */
export const EDITABLE_FIELDS: readonly string[] = [
  'profileName',
  'enabled',
  'state',
  'roles',
  'locations',
  'excludedLocations',
  'locationStrictness',
  'remotePreference',
  'remoteScope.countries',
  'remoteScope.regions',
  'remoteScope.worldwide',
  'remoteScope.acceptUnspecified',
  'employmentTypes',
  'seniorityLevels',
  'minimumExperienceYears',
  'maximumExperienceYears',
  'salary.minimum',
  'salary.maximum',
  'salary.currency',
  'salary.period',
  'salary.strictness',
  'salary.acceptUnstated',
  'skills',
  'excludedSkills',
  'skillStrictness',
  'keywords.mustContain',
  'keywords.mayContain',
  'keywords.mustNotContain',
  'companies.favourites',
  'companies.preferred',
  'companies.excluded',
  'companies.sizes',
  'companies.types',
  'companies.excludedTypes',
  'industries.preferred',
  'industries.excluded',
  'visa.stance',
  'visa.acceptUnknown',
  'visa.rejectNoSponsorship',
  'languages',
  'sources',
  'excludedSources',
  'searchFrequency',
  'notificationPolicy.enabled',
  'notificationPolicy.instantThreshold',
  'notificationPolicy.digestOnly',
];

/**
 * Changes that need a human to say yes.
 *
 * Not everything does — adding a preferred skill is trivially reversible and
 * asking about it teaches people to click through dialogs without reading. What
 * is listed here is either destructive or wide-reaching enough that a
 * misparsed instruction would quietly stop the search working.
 */
export const HIGH_RISK_FIELDS: readonly string[] = [
  'state',
  'enabled',
  'remotePreference',
  'locations',
  'excludedLocations',
  'skills',
  'sources',
  'excludedSources',
  'salary.minimum',
  'salary.strictness',
  'visa.stance',
];

export const confirmationPolicySchema = z.object({
  /** Ask before anything on the high-risk list. */
  confirmHighRisk: z.boolean().default(true),
  /** Ask before anything that removes rather than adds. */
  confirmRemovals: z.boolean().default(true),
  /** Ask when the parser was unsure. */
  confirmBelowConfidence: z.number().min(0).max(1).default(0.7),
  /** Ask for everything. Off by default; on for the cautious. */
  confirmEverything: z.boolean().default(false),
});
export type ConfirmationPolicy = z.infer<typeof confirmationPolicySchema>;

// ── History and undo (Parts 37, 38) ─────────────────────────────────────────

export const CHANGE_SOURCES = ['ui', 'api', 'natural_language', 'system_suggestion', 'override_expiry'] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

export const configHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  profileId: z.string().uuid().nullable().default(null),
  operation: z.enum(CONFIG_OPERATIONS),
  changes: z.array(configChangeSchema).max(30).default([]),
  /** The whole profile before the change, so undo is a restore. */
  snapshotBefore: z.unknown().optional(),
  source: z.enum(CHANGE_SOURCES),
  actor: z.string().max(120).default('user'),
  reason: z.string().max(400).nullable().default(null),
  /** Set when a later entry undid this one. */
  undoneAt: z.coerce.date().nullable().default(null),
  occurredAt: z.coerce.date().default(() => new Date()),
});
export type ConfigHistoryEntry = z.infer<typeof configHistoryEntrySchema>;

// ── Validation (Part 39) ────────────────────────────────────────────────────

export const VALIDATION_SEVERITIES = ['error', 'warning'] as const;
export type ValidationSeverity = (typeof VALIDATION_SEVERITIES)[number];

/**
 * A contradiction or a concern.
 *
 * `error` blocks the write; `warning` does not. The distinction matters: a
 * minimum above a maximum is incoherent and cannot be stored, while a profile
 * so narrow it will match nothing is a perfectly valid thing to want and only
 * needs saying out loud.
 */
export const validationIssueSchema = z.object({
  severity: z.enum(VALIDATION_SEVERITIES),
  field: z.string().max(120),
  message: z.string().max(400),
  /** How to resolve it, where there is an obvious way. */
  suggestion: z.string().max(300).nullable().default(null),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export const validationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(validationIssueSchema).max(40).default([]),
});
export type ValidationResult = z.infer<typeof validationResultSchema>;

// ── Effective configuration (Parts 40, 41) ──────────────────────────────────

/**
 * Precedence, encoded rather than remembered.
 *
 * Highest first. The one worth explaining is why a *hard* candidate constraint
 * outranks a profile: a profile is a search strategy, and no strategy should be
 * able to search for something the person has said they cannot accept. Their
 * softer preferences sit below the profile, because narrowing them is exactly
 * what a profile is for.
 */
export const PRECEDENCE_LAYERS = [
  'temporary_override',
  'candidate_hard_constraint',
  'profile_setting',
  'candidate_preference',
  'behavioural_signal',
  'ai_inference',
] as const;
export type PrecedenceLayer = (typeof PRECEDENCE_LAYERS)[number];

export const PRECEDENCE_RANK: Readonly<Record<PrecedenceLayer, number>> = {
  temporary_override: 0,
  candidate_hard_constraint: 1,
  profile_setting: 2,
  candidate_preference: 3,
  behavioural_signal: 4,
  ai_inference: 5,
};

/**
 * What the discovery engine actually reads.
 *
 * Every downstream stage consumes this rather than querying preference tables
 * itself. That is the whole point of Part 41: one resolver, one answer, and a
 * change to any input reaching every consumer on their next pass without any of
 * them knowing where it came from.
 */
export const effectiveSearchConfigSchema = z.object({
  candidateId: z.string().uuid(),
  profileId: z.string().uuid(),
  profileName: z.string().max(120),

  /** The resolved profile, after overrides and constraints are applied. */
  profile: searchProfileSchema,

  /** Which layer decided each field, so a surprising value is explainable. */
  provenance: z
    .array(
      z.object({
        field: z.string().max(120),
        layer: z.enum(PRECEDENCE_LAYERS),
        detail: z.string().max(300).default(''),
      }),
    )
    .max(80)
    .default([]),

  /** Overrides in force at resolution time. */
  activeOverrides: z.array(searchOverrideSchema).max(20).default([]),

  /** False when the candidate has paused searching globally. */
  searchEnabled: z.boolean().default(true),
  pauseReason: z.string().max(300).nullable().default(null),

  /** Sources this profile will actually query, after every exclusion. */
  resolvedSources: z
    .array(z.object({ sourceId: z.string().max(120), priority: z.enum(SOURCE_PRIORITIES) }))
    .max(200)
    .default([]),

  /** Minutes between runs, or null when the profile never self-schedules. */
  intervalMinutes: z.number().nullable().default(60),

  /** Changes any time an input changes. Drives cache invalidation. */
  configVersion: z.number().int().min(0).default(0),
  resolvedAt: z.coerce.date().default(() => new Date()),
});
export type EffectiveSearchConfig = z.infer<typeof effectiveSearchConfigSchema>;

// ── Global search state (Part 26) ───────────────────────────────────────────

export const searchStateSchema = z.object({
  candidateId: z.string().uuid(),
  /**
   * Global pause.
   *
   * Stops discovery cleanly and changes nothing else. Everything already found
   * stays exactly where it is — pausing a search is not deleting one.
   */
  paused: z.boolean().default(false),
  pausedAt: z.coerce.date().nullable().default(null),
  pauseReason: z.string().max(300).nullable().default(null),
  /** Bumped on every configuration write. Consumers compare and refresh. */
  configVersion: z.number().int().min(0).default(0),
  updatedAt: z.coerce.date().default(() => new Date()),
});
export type SearchState = z.infer<typeof searchStateSchema>;

// ── Profile-specific matching (Parts 29, 30, 31) ────────────────────────────

/**
 * One job, scored against one profile.
 *
 * The Part 30 requirement, and the reason cross-profile deduplication works:
 * there is exactly one job record, and this table says what each strategy makes
 * of it. Job X can be 92% for "Frontend Germany" and 61% for "Cloud Europe"
 * without either being wrong.
 */
export const profileJobMatchSchema = z.object({
  profileId: z.string().uuid(),
  jobId: z.string().uuid(),
  candidateId: z.string().uuid(),
  score: z.number().min(0).max(100),
  eligible: z.boolean().default(true),
  /** Why this profile in particular surfaced it — shown in notifications. */
  reason: z.string().max(400).default(''),
  matchedCriteria: z.array(z.string().max(120)).max(20).default([]),
  failedCriteria: z.array(z.string().max(120)).max(20).default([]),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type ProfileJobMatch = z.infer<typeof profileJobMatchSchema>;
