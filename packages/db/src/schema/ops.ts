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
  uuid,
} from 'drizzle-orm/pg-core';
import type { PipelineStageStatus, RunTimelineEntry } from '@job-intel/contracts';
import {
  aiOperationEnum,
  auditActionEnum,
  pipelineRunStatusEnum,
  pipelineRunTriggerEnum,
} from './enums';
import { jobSources } from './sources';

/**
 * Operations persistence.
 *
 * Everything the control centre reports comes from these tables plus the ones
 * the pipeline already writes. Nothing is computed from a hardcoded constant,
 * which is what makes an empty system report zeros rather than something that
 * merely looks alive.
 */

/**
 * One end-to-end pipeline execution.
 *
 * Distinct from `job_source_runs`, which records one connector's work. A
 * pipeline run spans discovery through notification and is the record the run
 * history page lists — "what happened at 08:00" is a question about the whole
 * pass, not about LinkedIn.
 */
export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trigger: pipelineRunTriggerEnum('trigger').notNull().default('SCHEDULED'),
    status: pipelineRunStatusEnum('status').notNull().default('running'),
    /** True when the run deliberately performed no writes or sends. */
    dryRun: boolean('dry_run').notNull().default(false),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),

    jobsDiscovered: integer('jobs_discovered').notNull().default(0),
    jobsProcessed: integer('jobs_processed').notNull().default(0),
    jobsMatched: integer('jobs_matched').notNull().default(0),
    jobsRecommended: integer('jobs_recommended').notNull().default(0),
    duplicatesDetected: integer('duplicates_detected').notNull().default(0),

    errorCount: integer('error_count').notNull().default(0),
    warningCount: integer('warning_count').notNull().default(0),

    /** Per-stage counters, for the pipeline visualisation. */
    stages: jsonb('stages').$type<PipelineStageStatus[]>().notNull().default([]),
    /** Ordered events, for the run-detail timeline. */
    timeline: jsonb('timeline').$type<RunTimelineEntry[]>().notNull().default([]),

    triggeredBy: text('triggered_by'),
    note: text('note'),
    traceId: text('trace_id'),
  },
  (t) => [
    index('pipeline_runs_started_idx').on(t.startedAt),
    index('pipeline_runs_status_idx').on(t.status, t.startedAt),
    index('pipeline_runs_trigger_idx').on(t.trigger, t.startedAt),
    index('pipeline_runs_trace_idx').on(t.traceId),
  ],
);

/**
 * Every model call, priced at the time it happened.
 *
 * `costUsd` is stored rather than derived on read: prices change, and a cost
 * report that silently rewrites last month's bill when a provider updates its
 * rate card is worse than no report. `priced` records whether a rate was
 * actually known — an unpriced call reports as unknown, never as free.
 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operation: aiOperationEnum('operation').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),

    calls: integer('calls').notNull().default(1),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 8 }).notNull().default('0'),
    /** False when no rate was configured for the model at that moment. */
    priced: boolean('priced').notNull().default(true),

    latencyMs: integer('latency_ms'),
    succeeded: boolean('succeeded').notNull().default(true),
    errorMessage: text('error_message'),

    jobId: uuid('job_id'),
    runId: uuid('run_id'),
    sourceId: text('source_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_usage_occurred_idx').on(t.occurredAt),
    index('ai_usage_operation_idx').on(t.operation, t.occurredAt),
    index('ai_usage_model_idx').on(t.model, t.occurredAt),
    index('ai_usage_run_idx').on(t.runId),
  ],
);

/**
 * Manual changes, append-only.
 *
 * `before` and `after` are both stored: "who changed the alert threshold" is
 * only half the question, and a record carrying only the new value cannot
 * answer the useful half.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: auditActionEnum('action').notNull(),
    actor: text('actor').notNull(),
    target: text('target'),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    requestId: text('request_id'),
    /** Coarse only — never a full address, which would be personal data. */
    userAgent: text('user_agent'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_occurred_idx').on(t.occurredAt),
    index('audit_log_action_idx').on(t.action, t.occurredAt),
    index('audit_log_actor_idx').on(t.actor, t.occurredAt),
    index('audit_log_target_idx').on(t.target),
  ],
);

/**
 * Latency and counter samples.
 *
 * Raw samples rather than pre-aggregated buckets, because p95 and p99 cannot be
 * recovered from an average. Retention is bounded by the maintenance job — this
 * table is the highest-volume one in the system.
 */
export const metricSamples = pgTable(
  'metric_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operation: text('operation').notNull(),
    valueMs: real('value_ms').notNull(),
    succeeded: boolean('succeeded').notNull().default(true),
    sourceId: text('source_id'),
    runId: uuid('run_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('metric_samples_operation_idx').on(t.operation, t.occurredAt),
    index('metric_samples_occurred_idx').on(t.occurredAt),
  ],
);

/**
 * HTTP outcomes per source, for the rate-limit dashboard.
 *
 * Rolled up per hour rather than stored per request: the useful question is
 * "are we being throttled by this host?", and a row per request would dwarf the
 * jobs table within a week.
 */
export const rateLimitEvents = pgTable(
  'rate_limit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id')
      .notNull()
      .references(() => jobSources.id, { onDelete: 'cascade' }),
    domain: text('domain'),
    /** Truncated to the hour; one row per (source, domain, hour). */
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),

    requests: integer('requests').notNull().default(0),
    succeeded: integer('succeeded').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    rateLimited: integer('rate_limited').notNull().default(0),

    backoffUntil: timestamp('backoff_until', { withTimezone: true }),
    remainingQuota: integer('remaining_quota'),
  },
  (t) => [
    index('rate_limit_events_source_window_idx').on(t.sourceId, t.windowStart),
    index('rate_limit_events_window_idx').on(t.windowStart),
  ],
);
