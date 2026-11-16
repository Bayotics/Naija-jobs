import { z } from 'zod';
import {
  EDUCATION_LEVELS,
  EMPLOYMENT_TYPES,
  JOB_STATUSES,
  REMOTE_TYPES,
  SALARY_PERIODS,
  SENIORITY_LEVELS,
  VISA_SPONSORSHIP_STATES,
  countryCodeSchema,
  currencyCodeSchema,
} from './common';

/**
 * The normalized job domain model.
 *
 * Everything downstream of extraction reads this shape and only this shape.
 * Source-specific payloads are preserved verbatim in `raw_postings` for
 * debugging and replay, but no business logic is permitted to reach into them —
 * that is what keeps the matching engine independent of the connector set.
 */

export const salarySchema = z
  .object({
    min: z.number().nonnegative().nullable().default(null),
    max: z.number().nonnegative().nullable().default(null),
    currency: currencyCodeSchema.nullable().default(null),
    period: z.enum(SALARY_PERIODS).nullable().default(null),
    /** True when the figure was inferred (e.g. by an aggregator), not stated. */
    isEstimated: z.boolean().default(false),
    /**
     * Comparison key. Every salary is projected to an annual USD figure so that
     * "€60k/year" and "$70/hour" are comparable against one preference value.
     * Null when the posting states no salary — which is the common case.
     */
    normalizedAnnualUsd: z.number().nonnegative().nullable().default(null),
    fxRateUsed: z.number().positive().nullable().default(null),
  })
  .refine((s) => s.min === null || s.max === null || s.min <= s.max, {
    message: 'Salary min must not exceed max',
  });
export type Salary = z.infer<typeof salarySchema>;

export const jobLocationSchema = z.object({
  raw: z.string().trim().max(300).nullable().default(null),
  city: z.string().trim().max(160).nullable().default(null),
  region: z.string().trim().max(160).nullable().default(null),
  countryCode: countryCodeSchema.nullable().default(null),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
});
export type JobLocation = z.infer<typeof jobLocationSchema>;

export const jobCompanySchema = z.object({
  name: z.string().trim().min(1).max(300),
  websiteUrl: z.string().trim().url().nullable().default(null),
  domain: z.string().trim().max(255).nullable().default(null),
  logoUrl: z.string().trim().url().nullable().default(null),
});
export type JobCompany = z.infer<typeof jobCompanySchema>;

/**
 * Output of the extraction + normalization stages, before persistence.
 * `null` means "the source did not tell us"; it never means "no".
 * That distinction matters: `visaSponsorship: 'unknown'` must pass a
 * `visaSponsorship: 'required'` filter, or the system discards most of the
 * corpus over missing metadata.
 */
export const normalizedJobSchema = z.object({
  title: z.string().trim().min(1).max(400),
  company: jobCompanySchema,

  description: z.string().max(200_000).nullable().default(null),
  descriptionHtml: z.string().max(400_000).nullable().default(null),
  responsibilities: z.array(z.string().trim().min(1)).default([]),
  requirements: z.array(z.string().trim().min(1)).default([]),
  preferredQualifications: z.array(z.string().trim().min(1)).default([]),
  benefits: z.array(z.string().trim().min(1)).default([]),

  skills: z.array(z.string().trim().min(1).max(120)).default([]),
  techStack: z.array(z.string().trim().min(1).max(120)).default([]),

  salary: salarySchema.default({}),
  location: jobLocationSchema.default({}),

  remoteType: z.enum(REMOTE_TYPES).default('unknown'),
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).default([]),
  seniority: z.enum(SENIORITY_LEVELS).nullable().default(null),
  seniorityConfidence: z.number().min(0).max(1).nullable().default(null),

  visaSponsorship: z.enum(VISA_SPONSORSHIP_STATES).default('unknown'),
  relocationSupport: z.boolean().nullable().default(null),

  educationRequired: z.enum(EDUCATION_LEVELS).nullable().default(null),
  minYearsExperience: z.number().min(0).max(60).nullable().default(null),
  maxYearsExperience: z.number().min(0).max(60).nullable().default(null),

  sourceUrl: z.string().trim().url(),
  canonicalUrl: z.string().trim().url().nullable().default(null),
  applyUrl: z.string().trim().url().nullable().default(null),
  externalId: z.string().trim().max(500).nullable().default(null),

  postedAt: z.date().nullable().default(null),
  validThrough: z.date().nullable().default(null),

  status: z.enum(JOB_STATUSES).default('active'),
});
export type NormalizedJob = z.infer<typeof normalizedJobSchema>;

/**
 * A posting exactly as a connector produced it. Immutable once written.
 * Storing this means an improved normalizer can be replayed over history
 * instead of losing everything a parser bug mangled.
 */
export const rawPostingSchema = z.object({
  sourceId: z.string().min(1),
  externalId: z.string().max(500).nullable().default(null),
  sourceUrl: z.string().trim().url().nullable().default(null),
  payload: z.unknown(),
  payloadFormat: z.enum(['json', 'html', 'rss', 'email_mime', 'text']),
  fetchedAt: z.date().default(() => new Date()),
});
export type RawPosting = z.infer<typeof rawPostingSchema>;

// ── Job identity (see @job-intel/core → JobIdentityService) ─────────────────

/**
 * The deterministic identity signals used to decide whether two records
 * describe the same underlying opening.
 *
 * This layer intentionally stops short of semantic matching (prompt 12). It
 * produces the keys and hashes that a later, smarter resolver will *block* on,
 * so the expensive comparison only ever runs inside a small candidate set.
 */
export const jobIdentitySchema = z.object({
  /**
   * SHA-256 of the canonicalized raw payload. Pure idempotency: identical
   * bytes from the same source must never be processed twice.
   */
  contentHash: z.string().length(64),
  /**
   * The source URL with tracking parameters removed, host lower-cased and
   * default ports/trailing slashes dropped. Two boards linking the same ATS
   * posting collapse here.
   */
  normalizedUrl: z.string().nullable(),
  urlHash: z.string().length(64).nullable(),
  /**
   * Coarse blocking key: company + title + country + posted-week. Cheap,
   * high-recall, low-precision — the candidate set, not the answer.
   */
  fingerprint: z.string().length(64),
  /** Human-readable form of the fingerprint inputs, for debugging in the UI. */
  fingerprintParts: z.object({
    company: z.string(),
    title: z.string(),
    location: z.string(),
    postedWeek: z.string(),
  }),
  /**
   * 64-bit SimHash over description shingles, stored as a signed decimal
   * string (Postgres bigint has no unsigned variant). Near-duplicate detection
   * by Hamming distance happens in prompt 12.
   */
  simhash: z.string().nullable(),
});
export type JobIdentity = z.infer<typeof jobIdentitySchema>;

// ── Query surface ───────────────────────────────────────────────────────────

export const jobListQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  countryCode: countryCodeSchema.optional(),
  remoteType: z.enum(REMOTE_TYPES).optional(),
  sourceId: z.string().optional(),
  company: z.string().trim().max(300).optional(),
  search: z.string().trim().max(200).optional(),
  postedSince: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type JobListQuery = z.infer<typeof jobListQuerySchema>;
