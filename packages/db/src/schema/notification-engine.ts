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
import type { NotificationPreferences } from '@job-intel/contracts';
import {
  alertPriorityEnum,
  deliveryEventEnum,
  notificationChannelEnum,
  notificationDecisionEnum,
  notificationStatusEnum,
  notificationTypeEnum,
} from './enums';
import { jobs } from './jobs';
import { candidateProfiles } from './identity';
import { jobSources } from './sources';

/**
 * Notification-engine persistence.
 *
 * Four things live here that the prompt-2 tables could not express: the
 * candidate's preferences, the decision trace, per-event delivery tracking, and
 * a job-level ledger keyed on the **canonical** job id.
 *
 * That last point is the one that stops the spam. A job re-found through a
 * second source is a different `jobs` row with the same canonical id; keying the
 * ledger on the row would email about it again, and a database constraint is
 * the only place that guarantee survives a concurrent worker.
 */

/** One row per candidate. Preferences are data, so changing them is a write. */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    profileId: uuid('profile_id')
      .primaryKey()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    /** Validated against `notificationPreferencesSchema` on every read. */
    payload: jsonb('payload').$type<NotificationPreferences>().notNull(),
    /** Promoted for the scheduler's "who is due?" query. */
    digestEnabled: boolean('digest_enabled').notNull().default(true),
    digestFrequency: text('digest_frequency').notNull().default('daily'),
    timezone: text('timezone').notNull().default('UTC'),
    lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
    lastWeeklySummaryAt: timestamp('last_weekly_summary_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_preferences_due_idx').on(t.digestEnabled, t.lastDigestAt)],
);

/**
 * Why every candidate was or was not notified.
 *
 * Written for suppressions too, which is the entire point: "why didn't I hear
 * about this job?" is unanswerable from a log line that was never emitted, and
 * a system that deliberately stays quiet has to be able to account for it.
 */
export const notificationDecisions = pgTable(
  'notification_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
    /** Dedup key. Equals `job_id` for an unmerged job. */
    canonicalJobId: uuid('canonical_job_id').references(() => jobs.id, { onDelete: 'cascade' }),

    outcome: notificationDecisionEnum('outcome').notNull(),
    priority: alertPriorityEnum('priority'),
    reason: text('reason').notNull(),

    recommendationScore: real('recommendation_score'),
    matchScore: real('match_score'),
    confidence: real('confidence'),

    /** Set when the decision releases the job later, e.g. after quiet hours. */
    deferredUntil: timestamp('deferred_until', { withTimezone: true }),
    /** The notification this decision produced, when it produced one. */
    notificationId: uuid('notification_id'),
    engineVersion: text('engine_version').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notification_decisions_profile_idx').on(t.profileId, t.decidedAt),
    /** Powers "why wasn't I told about this job?" directly. */
    index('notification_decisions_job_idx').on(t.jobId, t.decidedAt),
    index('notification_decisions_outcome_idx').on(t.profileId, t.outcome, t.decidedAt),
  ],
);

/**
 * A notification event: one rendered message, before any channel is attempted.
 *
 * Separate from `notification_deliveries` so a digest that succeeds by email
 * and fails by some future channel is representable, and so the rendered
 * payload survives for the history UI even when every delivery failed.
 */
export const notificationEvents = pgTable(
  'notification_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    priority: alertPriorityEnum('priority').notNull().default('NORMAL'),
    subject: text('subject').notNull(),

    jobIds: uuid('job_ids').array().notNull().default([]),
    canonicalJobIds: uuid('canonical_job_ids').array().notNull().default([]),

    /** Rendered once and stored, so a retry never re-renders differently. */
    html: text('html').notNull(),
    textBody: text('text_body').notNull(),
    /** Stable across re-renders of identical content; the send key. */
    idempotencyKey: text('idempotency_key').notNull(),

    /** Everything the templates were given, for the preview and for debugging. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    engineVersion: text('engine_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_events_idempotency_unique').on(t.idempotencyKey),
    index('notification_events_profile_idx').on(t.profileId, t.createdAt),
    index('notification_events_type_idx').on(t.profileId, t.type, t.createdAt),
  ],
);

/** One attempt on one channel. Retries update this row rather than adding one. */
export const notificationChannelDeliveries = pgTable(
  'notification_channel_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => notificationEvents.id, { onDelete: 'cascade' }),
    channel: notificationChannelEnum('channel').notNull().default('email'),
    recipient: text('recipient').notNull(),
    status: notificationStatusEnum('status').notNull().default('queued'),

    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),

    providerId: text('provider_id'),
    providerMessageId: text('provider_message_id'),
    /** Unique: the database-level guarantee against a double send. */
    idempotencyKey: text('idempotency_key').notNull(),

    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_channel_deliveries_idem_unique').on(t.idempotencyKey),
    index('notification_channel_deliveries_event_idx').on(t.eventId),
    /** The worker's queue: what is due for another attempt. */
    index('notification_channel_deliveries_pending_idx').on(t.status, t.nextAttemptAt),
    index('notification_channel_deliveries_provider_idx').on(t.providerMessageId),
  ],
);

/**
 * The delivery timeline. Append-only.
 *
 * `opened` and `clicked` arrive only from providers that report them, and
 * nothing in the system requires them — open tracking is a nice-to-have, not a
 * dependency, and a provider that offers none must still work completely.
 */
export const notificationDeliveryEvents = pgTable(
  'notification_delivery_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => notificationChannelDeliveries.id, { onDelete: 'cascade' }),
    event: deliveryEventEnum('event').notNull(),
    detail: text('detail'),
    providerMessageId: text('provider_message_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_delivery_events_delivery_idx').on(t.deliveryId, t.occurredAt)],
);

/**
 * One row per (candidate, canonical job) once notified.
 *
 * The anti-spam guarantee, enforced by a unique constraint rather than an
 * application check so it holds under concurrent workers and retry storms.
 * `contentFingerprint` is what the job looked like when sent, so a later
 * material change is detectable without diffing the whole record.
 */
export const notifiedJobs = pgTable(
  'notified_jobs',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    canonicalJobId: uuid('canonical_job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    firstNotifiedAt: timestamp('first_notified_at', { withTimezone: true }).notNull().defaultNow(),
    lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }).notNull().defaultNow(),
    notificationCount: integer('notification_count').notNull().default(1),
    lastPriority: alertPriorityEnum('last_priority').notNull().default('NORMAL'),
    lastScore: real('last_score'),
    contentFingerprint: text('content_fingerprint'),
    lastEventId: uuid('last_event_id'),
  },
  (t) => [
    uniqueIndex('notified_jobs_unique').on(t.profileId, t.canonicalJobId),
    index('notified_jobs_recent_idx').on(t.profileId, t.lastNotifiedAt),
  ],
);

/**
 * Alert-state per source, so a failing connector is reported once rather than
 * hourly. `alertedAtFailures` records the count at the last alert; re-alerting
 * requires the failures to have climbed materially since.
 */
export const sourceAlertState = pgTable(
  'source_alert_state',
  {
    sourceId: text('source_id')
      .primaryKey()
      .references(() => jobSources.id, { onDelete: 'cascade' }),
    alertedAtFailures: integer('alerted_at_failures'),
    lastAlertedAt: timestamp('last_alerted_at', { withTimezone: true }),
    lastSeverity: text('last_severity'),
    recoveredAt: timestamp('recovered_at', { withTimezone: true }),
  },
  (t) => [index('source_alert_state_alerted_idx').on(t.lastAlertedAt)],
);

export const notificationEventsRelations = relations(notificationEvents, ({ many, one }) => ({
  deliveries: many(notificationChannelDeliveries),
  profile: one(candidateProfiles, {
    fields: [notificationEvents.profileId],
    references: [candidateProfiles.id],
  }),
}));

export const notificationChannelDeliveriesRelations = relations(
  notificationChannelDeliveries,
  ({ one, many }) => ({
    event: one(notificationEvents, {
      fields: [notificationChannelDeliveries.eventId],
      references: [notificationEvents.id],
    }),
    events: many(notificationDeliveryEvents),
  }),
);

export const notifiedJobsRelations = relations(notifiedJobs, ({ one }) => ({
  job: one(jobs, { fields: [notifiedJobs.canonicalJobId], references: [jobs.id] }),
  profile: one(candidateProfiles, {
    fields: [notifiedJobs.profileId],
    references: [candidateProfiles.id],
  }),
}));
