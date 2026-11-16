import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import {
  BEHAVIORAL_EVENTS,
  CV_IMPORT_STATUSES,
  PREFERENCE_SOURCES,
  PREFERENCE_STRENGTHS,
  SKILL_IMPORTANCE,
  SKILL_PROFICIENCIES,
  SKILL_RELATION_TYPES,
  type CandidatePreferences,
  type CvExtraction,
} from '@job-intel/contracts';
import { candidateProfiles, skills } from './identity';
import { jobs } from './jobs';

export const preferenceStrengthEnum = pgEnum('preference_strength', PREFERENCE_STRENGTHS);
export const preferenceSourceEnum = pgEnum('preference_source', PREFERENCE_SOURCES);
export const skillProficiencyEnum = pgEnum('skill_proficiency', SKILL_PROFICIENCIES);
export const skillImportanceEnum = pgEnum('skill_importance', SKILL_IMPORTANCE);
export const skillRelationTypeEnum = pgEnum('skill_relation_type', SKILL_RELATION_TYPES);
export const behavioralEventEnum = pgEnum('behavioral_event', BEHAVIORAL_EVENTS);
export const cvImportStatusEnum = pgEnum('cv_import_status', CV_IMPORT_STATUSES);

/**
 * Versioned candidate preferences.
 *
 * Kept separate from `profile_versions` on purpose. Identity and professional
 * history change rarely; preferences change constantly, and mixing them would
 * mean every "raise my salary floor" created a new copy of the whole CV.
 *
 * Append-only: exactly one row per profile has `is_active`. A change is a new
 * row plus a flag flip, which is what lets an old match still be explained by
 * the preferences that produced it.
 */
export const candidatePreferenceVersions = pgTable(
  'candidate_preference_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** Validated against `candidatePreferencesSchema` on every read and write. */
    payload: jsonb('payload').$type<CandidatePreferences>().notNull(),
    isActive: boolean('is_active').notNull().default(false),
    changeSummary: text('change_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by'),
  },
  (t) => [
    uniqueIndex('candidate_preference_versions_unique').on(t.profileId, t.version),
    index('candidate_preference_versions_active_idx').on(t.profileId, t.isActive),
  ],
);

/**
 * Field-level change log.
 *
 * The version table answers "what were the preferences on 17 August"; this
 * answers "what exactly changed, and when". Both are needed to explain why an
 * older match scored the way it did.
 */
export const preferenceChanges = pgTable(
  'preference_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').references(() => candidatePreferenceVersions.id, {
      onDelete: 'cascade',
    }),
    /** Dot path, e.g. "salary.minimum" or "countries[Germany].strength". */
    path: text('path').notNull(),
    beforeValue: jsonb('before_value'),
    afterValue: jsonb('after_value'),
    summary: text('summary').notNull(),
    /** Whether this change invalidated the profile embedding. */
    invalidatedEmbedding: boolean('invalidated_embedding').notNull().default(false),
    changedBy: text('changed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('preference_changes_profile_idx').on(t.profileId, t.createdAt),
    index('preference_changes_path_idx').on(t.path),
  ],
);

/**
 * Candidate skills, richer than a join table.
 *
 * Proficiency and recency are separate from mere presence: listing a technology
 * says the candidate touched it, not that they are strong at it. Imports land
 * unrated until a human confirms.
 */
export const candidateSkillProfiles = pgTable(
  'candidate_skill_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    /** Resolved against the canonical vocabulary when possible. */
    skillId: uuid('skill_id').references(() => skills.id, { onDelete: 'set null' }),

    name: text('name').notNull(),
    slug: text('slug'),
    category: text('category'),
    proficiency: skillProficiencyEnum('proficiency'),
    yearsOfExperience: real('years_of_experience'),
    lastUsedYear: integer('last_used_year'),
    importance: skillImportanceEnum('importance').notNull().default('secondary'),
    evidence: text('evidence'),
    source: preferenceSourceEnum('source').notNull().default('explicit'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('candidate_skill_profiles_unique').on(t.profileId, t.name),
    index('candidate_skill_profiles_slug_idx').on(t.slug),
    index('candidate_skill_profiles_importance_idx').on(t.profileId, t.importance),
  ],
);

/**
 * Skill relationship graph.
 *
 * Data, not code: adding "Svelte implies JavaScript" is a row. The seed set
 * ships in the candidate package and is loaded here so it can be extended at
 * runtime without a release.
 */
export const skillRelations = pgTable(
  'skill_relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromSlug: text('from_slug').notNull(),
    toSlug: text('to_slug').notNull(),
    type: skillRelationTypeEnum('type').notNull(),
    weight: real('weight').notNull().default(0.5),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('skill_relations_unique').on(t.fromSlug, t.toSlug, t.type),
    index('skill_relations_from_idx').on(t.fromSlug),
  ],
);

/**
 * Behavioural events.
 *
 * Append-only and strictly separate from preferences. Nothing in this table
 * ever writes to `candidate_preference_versions`; it is read to compute learned
 * signals, which are offered as suggestions and never applied automatically.
 */
export const behavioralSignals = pgTable(
  'behavioral_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    event: behavioralEventEnum('event').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('behavioral_signals_profile_idx').on(t.profileId, t.occurredAt),
    index('behavioral_signals_job_idx').on(t.jobId),
    index('behavioral_signals_event_idx').on(t.event),
  ],
);

/**
 * Candidate profile embedding.
 *
 * `canonical_hash` is the hash of the text the vector was generated from, which
 * makes staleness a string comparison rather than a guess. `model` is stored
 * because distances are not comparable across models — a model change
 * invalidates every vector.
 */
export const candidateEmbeddings = pgTable(
  'candidate_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    /** Null while regeneration is queued but not yet complete. */
    embedding: vector('embedding', { dimensions: 1536 }),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    canonicalHash: text('canonical_hash').notNull(),
    canonicalText: text('canonical_text').notNull(),
    /** Set when a change invalidated the vector and regeneration is pending. */
    isStale: boolean('is_stale').notNull().default(true),
    staleReason: text('stale_reason'),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('candidate_embeddings_profile_model_unique').on(t.profileId, t.model),
    index('candidate_embeddings_stale_idx').on(t.isStale),
  ],
);

/**
 * CV imports.
 *
 * The extraction is held here, never merged into the profile automatically.
 * `needs_review` is the terminal state until a human accepts it — blindly
 * overwriting a curated profile with model output would destroy work the
 * candidate did by hand.
 */
export const cvImports = pgTable(
  'cv_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Extracted plain text, kept for re-parsing with improved extractors. */
    rawText: text('raw_text'),
    status: cvImportStatusEnum('status').notNull().default('uploaded'),
    extraction: jsonb('extraction').$type<CvExtraction | null>(),
    extractionError: text('extraction_error'),
    /** Which extracted sections the candidate accepted. */
    acceptedSections: text('accepted_sections').array().notNull().default([]),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('cv_imports_profile_idx').on(t.profileId, t.createdAt),
    index('cv_imports_status_idx').on(t.status),
  ],
);

export const candidatePreferenceVersionsRelations = relations(
  candidatePreferenceVersions,
  ({ one, many }) => ({
    profile: one(candidateProfiles, {
      fields: [candidatePreferenceVersions.profileId],
      references: [candidateProfiles.id],
    }),
    changes: many(preferenceChanges),
  }),
);

export const preferenceChangesRelations = relations(preferenceChanges, ({ one }) => ({
  version: one(candidatePreferenceVersions, {
    fields: [preferenceChanges.versionId],
    references: [candidatePreferenceVersions.id],
  }),
}));

export const candidateSkillProfilesRelations = relations(candidateSkillProfiles, ({ one }) => ({
  profile: one(candidateProfiles, {
    fields: [candidateSkillProfiles.profileId],
    references: [candidateProfiles.id],
  }),
  skill: one(skills, { fields: [candidateSkillProfiles.skillId], references: [skills.id] }),
}));

export const behavioralSignalsRelations = relations(behavioralSignals, ({ one }) => ({
  job: one(jobs, { fields: [behavioralSignals.jobId], references: [jobs.id] }),
}));
