import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { systemEventNameEnum, systemEventSeverityEnum } from './enums';

/**
 * Durable, queryable event stream.
 *
 * Logs answer "what is happening right now"; this table answers "what happened
 * to this job three weeks ago", which is the question the observability
 * requirements actually ask. Indexed by trace so one posting's whole journey is
 * a single query.
 */
export const systemEvents = pgTable(
  'system_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: systemEventNameEnum('name').notNull(),
    severity: systemEventSeverityEnum('severity').notNull().default('info'),
    message: text('message'),
    traceId: text('trace_id'),
    sourceId: text('source_id'),
    jobId: uuid('job_id'),
    runId: uuid('run_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('system_events_name_created_idx').on(t.name, t.createdAt),
    index('system_events_trace_idx').on(t.traceId),
    index('system_events_job_idx').on(t.jobId),
    index('system_events_source_idx').on(t.sourceId, t.createdAt),
    index('system_events_severity_idx').on(t.severity, t.createdAt),
  ],
);

/**
 * Runtime application configuration — layer 2 of the config model.
 *
 * Deliberately *not* env vars: everything here must be changeable from the UI
 * without a redeploy. Keys are dotted paths ("matching.minimumScore") deep-merged
 * onto the code defaults in `@job-intel/config`.
 *
 * Note what must never appear here: secrets, and candidate preferences.
 */
export const appConfig = pgTable('app_config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});
