import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  CoverageGap,
  DiscoveryQuery,
  DiscoveryMethod,
  SourceCapabilities,
} from '@job-intel/contracts';
import { jobSources } from './sources';
import { candidateProfiles } from './identity';

/**
 * Discovery framework state.
 *
 * Deliberately *additive*. `job_sources` and `job_source_runs` already model a
 * source, its schedule, its health and its run history, and duplicating any of
 * that here would create two answers to the same question. What is genuinely
 * new is:
 *
 *  - **Protocol state per resource.** A source can poll several URLs, each with
 *    its own ETag. `job_sources.cursor` is one opaque connector-defined blob and
 *    cannot express that.
 *  - **Queries as first-class rows.** Generated from preferences, executed
 *    against sources, and measured — which is what makes coverage reportable
 *    rather than assertable.
 *  - **Companies and user-submitted URLs**, which are *inputs* to source
 *    creation rather than sources themselves.
 */

// ── Checkpoints (Parts 13, 38) ──────────────────────────────────────────────

export const sourceCheckpoints = pgTable(
  'source_checkpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id')
      .notNull()
      .references(() => jobSources.id, { onDelete: 'cascade' }),
    /** The specific URL or endpoint this checkpoint describes. */
    resource: text('resource').notNull(),

    etag: text('etag'),
    lastModified: text('last_modified'),
    contentHash: text('content_hash'),
    cursor: text('cursor'),
    lastItemId: text('last_item_id'),
    lastItemAt: timestamp('last_item_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    /** Consecutive 304s or identical hashes. Drives adaptive slowdown. */
    unchangedStreak: integer('unchanged_streak').notNull().default(0),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One checkpoint per resource per source: the uniqueness that makes
    // "have I already seen this exact body" answerable in one query.
    unique('source_checkpoints_resource_key').on(t.sourceId, t.resource),
    index('source_checkpoints_source_idx').on(t.sourceId),
  ],
);

// ── Source capabilities (Part 2) ────────────────────────────────────────────

/**
 * Declared capabilities per source.
 *
 * Stored rather than derived from the connector because a *source* can be more
 * limited than its connector: the same RSS connector serves a feed that carries
 * ETags and one that does not, and the scheduler needs the per-source truth.
 */
export const sourceCapabilities = pgTable(
  'source_capabilities',
  {
    sourceId: text('source_id')
      .primaryKey()
      .references(() => jobSources.id, { onDelete: 'cascade' }),
    capabilities: jsonb('capabilities').$type<SourceCapabilities>().notNull().default({} as SourceCapabilities),
    /** Mechanisms this source can be driven by, cheapest first. */
    methods: text('methods').array().$type<DiscoveryMethod[]>().notNull().default([]),
    /** The mechanism actually in use, so a downgrade is visible. */
    activeMethod: text('active_method').$type<DiscoveryMethod>(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    detail: text('detail'),
  },
);

// ── Discovery queries (Parts 3–5, 33) ───────────────────────────────────────

export const discoveryQueries = pgTable(
  'discovery_queries',
  {
    /** Semantic hash from the planner — the same intent is one row forever. */
    id: text('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    text: text('text').notNull(),
    kind: text('kind').notNull(),
    priority: text('priority').notNull(),
    score: real('score').notNull().default(0),
    terms: jsonb('terms').$type<DiscoveryQuery['terms']>().notNull(),
    rationale: text('rationale').notNull().default(''),

    /** Preference version this query was generated from. */
    preferenceVersion: integer('preference_version'),

    // ── Observed performance, updated after each execution ────────────────
    executions: integer('executions').notNull().default(0),
    jobsDiscovered: integer('jobs_discovered').notNull().default(0),
    jobsMatched: integer('jobs_matched').notNull().default(0),
    lastExecutedAt: timestamp('last_executed_at', { withTimezone: true }),
    lastResultCount: integer('last_result_count'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => [
    index('discovery_queries_profile_idx').on(t.profileId, t.priority, t.score),
    index('discovery_queries_executed_idx').on(t.lastExecutedAt),
  ],
);

// ── Telemetry (Parts 35, 41) ────────────────────────────────────────────────

/**
 * One discovery operation.
 *
 * Finer-grained than `job_source_runs`: a single run of a search source
 * executes twenty queries, and "which query produced nothing" is not
 * answerable from a run-level row.
 */
export const discoveryTelemetry = pgTable(
  'discovery_telemetry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id').references(() => jobSources.id, { onDelete: 'cascade' }),
    runId: uuid('run_id'),
    method: text('method').$type<DiscoveryMethod>().notNull(),
    queryId: text('query_id'),
    queryText: text('query_text'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    status: text('status').notNull().default('running'),

    requests: integer('requests').notNull().default(0),
    results: integer('results').notNull().default(0),
    uniqueResults: integer('unique_results').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    rateLimitEvents: integer('rate_limit_events').notNull().default(0),
    /** 304s and identical bodies: requests the system correctly skipped. */
    notModified: integer('not_modified').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    detail: text('detail').notNull().default(''),
  },
  (t) => [
    index('discovery_telemetry_source_idx').on(t.sourceId, t.startedAt),
    index('discovery_telemetry_query_idx').on(t.queryId),
    index('discovery_telemetry_started_idx').on(t.startedAt),
  ],
);

// ── Coverage (Parts 33, 34) ─────────────────────────────────────────────────

export const coverageSnapshots = pgTable(
  'coverage_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    windowHours: integer('window_hours').notNull(),

    sourcesSearched: integer('sources_searched').notNull().default(0),
    sourcesAvailable: integer('sources_available').notNull().default(0),
    queriesExecuted: integer('queries_executed').notNull().default(0),
    uniqueJobsDiscovered: integer('unique_jobs_discovered').notNull().default(0),
    searchedShare: real('searched_share').notNull().default(0),
    productiveShare: real('productive_share').notNull().default(0),

    items: jsonb('items').$type<unknown[]>().notNull().default([]),
    gaps: jsonb('gaps').$type<CoverageGap[]>().notNull().default([]),

    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('coverage_snapshots_profile_idx').on(t.profileId, t.generatedAt)],
);

// ── Monitored companies (Parts 9, 10) ───────────────────────────────────────

export const monitoredCompanies = pgTable(
  'monitored_companies',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    domain: text('domain'),
    careersUrl: text('careers_url'),
    atsProvider: text('ats_provider'),
    atsIdentifier: text('ats_identifier'),
    status: text('status').notNull().default('pending'),
    /** Set once resolution produced a real source row. */
    sourceId: text('source_id').references(() => jobSources.id, { onDelete: 'set null' }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    detail: text('detail').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('monitored_companies_status_idx').on(t.status),
    unique('monitored_companies_domain_key').on(t.domain),
  ],
);

// ── User-provided sources (Parts 23, 24) ────────────────────────────────────

/**
 * A URL an operator submitted.
 *
 * Kept separate from `job_sources` on purpose: a submission is a *request* that
 * has not been validated, and mixing unvalidated rows into the table the
 * scheduler reads is how a typo becomes a crawler.
 */
export const userProvidedSources = pgTable(
  'user_provided_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    url: text('url').notNull(),
    displayName: text('display_name'),
    requestedSourceType: text('requested_source_type'),
    scanFrequencyMinutes: integer('scan_frequency_minutes').notNull().default(360),
    searchTerms: text('search_terms').array().notNull().default([]),
    location: text('location'),
    enabled: boolean('enabled').notNull().default(true),
    notes: text('notes'),

    status: text('status').notNull().default('pending_validation'),
    /** The detector's full findings, kept for the UI and for re-review. */
    detection: jsonb('detection').$type<Record<string, unknown>>(),
    rejectionReason: text('rejection_reason'),
    /** Set once activation created a real source. */
    sourceId: text('source_id').references(() => jobSources.id, { onDelete: 'set null' }),

    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
  },
  (t) => [
    unique('user_provided_sources_url_key').on(t.url),
    index('user_provided_sources_status_idx').on(t.status),
  ],
);

// ── Source performance (Part 29) ────────────────────────────────────────────

export const sourcePerformance = pgTable(
  'source_performance',
  {
    sourceId: text('source_id')
      .primaryKey()
      .references(() => jobSources.id, { onDelete: 'cascade' }),
    windowDays: smallint('window_days').notNull().default(30),

    runs: integer('runs').notNull().default(0),
    averageJobsPerRun: real('average_jobs_per_run').notNull().default(0),
    duplicateRate: real('duplicate_rate').notNull().default(0),
    validJobRate: real('valid_job_rate').notNull().default(0),
    enrichmentSuccessRate: real('enrichment_success_rate').notNull().default(0),
    matchRate: real('match_rate').notNull().default(0),
    staleRate: real('stale_rate').notNull().default(0),
    errorRate: real('error_rate').notNull().default(0),
    averageLatencyMs: integer('average_latency_ms').notNull().default(0),
    /** 0–100, combining the above. Drives adaptive scheduling. */
    valueScore: real('value_score').notNull().default(0),
    explanation: text('explanation').notNull().default(''),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('source_performance_value_idx').on(t.valueScore)],
);
