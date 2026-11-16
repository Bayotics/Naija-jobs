import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import {
  educationLevelEnum,
  employmentTypeEnum,
  jobStatusEnum,
  remoteTypeEnum,
  salaryPeriodEnum,
  seniorityLevelEnum,
  visaSponsorshipEnum,
} from './enums';
import { jobSourceRuns, jobSources } from './sources';
import { skills } from './identity';

/**
 * Companies.
 *
 * `ats_vendor` + `ats_slug` is what turns URL resolution into a compounding
 * asset: once a posting resolves to a recognised ATS board, that board can be
 * polled directly from then on — the highest-signal source in the system grows
 * itself as the system runs.
 */
export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    canonicalName: text('canonical_name').notNull(),
    /** Lower-cased, punctuation-stripped key used for matching. */
    normalizedName: text('normalized_name').notNull(),
    aliases: text('aliases').array().notNull().default([]),
    primaryDomain: text('primary_domain'),
    websiteUrl: text('website_url'),
    logoUrl: text('logo_url'),
    atsVendor: text('ats_vendor'),
    atsSlug: text('ats_slug'),
    industries: text('industries').array().notNull().default([]),
    sizeBucket: text('size_bucket'),
    hqCountryCode: text('hq_country_code'),
    /** Domain age is a scam signal; null when never looked up. */
    domainFirstSeen: date('domain_first_seen'),
    verified: boolean('verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('companies_normalized_name_unique').on(t.normalizedName),
    index('companies_domain_idx').on(t.primaryDomain),
    index('companies_ats_idx').on(t.atsVendor, t.atsSlug),
  ],
);

/**
 * Immutable capture of what a connector actually received.
 *
 * Never updated. This is what makes the pipeline replayable: when the
 * normalizer improves, history is reprocessed instead of lost to a parser bug.
 * The unique constraint on (source, content_hash) is the exact-dedup guard —
 * re-crawling costs nothing.
 */
export const rawPostings = pgTable(
  'raw_postings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id')
      .notNull()
      .references(() => jobSources.id, { onDelete: 'cascade' }),
    sourceRunId: uuid('source_run_id').references(() => jobSourceRuns.id, {
      onDelete: 'set null',
    }),
    externalId: text('external_id'),
    sourceUrl: text('source_url'),
    payload: jsonb('payload').notNull(),
    payloadFormat: text('payload_format').notNull(),
    contentHash: text('content_hash').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    traceId: text('trace_id'),
  },
  (t) => [
    uniqueIndex('raw_postings_source_hash_unique').on(t.sourceId, t.contentHash),
    index('raw_postings_fetched_idx').on(t.fetchedAt),
    index('raw_postings_external_idx').on(t.sourceId, t.externalId),
  ],
);

/**
 * A real-world opening, as opposed to a posting *about* it.
 *
 * The same job on LinkedIn, Reddit and the company's careers page produces
 * three `jobs` rows in one `job_group`. Feedback, applications and notification
 * de-duplication all attach here rather than to individual postings.
 */
export const jobGroups = pgTable(
  'job_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    canonicalJobId: uuid('canonical_job_id'),
    canonicalUrl: text('canonical_url'),
    canonicalUrlConfidence: real('canonical_url_confidence'),
    /** ats_direct | company_careers | board | aggregator | social */
    canonicalUrlKind: text('canonical_url_kind'),
    /** Blocking key shared by all members — see `JobIdentityService`. */
    fingerprint: text('fingerprint').notNull(),
    memberCount: integer('member_count').notNull().default(1),
    status: jobStatusEnum('status').notNull().default('active'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('job_groups_fingerprint_idx').on(t.fingerprint),
    index('job_groups_status_idx').on(t.status, t.lastSeenAt),
  ],
);

/**
 * A normalized posting. Everything downstream reads this shape and nothing
 * reaches back into `raw_postings.payload`.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rawPostingId: uuid('raw_posting_id').references(() => rawPostings.id, {
      onDelete: 'set null',
    }),
    sourceId: text('source_id')
      .notNull()
      .references(() => jobSources.id, { onDelete: 'cascade' }),
    jobGroupId: uuid('job_group_id').references(() => jobGroups.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),

    title: text('title').notNull(),
    titleNormalized: text('title_normalized').notNull(),
    companyNameRaw: text('company_name_raw').notNull(),
    companyWebsite: text('company_website'),

    description: text('description'),
    descriptionHtml: text('description_html'),
    responsibilities: text('responsibilities').array().notNull().default([]),
    requirements: text('requirements').array().notNull().default([]),
    preferredQualifications: text('preferred_qualifications').array().notNull().default([]),
    benefits: text('benefits').array().notNull().default([]),
    /** Denormalised for cheap filtering; `job_skills` holds the resolved graph. */
    techStack: text('tech_stack').array().notNull().default([]),

    employmentTypes: employmentTypeEnum('employment_types').array().notNull().default([]),
    remoteType: remoteTypeEnum('remote_type').notNull().default('unknown'),
    seniority: seniorityLevelEnum('seniority'),
    seniorityConfidence: real('seniority_confidence'),

    locationRaw: text('location_raw'),
    city: text('city'),
    region: text('region'),
    countryCode: text('country_code'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),

    salaryMin: numeric('salary_min', { precision: 14, scale: 2 }),
    salaryMax: numeric('salary_max', { precision: 14, scale: 2 }),
    salaryCurrency: text('salary_currency'),
    salaryPeriod: salaryPeriodEnum('salary_period'),
    salaryIsEstimated: boolean('salary_is_estimated').notNull().default(false),
    /** Cross-currency comparison key. Null means the posting stated no salary. */
    salaryNormalizedAnnualUsd: numeric('salary_normalized_annual_usd', {
      precision: 14,
      scale: 2,
    }),
    salaryFxRate: numeric('salary_fx_rate', { precision: 18, scale: 8 }),

    visaSponsorship: visaSponsorshipEnum('visa_sponsorship').notNull().default('unknown'),
    relocationSupport: boolean('relocation_support'),
    educationRequired: educationLevelEnum('education_required'),
    minYearsExperience: real('min_years_experience'),
    maxYearsExperience: real('max_years_experience'),

    sourceUrl: text('source_url').notNull(),
    canonicalUrl: text('canonical_url'),
    applyUrl: text('apply_url'),
    externalId: text('external_id'),

    // ── Identity signals (see @job-intel/core → JobIdentityService) ─────────
    /**
     * Stable per-source identity: the source's own id when it has one, else a
     * hash of the normalized URL. Unlike `content_hash` this survives an edit,
     * which is what lets a changed posting UPDATE its row instead of inserting
     * a second one.
     */
    sourceIdentity: text('source_identity').notNull(),
    /**
     * The discovery query that found this posting first.
     *
     * Without it the feedback loop cannot close: query learning needs to know
     * which searches produce jobs the candidate actually engages with, and the
     * only join available is job → query. Nullable because a job can arrive
     * from a feed or an ATS listing where no query was involved, and because
     * every job discovered before this column existed has no answer.
     */
    discoveryQueryId: text('discovery_query_id'),
    /** Changes whenever the posting's content changes. Drives versioning. */
    contentHash: text('content_hash').notNull(),
    /** Incremented on each material change; mirrors `job_versions.version`. */
    version: integer('version').notNull().default(1),
    normalizedUrl: text('normalized_url'),
    urlHash: text('url_hash'),
    fingerprint: text('fingerprint').notNull(),
    /** 64-bit SimHash; bigint because Postgres has no unsigned integer type. */
    simhash: bigint('simhash', { mode: 'bigint' }),

    status: jobStatusEnum('status').notNull().default('active'),
    qualityScore: real('quality_score'),
    scamScore: real('scam_score'),
    scamFlags: jsonb('scam_flags').$type<Record<string, unknown>>(),

    postedAt: timestamp('posted_at', { withTimezone: true }),
    validThrough: timestamp('valid_through', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    traceId: text('trace_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One row per (source, posting) forever. Keyed on the *stable* identity, so
     * re-discovering an edited posting updates rather than duplicates.
     */
    uniqueIndex('jobs_source_identity_unique').on(t.sourceId, t.sourceIdentity),
    index('jobs_content_hash_idx').on(t.sourceId, t.contentHash),
    index('jobs_status_posted_idx').on(t.status, t.postedAt),
    index('jobs_group_idx').on(t.jobGroupId),
    index('jobs_company_idx').on(t.companyId),
    index('jobs_fingerprint_idx').on(t.fingerprint),
    index('jobs_url_hash_idx').on(t.urlHash),
    index('jobs_country_remote_idx').on(t.countryCode, t.remoteType),
    index('jobs_source_idx').on(t.sourceId, t.firstSeenAt),
    index('jobs_simhash_idx').on(t.simhash),
    /** Query learning aggregates by this; without the index it scans. */
    index('jobs_discovery_query_idx').on(t.discoveryQueryId),
  ],
);

/**
 * Snapshot of a job whenever a material field changes upstream.
 *
 * Postings get edited — salary added, title corrected, description rewritten.
 * Keeping versions means "this job changed after I saw it" is answerable, and a
 * re-scored match can be attributed to the posting changing rather than to the
 * matcher misbehaving.
 */
export const jobVersions = pgTable(
  'job_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    contentHash: text('content_hash').notNull(),
    /** Field names that differ from the previous version. */
    changedFields: text('changed_fields').array().notNull().default([]),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('job_versions_job_version_unique').on(t.jobId, t.version),
    index('job_versions_detected_idx').on(t.detectedAt),
  ],
);

/** Resolved job ↔ skill graph. `jobs.tech_stack` is the denormalised mirror. */
export const jobSkills = pgTable(
  'job_skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    /** True when listed as a hard requirement rather than nice-to-have. */
    isRequired: boolean('is_required').notNull().default(false),
    /** Extraction confidence, so a guessed skill can be down-weighted. */
    confidence: real('confidence'),
  },
  (t) => [
    uniqueIndex('job_skills_unique').on(t.jobId, t.skillId),
    index('job_skills_skill_idx').on(t.skillId),
  ],
);

/**
 * Every URL ever seen for a group, with its verification state.
 *
 * Retaining all of them is what allows the canonical choice to be explained and
 * overridden in the UI, instead of being an opaque first-seen guess.
 */
export const jobUrls = pgTable(
  'job_urls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobGroupId: uuid('job_group_id')
      .notNull()
      .references(() => jobGroups.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    url: text('url').notNull(),
    urlNormalized: text('url_normalized').notNull(),
    kind: text('kind'),
    httpStatus: integer('http_status'),
    finalUrl: text('final_url'),
    hasJobPostingJsonLd: boolean('has_jobposting_jsonld'),
    rankScore: real('rank_score'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('job_urls_group_normalized_unique').on(t.jobGroupId, t.urlNormalized),
    index('job_urls_rank_idx').on(t.jobGroupId, t.rankScore),
  ],
);

/**
 * Embeddings live in their own table keyed by (job, model).
 *
 * Changing embedding model is then a backfill rather than a migration, and two
 * models can coexist while a transition completes.
 */
export const jobEmbeddings = pgTable(
  'job_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    /** Skip re-embedding when the underlying text has not changed. */
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('job_embeddings_job_model_unique').on(t.jobId, t.model),
    index('job_embeddings_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export const companiesRelations = relations(companies, ({ many }) => ({
  jobs: many(jobs),
}));

export const jobGroupsRelations = relations(jobGroups, ({ many }) => ({
  jobs: many(jobs),
  urls: many(jobUrls),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  source: one(jobSources, { fields: [jobs.sourceId], references: [jobSources.id] }),
  group: one(jobGroups, { fields: [jobs.jobGroupId], references: [jobGroups.id] }),
  company: one(companies, { fields: [jobs.companyId], references: [companies.id] }),
  rawPosting: one(rawPostings, { fields: [jobs.rawPostingId], references: [rawPostings.id] }),
  versions: many(jobVersions),
  skills: many(jobSkills),
  embeddings: many(jobEmbeddings),
}));

export const jobSkillsRelations = relations(jobSkills, ({ one }) => ({
  job: one(jobs, { fields: [jobSkills.jobId], references: [jobs.id] }),
  skill: one(skills, { fields: [jobSkills.skillId], references: [skills.id] }),
}));

export const jobUrlsRelations = relations(jobUrls, ({ one }) => ({
  group: one(jobGroups, { fields: [jobUrls.jobGroupId], references: [jobGroups.id] }),
}));
