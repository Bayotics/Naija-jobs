import { z } from 'zod';

/**
 * Operations control-centre contracts.
 *
 * The governing requirement is stated in the brief and is stricter than it
 * sounds: **every important operation must be observable.** Not "loggable" —
 * observable, meaning the answer to "why did this job get 91?" or "why wasn't
 * I emailed about it?" is a query, not an investigation.
 *
 * Two rules shape everything here:
 *
 *  1. **No fabricated numbers.** Every metric is derived from stored state. An
 *     empty system reports zeros, never plausible-looking placeholders — a
 *     dashboard that looks alive when nothing is running is worse than one that
 *     admits it, because it is trusted right up until it matters.
 *  2. **Degraded, not broken.** A failing email provider must produce a red
 *     status card, not a 500. Every component reports its own health and the
 *     page composes whatever it gets.
 */

export const OPS_VERSION = '1.0.0';

// ── Component health ────────────────────────────────────────────────────────

export const COMPONENT_STATUSES = ['healthy', 'degraded', 'down', 'unknown', 'disabled'] as const;
export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];

export const STATUS_RANK: Readonly<Record<ComponentStatus, number>> = {
  healthy: 0,
  unknown: 1,
  disabled: 1,
  degraded: 2,
  down: 3,
};

export const componentHealthSchema = z.object({
  component: z.string().max(60),
  status: z.enum(COMPONENT_STATUSES),
  detail: z.string().max(400),
  /** Round-trip time of the probe, when one was made. */
  latencyMs: z.number().min(0).nullable().default(null),
  checkedAt: z.coerce.date(),
});
export type ComponentHealth = z.infer<typeof componentHealthSchema>;

export const systemHealthSchema = z.object({
  status: z.enum(COMPONENT_STATUSES),
  components: z.array(componentHealthSchema).default([]),
  /** Plain-language summary of the worst thing currently wrong. */
  summary: z.string().max(400),
  checkedAt: z.coerce.date(),
});
export type SystemHealth = z.infer<typeof systemHealthSchema>;

// ── Pipeline ────────────────────────────────────────────────────────────────

/**
 * The stages, in order.
 *
 * Named here rather than inferred from queue names so the visualisation has a
 * fixed spine: a stage with no queue (deduplication runs inline) still appears,
 * and a queue that is an implementation detail does not.
 */
export const PIPELINE_STAGES = [
  'discovery',
  'normalization',
  'deduplication',
  'enrichment',
  'quality',
  'matching',
  'ranking',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const pipelineStageStatusSchema = z.object({
  stage: z.enum(PIPELINE_STAGES),
  status: z.enum(COMPONENT_STATUSES),
  processed: z.number().int().min(0),
  succeeded: z.number().int().min(0),
  failed: z.number().int().min(0),
  waiting: z.number().int().min(0),
  lastRunAt: z.coerce.date().nullable().default(null),
  lastDurationMs: z.number().min(0).nullable().default(null),
  detail: z.string().max(300).default(''),
});
export type PipelineStageStatus = z.infer<typeof pipelineStageStatusSchema>;

// ── The funnel ──────────────────────────────────────────────────────────────

/**
 * Discovery → shortlist, as counts.
 *
 * Each step reports how many entered and how many survived, so the place the
 * corpus collapses is visible rather than inferred. `10,000 discovered → 14
 * shortlisted` is only alarming if you cannot see which step ate the other
 * 9,986.
 */
export const funnelStepSchema = z.object({
  key: z.string().max(40),
  label: z.string().max(80),
  count: z.number().int().min(0),
  /** Share of the previous step that survived. Null for the first step. */
  retention: z.number().min(0).max(1).nullable().default(null),
  detail: z.string().max(200).default(''),
});
export type FunnelStep = z.infer<typeof funnelStepSchema>;

export const funnelSchema = z.object({
  windowHours: z.number().int().min(1),
  steps: z.array(funnelStepSchema).default([]),
  generatedAt: z.coerce.date(),
});
export type Funnel = z.infer<typeof funnelSchema>;

// ── Source health score ─────────────────────────────────────────────────────

/**
 * A transparent 0-100 score.
 *
 * Every component reports its own value, weight and reason, so "why is
 * LinkedIn 81?" is answerable from the record. An opaque health number is
 * worse than none: it invites trust it has not earned.
 */
export const healthComponentSchema = z.object({
  component: z.string().max(40),
  score: z.number().min(0).max(100),
  weight: z.number().min(0),
  applicable: z.boolean().default(true),
  detail: z.string().max(200),
});
export type HealthComponent = z.infer<typeof healthComponentSchema>;

export const sourceHealthScoreSchema = z.object({
  sourceId: z.string().max(120),
  score: z.number().min(0).max(100),
  status: z.enum(COMPONENT_STATUSES),
  components: z.array(healthComponentSchema).default([]),
  /** Anomalies worth a human's attention, e.g. a sudden zero-result run. */
  anomalies: z.array(z.string().max(200)).default([]),
  explanation: z.string().max(400),
});
export type SourceHealthScore = z.infer<typeof sourceHealthScoreSchema>;

// ── AI usage and cost ───────────────────────────────────────────────────────

export const AI_OPERATIONS = [
  'enrichment_extraction',
  'match_reasoning',
  'scam_reasoning',
  'embedding',
  'preference_parsing',
  'other',
] as const;
export type AiOperation = (typeof AI_OPERATIONS)[number];

/**
 * Model pricing, as versioned configuration.
 *
 * Providers change prices. Baking a rate into code means a silently wrong cost
 * dashboard months later, so pricing is stored, dated and looked up by
 * effective date — an old usage row keeps costing what it cost.
 */
export const modelPriceSchema = z.object({
  model: z.string().max(120),
  provider: z.string().max(60),
  /** USD per million tokens. */
  inputPerMillion: z.number().min(0),
  outputPerMillion: z.number().min(0),
  /** For embedding models; output price is then zero. */
  effectiveFrom: z.coerce.date(),
  note: z.string().max(200).nullable().default(null),
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;

export const aiUsageRecordSchema = z.object({
  operation: z.enum(AI_OPERATIONS),
  provider: z.string().max(60),
  model: z.string().max(120),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  calls: z.number().int().min(0).default(1),
  costUsd: z.number().min(0).default(0),
  latencyMs: z.number().min(0).nullable().default(null),
  succeeded: z.boolean().default(true),
  jobId: z.string().uuid().nullable().default(null),
  runId: z.string().uuid().nullable().default(null),
  sourceId: z.string().max(120).nullable().default(null),
  occurredAt: z.coerce.date(),
});
export type AiUsageRecord = z.infer<typeof aiUsageRecordSchema>;

export const aiCostSummarySchema = z.object({
  windowHours: z.number().int().min(1),
  totalCalls: z.number().int().min(0),
  totalInputTokens: z.number().int().min(0),
  totalOutputTokens: z.number().int().min(0),
  totalCostUsd: z.number().min(0),
  byOperation: z.record(z.string(), z.number()).prefault({}),
  byModel: z.record(z.string(), z.number()).prefault({}),
  byDay: z.array(z.object({ day: z.string().max(10), costUsd: z.number() })).default([]),
  /** Configured ceiling, so the dashboard can show headroom rather than a bare figure. */
  dailyBudgetUsd: z.number().min(0).nullable().default(null),
});
export type AiCostSummary = z.infer<typeof aiCostSummarySchema>;

// ── Data quality ────────────────────────────────────────────────────────────

export const dataQualityMetricSchema = z.object({
  key: z.string().max(60),
  label: z.string().max(120),
  count: z.number().int().min(0),
  total: z.number().int().min(0),
  share: z.number().min(0).max(1),
  /** Where in the pipeline this weakness lives, for triage. */
  stage: z.enum(PIPELINE_STAGES),
  detail: z.string().max(300).default(''),
});
export type DataQualityMetric = z.infer<typeof dataQualityMetricSchema>;

// ── Metrics ─────────────────────────────────────────────────────────────────

export const latencySummarySchema = z.object({
  operation: z.string().max(60),
  count: z.number().int().min(0),
  p50: z.number().min(0),
  p95: z.number().min(0),
  p99: z.number().min(0),
  max: z.number().min(0),
  mean: z.number().min(0),
});
export type LatencySummary = z.infer<typeof latencySummarySchema>;

// ── Runs ────────────────────────────────────────────────────────────────────

export const PIPELINE_RUN_TRIGGERS = ['SCHEDULED', 'MANUAL', 'RETRY', 'SYSTEM'] as const;
export type PipelineRunTrigger = (typeof PIPELINE_RUN_TRIGGERS)[number];

export const PIPELINE_RUN_STATUSES = ['running', 'success', 'partial', 'failed', 'cancelled'] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

export const runTimelineEntrySchema = z.object({
  at: z.coerce.date(),
  stage: z.string().max(60),
  event: z.string().max(120),
  detail: z.string().max(400).default(''),
  severity: z.enum(['info', 'warning', 'error']).default('info'),
});
export type RunTimelineEntry = z.infer<typeof runTimelineEntrySchema>;

export const pipelineRunSchema = z.object({
  id: z.string().uuid(),
  trigger: z.enum(PIPELINE_RUN_TRIGGERS),
  status: z.enum(PIPELINE_RUN_STATUSES),
  /** True when the run deliberately performed no writes or sends. */
  dryRun: z.boolean().default(false),
  startedAt: z.coerce.date(),
  completedAt: z.coerce.date().nullable().default(null),
  durationMs: z.number().min(0).nullable().default(null),

  jobsDiscovered: z.number().int().min(0).default(0),
  jobsProcessed: z.number().int().min(0).default(0),
  jobsMatched: z.number().int().min(0).default(0),
  jobsRecommended: z.number().int().min(0).default(0),
  duplicatesDetected: z.number().int().min(0).default(0),

  errorCount: z.number().int().min(0).default(0),
  warningCount: z.number().int().min(0).default(0),
  stages: z.array(pipelineStageStatusSchema).default([]),
  timeline: z.array(runTimelineEntrySchema).default([]),
  triggeredBy: z.string().max(120).nullable().default(null),
  note: z.string().max(400).nullable().default(null),
});
export type PipelineRun = z.infer<typeof pipelineRunSchema>;

// ── Dry run ─────────────────────────────────────────────────────────────────

/**
 * What a run *would* do.
 *
 * A dry run must be genuinely inert: no emails, no preference writes, no
 * destructive operations. It reports intentions so an operator can inspect a
 * change before it reaches an inbox — which is the only safe way to tune
 * thresholds on a system that emails a real person.
 */
export const dryRunReportSchema = z.object({
  runId: z.string().uuid(),
  wouldDiscover: z.number().int().min(0),
  wouldEnrich: z.number().int().min(0),
  wouldMatch: z.number().int().min(0),
  wouldRecommend: z.number().int().min(0),
  wouldShortlist: z.number().int().min(0),
  /** What the dashboard would put in front of the candidate, and why. */
  shortlist: z
    .array(
      z.object({
        jobId: z.string().uuid(),
        title: z.string().max(300),
        company: z.string().max(300),
        tier: z.string().max(40),
        priority: z.string().max(20),
        headline: z.string().max(300),
        reason: z.string().max(400),
      }),
    )
    .default([]),
  suppressed: z
    .array(z.object({ jobId: z.string().uuid(), outcome: z.string().max(60), reason: z.string().max(400) }))
    .default([]),
  /** Writes that were skipped because this was a dry run. */
  skippedWrites: z.array(z.string().max(200)).default([]),
  durationMs: z.number().min(0),
  generatedAt: z.coerce.date(),
});
export type DryRunReport = z.infer<typeof dryRunReportSchema>;

// ── Audit ───────────────────────────────────────────────────────────────────

export const AUDIT_ACTIONS = [
  'source.enabled',
  'source.disabled',
  'source.configured',
  'source.tested',
  'source.run_manually',
  'preferences.updated',
  'preferences.nl_applied',
  'config.updated',
  'notification.preferences_updated',
  'notification.test_sent',
  'pipeline.run_triggered',
  'pipeline.dry_run',
  'job.re_enriched',
  'job.rematched',
  'job.reranked',
  'job.reverified',
  'queue.paused',
  'queue.resumed',
  'queue.job_retried',
  'queue.job_discarded',
  'digest.generated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * One manual change.
 *
 * `before` and `after` are stored because "who changed the alert threshold?" is
 * only half the question — the useful half is what it was, and a record with
 * only the new value cannot answer it.
 */
export const auditEntrySchema = z.object({
  id: z.string().uuid(),
  action: z.enum(AUDIT_ACTIONS),
  actor: z.string().max(120),
  target: z.string().max(200).nullable().default(null),
  before: z.unknown().nullable().default(null),
  after: z.unknown().nullable().default(null),
  reason: z.string().max(400).nullable().default(null),
  requestId: z.string().max(80).nullable().default(null),
  occurredAt: z.coerce.date(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

// ── Job explorer ────────────────────────────────────────────────────────────

/**
 * Explorer query.
 *
 * Every filter is an enum, a uuid or a bounded value; nothing becomes a SQL
 * fragment. Pagination is mandatory — the brief rules out loading thousands of
 * rows into the browser, and an unbounded query against a growing corpus is the
 * first thing that makes an ops console unusable.
 */
export const jobExplorerQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  sourceId: z.string().trim().max(120).optional(),
  countryCode: z.string().trim().length(2).optional(),
  remoteType: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).optional(),
  status: z.enum(['active', 'expired', 'closed', 'quarantined']).optional(),
  lifecycle: z.enum(['ACTIVE', 'STALE', 'EXPIRED', 'CLOSED', 'UNKNOWN']).optional(),
  minSalaryUsd: z.coerce.number().min(0).optional(),
  minMatchScore: z.coerce.number().min(0).max(100).optional(),
  minQualityScore: z.coerce.number().min(0).max(100).optional(),
  minRecommendationScore: z.coerce.number().min(0).max(100).optional(),
  discoveredWithinHours: z.coerce.number().int().min(1).max(8760).optional(),
  postedWithinHours: z.coerce.number().int().min(1).max(8760).optional(),
  duplicatesOnly: z.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['discovered', 'posted', 'match', 'recommendation', 'quality']).default('discovered'),
});
export type JobExplorerQuery = z.infer<typeof jobExplorerQuerySchema>;

// ── Provenance ──────────────────────────────────────────────────────────────

/**
 * Where a displayed value came from.
 *
 * The brief asks for raw, AI-extracted and system-derived data to be *clearly
 * distinguished*. Carrying the origin on every field is how that survives a
 * redesign — otherwise the distinction lives in the layout and is lost the
 * first time someone moves a card.
 */
export const FIELD_ORIGINS = ['raw', 'normalized', 'ai_extracted', 'system_derived'] as const;
export type FieldOrigin = (typeof FIELD_ORIGINS)[number];

export const inspectedFieldSchema = z.object({
  label: z.string().max(80),
  value: z.string().max(2000).nullable(),
  origin: z.enum(FIELD_ORIGINS),
  confidence: z.number().min(0).max(1).nullable().default(null),
  method: z.string().max(60).nullable().default(null),
  evidence: z.string().max(400).nullable().default(null),
});
export type InspectedField = z.infer<typeof inspectedFieldSchema>;

// ── Rate limits ─────────────────────────────────────────────────────────────

export const rateLimitSummarySchema = z.object({
  sourceId: z.string().max(120),
  domain: z.string().max(200).nullable().default(null),
  requests: z.number().int().min(0),
  succeeded: z.number().int().min(0),
  failed: z.number().int().min(0),
  rateLimited: z.number().int().min(0),
  /** Current circuit state, when the source has one. */
  circuitState: z.string().max(20).nullable().default(null),
  backoffUntil: z.coerce.date().nullable().default(null),
  remainingQuota: z.number().int().nullable().default(null),
});
export type RateLimitSummary = z.infer<typeof rateLimitSummarySchema>;

// ── Dashboard overview ──────────────────────────────────────────────────────

export const dashboardOverviewSchema = z.object({
  health: systemHealthSchema,
  pipeline: z.object({
    discoveredToday: z.number().int().min(0),
    discoveredThisHour: z.number().int().min(0),
    enriched: z.number().int().min(0),
    matched: z.number().int().min(0),
    recommended: z.number().int().min(0),
    duplicates: z.number().int().min(0),
    stale: z.number().int().min(0),
  }),
  recommendations: z.object({
    exceptional: z.number().int().min(0),
    strong: z.number().int().min(0),
    averageScore: z.number().min(0).max(100),
    averageConfidence: z.number().min(0).max(1),
  }),
  sources: z.object({
    healthy: z.number().int().min(0),
    degraded: z.number().int().min(0),
    failing: z.number().int().min(0),
    disabled: z.number().int().min(0),
  }),
  scheduler: z.object({
    lastRunAt: z.coerce.date().nullable().default(null),
    lastRunStatus: z.string().max(20).nullable().default(null),
    currentRunId: z.string().uuid().nullable().default(null),
    nextRunAt: z.coerce.date().nullable().default(null),
    queueBacklog: z.number().int().min(0),
  }),
  generatedAt: z.coerce.date(),
});
export type DashboardOverview = z.infer<typeof dashboardOverviewSchema>;
