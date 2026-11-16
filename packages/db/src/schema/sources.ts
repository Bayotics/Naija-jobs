import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { RunErrorDetail, SourceConfig, SourceLimits } from '@job-intel/contracts';
import {
  accessTierEnum,
  circuitStateEnum,
  runStatusEnum,
  runTriggerEnum,
  sourceHealthEnum,
  sourceTypeEnum,
} from './enums';

/**
 * Job sources and their run history.
 *
 * A source row binds a connector implementation to a configuration, a schedule
 * and a priority. Adding a source is an INSERT, not a deploy — which is the
 * property that keeps job sources out of the core business logic.
 */
export const jobSources = pgTable(
  'job_sources',
  {
    /** Human-chosen stable key, e.g. "greenhouse:eu-startups". */
    id: text('id').primaryKey(),
    /** Which connector implementation runs this source. */
    connectorId: text('connector_id').notNull(),
    displayName: text('display_name').notNull(),
    sourceType: sourceTypeEnum('source_type').notNull(),
    accessTier: accessTierEnum('access_tier').notNull(),

    enabled: boolean('enabled').notNull().default(true),
    /** 0 = highest. Drives default schedule cadence. */
    priority: smallint('priority').notNull().default(2),
    scheduleCron: text('schedule_cron').notNull().default('0 * * * *'),

    /** Connector-specific settings. Validated by the connector's own schema. */
    config: jsonb('config').$type<SourceConfig>().notNull().default({}),
    limits: jsonb('limits').$type<SourceLimits>().notNull().default({} as SourceLimits),
    /**
     * Environment variable *names* only. Values are resolved at run time from
     * the process environment, so a database dump never contains a credential.
     */
    credentialRefs: text('credential_refs').array().notNull().default([]),

    baseUrl: text('base_url'),
    /** Why a `restricted` source is permanently off, shown in the UI. */
    restrictionReason: text('restriction_reason'),
    notes: text('notes'),

    // ── Operational state (mutable; distinct from configuration above) ──────
    healthStatus: sourceHealthEnum('health_status').notNull().default('unknown'),
    circuitState: circuitStateEnum('circuit_state').notNull().default('closed'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    circuitOpenedAt: timestamp('circuit_opened_at', { withTimezone: true }),
    lastAttemptedRunAt: timestamp('last_attempted_run_at', { withTimezone: true }),
    lastSuccessfulRunAt: timestamp('last_successful_run_at', { withTimezone: true }),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastErrorMessage: text('last_error_message'),
    /** Incremental watermark carried between runs. */
    cursor: jsonb('cursor').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete: run history and discovered jobs must survive removal. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    index('job_sources_enabled_idx').on(t.enabled, t.priority),
    index('job_sources_connector_idx').on(t.connectorId),
    index('job_sources_health_idx').on(t.healthStatus),
  ],
);

/**
 * One discovery execution.
 *
 * Counters are granular by design: a run that discovers 200 and accepts 3 is
 * healthy, while one that discovers 0 with successful HTTP requests almost
 * always means the source changed its markup.
 */
export const jobSourceRuns = pgTable(
  'job_source_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id')
      .notNull()
      .references(() => jobSources.id, { onDelete: 'cascade' }),
    trigger: runTriggerEnum('trigger').notNull().default('schedule'),
    status: runStatusEnum('status').notNull().default('running'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),

    jobsDiscovered: integer('jobs_discovered').notNull().default(0),
    jobsAccepted: integer('jobs_accepted').notNull().default(0),
    jobsRejected: integer('jobs_rejected').notNull().default(0),
    jobsUpdated: integer('jobs_updated').notNull().default(0),
    jobsDuplicated: integer('jobs_duplicated').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    httpRequests: integer('http_requests').notNull().default(0),
    bytesFetched: bigint('bytes_fetched', { mode: 'number' }).notNull().default(0),

    errors: jsonb('errors').$type<RunErrorDetail[]>().notNull().default([]),
    traceId: text('trace_id'),
  },
  (t) => [
    index('job_source_runs_source_started_idx').on(t.sourceId, t.startedAt),
    index('job_source_runs_status_idx').on(t.status),
    index('job_source_runs_trace_idx').on(t.traceId),
  ],
);

export const jobSourcesRelations = relations(jobSources, ({ many }) => ({
  runs: many(jobSourceRuns),
}));

export const jobSourceRunsRelations = relations(jobSourceRuns, ({ one }) => ({
  source: one(jobSources, { fields: [jobSourceRuns.sourceId], references: [jobSources.id] }),
}));
