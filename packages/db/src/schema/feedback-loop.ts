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
  Experiment,
  FeatureAffinity,
  LearningConfig,
  PreferenceSuggestion,
} from '@job-intel/contracts';
import { candidateProfiles } from './identity';
import { jobs } from './jobs';
import { jobSources } from './sources';

/**
 * The feedback loop.
 *
 * Two structural decisions carry the absolute principle:
 *
 *  1. **`behavior_events` is append-only.** Nothing updates a row. An unsave is
 *     a new event, not a deletion — which is what makes the whole history
 *     replayable when the algorithm version changes, and what makes "what did
 *     the system know last Tuesday" answerable.
 *
 *  2. **Learned state never touches preference tables.** `feature_affinities`
 *     and `behavioral_profiles` are separate tables with no write path into
 *     `candidate_preference_versions`. A learned signal reaches a preference
 *     only by becoming a row in `preference_suggestions` that a person accepts.
 *
 * `behavioral_signals` from prompt 5 is deliberately left alone rather than
 * migrated: it is a narrower, still-used record, and rewriting history to fit a
 * new schema is exactly what point 3 of the brief rules out. New ingestion
 * writes here.
 */

// ── Events (Parts 1–4) ──────────────────────────────────────────────────────

export const behaviorEvents = pgTable(
  'behavior_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    /**
     * Nullable: some events (an email open) are about a notification rather
     * than a specific job, and forcing a job id would mean inventing one.
     */
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'cascade' }),

    eventType: text('event_type').notNull(),
    context: text('context').notNull().default('UNKNOWN'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    /** Opaque and rotating. Never an identifier for a person. */
    sessionId: text('session_id'),
    notificationId: uuid('notification_id'),
    recommendationId: text('recommendation_id'),
    /** Rank the job was shown at, for Precision@K. */
    shownAtRank: integer('shown_at_rank'),

    rejectionReason: text('rejection_reason'),
    reasonText: text('reason_text'),

    experimentId: text('experiment_id'),
    variant: text('variant'),

    metadata: jsonb('metadata').$type<Record<string, string | number | boolean>>().notNull().default({}),

    /**
     * Idempotency key for at-least-once ingestion.
     *
     * A retried enqueue must not become a second click. Unique rather than
     * checked in application code, because a uniqueness rule enforced by
     * convention is a rule that eventually loses a race.
     */
    dedupeKey: text('dedupe_key'),

    /** Set once the event has been folded into the behavioural profile. */
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    index('behavior_events_candidate_idx').on(t.candidateId, t.occurredAt),
    index('behavior_events_job_idx').on(t.jobId),
    index('behavior_events_type_idx').on(t.eventType, t.occurredAt),
    index('behavior_events_unprocessed_idx').on(t.processedAt),
    index('behavior_events_recommendation_idx').on(t.recommendationId),
    unique('behavior_events_dedupe_key').on(t.dedupeKey),
  ],
);

// ── Learned state (Parts 10–13) ─────────────────────────────────────────────

export const featureAffinities = pgTable(
  'feature_affinities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    dimension: text('dimension').notNull(),
    value: text('value').notNull(),

    /** -1..1 */
    affinity: real('affinity').notNull().default(0),
    /** 0..1 — what the ranking layer actually multiplies by. */
    confidence: real('confidence').notNull().default(0),
    sampleSize: integer('sample_size').notNull().default(0),
    positiveEvents: integer('positive_events').notNull().default(0),
    negativeEvents: integer('negative_events').notNull().default(0),
    /** Σ decayed evidence weight. The denominator behind both numbers above. */
    evidence: real('evidence').notNull().default(0),

    firstObservedAt: timestamp('first_observed_at', { withTimezone: true }),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }),
    lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),

    /** True when this contradicts something explicit. Surfaced, never applied. */
    conflictsWithExplicit: boolean('conflicts_with_explicit').notNull().default(false),
    explicitValue: text('explicit_value'),

    algorithmVersion: text('algorithm_version').notNull(),
    featureVersion: text('feature_version').notNull(),
  },
  (t) => [
    // One row per (candidate, dimension, value): the natural key that makes
    // incremental merging an upsert rather than a read-modify-write race.
    unique('feature_affinities_key').on(t.candidateId, t.dimension, t.value),
    index('feature_affinities_candidate_idx').on(t.candidateId, t.confidence),
    index('feature_affinities_conflict_idx').on(t.candidateId, t.conflictsWithExplicit),
  ],
);

export const behavioralProfiles = pgTable('behavioral_profiles', {
  candidateId: uuid('candidate_id')
    .primaryKey()
    .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

  totalEvents: integer('total_events').notNull().default(0),
  distinctJobs: integer('distinct_jobs').notNull().default(0),
  firstEventAt: timestamp('first_event_at', { withTimezone: true }),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),

  /** False during cold start, with the reason stated rather than implied. */
  hasSufficientData: boolean('has_sufficient_data').notNull().default(false),
  coldStartReason: text('cold_start_reason'),

  algorithmVersion: text('algorithm_version').notNull(),
  featureVersion: text('feature_version').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Per-candidate learning settings. Separate from app config: this is theirs. */
export const learningSettings = pgTable('learning_settings', {
  candidateId: uuid('candidate_id')
    .primaryKey()
    .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
  config: jsonb('config').$type<LearningConfig>().notNull().default({} as LearningConfig),
  /** Bumped on every change, so a stored affinity can be traced to its config. */
  configurationVersion: integer('configuration_version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Suggestions (Parts 27–28) ───────────────────────────────────────────────

export const preferenceSuggestions = pgTable(
  'preference_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    path: text('path').notNull(),
    operation: text('operation').notNull(),
    currentValue: jsonb('current_value'),
    suggestedValue: jsonb('suggested_value'),
    message: text('message').notNull(),
    evidence: jsonb('evidence').$type<PreferenceSuggestion['evidence']>().notNull(),
    confidence: real('confidence').notNull().default(0),

    /** pending | accepted | declined | dismissed | expired */
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    /** Set when accepted: the preference version the write produced. */
    appliedVersion: integer('applied_version'),

    algorithmVersion: text('algorithm_version').notNull(),
  },
  (t) => [
    index('preference_suggestions_candidate_idx').on(t.candidateId, t.status),
    // One live suggestion per path: re-running the generator must not stack up
    // duplicates of the same question.
    unique('preference_suggestions_open_key').on(t.candidateId, t.path, t.status),
  ],
);

// ── Query and source learning (Parts 20–23) ─────────────────────────────────

export const queryPerformance = pgTable(
  'query_performance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    queryId: text('query_id').notNull(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    jobsDiscovered: integer('jobs_discovered').notNull().default(0),
    jobsMatched: integer('jobs_matched').notNull().default(0),
    jobsShown: integer('jobs_shown').notNull().default(0),
    views: integer('views').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),
    saves: integer('saves').notNull().default(0),
    applications: integer('applications').notNull().default(0),
    rejections: integer('rejections').notNull().default(0),

    engagementRate: real('engagement_rate').notNull().default(0),
    valueScore: real('value_score').notNull().default(0),
    explanation: text('explanation').notNull().default(''),
    windowDays: smallint('window_days').notNull().default(30),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('query_performance_key').on(t.queryId, t.candidateId),
    index('query_performance_value_idx').on(t.candidateId, t.valueScore),
  ],
);

/**
 * Source value *to this candidate*.
 *
 * Deliberately a different table from `source_performance` (prompt 10), which
 * measures technical reliability. A source can score 95 there and 12 here, and
 * that gap is the finding — not a contradiction to be averaged away.
 */
export const sourceUserValue = pgTable(
  'source_user_value',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id')
      .notNull()
      .references(() => jobSources.id, { onDelete: 'cascade' }),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    jobsDiscovered: integer('jobs_discovered').notNull().default(0),
    jobsShown: integer('jobs_shown').notNull().default(0),
    views: integer('views').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),
    saves: integer('saves').notNull().default(0),
    applications: integer('applications').notNull().default(0),
    rejections: integer('rejections').notNull().default(0),

    engagementRate: real('engagement_rate').notNull().default(0),
    userValueScore: real('user_value_score').notNull().default(0),
    explanation: text('explanation').notNull().default(''),
    windowDays: smallint('window_days').notNull().default(30),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('source_user_value_key').on(t.sourceId, t.candidateId),
    index('source_user_value_score_idx').on(t.candidateId, t.userValueScore),
  ],
);

// ── Analytics (Parts 39–40) ─────────────────────────────────────────────────

export const engagementSnapshots = pgTable(
  'engagement_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    windowDays: smallint('window_days').notNull(),

    recommendationsShown: integer('recommendations_shown').notNull().default(0),
    jobsViewed: integer('jobs_viewed').notNull().default(0),
    jobsClicked: integer('jobs_clicked').notNull().default(0),
    jobsSaved: integer('jobs_saved').notNull().default(0),
    jobsRejected: integer('jobs_rejected').notNull().default(0),
    jobsApplied: integer('jobs_applied').notNull().default(0),

    viewRate: real('view_rate').notNull().default(0),
    clickRate: real('click_rate').notNull().default(0),
    saveRate: real('save_rate').notNull().default(0),
    applicationRate: real('application_rate').notNull().default(0),
    acceptanceRate: real('acceptance_rate').notNull().default(0),
    rejectionRate: real('rejection_rate').notNull().default(0),

    /** Precision@K and friends, keyed by k. */
    rankingQuality: jsonb('ranking_quality').$type<unknown[]>().notNull().default([]),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('engagement_snapshots_candidate_idx').on(t.candidateId, t.computedAt)],
);

// ── Experiments (Part 41) ───────────────────────────────────────────────────

export const experiments = pgTable('experiments', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hypothesis: text('hypothesis').notNull().default(''),
  status: text('status').notNull().default('draft'),
  variants: jsonb('variants').$type<Experiment['variants']>().notNull().default([]),
  /**
   * Explicit enrolment only.
   *
   * An empty array means nobody is in the experiment, which is the correct
   * default: defining an experiment must never be enough to start running it
   * on a real person.
   */
  enrolledCandidateIds: uuid('enrolled_candidate_ids').array().notNull().default([]),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Convenience type re-exports for repository code. */
export type StoredFeatureAffinity = typeof featureAffinities.$inferSelect;
export type StoredBehaviorEvent = typeof behaviorEvents.$inferSelect;
export type { FeatureAffinity };
