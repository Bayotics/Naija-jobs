import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ENRICHMENT_STATUSES,
  SKILL_REQUIREMENT_TYPES,
  type ApplicationTarget,
  type Classification,
  type Compensation,
  type EducationRequirement,
  type ExperienceRequirement,
  type ExtractedLocation,
  type QualityAssessment,
  type WorkArrangement,
  type WorkAuthorization,
} from '@job-intel/contracts';
import { jobs } from './jobs';
import { skills } from './identity';

export const enrichmentStatusEnum = pgEnum('enrichment_status', ENRICHMENT_STATUSES);
export const skillRequirementEnum = pgEnum('skill_requirement', SKILL_REQUIREMENT_TYPES);

/**
 * Structured enrichment, one row per job.
 *
 * Deliberately a separate table rather than more columns on `jobs`:
 *
 *  - `jobs` records what a source said; this records what we inferred. Keeping
 *    them apart means a re-extraction can never corrupt source data.
 *  - Enrichment is versioned. Bumping `enrichment_version` lets the corpus be
 *    replayed through improved extractors without touching discovery.
 *  - The row is deleted with its job, so no orphan state accumulates.
 *
 * Frequently-filtered scalars are promoted to real columns so the matching
 * engine can index them; rich nested shapes stay as validated JSONB.
 */
export const jobEnrichments = pgTable(
  'job_enrichments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    enrichmentVersion: integer('enrichment_version').notNull(),
    status: enrichmentStatusEnum('status').notNull().default('enriched'),

    // ── Promoted scalars: indexed and filterable ───────────────────────────
    normalizedTitle: text('normalized_title').notNull(),
    roleSlug: text('role_slug'),
    titleConfidence: real('title_confidence'),

    seniority: text('seniority'),
    seniorityConfidence: real('seniority_confidence'),
    /** Set when the title and the stated experience disagree. */
    seniorityConflict: text('seniority_conflict'),

    minYearsExperience: real('min_years_experience'),
    maxYearsExperience: real('max_years_experience'),

    workMode: text('work_mode'),
    workModeConfidence: real('work_mode_confidence'),
    remoteWorldwide: boolean('remote_worldwide'),
    remoteRegions: text('remote_regions').array().notNull().default([]),

    countryCode: text('country_code'),
    city: text('city'),

    /** offered | not_offered | unclear | not_mentioned */
    visaSponsorship: text('visa_sponsorship'),
    visaConfidence: real('visa_confidence'),

    salaryStated: boolean('salary_stated'),
    salaryAnnualUsd: numeric('salary_annual_usd', { precision: 14, scale: 2 }),

    jobFunction: text('job_function'),
    qualityScore: real('quality_score'),
    scamScore: real('scam_score'),

    // ── Rich structures: validated JSONB ───────────────────────────────────
    experience: jsonb('experience').$type<ExperienceRequirement>().notNull(),
    workArrangement: jsonb('work_arrangement').$type<WorkArrangement>().notNull(),
    location: jsonb('location').$type<ExtractedLocation>().notNull(),
    compensation: jsonb('compensation').$type<Compensation>().notNull(),
    workAuthorization: jsonb('work_authorization').$type<WorkAuthorization>().notNull(),
    education: jsonb('education').$type<EducationRequirement>().notNull(),
    classification: jsonb('classification').$type<Classification>().notNull(),
    quality: jsonb('quality').$type<QualityAssessment>().notNull(),
    applicationTarget: jsonb('application_target').$type<ApplicationTarget>().notNull(),

    responsibilities: text('responsibilities').array().notNull().default([]),
    requirements: text('requirements').array().notNull().default([]),
    preferredQualifications: text('preferred_qualifications').array().notNull().default([]),
    benefits: text('benefits').array().notNull().default([]),

    cleanedDescription: text('cleaned_description'),
    cleaningRemovedChars: integer('cleaning_removed_chars').notNull().default(0),

    // ── Performance and AI accounting ──────────────────────────────────────
    stageReports: jsonb('stage_reports').$type<unknown[]>().notNull().default([]),
    totalDurationMs: integer('total_duration_ms').notNull().default(0),
    aiUsed: boolean('ai_used').notNull().default(false),
    aiModel: text('ai_model'),
    aiInputTokens: integer('ai_input_tokens'),
    aiOutputTokens: integer('ai_output_tokens'),
    aiCostUsd: numeric('ai_cost_usd', { precision: 12, scale: 6 }),
    aiError: text('ai_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One enrichment per job. Re-enriching upserts rather than accumulating. */
    uniqueIndex('job_enrichments_job_unique').on(t.jobId),
    index('job_enrichments_version_idx').on(t.enrichmentVersion),
    index('job_enrichments_role_idx').on(t.roleSlug),
    index('job_enrichments_seniority_idx').on(t.seniority),
    index('job_enrichments_workmode_idx').on(t.workMode, t.countryCode),
    index('job_enrichments_visa_idx').on(t.visaSponsorship),
    index('job_enrichments_salary_idx').on(t.salaryAnnualUsd),
    index('job_enrichments_quality_idx').on(t.qualityScore),
    index('job_enrichments_scam_idx').on(t.scamScore),
  ],
);

/**
 * Extracted job/skill graph with requirement strength.
 *
 * The `requirement` column is the point: matching must weigh a skill listed
 * under Requirements very differently from one merely implied by context, and a
 * plain many-to-many table loses that distinction entirely.
 */
export const jobSkillExtractions = pgTable(
  'job_skill_extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** Null until the slug is reconciled with the canonical vocabulary. */
    skillId: uuid('skill_id').references(() => skills.id, { onDelete: 'set null' }),

    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    category: text('category').notNull(),
    requirement: skillRequirementEnum('requirement').notNull(),
    confidence: real('confidence').notNull(),
    method: text('method').notNull(),
    matchedText: text('matched_text'),
    evidence: text('evidence'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('job_skill_extractions_job_slug_unique').on(t.jobId, t.slug),
    index('job_skill_extractions_slug_idx').on(t.slug, t.requirement),
    index('job_skill_extractions_job_idx').on(t.jobId),
  ],
);

export const jobEnrichmentsRelations = relations(jobEnrichments, ({ one }) => ({
  job: one(jobs, { fields: [jobEnrichments.jobId], references: [jobs.id] }),
}));

export const jobSkillExtractionsRelations = relations(jobSkillExtractions, ({ one }) => ({
  job: one(jobs, { fields: [jobSkillExtractions.jobId], references: [jobs.id] }),
  skill: one(skills, { fields: [jobSkillExtractions.skillId], references: [skills.id] }),
}));
