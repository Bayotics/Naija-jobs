import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  DedupSignalResult,
  Exposure,
  FreshnessScore,
  JobQuality,
  MergeConflict,
  RecommendationScore,
  RepostAssessment,
  ScamAssessment,
  StalenessVerdict,
} from '@job-intel/contracts';
import {
  duplicateTierEnum,
  exposureStateEnum,
  lifecycleStatusEnum,
  recommendationTierEnum,
  sourceAuthorityEnum,
  verificationOutcomeEnum,
} from './enums';
import { jobs } from './jobs';
import { candidateProfiles } from './identity';

/**
 * Recommendation-layer persistence.
 *
 * Split from `jobs` deliberately. These are *derived* signals with their own
 * recomputation cadence — freshness changes every hour without the posting
 * changing at all — and mixing them into the job row would make every freshness
 * recalculation a write to the table every other query joins against.
 */

/**
 * Per-job derived signals.
 *
 * One row per job, upserted. Cached rather than recomputed per candidate:
 * quality, freshness, staleness, scam risk and repost status are properties of
 * the *posting*, identical for every candidate, and recomputing them inside a
 * ranking loop is what turns a 10,000-job ranking into a slow one.
 */
export const jobSignals = pgTable(
  'job_signals',
  {
    jobId: uuid('job_id')
      .primaryKey()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    qualityScore: real('quality_score').notNull(),
    qualityConfidence: real('quality_confidence').notNull(),
    quality: jsonb('quality').$type<JobQuality>().notNull(),

    freshnessScore: real('freshness_score').notNull(),
    freshnessAgeHours: real('freshness_age_hours').notNull(),
    freshness: jsonb('freshness').$type<FreshnessScore>().notNull(),

    lifecycleStatus: lifecycleStatusEnum('lifecycle_status').notNull().default('ACTIVE'),
    lifecycle: jsonb('lifecycle').$type<StalenessVerdict>().notNull(),

    scamRisk: real('scam_risk').notNull().default(0),
    scam: jsonb('scam').$type<ScamAssessment>().notNull(),

    repostKind: text('repost_kind').notNull().default('new'),
    repost: jsonb('repost').$type<RepostAssessment>().notNull(),

    sourceAuthority: sourceAuthorityEnum('source_authority').notNull().default('medium'),
    /** Consecutive source runs in which the listing did not appear. */
    absenceRuns: integer('absence_runs').notNull().default(0),

    recommendationVersion: text('recommendation_version').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Drives "what is still worth showing" without touching the jobs table. */
    index('job_signals_lifecycle_idx').on(t.lifecycleStatus, t.freshnessScore),
    index('job_signals_quality_idx').on(t.qualityScore),
    index('job_signals_scam_idx').on(t.scamRisk),
    index('job_signals_freshness_idx').on(t.freshnessAgeHours),
    index('job_signals_version_idx').on(t.recommendationVersion),
  ],
);

/**
 * Pairwise duplicate findings.
 *
 * Stored even below the merge threshold. A near-miss is exactly what someone
 * needs to see when asking "why weren't these merged?", and discarding
 * everything that did not reach the bar leaves that question unanswerable.
 */
export const jobDuplicates = pgTable(
  'job_duplicates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** The record this one duplicates. Null while a group has no canonical yet. */
    duplicateOfJobId: uuid('duplicate_of_job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    tier: duplicateTierEnum('tier').notNull(),
    duplicateConfidence: real('duplicate_confidence').notNull(),
    duplicateReason: text('duplicate_reason').notNull(),
    /** Whether this finding was acted on, as opposed to merely recorded. */
    merged: boolean('merged').notNull().default(false),

    signals: jsonb('signals').$type<DedupSignalResult[]>().notNull().default([]),
    conflicts: jsonb('conflicts').$type<DedupSignalResult[]>().notNull().default([]),

    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One verdict per ordered pair; re-running upserts rather than appending. */
    uniqueIndex('job_duplicates_pair_unique').on(t.jobId, t.duplicateOfJobId),
    index('job_duplicates_job_idx').on(t.jobId, t.duplicateConfidence),
    index('job_duplicates_target_idx').on(t.duplicateOfJobId),
    index('job_duplicates_merged_idx').on(t.merged, t.tier),
  ],
);

/**
 * Merge decisions for a canonical group.
 *
 * The conflicts are the point: "LinkedIn says hybrid, the employer says remote"
 * is information the candidate needs, and a merge that silently picked one
 * would present a guess as a fact.
 */
export const jobGroupMerges = pgTable(
  'job_group_merges',
  {
    groupId: uuid('group_id').primaryKey(),
    canonicalJobId: uuid('canonical_job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    bestApplyUrl: text('best_apply_url'),
    bestApplyUrlSourceId: text('best_apply_url_source_id'),
    memberCount: integer('member_count').notNull().default(1),
    provenance: jsonb('provenance').$type<unknown[]>().notNull().default([]),
    conflicts: jsonb('conflicts').$type<MergeConflict[]>().notNull().default([]),
    mergedAt: timestamp('merged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('job_group_merges_canonical_idx').on(t.canonicalJobId)],
);

/**
 * Application-URL checks. Append-only.
 *
 * History rather than a single column, because one 500 is a blip and three in a
 * row is a closed job — a distinction that a last-result column cannot make.
 */
export const jobVerifications = pgTable(
  'job_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    outcome: verificationOutcomeEnum('outcome').notNull(),
    httpStatus: integer('http_status'),
    durationMs: integer('duration_ms').notNull().default(0),
    detail: text('detail'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('job_verifications_job_idx').on(t.jobId, t.checkedAt),
    index('job_verifications_outcome_idx').on(t.outcome, t.checkedAt),
  ],
);

/**
 * What a candidate has already seen of a job.
 *
 * The table that stops the same job being emailed every night. `notified_at`
 * plus `notified_content_hash` together answer "has this changed enough since
 * we last told them?", which no single field can.
 */
export const candidateJobExposure = pgTable(
  'candidate_job_exposure',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    state: exposureStateEnum('state').notNull().default('never_shown'),
    timesShown: integer('times_shown').notNull().default(0),
    firstShownAt: timestamp('first_shown_at', { withTimezone: true }),
    lastShownAt: timestamp('last_shown_at', { withTimezone: true }),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    notifiedContentHash: text('notified_content_hash'),
    notifiedScore: real('notified_score'),
    /** Snapshot of the material fields at notification, for change detection. */
    notifiedSnapshot: jsonb('notified_snapshot').$type<Record<string, unknown>>(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('candidate_job_exposure_unique').on(t.profileId, t.jobId),
    index('candidate_job_exposure_state_idx').on(t.profileId, t.state),
    index('candidate_job_exposure_notified_idx').on(t.profileId, t.notifiedAt),
  ],
);

/**
 * The ranked list, per candidate.
 *
 * Persisted rather than recomputed on read: the ranking is a property of the
 * *pool*, so "what was #1 last night?" cannot be reconstructed from the jobs
 * alone once the pool has moved on.
 */
export const jobRecommendations = pgTable(
  'job_recommendations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    rank: integer('rank').notNull(),
    finalScore: real('final_score').notNull(),
    rawScore: real('raw_score').notNull(),
    calibratedScore: real('calibrated_score').notNull(),
    diversityPenalty: real('diversity_penalty').notNull().default(0),
    tier: recommendationTierEnum('tier').notNull(),

    /** The match, copied and never modified by ranking. */
    matchScore: real('match_score').notNull(),
    matchConfidence: real('match_confidence').notNull(),

    score: jsonb('score').$type<RecommendationScore>().notNull(),
    exposure: jsonb('exposure').$type<Exposure>().notNull(),
    rankExplanation: text('rank_explanation').notNull().default(''),
    rankReasons: text('rank_reasons').array().notNull().default([]),

    notificationEligible: boolean('notification_eligible').notNull().default(false),
    notificationBlockers: text('notification_blockers').array().notNull().default([]),

    recommendationVersion: text('recommendation_version').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('job_recommendations_profile_job_unique').on(t.profileId, t.jobId),
    /** The digest query: best first, for one candidate. */
    index('job_recommendations_rank_idx').on(t.profileId, t.rank),
    index('job_recommendations_score_idx').on(t.profileId, t.finalScore),
    index('job_recommendations_tier_idx').on(t.profileId, t.tier, t.finalScore),
    index('job_recommendations_notifiable_idx').on(
      t.profileId,
      t.notificationEligible,
      t.finalScore,
    ),
    index('job_recommendations_computed_idx').on(t.profileId, t.computedAt),
  ],
);

/** One ranking pass, for the run report and for reproducing a past digest. */
export const recommendationRuns = pgTable(
  'recommendation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    considered: integer('considered').notNull().default(0),
    ranked: integer('ranked').notNull().default(0),
    suppressed: integer('suppressed').notNull().default(0),
    notifiable: integer('notifiable').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    /** Distribution health — see `describeDistribution`. */
    distribution: jsonb('distribution').$type<Record<string, unknown>>().notNull().default({}),
    recommendationVersion: text('recommendation_version').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('recommendation_runs_profile_idx').on(t.profileId, t.startedAt)],
);

export const jobSignalsRelations = relations(jobSignals, ({ one }) => ({
  job: one(jobs, { fields: [jobSignals.jobId], references: [jobs.id] }),
}));

export const jobRecommendationsRelations = relations(jobRecommendations, ({ one }) => ({
  job: one(jobs, { fields: [jobRecommendations.jobId], references: [jobs.id] }),
  profile: one(candidateProfiles, {
    fields: [jobRecommendations.profileId],
    references: [candidateProfiles.id],
  }),
}));

export const candidateJobExposureRelations = relations(candidateJobExposure, ({ one }) => ({
  job: one(jobs, { fields: [candidateJobExposure.jobId], references: [jobs.id] }),
  profile: one(candidateProfiles, {
    fields: [candidateJobExposure.profileId],
    references: [candidateProfiles.id],
  }),
}));
