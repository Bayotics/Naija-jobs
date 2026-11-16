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
import { jobSources, jobSourceRuns } from './sources';
import { jobs } from './jobs';

/**
 * Persistence for the acquisition layer.
 *
 * Three tables, each answering a question the existing schema could not.
 *
 * `raw_source_documents` keeps what was retrieved apart from what was
 * understood, so an improved parser can be replayed over history rather than
 * only applying to jobs discovered after the fix.
 *
 * `job_change_events` records what changed about a posting between two reads,
 * which is what makes "the salary on that job you saved has been published"
 * possible without re-notifying about every reworded paragraph.
 *
 * `source_reliability_windows` accumulates the counters behind the health
 * score. Kept as windows rather than as running totals on the source row
 * because a source that failed for a week in March should not still be
 * dragging its score down in August.
 */

/**
 * What was actually retrieved.
 *
 * `raw_postings` already stores one parsed item's payload; this stores the
 * whole HTTP response that produced it — usually one document per request
 * rather than one per posting. A careers page yielding forty jobs is one row
 * here and forty there.
 *
 * Content lives inline when small and in object storage when not, addressed
 * either way through `storage_reference`. The pipeline does not change when
 * that threshold moves.
 */
export const rawSourceDocuments = pgTable(
  'raw_source_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id')
      .notNull()
      .references(() => jobSources.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => jobSourceRuns.id, { onDelete: 'set null' }),

    requestId: text('request_id').notNull(),
    url: text('url').notNull(),

    /** `inline:` or an object-storage key. */
    storageReference: text('storage_reference').notNull(),
    inlineContent: text('inline_content'),

    contentType: text('content_type').notNull().default('application/octet-stream'),
    contentHash: text('content_hash').notNull(),
    byteLength: integer('byte_length').notNull().default(0),
    httpStatus: integer('http_status').notNull().default(200),

    acquisitionMethod: text('acquisition_method').notNull().default('PERMITTED_HTML'),
    parserVersion: text('parser_version').notNull().default('1.0.0'),

    retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull().defaultNow(),
    traceId: text('trace_id'),
  },
  (t) => [
    /*
     * Idempotency as a constraint rather than as application logic.
     *
     * A retried run re-fetching an unchanged page must not create a second
     * document. Enforcing that in code means enforcing it in every caller and
     * losing the race between two workers; enforcing it here means it is simply
     * true.
     */
    uniqueIndex('raw_source_documents_hash_unique').on(t.sourceId, t.contentHash),
    index('raw_source_documents_url_idx').on(t.url),
    index('raw_source_documents_retrieved_idx').on(t.retrievedAt),
    index('raw_source_documents_run_idx').on(t.runId),
  ],
);

/**
 * What changed about a posting between two reads.
 *
 * One row per detected change set, with the individual field changes as JSON:
 * they are read together, always, and normalising them into a child table would
 * buy nothing but a join.
 *
 * `material` is stored rather than derived on read so the notification layer
 * can index on it. The vast majority of change sets are immaterial, and
 * scanning them all to find the few that matter would make the query that runs
 * most often the slowest one.
 */
export const jobChangeEvents = pgTable(
  'job_change_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => jobSources.id, { onDelete: 'cascade' }),

    previousContentHash: text('previous_content_hash').notNull(),
    currentContentHash: text('current_content_hash').notNull(),

    changes: jsonb('changes').notNull().default([]),
    material: boolean('material').notNull().default(false),

    /** Set once the notification layer has considered this change. */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),

    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * One row per job per transition, so re-running detection over the same two
     * versions cannot produce duplicate notifications.
     */
    uniqueIndex('job_change_events_transition_unique').on(
      t.jobId,
      t.previousContentHash,
      t.currentContentHash,
    ),
    index('job_change_events_material_idx').on(t.material, t.detectedAt),
    index('job_change_events_job_idx').on(t.jobId),
  ],
);

/**
 * Counters behind the source health score.
 *
 * Bucketed by hour. Fine enough to show a source degrading over a morning,
 * coarse enough that a year of twenty sources is a table you can still query
 * without thinking about it.
 */
export const sourceReliabilityWindows = pgTable(
  'source_reliability_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id')
      .notNull()
      .references(() => jobSources.id, { onDelete: 'cascade' }),

    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),

    requestsAttempted: integer('requests_attempted').notNull().default(0),
    requestsSucceeded: integer('requests_succeeded').notNull().default(0),
    requestsFailed: integer('requests_failed').notNull().default(0),

    itemsSeen: integer('items_seen').notNull().default(0),
    itemsParsed: integer('items_parsed').notNull().default(0),
    itemsRejected: integer('items_rejected').notNull().default(0),

    jobsYielded: integer('jobs_yielded').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    stale: integer('stale').notNull().default(0),
    falsePositives: integer('false_positives').notNull().default(0),

    rateLimitHits: integer('rate_limit_hits').notNull().default(0),
    timeouts: integer('timeouts').notNull().default(0),
    averageLatencyMs: real('average_latency_ms').notNull().default(0),
  },
  (t) => [
    uniqueIndex('source_reliability_window_unique').on(t.sourceId, t.windowStart),
    index('source_reliability_window_idx').on(t.windowStart),
  ],
);

/**
 * Where each source's last scan reached.
 *
 * One row per source rather than a column on `job_sources` because watermarks
 * are written on every run while the source row is mostly static — mixing a
 * hot-write column into a config row means every scan contends with every read
 * of the source registry.
 */
export const sourceWatermarks = pgTable(
  'source_watermarks',
  {
    sourceId: text('source_id')
      .primaryKey()
      .references(() => jobSources.id, { onDelete: 'cascade' }),

    lastSuccessfulScanAt: timestamp('last_successful_scan_at', { withTimezone: true }),
    lastSeenPublishedAt: timestamp('last_seen_published_at', { withTimezone: true }),
    lastSeenUpdatedAt: timestamp('last_seen_updated_at', { withTimezone: true }),

    lastCursor: text('last_cursor'),
    lastPage: integer('last_page'),
    lastItemId: text('last_item_id'),
    lastContentHash: text('last_content_hash'),

    /** Consecutive scans that produced nothing new. Drives adaptive backoff. */
    emptyScans: integer('empty_scans').notNull().default(0),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);
