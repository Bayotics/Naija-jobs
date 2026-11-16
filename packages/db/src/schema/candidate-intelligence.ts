import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  AchievementRecord,
  CandidateIntelligence,
  CandidateSkillFact,
  CareerTrajectory,
  CertificationRecord,
  EducationRecord,
  EvidenceItem,
  ExperienceEntry,
  LanguageRecord,
  ProfileQuality,
  ProjectRecord,
  SeniorityEstimate,
} from '@job-intel/contracts';
import { candidateProfiles } from './identity';
import { jobs } from './jobs';

/**
 * Candidate intelligence storage.
 *
 * Three structural decisions:
 *
 *  1. **Documents store metadata, never bytes.** The file itself lives in
 *     object storage behind a signed, expiring URL; this table holds the hash,
 *     the size and the status. A resume in a database row is a resume in every
 *     backup, every replica and every logical dump — and nothing here needs the
 *     bytes after extraction.
 *
 *  2. **Profiles are versioned, never mutated.** A new resume creates
 *     version N+1 and leaves N intact, so a match computed in March stays
 *     reproducible in June against the profile that actually produced it.
 *
 *  3. **Overrides are a separate table, applied on read.** A hand correction
 *     must survive re-extraction. Storing it inside the profile row would mean
 *     the next upload silently overwrites it, which is the fastest way to make
 *     someone stop trusting the editor.
 */

// ── Documents (Parts 2, 3, 41, 42) ──────────────────────────────────────────

export const candidateDocuments = pgTable(
  'candidate_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    kind: text('kind').notNull().default('resume'),
    label: text('label').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),

    /** SHA-256 of the bytes. Re-uploading the same file is detectable. */
    contentHash: text('content_hash').notNull(),
    /**
     * Where the bytes live — an object-storage key, never a public URL. The
     * brief forbids exposing documents through public URLs, so access is always
     * mediated by a short-lived signed URL minted at request time.
     */
    storageKey: text('storage_key'),

    status: text('status').notNull().default('uploaded'),
    rejectionReason: text('rejection_reason'),
    targetRole: text('target_role'),

    /** Stage-by-stage record of the pipeline run, for the debugger. */
    pipelineStages: jsonb('pipeline_stages').$type<unknown[]>().notNull().default([]),
    /** Characters extracted. Never the text — see the note above. */
    textLength: integer('text_length').notNull().default(0),
    extractorWarnings: jsonb('extractor_warnings').$type<string[]>().notNull().default([]),

    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    candidateIdx: index('candidate_documents_candidate_idx').on(table.candidateId, table.uploadedAt),
    statusIdx: index('candidate_documents_status_idx').on(table.status),
    /*
     * The same file uploaded twice is one document. A unique index rather than
     * an application check, so two concurrent uploads cannot both win.
     */
    hashUnique: unique('candidate_documents_hash_unique').on(table.candidateId, table.contentHash),
  }),
);

/** Detected sections, kept for the extraction debugger and re-parsing. */
export const documentSections = pgTable(
  'document_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => candidateDocuments.id, { onDelete: 'cascade' }),

    kind: text('kind').notNull(),
    heading: text('heading').notNull(),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
    /**
     * Section text *is* stored: without it the extraction debugger cannot show
     * why a role was parsed the way it was, and re-parsing after an extractor
     * fix would require the original file. It is protected by the same access
     * rules as the document, and never logged.
     */
    text: text('text').notNull(),
    confidence: real('confidence').notNull(),
    aiClassified: boolean('ai_classified').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index('document_sections_document_idx').on(table.documentId),
  }),
);

/** Per-document extraction, before merging into a profile. */
export const documentExtractions = pgTable(
  'document_extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => candidateDocuments.id, { onDelete: 'cascade' })
      .unique(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    experience: jsonb('experience').$type<ExperienceEntry[]>().notNull().default([]),
    education: jsonb('education').$type<EducationRecord[]>().notNull().default([]),
    certifications: jsonb('certifications').$type<CertificationRecord[]>().notNull().default([]),
    projects: jsonb('projects').$type<ProjectRecord[]>().notNull().default([]),
    achievements: jsonb('achievements').$type<AchievementRecord[]>().notNull().default([]),
    languages: jsonb('languages').$type<LanguageRecord[]>().notNull().default([]),
    skills: jsonb('skills').$type<CandidateSkillFact[]>().notNull().default([]),
    summary: text('summary'),

    extractionVersion: text('extraction_version').notNull(),
    taxonomyVersion: text('taxonomy_version').notNull(),
    extractionModel: text('extraction_model'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    candidateIdx: index('document_extractions_candidate_idx').on(table.candidateId),
  }),
);

// ── Versioned profile (Part 31) ─────────────────────────────────────────────

export const candidateIntelligenceProfiles = pgTable(
  'candidate_intelligence_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    profileVersion: integer('profile_version').notNull(),

    summary: text('summary'),
    summaryGenerated: boolean('summary_generated').notNull().default(true),

    skills: jsonb('skills').$type<CandidateSkillFact[]>().notNull().default([]),
    experience: jsonb('experience').$type<ExperienceEntry[]>().notNull().default([]),
    education: jsonb('education').$type<EducationRecord[]>().notNull().default([]),
    certifications: jsonb('certifications').$type<CertificationRecord[]>().notNull().default([]),
    projects: jsonb('projects').$type<ProjectRecord[]>().notNull().default([]),
    achievements: jsonb('achievements').$type<AchievementRecord[]>().notNull().default([]),
    languages: jsonb('languages').$type<LanguageRecord[]>().notNull().default([]),

    seniority: jsonb('seniority').$type<SeniorityEstimate>().notNull(),
    trajectory: jsonb('trajectory').$type<CareerTrajectory>().notNull(),
    quality: jsonb('quality').$type<ProfileQuality | null>(),

    sourceDocumentIds: jsonb('source_document_ids').$type<string[]>().notNull().default([]),
    openConflicts: smallint('open_conflicts').notNull().default(0),

    extractionVersion: text('extraction_version').notNull(),
    taxonomyVersion: text('taxonomy_version').notNull(),
    extractionModel: text('extraction_model'),

    /** Exactly one version per candidate is active; the rest are history. */
    isActive: boolean('is_active').notNull().default(false),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionUnique: unique('candidate_intelligence_version_unique').on(
      table.candidateId,
      table.profileVersion,
    ),
    activeIdx: index('candidate_intelligence_active_idx').on(table.candidateId, table.isActive),
  }),
);

/**
 * Skill facts, denormalised out of the profile JSON.
 *
 * The profile row is the record; this table exists so matching can answer
 * "which candidates evidence Kubernetes" with an index rather than by scanning
 * JSON. It is rebuilt whenever a profile version becomes active.
 */
export const candidateSkillFacts = pgTable(
  'candidate_skill_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    profileVersion: integer('profile_version').notNull(),

    slug: text('slug').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull().default('other'),

    proficiency: text('proficiency'),
    proficiencyConfidence: real('proficiency_confidence').notNull().default(0),
    proficiencyRationale: text('proficiency_rationale').notNull().default(''),

    totalMonths: integer('total_months'),
    monthsIsEstimate: boolean('months_is_estimate').notNull().default(false),
    lastEvidencedAt: timestamp('last_evidenced_at', { withTimezone: true }),
    firstEvidencedAt: timestamp('first_evidenced_at', { withTimezone: true }),

    evidence: jsonb('evidence').$type<EvidenceItem[]>().notNull().default([]),
    strongestSource: text('strongest_source'),
    userVerified: boolean('user_verified').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUnique: unique('candidate_skill_facts_unique').on(
      table.candidateId,
      table.profileVersion,
      table.slug,
    ),
    lookupIdx: index('candidate_skill_facts_lookup_idx').on(table.slug, table.candidateId),
  }),
);

// ── Conflicts and overrides (Parts 32, 34) ──────────────────────────────────

export const profileConflicts = pgTable(
  'profile_conflicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    positions: jsonb('positions').$type<unknown[]>().notNull(),
    detail: text('detail').notNull(),

    status: text('status').notNull().default('open'),
    resolvedValue: text('resolved_value'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    openIdx: index('profile_conflicts_open_idx').on(table.candidateId, table.status),
    /*
     * The same contradiction detected on two runs is one conflict. Without this
     * a candidate who re-uploads sees the same question three times.
     */
    subjectUnique: unique('profile_conflicts_subject_unique').on(
      table.candidateId,
      table.kind,
      table.subject,
    ),
  }),
);

export const profileFieldOverrides = pgTable(
  'profile_field_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    /** Dotted path into the profile: `skills.react.proficiency`. */
    path: text('path').notNull(),
    value: jsonb('value'),
    previousValue: jsonb('previous_value'),
    origin: text('origin').notNull().default('user_verified'),
    note: text('note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** One override per path — a correction replaces the previous correction. */
    pathUnique: unique('profile_field_overrides_path_unique').on(table.candidateId, table.path),
  }),
);

// ── Requirement matrices (Parts 26–29, 37) ──────────────────────────────────

export const requirementMatrices = pgTable(
  'requirement_matrices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    rows: jsonb('rows').$type<unknown[]>().notNull().default([]),
    directMatches: smallint('direct_matches').notNull().default(0),
    transferableMatches: smallint('transferable_matches').notNull().default(0),
    unknowns: smallint('unknowns').notNull().default(0),
    missing: smallint('missing').notNull().default(0),
    coverageScore: real('coverage_score').notNull().default(0),

    /** Which profile produced this, so a stale matrix is detectable. */
    profileVersion: integer('profile_version'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pairUnique: unique('requirement_matrices_pair_unique').on(
      table.candidateId,
      table.jobId,
      table.profileVersion,
    ),
    jobIdx: index('requirement_matrices_job_idx').on(table.jobId),
  }),
);

// ── External profiles (Parts 18, 19) ────────────────────────────────────────

/**
 * Public portfolio and repository sources the candidate has told us about.
 *
 * Only what the candidate explicitly links, and only public data through
 * documented APIs. Nothing here scrapes an authenticated surface or a profile
 * the candidate has not named.
 */
export const externalProfiles = pgTable(
  'external_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    provider: text('provider').notNull(),
    /** The candidate's handle or the URL they supplied. */
    identifier: text('identifier').notNull(),
    url: text('url').notNull(),

    status: text('status').notNull().default('pending'),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    lastError: text('last_error'),

    /** Normalised result: languages, repositories, topics. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** Skill evidence derived from it, kept separate from resume evidence. */
    derivedSkills: jsonb('derived_skills').$type<CandidateSkillFact[]>().notNull().default([]),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerUnique: unique('external_profiles_unique').on(
      table.candidateId,
      table.provider,
      table.identifier,
    ),
  }),
);

export type CandidateDocumentRow = typeof candidateDocuments.$inferSelect;
export type CandidateIntelligenceRow = typeof candidateIntelligenceProfiles.$inferSelect;
export type ProfileConflictRow = typeof profileConflicts.$inferSelect;
export type RequirementMatrixRow = typeof requirementMatrices.$inferSelect;
export type ExternalProfileRow = typeof externalProfiles.$inferSelect;

/** Narrowing helper so repositories can round-trip the profile JSON safely. */
export type StoredIntelligence = Omit<CandidateIntelligence, 'computedAt'> & { computedAt: Date };
