import { z } from 'zod';
import {
  ACCESS_TIERS,
  CIRCUIT_STATES,
  RUN_STATUSES,
  RUN_TRIGGERS,
  SOURCE_HEALTH_STATUSES,
  SOURCE_TYPES,
  cronExpressionSchema,
} from './common';
import type { RawPosting } from './job';

/**
 * A JobSource binds a *connector implementation* to a *configuration*, a
 * *schedule* and a *priority*. Two rows using the same `connectorId` with
 * different configs are two independently scheduled, independently health-
 * tracked sources sharing one piece of code.
 *
 * Adding a source is therefore a database row, not a deploy.
 */

/**
 * Per-source politeness and safety limits. These belong to the source record
 * rather than to code so that a source that starts rate-limiting can be calmed
 * down from the UI at 3am without a release.
 */
export const sourceLimitsSchema = z.object({
  requestsPerMinute: z.number().int().min(1).max(600).default(30),
  dailyRequestCap: z.number().int().min(1).max(1_000_000).nullable().default(null),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
  maxRetries: z.number().int().min(0).max(10).default(3),
  /** Consecutive failures before the circuit opens and scheduling skips this source. */
  circuitBreakerThreshold: z.number().int().min(1).max(100).default(5),
  circuitCooldownSeconds: z.number().int().min(30).max(86_400).default(900),
  /** Randomised schedule offset, so every source does not fire on the hour together. */
  jitterSeconds: z.number().int().min(0).max(3_600).default(60),
});
export type SourceLimits = z.infer<typeof sourceLimitsSchema>;

/**
 * Connector-specific settings (company slugs, subreddits, queries, feed URLs,
 * countries…). Deliberately unconstrained here: each connector declares its own
 * Zod schema and validates this blob at registration time, which is also what
 * generates its settings form in the dashboard.
 *
 * Secrets never live here. A source references a *credential name*; the value
 * is resolved from the environment at run time. See `credentialRefs`.
 */
export const sourceConfigSchema = z.record(z.string(), z.unknown());
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export const jobSourceSchema = z.object({
  id: z.string().trim().min(1).max(100),
  connectorId: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(200),
  sourceType: z.enum(SOURCE_TYPES),
  accessTier: z.enum(ACCESS_TIERS),
  enabled: z.boolean().default(true),
  /**
   * 0 = highest. Drives default cadence: P0 sources are cheap, fresh and
   * high-signal (ATS APIs, mailbox); P3 are expensive or low-yield.
   */
  priority: z.number().int().min(0).max(3).default(2),
  scheduleCron: cronExpressionSchema.default('0 * * * *'),
  config: sourceConfigSchema.prefault({}),
  limits: sourceLimitsSchema.prefault({}),
  /**
   * Names of environment variables this source needs (e.g. ADZUNA_APP_KEY).
   * Only names are persisted — never values. A source whose credentials are
   * absent is reported unhealthy instead of crashing the worker.
   */
  credentialRefs: z.array(z.string().trim().min(1).max(100)).default([]),
  /** Populated for `restricted` sources so the UI can explain why it is off. */
  restrictionReason: z.string().trim().max(500).nullable().default(null),
  baseUrl: z.string().trim().url().nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
});
export type JobSource = z.infer<typeof jobSourceSchema>;

export const jobSourceCreateSchema = jobSourceSchema;
export const jobSourceUpdateSchema = jobSourceSchema
  .omit({ id: true, connectorId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type JobSourceUpdate = z.infer<typeof jobSourceUpdateSchema>;

/** Mutable operational state, kept separate from configuration. */
export const sourceHealthSchema = z.object({
  healthStatus: z.enum(SOURCE_HEALTH_STATUSES),
  circuitState: z.enum(CIRCUIT_STATES),
  consecutiveFailures: z.number().int().min(0),
  lastAttemptedRunAt: z.date().nullable(),
  lastSuccessfulRunAt: z.date().nullable(),
  lastErrorAt: z.date().nullable(),
  lastErrorMessage: z.string().nullable(),
});
export type SourceHealth = z.infer<typeof sourceHealthSchema>;

// ── Runs (Part 7) ───────────────────────────────────────────────────────────

/**
 * One discovery execution. Counters are deliberately granular: a run that
 * discovers 200 postings and accepts 3 is healthy, whereas one that discovers 0
 * while still making successful HTTP requests almost certainly means the source
 * changed its markup — the single highest-value alert in the system.
 */
export const sourceRunStatsSchema = z.object({
  jobsDiscovered: z.number().int().min(0).default(0),
  jobsAccepted: z.number().int().min(0).default(0),
  jobsRejected: z.number().int().min(0).default(0),
  jobsUpdated: z.number().int().min(0).default(0),
  jobsDuplicated: z.number().int().min(0).default(0),
  errorCount: z.number().int().min(0).default(0),
  httpRequests: z.number().int().min(0).default(0),
  bytesFetched: z.number().int().min(0).default(0),
});
export type SourceRunStats = z.infer<typeof sourceRunStatsSchema>;

export const runErrorDetailSchema = z.object({
  type: z.string().max(200),
  message: z.string().max(4000),
  retryable: z.boolean().default(false),
  occurredAt: z.date().default(() => new Date()),
  context: z.record(z.string(), z.unknown()).optional(),
});
export type RunErrorDetail = z.infer<typeof runErrorDetailSchema>;

export const jobSourceRunSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string(),
  trigger: z.enum(RUN_TRIGGERS),
  status: z.enum(RUN_STATUSES),
  startedAt: z.date(),
  completedAt: z.date().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  stats: sourceRunStatsSchema,
  errors: z.array(runErrorDetailSchema).default([]),
  traceId: z.string().nullable(),
});
export type JobSourceRun = z.infer<typeof jobSourceRunSchema>;

// ── Connector contract (implementations land in prompt 5) ───────────────────

export interface ConnectorCapabilities {
  supportsIncremental: boolean;
  supportsDetailFetch: boolean;
  supportsExpiryCheck: boolean;
  providesStructuredSalary: boolean;
  providesVisaFlag: boolean;
  requiresBrowser: boolean;
}

export interface ConnectorHealthResult {
  healthy: boolean;
  message?: string;
  checkedAt: Date;
}

/**
 * The single seam between "where jobs come from" and "what the system does with
 * them". A connector's only job is to yield `RawPosting`s; it must not
 * normalize, score, deduplicate, or know that matching exists.
 *
 * Declared here (in contracts) rather than in the connectors package so that
 * the database and API layers can reason about sources without depending on
 * any connector implementation.
 */
export interface Connector<TConfig = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly sourceType: (typeof SOURCE_TYPES)[number];
  readonly accessTier: (typeof ACCESS_TIERS)[number];
  readonly capabilities: ConnectorCapabilities;
  /** Validates `JobSource.config` and drives the generated settings form. */
  readonly configSchema: z.ZodType<TConfig>;

  healthCheck(ctx: ConnectorContext<TConfig>): Promise<ConnectorHealthResult>;
  /** Streams postings so memory stays flat regardless of source size. */
  discover(ctx: ConnectorContext<TConfig>): AsyncIterable<RawPosting>;
}

export interface ConnectorContext<TConfig> {
  readonly source: JobSource;
  readonly config: TConfig;
  /** Incremental watermark persisted between runs. */
  readonly cursor: Record<string, unknown> | null;
  readonly signal: AbortSignal;
  readonly traceId: string;
  getSecret(name: string): string | undefined;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: object): void;
}
