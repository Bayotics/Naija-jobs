import { z } from 'zod';
import {
  EDUCATION_LEVELS,
  EMPLOYMENT_TYPES,
  REMOTE_TYPES,
  SENIORITY_LEVELS,
  countryCodeSchema,
  currencyCodeSchema,
  timezoneSchema,
} from './common';

/**
 * The candidate profile is the system's only source of truth for "what does
 * this person want". Nothing in the matching path may hardcode any of it.
 *
 * Three properties make it survivable over time:
 *
 *  1. It is stored as a *versioned* JSON payload, not as columns. Adding a new
 *     preference is a schema change here, not a database migration.
 *  2. `custom` accepts arbitrary additional preferences, so a preference the
 *     schema has not learned about yet is still persisted and still reaches the
 *     matching engine.
 *  3. Every field is optional-with-default. A half-filled profile is valid and
 *     the engine degrades to "no constraint" rather than rejecting everything.
 */

// ── Identity ────────────────────────────────────────────────────────────────

export const candidateIdentitySchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  phone: z.string().trim().max(50).optional(),
  timezone: timezoneSchema.default('UTC'),
  locationCountry: countryCodeSchema.optional(),
  locationCity: z.string().trim().max(120).optional(),
  websiteUrl: z.string().trim().url().optional(),
  linkedinUrl: z.string().trim().url().optional(),
  githubUrl: z.string().trim().url().optional(),
});
export type CandidateIdentity = z.infer<typeof candidateIdentitySchema>;

// ── Professional profile ────────────────────────────────────────────────────

export const educationEntrySchema = z.object({
  institution: z.string().trim().min(1).max(200),
  degree: z.string().trim().max(200).optional(),
  field: z.string().trim().max(200).optional(),
  level: z.enum(EDUCATION_LEVELS).optional(),
  startYear: z.number().int().min(1900).max(2200).optional(),
  endYear: z.number().int().min(1900).max(2200).optional(),
});
export type EducationEntry = z.infer<typeof educationEntrySchema>;

/**
 * A skill as expressed on the profile. `skillId` is filled in once the string
 * has been resolved against the canonical skill vocabulary; until then the
 * free-text `name` is authoritative.
 */
export const candidateSkillSchema = z.object({
  name: z.string().trim().min(1).max(120),
  skillId: z.string().uuid().optional(),
  yearsOfExperience: z.number().min(0).max(60).optional(),
  proficiency: z.number().int().min(1).max(5).optional(),
  isPrimary: z.boolean().default(false),
});
export type CandidateSkillInput = z.infer<typeof candidateSkillSchema>;

export const professionalProfileSchema = z.object({
  currentTitle: z.string().trim().max(200).optional(),
  yearsOfExperience: z.number().min(0).max(60).optional(),
  seniority: z.enum(SENIORITY_LEVELS).optional(),
  summary: z.string().trim().max(4000).optional(),
  education: z.array(educationEntrySchema).default([]),
  highestEducationLevel: z.enum(EDUCATION_LEVELS).optional(),
  industries: z.array(z.string().trim().min(1).max(120)).default([]),
  skills: z.array(candidateSkillSchema).default([]),
  /** Free-form technologies. Resolved against the skill vocabulary downstream. */
  technologies: z.array(z.string().trim().min(1).max(120)).default([]),
  languages: z.array(z.string().trim().min(1).max(80)).default([]),
});
export type ProfessionalProfile = z.infer<typeof professionalProfileSchema>;

// ── Positive preferences ────────────────────────────────────────────────────

export const salaryExpectationSchema = z.object({
  minimum: z.number().nonnegative().optional(),
  target: z.number().nonnegative().optional(),
  currency: currencyCodeSchema.default('USD'),
  /**
   * When true, a posting that states no salary is rejected. Defaults to false
   * because most postings omit salary — defaulting to true would silently
   * discard the majority of the corpus.
   */
  requireStatedSalary: z.boolean().default(false),
});
export type SalaryExpectation = z.infer<typeof salaryExpectationSchema>;

export const locationPreferenceSchema = z.object({
  countries: z.array(countryCodeSchema).default([]),
  cities: z.array(z.string().trim().min(1).max(120)).default([]),
  /**
   * Accepted work arrangements. An empty array means "no constraint", which is
   * materially different from an empty *result*.
   */
  remoteTypes: z.array(z.enum(REMOTE_TYPES)).default([]),
  willingToRelocate: z.boolean().default(false),
  relocationCountries: z.array(countryCodeSchema).default([]),
});
export type LocationPreference = z.infer<typeof locationPreferenceSchema>;

export const jobPreferencesSchema = z.object({
  desiredTitles: z.array(z.string().trim().min(1).max(200)).default([]),
  location: locationPreferenceSchema.default({}),
  salary: salaryExpectationSchema.default({}),
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).default([]),
  seniorityLevels: z.array(z.enum(SENIORITY_LEVELS)).default([]),
  /**
   * `required`  — only postings that offer sponsorship (or are silent) pass.
   * `preferred` — sponsorship is a scoring bonus, never a filter.
   * `not_needed`— sponsorship is irrelevant.
   */
  visaSponsorship: z.enum(['required', 'preferred', 'not_needed']).default('not_needed'),
  preferredIndustries: z.array(z.string().trim().min(1).max(120)).default([]),
  preferredCompanies: z.array(z.string().trim().min(1).max(200)).default([]),
  preferredCompanyTypes: z.array(z.string().trim().min(1).max(80)).default([]),
  preferredTechnologies: z.array(z.string().trim().min(1).max(120)).default([]),
});
export type JobPreferences = z.infer<typeof jobPreferencesSchema>;

// ── Negative preferences ────────────────────────────────────────────────────

export const exclusionPreferencesSchema = z.object({
  titles: z.array(z.string().trim().min(1).max(200)).default([]),
  technologies: z.array(z.string().trim().min(1).max(120)).default([]),
  industries: z.array(z.string().trim().min(1).max(120)).default([]),
  companies: z.array(z.string().trim().min(1).max(200)).default([]),
  countries: z.array(countryCodeSchema).default([]),
  cities: z.array(z.string().trim().min(1).max(120)).default([]),
  /** Arbitrary keyword blocklist applied to title + description. */
  keywords: z.array(z.string().trim().min(1).max(120)).default([]),
});
export type ExclusionPreferences = z.infer<typeof exclusionPreferencesSchema>;

// ── The complete payload ────────────────────────────────────────────────────

export const candidateProfilePayloadSchema = z.object({
  /** Bumped when the shape changes, so old versions remain readable. */
  schemaVersion: z.literal(1).default(1),
  identity: candidateIdentitySchema,
  professional: professionalProfileSchema.default({}),
  preferences: jobPreferencesSchema.default({}),
  exclusions: exclusionPreferencesSchema.default({}),
  /**
   * Extensibility hatch. Preferences the schema does not model yet are stored
   * verbatim and passed to the matching engine, so a new preference can be
   * introduced from the UI before it is formally added above.
   */
  custom: z.record(z.string(), z.unknown()).default({}),
});
export type CandidateProfilePayload = z.infer<typeof candidateProfilePayloadSchema>;

/**
 * Partial update accepted by `PATCH /api/v1/preferences`. Deep-merged onto the
 * active version to produce the next one — this is the "change one setting"
 * path that must never require a code change or redeploy.
 */
export const candidateProfilePatchSchema = z
  .object({
    identity: candidateIdentitySchema.partial().optional(),
    professional: professionalProfileSchema.partial().optional(),
    preferences: jobPreferencesSchema
      .omit({ location: true, salary: true })
      .partial()
      .extend({
        location: locationPreferenceSchema.partial().optional(),
        salary: salaryExpectationSchema.partial().optional(),
      })
      .optional(),
    exclusions: exclusionPreferencesSchema.partial().optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
    changeSummary: z.string().trim().max(500).optional(),
  })
  .refine(
    (v) =>
      Boolean(v.identity ?? v.professional ?? v.preferences ?? v.exclusions ?? v.custom),
    { message: 'Patch must change at least one section' },
  );
export type CandidateProfilePatch = z.infer<typeof candidateProfilePatchSchema>;

export const profileVersionSchema = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  version: z.number().int().positive(),
  payload: candidateProfilePayloadSchema,
  changeSummary: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.date(),
});
export type ProfileVersion = z.infer<typeof profileVersionSchema>;
