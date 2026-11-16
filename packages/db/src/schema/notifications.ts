import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  notificationChannelEnum,
  notificationKindEnum,
  notificationStatusEnum,
} from './enums';
import { jobs } from './jobs';

/**
 * A notification is a batch; a delivery is one attempt on one channel.
 * Splitting them means a digest that succeeds by email and fails by Telegram is
 * representable, and retries are per-channel rather than all-or-nothing.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: notificationKindEnum('kind').notNull().default('digest'),
    subject: text('subject').notNull(),
    jobIds: uuid('job_ids').array().notNull().default([]),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_scheduled_idx').on(t.scheduledFor)],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    channel: notificationChannelEnum('channel').notNull(),
    recipient: text('recipient').notNull(),
    status: notificationStatusEnum('status').notNull().default('queued'),
    providerMessageId: text('provider_message_id'),
    attempts: integer('attempts').notNull().default(0),
    /** Guards against double-send across retries and process restarts. */
    idempotencyKey: text('idempotency_key').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_deliveries_idempotency_unique').on(t.idempotencyKey),
    index('notification_deliveries_status_idx').on(t.status),
    index('notification_deliveries_notification_idx').on(t.notificationId),
  ],
);

/**
 * Hard guarantee that a job is never notified twice on a channel.
 *
 * A database constraint rather than an application check, so it holds even when
 * the application is wrong — retry storms and concurrent workers included.
 */
export const notificationLedger = pgTable(
  'notification_ledger',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    channel: notificationChannelEnum('channel').notNull(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('notification_ledger_job_channel_unique').on(t.jobId, t.channel)],
);

export const notificationsRelations = relations(notifications, ({ many }) => ({
  deliveries: many(notificationDeliveries),
}));

export const notificationDeliveriesRelations = relations(notificationDeliveries, ({ one }) => ({
  notification: one(notifications, {
    fields: [notificationDeliveries.notificationId],
    references: [notifications.id],
  }),
}));
