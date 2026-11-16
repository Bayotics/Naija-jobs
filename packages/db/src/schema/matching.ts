import { relations } from 'drizzle-orm';
import {
  boolean,
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
} from 'drizzle-orm/pg-core';
import type {
  ComponentScore,
  HardConstraintResult,
  MatchTrace,
  SkillMatchDetail,
} from '@job-intel/contracts';
import {
  applicationStateEnum,
  feedbackActionEnum,
  recommendationCategoryEnum,
} from './enums';
import { jobs } from './jobs';
import { candidateProfiles, profileVersions } from './identity';
import { candidatePreferenceVersions } from './candidate';

/**
 * Match results, feedback and applications.
 *
 * The defining constraint here is provenance. A score is a function of the job,
 * the profile version, the preference version, the enrichment version and the
 * engine version — so all five are stored on the row. That is what makes an old
 * score still interpretable after preferences change, what makes staleness a
 * query rather than a guess, and what turns "recompute everything" into
 * "recompute the rows whose inputs moved".
 *
 * The per-dimension breakdown is stored, not just the total. A single number
 * cannot answer "why 72?", and a match nobody can interrogate is a match nobody
 * should act on.
 */
export const jobMatches = pgTable(
  'job_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /**
     * The candidate. Present so the engine is multi-candidate by construction;
     * a single-profile shortcut here would be the hardest thing to undo later.
     */
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    profileVersionId: uuid('profile_version_id')
      .notNull()
      .references(() => profileVersions.id, { onDelete: 'cascade' }),
    preferenceVersionId: uuid('preference_version_id').references(
      () => candidatePreferenceVersions.id,
      { onDelete: 'set null' },
    ),

    overallScore: real('overall_score').notNull(),
    confidence: real('confidence').notNull(),
    recommendation: recommendationCategoryEnum('recommendation').notNull(),
    eligible: boolean('eligible').notNull(),

    /** The stages, kept apart so a divergence between them is detectable. */
    structuredScore: real('structured_score').notNull(),
    semanticScore: real('semantic_score'),
    behavioralAdjustment: real('behavioral_adjustment').notNull().default(0),
    llmAdjustment: real('llm_adjustment').notNull().default(0),

    hardConstraintResult: jsonb('hard_constraint_result')
      .$type<HardConstraintResult>()
      .notNull(),
    componentScores: jsonb('component_scores').$type<ComponentScore[]>().notNull().default([]),
    skillMatches: jsonb('skill_matches').$type<SkillMatchDetail[]>().notNull().default([]),

    matchedRequirements: text('matched_requirements').array().notNull().default([]),
    missingRequirements: text('missing_requirements').array().notNull().default([]),
    concerns: text('concerns').array().notNull().default([]),
    positiveSignals: text('positive_signals').array().notNull().default([]),
    negativeSignals: text('negative_signals').array().notNull().default([]),
    explanation: text('explanation').notNull().default(''),

    /** Full reconstruction of how the score was reached. */
    trace: jsonb('trace').$type<MatchTrace>().notNull(),

    /** Engine semver. A bump makes every older row stale by comparison. */
    matchingVersion: text('matching_version').notNull(),
    enrichmentVersion: integer('enrichment_version').notNull().default(0),

    modelId: text('model_id'),
    promptVersion: text('prompt_version'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    latencyMs: integer('latency_ms'),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One current match per (job, candidate). Recomputation upserts rather than
     * appending, so "the score" is never ambiguous; the previous value's
     * provenance is preserved in `trace` and in the history table.
     */
    uniqueIndex('job_matches_job_profile_unique').on(t.jobId, t.profileId),
    index('job_matches_score_idx').on(t.profileId, t.overallScore),
    index('job_matches_recommendation_idx').on(t.profileId, t.recommendation),
    index('job_matches_eligible_idx').on(t.profileId, t.eligible),
    /** Drives "which matches need recomputing after a version bump". */
    index('job_matches_version_idx').on(t.matchingVersion),
    index('job_matches_computed_idx').on(t.profileId, t.computedAt),
  ],
);

/**
 * Append-only score history.
 *
 * Exists so "this used to be a strong match — what changed?" is answerable.
 * Without it, an upsert silently destroys the only evidence that a preference
 * edit, a re-enrichment or an engine change moved the number, and every such
 * surprise becomes unfalsifiable.
 */
export const jobMatchHistory = pgTable(
  'job_match_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    overallScore: real('overall_score').notNull(),
    confidence: real('confidence').notNull(),
    recommendation: recommendationCategoryEnum('recommendation').notNull(),
    eligible: boolean('eligible').notNull(),
    matchingVersion: text('matching_version').notNull(),
    profileVersion: integer('profile_version').notNull().default(0),
    preferenceVersion: integer('preference_version').notNull().default(0),
    enrichmentVersion: integer('enrichment_version').notNull().default(0),
    /** Why this recomputation happened, e.g. "preferences changed to v7". */
    reason: text('reason'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('job_match_history_job_profile_idx').on(t.jobId, t.profileId, t.computedAt),
    index('job_match_history_profile_idx').on(t.profileId, t.computedAt),
  ],
);

/**
 * Append-only feedback. Never garbage-collected: this is the training data for
 * the learning loop, and it is the only data in the system that cannot be
 * re-derived from sources.
 */
export const jobFeedback = pgTable(
  'job_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    action: feedbackActionEnum('action').notNull(),
    reasonCodes: text('reason_codes').array().notNull().default([]),
    note: text('note'),
    /** dashboard | email_link | api */
    source: text('source').notNull().default('dashboard'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('job_feedback_job_idx').on(t.jobId),
    index('job_feedback_profile_created_idx').on(t.profileId, t.createdAt),
    index('job_feedback_action_idx').on(t.action),
  ],
);

/**
 * Current pipeline position for a job the candidate engaged with.
 *
 * Derived from feedback but stored explicitly, because "where am I with this
 * application" is a question asked far more often than it is written.
 */
export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    state: applicationStateEnum('state').notNull().default('new'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    notes: text('notes'),
    lastTransitionAt: timestamp('last_transition_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('applications_job_profile_unique').on(t.jobId, t.profileId),
    index('applications_state_idx').on(t.profileId, t.state),
  ],
);

export const jobMatchesRelations = relations(jobMatches, ({ one }) => ({
  job: one(jobs, { fields: [jobMatches.jobId], references: [jobs.id] }),
  profile: one(candidateProfiles, {
    fields: [jobMatches.profileId],
    references: [candidateProfiles.id],
  }),
  profileVersion: one(profileVersions, {
    fields: [jobMatches.profileVersionId],
    references: [profileVersions.id],
  }),
  preferenceVersion: one(candidatePreferenceVersions, {
    fields: [jobMatches.preferenceVersionId],
    references: [candidatePreferenceVersions.id],
  }),
}));

export const jobMatchHistoryRelations = relations(jobMatchHistory, ({ one }) => ({
  job: one(jobs, { fields: [jobMatchHistory.jobId], references: [jobs.id] }),
  profile: one(candidateProfiles, {
    fields: [jobMatchHistory.profileId],
    references: [candidateProfiles.id],
  }),
}));

export const jobFeedbackRelations = relations(jobFeedback, ({ one }) => ({
  job: one(jobs, { fields: [jobFeedback.jobId], references: [jobs.id] }),
  profile: one(candidateProfiles, {
    fields: [jobFeedback.profileId],
    references: [candidateProfiles.id],
  }),
}));

export const applicationsRelations = relations(applications, ({ one }) => ({
  job: one(jobs, { fields: [applications.jobId], references: [jobs.id] }),
  profile: one(candidateProfiles, {
    fields: [applications.profileId],
    references: [candidateProfiles.id],
  }),
}));
