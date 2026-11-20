import { z } from 'zod';
import {
  EDUCATION_LEVELS,
  EMPLOYMENT_TYPES,
  REMOTE_TYPES,
  SALARY_PERIODS,
  SENIORITY_LEVELS,
  countryCodeSchema,
  currencyCodeSchema,
} from './common';

/**
 * Enrichment contracts.
 *
 * The governing idea: absence of evidence is not evidence of absence. A posting
 * that says nothing about visa sponsorship is not a posting that refuses it, and
 * conflating those makes a hard preference filter wrong in the most damaging
 * direction. Every extracted field therefore carries its own confidence and the
 * evidence it came from, and every enum that can be unknown has an explicit
 * unknown member distinct from a negative one.
 */

/** How a value was arrived at. Drives how much later stages should trust it. */
export const EXTRACTION_METHODS = [
  'source_structured',
  'pattern',
  'taxonomy',
  'heuristic',
  'llm',
  'default',
] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/**
 * A single extracted value with its provenance. `evidence` quotes the source
 * text wherever possible, which is what makes a wrong value diagnosable in the
 * UI rather than an unexplained number.
 */
export interface Confident<T> {
  value: T;
  confidence: number;
  method: ExtractionMethod;
  evidence: string | null;
}

// ── Skills ──────────────────────────────────────────────────────────────────

/**
 * Whether a skill is demanded or merely welcomed.
 *
 * `inferred` is deliberately separate: a skill implied by context ("modern
 * React ecosystem" implies React) must never be weighted like one the posting
 * explicitly listed under Requirements.
 */
export const SKILL_REQUIREMENT_TYPES = ['required', 'preferred', 'optional', 'inferred'] as const;
export type SkillRequirementType = (typeof SKILL_REQUIREMENT_TYPES)[number];

export const SKILL_CATEGORIES = [
  'language',
  'framework',
  'library',
  'database',
  'cloud',
  'devops',
  'testing',
  'design',
  'project_management',
  'security',
  'data',
  'mobile',
  'soft_skill',
  'domain',
  'other',
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export const extractedSkillSchema = z.object({
  /** Canonical taxonomy slug, e.g. "react". */
  slug: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(120),
  category: z.enum(SKILL_CATEGORIES),
  requirement: z.enum(SKILL_REQUIREMENT_TYPES),
  confidence: z.number().min(0).max(1),
  method: z.enum(EXTRACTION_METHODS),
  /** The matched surface form, so "ReactJS" is traceable back to "react". */
  matchedText: z.string().max(200).nullable().default(null),
  evidence: z.string().max(400).nullable().default(null),
});
export type ExtractedSkill = z.infer<typeof extractedSkillSchema>;

// ── Experience ──────────────────────────────────────────────────────────────

export const experienceRequirementSchema = z.object({
  minimumYears: z.number().min(0).max(60).nullable().default(null),
  maximumYears: z.number().min(0).max(60).nullable().default(null),
  confidence: z.number().min(0).max(1),
  method: z.enum(EXTRACTION_METHODS),
  rawText: z.string().max(300).nullable().default(null),
  /** True for prose like "strong professional experience" with no number. */
  qualitativeOnly: z.boolean().default(false),
});
export type ExperienceRequirement = z.infer<typeof experienceRequirementSchema>;

// ── Work arrangement ────────────────────────────────────────────────────────

/**
 * Work arrangement, with the detail a bare enum loses.
 *
 * "Remote" is not one thing: "remote worldwide" and "remote, US only" are
 * completely different opportunities, and collapsing both to `remote` destroys
 * the distinction. `remoteRegions` preserves it.
 */
export const workArrangementSchema = z.object({
  mode: z.enum(REMOTE_TYPES),
  confidence: z.number().min(0).max(1),
  method: z.enum(EXTRACTION_METHODS),
  evidence: z.string().max(400).nullable().default(null),

  remoteAllowed: z.boolean().nullable().default(null),
  /** Country codes or region names a remote role is restricted to. */
  remoteRegions: z.array(z.string().trim().min(1).max(80)).default([]),
  remoteWorldwide: z.boolean().default(false),

  officeDaysPerWeek: z.number().int().min(0).max(7).nullable().default(null),
  officeLocation: z.string().trim().max(200).nullable().default(null),
  relocationRequired: z.boolean().nullable().default(null),
  /** Free-text restriction, e.g. "within 50 miles of NYC". */
  geographicRestriction: z.string().trim().max(300).nullable().default(null),
  travelRequirement: z.string().trim().max(200).nullable().default(null),
});
export type WorkArrangement = z.infer<typeof workArrangementSchema>;

// ── Location ────────────────────────────────────────────────────────────────

export const extractedLocationSchema = z.object({
  raw: z.string().max(300).nullable().default(null),
  city: z.string().trim().max(160).nullable().default(null),
  region: z.string().trim().max(160).nullable().default(null),
  countryCode: countryCodeSchema.nullable().default(null),
  /** Only when the posting states one, e.g. "within CET". */
  timezoneHint: z.string().trim().max(80).nullable().default(null),
  confidence: z.number().min(0).max(1),
  method: z.enum(EXTRACTION_METHODS),
});
export type ExtractedLocation = z.infer<typeof extractedLocationSchema>;

// ── Compensation ────────────────────────────────────────────────────────────

/**
 * Compensation, with conversion kept auditable.
 *
 * The original figure is never replaced. A converted value carries the rate,
 * timestamp and source that produced it, so a comparison made months later can
 * still be explained and a stale rate recomputed rather than silently trusted.
 */
export const compensationSchema = z.object({
  stated: z.boolean(),
  minimum: z.number().nonnegative().nullable().default(null),
  maximum: z.number().nonnegative().nullable().default(null),
  currency: currencyCodeSchema.nullable().default(null),
  period: z.enum(SALARY_PERIODS).nullable().default(null),
  /** True for "up to $150k" or "from EUR 70k" - one bound only. */
  isOpenEnded: z.boolean().default(false),
  isEstimated: z.boolean().default(false),
  /** Verbatim compensation text. Never discarded. */
  rawText: z.string().max(400).nullable().default(null),
  components: z.array(z.string().trim().max(80)).default([]),

  confidence: z.number().min(0).max(1),
  method: z.enum(EXTRACTION_METHODS),

  /** Present only when a conversion actually happened. */
  conversion: z
    .object({
      annualUsd: z.number().nonnegative(),
      rate: z.number().positive(),
      rateSource: z.string().max(120),
      rateTimestamp: z.coerce.date(),
      periodInferred: z.boolean(),
    })
    .nullable()
    .default(null),
});
export type Compensation = z.infer<typeof compensationSchema>;

// ── Work authorization ──────────────────────────────────────────────────────

/**
 * Four states, not two.
 *
 * `not_mentioned` and `unclear` both mean "we do not know", but differ: the
 * first means the posting is silent, the second that it says something
 * ambiguous. Neither may ever be read as `not_offered`.
 */
export const VISA_SPONSORSHIP_DETAILED = [
  'offered',
  'not_offered',
  'unclear',
  'not_mentioned',
] as const;
export type VisaSponsorshipDetailed = (typeof VISA_SPONSORSHIP_DETAILED)[number];

export const workAuthorizationSchema = z.object({
  sponsorship: z.enum(VISA_SPONSORSHIP_DETAILED),
  sponsorshipConfidence: z.number().min(0).max(1),
  sponsorshipEvidence: z.string().max(400).nullable().default(null),

  workAuthorizationRequirement: z.string().trim().max(400).nullable().default(null),
  citizenshipRequired: z.boolean().nullable().default(null),
  securityClearanceRequired: z.boolean().nullable().default(null),
  securityClearanceLevel: z.string().trim().max(120).nullable().default(null),

  relocationSupport: z.enum(VISA_SPONSORSHIP_DETAILED),
  relocationEvidence: z.string().max(400).nullable().default(null),
});
export type WorkAuthorization = z.infer<typeof workAuthorizationSchema>;

// ── Education ───────────────────────────────────────────────────────────────

export const educationRequirementSchema = z.object({
  /** `null` means the posting did not state one, never "no degree needed". */
  level: z.enum(EDUCATION_LEVELS).nullable().default(null),
  requirement: z.enum(['required', 'preferred', 'not_specified']),
  fields: z.array(z.string().trim().max(120)).default([]),
  certifications: z.array(z.string().trim().max(160)).default([]),
  confidence: z.number().min(0).max(1),
  method: z.enum(EXTRACTION_METHODS),
  evidence: z.string().max(400).nullable().default(null),
});
export type EducationRequirement = z.infer<typeof educationRequirementSchema>;

// ── Classification ──────────────────────────────────────────────────────────

export const JOB_FUNCTIONS = [
  'software_engineering',
  'data',
  'devops_sre',
  'security',
  'design',
  'product',
  'qa',
  'it_support',
  'sales',
  'marketing',
  'finance',
  'hr',
  'operations',
  'legal',
  'healthcare',
  'education',
  'engineering_other',
  'other',
] as const;
export type JobFunction = (typeof JOB_FUNCTIONS)[number];

export const classificationSchema = z.object({
  jobFunction: z.enum(JOB_FUNCTIONS),
  functionConfidence: z.number().min(0).max(1),
  industries: z.array(z.string().trim().max(80)).default([]),
  industryConfidence: z.number().min(0).max(1),
  method: z.enum(EXTRACTION_METHODS),
  evidence: z.string().max(400).nullable().default(null),
});
export type Classification = z.infer<typeof classificationSchema>;

// ── Quality ─────────────────────────────────────────────────────────────────

export const QUALITY_FLAGS = [
  'description_too_short',
  'description_missing',
  'company_unidentifiable',
  'no_application_url',
  'payment_requested',
  'excessive_urgency',
  'unrealistic_compensation',
  'suspicious_contact_method',
  'free_email_contact',
  'hidden_content',
  'no_experience_high_pay',
  'personal_documents_requested',
  'boilerplate_heavy',
  'crypto_payment',
] as const;
export type QualityFlag = (typeof QUALITY_FLAGS)[number];

export const qualityAssessmentSchema = z.object({
  /** 0-1, higher is better. Completeness and specificity, not desirability. */
  qualityScore: z.number().min(0).max(1),
  /** 0-1, higher is more suspicious. Deliberately separate from quality: a
   *  thin posting is not a scam, and conflating them trains you to ignore the
   *  scam flag. */
  scamScore: z.number().min(0).max(1),
  qualityConfidence: z.number().min(0).max(1),
  flags: z
    .array(
      z.object({
        flag: z.enum(QUALITY_FLAGS),
        weight: z.number().min(0).max(1),
        evidence: z.string().max(300).nullable().default(null),
      }),
    )
    .default([]),
  /** Component sub-scores, so a score is explainable rather than opaque. */
  components: z.record(z.string(), z.number()).prefault({}),
});
export type QualityAssessment = z.infer<typeof qualityAssessmentSchema>;

// ── Application URLs ────────────────────────────────────────────────────────

export const ATS_VENDORS = [
  'greenhouse',
  'lever',
  'ashby',
  'workday',
  'smartrecruiters',
  'icims',
  'workable',
  'recruitee',
  'personio',
  'teamtailor',
  'bamboohr',
  'jobvite',
  'taleo',
  'successfactors',
  'unknown',
] as const;
export type AtsVendor = (typeof ATS_VENDORS)[number];

export const applicationTargetSchema = z.object({
  sourceUrl: z.string().url(),
  canonicalJobUrl: z.string().url().nullable().default(null),
  applicationUrl: z.string().url().nullable().default(null),
  atsVendor: z.enum(ATS_VENDORS).nullable().default(null),
  /** Company slug on the ATS, e.g. "acme" in boards.greenhouse.io/acme. */
  atsSlug: z.string().max(160).nullable().default(null),
  confidence: z.number().min(0).max(1),
  /** ats_direct | company_careers | board | aggregator | social */
  kind: z.string().max(40),
  /** Every candidate considered, so the choice is explainable. */
  candidates: z
    .array(
      z.object({
        url: z.string().max(2000),
        kind: z.string().max(40),
        rank: z.number(),
        note: z.string().max(200).nullable().default(null),
      }),
    )
    .default([]),
});
export type ApplicationTarget = z.infer<typeof applicationTargetSchema>;

// ── The complete enrichment ─────────────────────────────────────────────────

export const ENRICHMENT_STATUSES = [
  'pending',
  'processing',
  'enriched',
  'partial',
  'failed',
  'skipped',
] as const;
export type EnrichmentStatus = (typeof ENRICHMENT_STATUSES)[number];

export const jobEnrichmentSchema = z.object({
  /** Bumped when extractor behaviour changes, so stale rows can be replayed. */
  enrichmentVersion: z.number().int().positive(),

  normalizedTitle: z.string().trim().max(300),
  titleConfidence: z.number().min(0).max(1),
  /** Canonical role slug, e.g. "frontend-engineer". */
  roleSlug: z.string().trim().max(120).nullable().default(null),

  seniority: z.enum(SENIORITY_LEVELS).nullable(),
  seniorityConfidence: z.number().min(0).max(1),
  seniorityEvidence: z.string().max(400).nullable().default(null),
  /** Set when title and stated experience disagree. */
  seniorityConflict: z.string().max(300).nullable().default(null),

  experience: experienceRequirementSchema,
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).default([]),
  workArrangement: workArrangementSchema,
  location: extractedLocationSchema,
  compensation: compensationSchema,
  workAuthorization: workAuthorizationSchema,
  education: educationRequirementSchema,
  classification: classificationSchema,
  quality: qualityAssessmentSchema,
  applicationTarget: applicationTargetSchema,

  skills: z.array(extractedSkillSchema).default([]),

  responsibilities: z.array(z.string().max(1000)).default([]),
  requirements: z.array(z.string().max(1000)).default([]),
  preferredQualifications: z.array(z.string().max(1000)).default([]),
  benefits: z.array(z.string().max(1000)).default([]),

  /** Cleaned description; the original stays on the job row. */
  cleanedDescription: z.string().max(200_000).nullable().default(null),
  /** Characters removed by cleaning. A spike means the cleaner over-reached. */
  cleaningRemovedChars: z.number().int().min(0).default(0),

  applicationDeadline: z.coerce.date().nullable().default(null),

  /** Which stages ran, how long they took, whether they failed. */
  stageReports: z
    .array(
      z.object({
        stage: z.string().max(60),
        durationMs: z.number().min(0),
        ok: z.boolean(),
        note: z.string().max(400).nullable().default(null),
      }),
    )
    .default([]),

  aiUsed: z.boolean().default(false),
  aiModel: z.string().max(120).nullable().default(null),
  aiInputTokens: z.number().int().min(0).nullable().default(null),
  aiOutputTokens: z.number().int().min(0).nullable().default(null),
  aiCostUsd: z.number().min(0).nullable().default(null),
  aiError: z.string().max(400).nullable().default(null),

  totalDurationMs: z.number().min(0),
});
export type JobEnrichment = z.infer<typeof jobEnrichmentSchema>;
