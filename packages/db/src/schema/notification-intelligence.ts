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
  DeadlineAssessment,
  NotificationIntelligenceConfig,
  NotificationScore,
  RarityAssessment,
} from '@job-intel/contracts';
import { candidateProfiles } from './identity';
import { jobs } from './jobs';

/**
 * Notification intelligence storage.
 *
 * The design commitment here is that **every decision is recorded, including
 * the ones that produced nothing**. A notification system whose main behaviour
 * is staying quiet is only trustworthy if each silence can be explained weeks
 * later, and that is not possible from a log line nobody wrote.
 *
 * So `notification_suppressions` is expected to be the largest table in this
 * file by a wide margin. That is correct: most jobs do not deserve an email,
 * and the record of why is the product feature.
 */

// ── The notification entity (Part 1) ────────────────────────────────────────

export const notificationRecords = pgTable(
  'notification_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    /** Null for operational notifications that are not about a job. */
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'cascade' }),

    type: text('type').notNull(),
    priority: text('priority').notNull().default('NORMAL'),
    urgency: text('urgency').notNull().default('LOW'),
    channel: text('channel').notNull().default('email'),
    state: text('state').notNull().default('PENDING'),

    /** Shown to the candidate verbatim. See Part 30. */
    reason: text('reason').notNull().default(''),
    notificationScore: real('notification_score'),
    /** The full score breakdown, for the dashboard and for calibration. */
    scoreDetail: jsonb('score_detail').$type<NotificationScore | null>(),

    /** Digest membership. Several rows share one group. */
    groupId: uuid('group_id'),

    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** Unreliable by nature — clicks are the signal worth reading. */
    openedAt: timestamp('opened_at', { withTimezone: true }),
    clickedAt: timestamp('clicked_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    attempts: smallint('attempts').notNull().default(0),

    /**
     * Idempotency key for the queue.
     *
     * A unique index rather than an application check, for the same reason
     * every other idempotency guard in this system is one: at-least-once
     * delivery is the normal case, and a retried job that becomes two emails is
     * exactly the failure this whole layer exists to prevent.
     */
    dedupeKey: text('dedupe_key').notNull(),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dedupeUnique: unique('notification_records_dedupe_unique').on(table.dedupeKey),
    candidateIdx: index('notification_records_candidate_idx').on(table.candidateId, table.createdAt),
    stateIdx: index('notification_records_state_idx').on(table.state, table.scheduledAt),
    jobIdx: index('notification_records_job_idx').on(table.jobId),
    groupIdx: index('notification_records_group_idx').on(table.groupId),
    /** Drives the cooldown queries, which run on every scoring pass. */
    sentIdx: index('notification_records_sent_idx').on(table.candidateId, table.sentAt),
  }),
);

// ── Suppression trace (Parts 31, 32) ────────────────────────────────────────

export const notificationSuppressions = pgTable(
  'notification_suppressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    reason: text('reason').notNull(),
    detail: text('detail').notNull(),
    /** The setting responsible, so the UI can link straight to it. */
    setting: text('setting'),
    remedy: text('remedy'),

    notificationScore: real('notification_score'),
    thresholdApplied: real('threshold_applied'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /*
     * One current record per (candidate, job).
     *
     * Rewritten on each pass rather than appended: the candidate wants to know
     * why they are not hearing about a job *now*, and a hundred historical rows
     * saying "below threshold" answer a question nobody asked.
     */
    pairUnique: unique('notification_suppressions_pair_unique').on(table.candidateId, table.jobId),
    reasonIdx: index('notification_suppressions_reason_idx').on(table.candidateId, table.reason),
    occurredIdx: index('notification_suppressions_occurred_idx').on(table.occurredAt),
  }),
);

// ── Configuration and overrides ─────────────────────────────────────────────

export const notificationIntelligenceConfigs = pgTable('notification_intelligence_configs', {
  candidateId: uuid('candidate_id')
    .primaryKey()
    .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
  config: jsonb('config').$type<NotificationIntelligenceConfig>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notificationOverrides = pgTable(
  'notification_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    subject: text('subject').notNull(),
    value: text('value').notNull(),
    /** `never_alert` wins over `always_alert`. See the precedence note. */
    action: text('action').notNull(),
    note: text('note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ruleUnique: unique('notification_overrides_unique').on(
      table.candidateId,
      table.subject,
      table.value,
    ),
    lookupIdx: index('notification_overrides_lookup_idx').on(table.candidateId, table.subject),
  }),
);

// ── Delivery health (Parts 43, 44) ──────────────────────────────────────────

/*
 * Delivery events are NOT re-modelled here.
 *
 * Prompt 8 already owns `notification_delivery_events`, keyed on a channel
 * delivery. Adding a second table with the same name and a slightly different
 * shape would give the system two answers to "was this email delivered?", and
 * the two would drift the first time only one of them got updated.
 *
 * The new notification entity carries its own `sentAt` / `deliveredAt` /
 * `openedAt` / `clickedAt` / `failedAt` columns for its own lifecycle, and
 * deliverability *classification* — which the older table does not model — lives
 * in the address-health record below, where it actually gets used.
 */

/**
 * Per-address delivery health.
 *
 * `suppressed` is the switch that stops the system emailing an address that has
 * hard-bounced. The brief asks that permanent failures are not retried
 * endlessly, and the reason is not politeness: continuing to send to a dead
 * address damages the sender reputation that every *other* email depends on.
 */
export const notificationAddressHealth = pgTable('notification_address_health', {
  candidateId: uuid('candidate_id')
    .primaryKey()
    .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),

  suppressed: boolean('suppressed').notNull().default(false),
  suppressedReason: text('suppressed_reason'),

  hardBounces: integer('hard_bounces').notNull().default(0),
  softBounces: integer('soft_bounces').notNull().default(0),
  complaints: integer('complaints').notNull().default(0),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),

  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Rarity history (Part 10) ────────────────────────────────────────────────

/**
 * Rolling counts of what discovery has actually turned up.
 *
 * Rarity is measured against this rather than against a figure someone invented.
 * Written by the discovery pipeline as a cheap aggregate so the scorer never has
 * to scan the jobs table on the hot path.
 */
export const discoveryProfileCounts = pgTable(
  'discovery_profile_counts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    /** The day being counted, so the window is a range scan. */
    day: timestamp('day', { withTimezone: true }).notNull(),
    totalJobs: integer('total_jobs').notNull().default(0),
    /** Jobs matching every dimension the candidate asked for. */
    matchingAllDimensions: integer('matching_all_dimensions').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dayUnique: unique('discovery_profile_counts_day_unique').on(table.candidateId, table.day),
    windowIdx: index('discovery_profile_counts_window_idx').on(table.candidateId, table.day),
  }),
);

// ── Digest plans (Part 36) ──────────────────────────────────────────────────

export const digestPlans = pgTable(
  'digest_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    type: text('type').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),

    sections: jsonb('sections').$type<unknown[]>().notNull().default([]),
    totalJobs: smallint('total_jobs').notNull().default(0),
    /** Counts by reason, so the dashboard can show what was left out. */
    excluded: jsonb('excluded').$type<Record<string, number>>().notNull().default({}),

    notificationId: uuid('notification_id').references(() => notificationRecords.id, {
      onDelete: 'set null',
    }),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** One plan per (candidate, type, window) — regeneration is idempotent. */
    windowUnique: unique('digest_plans_window_unique').on(
      table.candidateId,
      table.type,
      table.windowStart,
    ),
    candidateIdx: index('digest_plans_candidate_idx').on(table.candidateId, table.generatedAt),
  }),
);

// ── Cached assessments ──────────────────────────────────────────────────────

/**
 * The most recent score per (candidate, job).
 *
 * Kept so re-notification can compare against what was scored last time, and so
 * the dashboard can rank without recomputing. Overwritten rather than appended:
 * the history that matters lives in `notification_records`.
 */
export const notificationScores = pgTable(
  'notification_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    score: real('score').notNull(),
    urgency: text('urgency').notNull().default('LOW'),
    opportunityValue: real('opportunity_value').notNull().default(0),
    confidence: real('confidence').notNull().default(0),

    deadline: jsonb('deadline').$type<DeadlineAssessment>().notNull(),
    rarity: jsonb('rarity').$type<RarityAssessment>().notNull(),
    factors: jsonb('factors').$type<unknown[]>().notNull().default([]),
    explanation: text('explanation').notNull().default(''),

    algorithmVersion: text('algorithm_version').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pairUnique: unique('notification_scores_pair_unique').on(table.candidateId, table.jobId),
    rankIdx: index('notification_scores_rank_idx').on(table.candidateId, table.score),
  }),
);

export type NotificationRecordRow = typeof notificationRecords.$inferSelect;
export type NotificationSuppressionRow = typeof notificationSuppressions.$inferSelect;
export type NotificationOverrideRow = typeof notificationOverrides.$inferSelect;
export type DigestPlanRow = typeof digestPlans.$inferSelect;
