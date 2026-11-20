import { z } from 'zod';
import { SOURCE_TYPES } from './common';

/**
 * The universal discovery framework.
 *
 * Prompt 3 established *a* discovery layer: connectors, a runner, a pipeline.
 * This is the model that lets that layer grow across the legitimate public web
 * without becoming a pile of bespoke scrapers.
 *
 * Three ideas carry most of the weight:
 *
 *  1. **Capabilities are declared, not assumed.** A scheduler that knows a
 *     source has an API does not fall back to parsing its HTML. Capability data
 *     is what makes "prefer the cheapest correct mechanism" a rule the system
 *     can execute rather than a comment in a design document.
 *
 *  2. **Every candidate carries how it was found.** A posting extracted from
 *     Schema.org markup and one inferred from a search snippet are not equally
 *     trustworthy, and nothing downstream can tell them apart unless discovery
 *     says so.
 *
 *  3. **Coverage is measured, never claimed.** The web is too large to search
 *     exhaustively. What the system can honestly report is which of *your*
 *     titles, locations and technologies it actually looked for, from which
 *     sources, and where the gaps are.
 */

export const DISCOVERY_FRAMEWORK_VERSION = '1.0.0';

// ── Capability model (Part 2) ───────────────────────────────────────────────

/**
 * What a source can do.
 *
 * Deliberately about *mechanism*, not quality: `supportsSearch` means the
 * source accepts a query, not that it answers one well. Quality is tracked
 * separately in `sourcePerformanceSchema`, because a source can be highly
 * capable and consistently useless.
 */
export const sourceCapabilitiesSchema = z.object({
  supportsSearch: z.boolean().default(false),
  supportsPagination: z.boolean().default(false),
  supportsDateFiltering: z.boolean().default(false),
  supportsLocationFiltering: z.boolean().default(false),
  supportsRemoteFiltering: z.boolean().default(false),
  supportsRss: z.boolean().default(false),
  supportsApi: z.boolean().default(false),
  supportsStructuredData: z.boolean().default(false),
  supportsIncrementalSync: z.boolean().default(false),
  supportsConditionalRequests: z.boolean().default(false),
  supportsDetailFetch: z.boolean().default(false),
  supportsExpiryCheck: z.boolean().default(false),

  /*
   * Filters the engine can push down to the source.
   *
   * Every one defaults to false, so a connector that forgets to declare
   * something is treated as not supporting it. The engine then over-fetches and
   * filters locally, which is wasteful but correct — the opposite default would
   * send a filter the source silently ignores and quietly return the wrong set.
   */
  supportsSalaryFiltering: z.boolean().default(false),
  supportsKeywordFiltering: z.boolean().default(false),

  /** Pushes new postings to us rather than waiting to be polled. */
  supportsWebhooks: z.boolean().default(false),
  providesStructuredSalary: z.boolean().default(false),
  providesVisaFlag: z.boolean().default(false),
  requiresBrowser: z.boolean().default(false),
  requiresCredentials: z.boolean().default(false),
});
export type SourceCapabilities = z.infer<typeof sourceCapabilitiesSchema>;

export const DEFAULT_SOURCE_CAPABILITIES: SourceCapabilities = sourceCapabilitiesSchema.parse({});

/**
 * Discovery mechanisms, ordered from cheapest-and-most-reliable to most
 * expensive-and-most-fragile.
 *
 * The order is the scheduling preference the brief asks for:
 * API > feed > structured endpoint > search discovery > page crawling.
 * A source offering several mechanisms should be driven by the earliest one it
 * supports — not because later ones are forbidden, but because each step down
 * costs more requests, more parsing and more uncertainty for the same posting.
 */
export const DISCOVERY_METHODS = [
  'official_api',
  'ats_api',
  'public_feed',
  'structured_data',
  'sitemap',
  'permitted_html',
  'search_result',
  'social_post',
  'user_submitted',
  'manual',
] as const;
export type DiscoveryMethod = (typeof DISCOVERY_METHODS)[number];

/** Lower is preferred. Used to pick among a source's available mechanisms. */
export const METHOD_PREFERENCE: Readonly<Record<DiscoveryMethod, number>> = {
  official_api: 0,
  ats_api: 1,
  public_feed: 2,
  structured_data: 3,
  sitemap: 4,
  permitted_html: 5,
  search_result: 6,
  social_post: 7,
  user_submitted: 8,
  manual: 9,
};

/**
 * How much to trust a record purely on the strength of how it was obtained.
 *
 * Configurable rather than hardcoded, because these are judgements about
 * mechanisms, not facts. The defaults encode one claim: data a publisher chose
 * to emit in a machine-readable form (an API response, JSON-LD markup) is
 * far more likely to be correct than data we inferred from prose.
 *
 * This is *discovery* confidence only. It says nothing about whether the job is
 * a good match, whether it is still open, or whether it is a scam.
 */
export const discoveryConfidenceConfigSchema = z.object({
  byMethod: z
    .record(z.enum(DISCOVERY_METHODS), z.number().min(0).max(1))
    .default({
      official_api: 0.99,
      ats_api: 0.99,
      public_feed: 0.95,
      structured_data: 0.97,
      sitemap: 0.8,
      permitted_html: 0.8,
      search_result: 0.7,
      social_post: 0.55,
      user_submitted: 0.9,
      manual: 1,
    }),
  /** Applied when an AI classifier, not the source, decided this is a job. */
  aiClassifiedCeiling: z.number().min(0).max(1).default(0.85),
  /** Applied when only a search snippet was available — the page never loaded. */
  snippetOnlyPenalty: z.number().min(0).max(1).default(0.25),
  /** Applied when required fields had to be inferred rather than read. */
  inferredFieldPenalty: z.number().min(0).max(1).default(0.1),
  floor: z.number().min(0).max(1).default(0.1),
});
export type DiscoveryConfidenceConfig = z.infer<typeof discoveryConfidenceConfigSchema>;

/** How one candidate was obtained, carried all the way to the job record. */
export const discoveryProvenanceSchema = z.object({
  method: z.enum(DISCOVERY_METHODS),
  confidence: z.number().min(0).max(1),
  /** The connector that produced it. */
  connectorId: z.string().max(100),
  sourceId: z.string().max(120),
  /** Set when a generated query produced this record. */
  queryId: z.string().max(120).nullable().default(null),
  /** Where the fields came from, in the connector's own words. */
  extractedBy: z.string().max(120).nullable().default(null),
  /** True when a model, rather than the source, decided this is a job posting. */
  aiClassified: z.boolean().default(false),
  /** Reasons the confidence is not the method's baseline. */
  adjustments: z.array(z.string().max(160)).default([]),
  discoveredAt: z.coerce.date().default(() => new Date()),

  /*
   * The acquisition trail (Prompt 16, Part 48).
   *
   * "Found via a search query, originally hosted on Greenhouse, reached through
   * the company's careers page" is three separate facts. Losing the first costs
   * the ability to tell which discovery strategies earn their cost; losing the
   * second costs the ability to judge how much to trust the data; losing the
   * third costs the user the place they actually apply.
   */
  sourceUrl: z.string().max(2_000).nullable().default(null),
  canonicalUrl: z.string().max(2_000).nullable().default(null),
  applicationUrl: z.string().max(2_000).nullable().default(null),

  /** The system that originally hosts the posting: `greenhouse`, `lever`, … */
  originHost: z.string().max(200).nullable().default(null),
  /** What led us here — a search query, a referring career page. */
  referrer: z.string().max(2_000).nullable().default(null),

  retrievedAt: z.coerce.date().nullable().default(null),
  /** Which parser read it. Bump on any change to extraction behaviour. */
  parserVersion: z.string().max(40).default('1.0.0'),
  /** The stored raw document this was extracted from, when one was kept. */
  rawDocumentId: z.string().uuid().nullable().default(null),

  /*
   * How much to trust this record, carried rather than looked up later.
   *
   * A source's type can change; a job's provenance must describe the world as
   * it was when the job was found.
   */
  authority: z.number().min(0).max(1).default(0.5),
});
export type DiscoveryProvenance = z.infer<typeof discoveryProvenanceSchema>;

// ── Search strategy (Parts 3–5) ─────────────────────────────────────────────

export const QUERY_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type QueryPriority = (typeof QUERY_PRIORITIES)[number];

export const QUERY_KINDS = [
  'title_location',
  'title_remote',
  'title_only',
  'technology_location',
  'technology_only',
  'company_targeted',
  'domain_restricted',
  'exploratory',
] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

/**
 * One generated discovery query.
 *
 * Generated from structured candidate data, never written by hand into a
 * source's configuration. `terms` is kept alongside the rendered `text` so a
 * provider that wants structured filters (location, remote, posted-after) can
 * use them instead of jamming everything into a string.
 */
export const discoveryQuerySchema = z.object({
  /** Stable hash of the semantic content, so the same query dedupes across runs. */
  id: z.string().max(120),
  text: z.string().min(1).max(400),
  kind: z.enum(QUERY_KINDS),
  priority: z.enum(QUERY_PRIORITIES),
  /** 0–100. Derived from preference strengths; drives ordering within a tier. */
  score: z.number().min(0).max(100),
  terms: z.object({
    title: z.string().max(200).nullable().default(null),
    technology: z.string().max(120).nullable().default(null),
    location: z.string().max(160).nullable().default(null),
    countryCode: z.string().length(2).nullable().default(null),
    seniority: z.string().max(60).nullable().default(null),
    remoteOnly: z.boolean().default(false),
    /** Restricts results to one host, e.g. a company careers domain. */
    site: z.string().max(200).nullable().default(null),
  }),
  /** Why this query exists, shown in the coverage view. */
  rationale: z.string().max(300),
});
export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;

/**
 * Limits on query generation.
 *
 * Query generation is a cross-product and therefore explodes: 8 titles × 6
 * technologies × 5 locations × 3 seniorities is 720 queries, most of them
 * near-duplicates, each costing a paid search call. Every limit here exists to
 * stop that.
 */
export const queryPlanConfigSchema = z.object({
  /**
   * The ceiling is generous and the default is not.
   *
   * Protection against runaway query generation comes from the default and
   * from the discovery budget, which refuses spend before it happens. A tight
   * schema ceiling would only stop an operator who has deliberately raised the
   * limit and knows what it costs.
   */
  maxQueries: z.number().int().min(1).max(2_000).default(40),
  maxPerTitle: z.number().int().min(1).max(50).default(6),
  maxPerLocation: z.number().int().min(1).max(50).default(12),
  maxTitles: z.number().int().min(1).max(50).default(6),
  maxTechnologies: z.number().int().min(0).max(50).default(5),
  maxLocations: z.number().int().min(1).max(50).default(4),
  /** Include title × technology pairs. Off keeps the plan small and precise. */
  includeTechnologyPairs: z.boolean().default(true),
  includeSeniorityVariants: z.boolean().default(true),
  includeExploratory: z.boolean().default(true),
  /** Share of the plan reserved for each tier, before truncation. */
  highShare: z.number().min(0).max(1).default(0.5),
  mediumShare: z.number().min(0).max(1).default(0.35),
});
export type QueryPlanConfig = z.infer<typeof queryPlanConfigSchema>;

export const queryPlanSchema = z.object({
  profileId: z.string().max(120),
  /** Preference version the plan was generated from, so staleness is visible. */
  preferenceVersion: z.number().int().min(0).nullable().default(null),
  queries: z.array(discoveryQuerySchema).default([]),
  /** Combinations that were generated and then dropped by a limit. */
  droppedCount: z.number().int().min(0).default(0),
  dropReasons: z.array(z.string().max(160)).default([]),
  generatedAt: z.coerce.date().default(() => new Date()),
});
export type QueryPlan = z.infer<typeof queryPlanSchema>;

// ── Budgets (Part 30) ───────────────────────────────────────────────────────

/**
 * What one discovery cycle is allowed to spend.
 *
 * Enforced as counters checked before each unit of work, not as a post-hoc
 * report. A budget you can only discover you exceeded is an invoice, not a
 * budget.
 */
export const discoveryBudgetSchema = z.object({
  maxRequestsPerSource: z.number().int().min(1).max(100_000).default(300),
  maxRequestsPerCycle: z.number().int().min(1).max(1_000_000).default(5_000),
  maxQueriesPerHour: z.number().int().min(1).max(10_000).default(60),
  maxSearchApiCalls: z.number().int().min(0).max(100_000).default(100),
  maxClassificationCalls: z.number().int().min(0).max(100_000).default(50),
  maxEmbeddingCalls: z.number().int().min(0).max(1_000_000).default(2_000),
  maxPageFetches: z.number().int().min(0).max(100_000).default(400),
  /** Hard ceiling on paid spend for one cycle. */
  maxCostUsd: z.number().min(0).max(1_000).default(1),
});
export type DiscoveryBudget = z.infer<typeof discoveryBudgetSchema>;

export const BUDGET_KEYS = [
  'requests',
  'queries',
  'searchApiCalls',
  'classificationCalls',
  'embeddingCalls',
  'pageFetches',
  'costUsd',
] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];

export const budgetUsageSchema = z.object({
  requests: z.number().min(0).default(0),
  queries: z.number().min(0).default(0),
  searchApiCalls: z.number().min(0).default(0),
  classificationCalls: z.number().min(0).default(0),
  embeddingCalls: z.number().min(0).default(0),
  pageFetches: z.number().min(0).default(0),
  costUsd: z.number().min(0).default(0),
});
export type BudgetUsage = z.infer<typeof budgetUsageSchema>;

// ── Checkpoints and crawl state (Parts 13, 38) ──────────────────────────────

/**
 * Where a source got to last time.
 *
 * Separate from `job_sources.cursor` (which is connector-defined and opaque)
 * because these fields are *protocol* state the framework understands and can
 * act on without asking the connector: a matching ETag means skip the fetch
 * entirely, whichever connector owns the source.
 */
export const sourceCheckpointSchema = z.object({
  sourceId: z.string().max(120),
  /** Resource this checkpoint describes — a feed URL, an API endpoint. */
  resource: z.string().max(500),
  etag: z.string().max(400).nullable().default(null),
  lastModified: z.string().max(200).nullable().default(null),
  /** Hash of the last body, for sources that send neither validator. */
  contentHash: z.string().max(80).nullable().default(null),
  /** Connector-defined continuation token. */
  cursor: z.string().max(2000).nullable().default(null),
  lastItemId: z.string().max(400).nullable().default(null),
  lastItemAt: z.coerce.date().nullable().default(null),
  lastSuccessAt: z.coerce.date().nullable().default(null),
  /** Consecutive fetches that returned 304 or an identical hash. */
  unchangedStreak: z.number().int().min(0).default(0),
  updatedAt: z.coerce.date().default(() => new Date()),
});
export type SourceCheckpoint = z.infer<typeof sourceCheckpointSchema>;

// ── Source performance (Part 29) ────────────────────────────────────────────

/**
 * How a source has actually behaved.
 *
 * Used to prioritise: a source with a high duplicate rate is not broken, it is
 * *redundant*, and the scheduler should visit it less often than one producing
 * unique matches. Those two conclusions are indistinguishable from error rate
 * alone, which is why each is tracked separately.
 */
export const sourcePerformanceSchema = z.object({
  sourceId: z.string().max(120),
  windowDays: z.number().int().min(1).max(365),
  runs: z.number().int().min(0).default(0),
  averageJobsPerRun: z.number().min(0).default(0),
  duplicateRate: z.number().min(0).max(1).default(0),
  validJobRate: z.number().min(0).max(1).default(0),
  enrichmentSuccessRate: z.number().min(0).max(1).default(0),
  /** Share of this source's jobs that cleared the candidate's match threshold. */
  matchRate: z.number().min(0).max(1).default(0),
  staleRate: z.number().min(0).max(1).default(0),
  errorRate: z.number().min(0).max(1).default(0),
  averageLatencyMs: z.number().min(0).default(0),
  /** 0–100, combining the above. Drives adaptive scheduling. */
  valueScore: z.number().min(0).max(100).default(0),
  explanation: z.string().max(400).default(''),
});
export type SourcePerformance = z.infer<typeof sourcePerformanceSchema>;

// ── Adaptive scheduling (Part 31) ───────────────────────────────────────────

export const schedulingPolicySchema = z.object({
  /** Bounds on the computed interval, so no policy can produce a hot loop. */
  minIntervalMinutes: z.number().int().min(1).max(10_080).default(15),
  maxIntervalMinutes: z.number().int().min(1).max(10_080).default(1_440),
  /** Interval for a source with a top value score. */
  highValueIntervalMinutes: z.number().int().min(1).max(10_080).default(30),
  /** Interval for a healthy but low-yield source. */
  lowValueIntervalMinutes: z.number().int().min(1).max(10_080).default(360),
  /** Multiplier applied per consecutive failure, compounding. */
  failureBackoffFactor: z.number().min(1).max(10).default(2),
  maxBackoffMinutes: z.number().int().min(1).max(10_080).default(1_440),
  /** Consecutive unchanged fetches before the interval starts stretching. */
  unchangedStreakBeforeSlowdown: z.number().int().min(1).max(100).default(3),
  jitterPercent: z.number().min(0).max(0.5).default(0.15),
});
export type SchedulingPolicy = z.infer<typeof schedulingPolicySchema>;

export const scheduleDecisionSchema = z.object({
  sourceId: z.string().max(120),
  intervalMinutes: z.number().int().min(1),
  nextRunAt: z.coerce.date(),
  /** Why this cadence, in one sentence, for the operator. */
  reason: z.string().max(300),
  /** True when the circuit breaker is holding this source back. */
  suppressed: z.boolean().default(false),
});
export type ScheduleDecision = z.infer<typeof scheduleDecisionSchema>;

// ── Coverage (Parts 33, 34) ─────────────────────────────────────────────────

export const COVERAGE_DIMENSIONS = ['title', 'location', 'technology', 'seniority'] as const;
export type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

/**
 * One thing the candidate asked for, and what the system did about it.
 *
 * `queriesExecuted` and `jobsDiscovered` are different failures: zero queries
 * means the planner never looked, zero jobs from many queries means it looked
 * and the sources had nothing. Collapsing them into one "coverage %" would hide
 * the only actionable distinction.
 */
export const coverageItemSchema = z.object({
  dimension: z.enum(COVERAGE_DIMENSIONS),
  value: z.string().max(200),
  /** Preference strength, so an unmet *strong* preference outranks a weak one. */
  weight: z.number().min(0).max(1).default(0.5),
  queriesPlanned: z.number().int().min(0).default(0),
  queriesExecuted: z.number().int().min(0).default(0),
  sourcesSearched: z.number().int().min(0).default(0),
  jobsDiscovered: z.number().int().min(0).default(0),
  jobsMatched: z.number().int().min(0).default(0),
  lastSearchedAt: z.coerce.date().nullable().default(null),
});
export type CoverageItem = z.infer<typeof coverageItemSchema>;

export const COVERAGE_GAP_KINDS = [
  'NEVER_SEARCHED',
  'NOT_SEARCHED_RECENTLY',
  'LOW_DISCOVERY_COVERAGE',
  'NO_CAPABLE_SOURCE',
  'SOURCE_UNAVAILABLE',
] as const;
export type CoverageGapKind = (typeof COVERAGE_GAP_KINDS)[number];

export const coverageGapSchema = z.object({
  kind: z.enum(COVERAGE_GAP_KINDS),
  dimension: z.enum(COVERAGE_DIMENSIONS),
  value: z.string().max(200),
  severity: z.enum(['low', 'medium', 'high']),
  detail: z.string().max(400),
  /** What would close it — a credential, a source, a schedule change. */
  suggestion: z.string().max(400),
});
export type CoverageGap = z.infer<typeof coverageGapSchema>;

/**
 * The coverage report.
 *
 * Deliberately framed as "of what you asked for, here is what we looked for and
 * found". The system never claims to have searched the web; it reports the
 * portion of the candidate's stated search space it actually addressed.
 */
export const coverageReportSchema = z.object({
  profileId: z.string().max(120),
  windowHours: z.number().int().min(1),
  items: z.array(coverageItemSchema).default([]),
  gaps: z.array(coverageGapSchema).default([]),
  sourcesSearched: z.number().int().min(0).default(0),
  sourcesAvailable: z.number().int().min(0).default(0),
  queriesExecuted: z.number().int().min(0).default(0),
  uniqueJobsDiscovered: z.number().int().min(0).default(0),
  /** Share of preference items that received at least one executed query. */
  searchedShare: z.number().min(0).max(1).default(0),
  /** Share that produced at least one discovered job. */
  productiveShare: z.number().min(0).max(1).default(0),
  generatedAt: z.coerce.date().default(() => new Date()),
});
export type CoverageReport = z.infer<typeof coverageReportSchema>;

// ── Telemetry (Parts 35, 41) ────────────────────────────────────────────────

export const discoveryTelemetrySchema = z.object({
  sourceId: z.string().max(120),
  runId: z.string().max(120).nullable().default(null),
  method: z.enum(DISCOVERY_METHODS),
  queryId: z.string().max(120).nullable().default(null),
  queryText: z.string().max(400).nullable().default(null),
  startedAt: z.coerce.date(),
  completedAt: z.coerce.date().nullable().default(null),
  status: z.enum(['running', 'success', 'partial', 'failed', 'skipped']),
  requests: z.number().int().min(0).default(0),
  results: z.number().int().min(0).default(0),
  uniqueResults: z.number().int().min(0).default(0),
  duplicates: z.number().int().min(0).default(0),
  errors: z.number().int().min(0).default(0),
  rateLimitEvents: z.number().int().min(0).default(0),
  /** 304s and identical-hash responses: work the system correctly avoided. */
  notModified: z.number().int().min(0).default(0),
  costUsd: z.number().min(0).default(0),
  detail: z.string().max(500).default(''),
});
export type DiscoveryTelemetry = z.infer<typeof discoveryTelemetrySchema>;

/** Structured statistics for one discovery run (Part 41). */
export const discoveryRunStatsSchema = z.object({
  discovered: z.number().int().min(0).default(0),
  valid: z.number().int().min(0).default(0),
  invalid: z.number().int().min(0).default(0),
  duplicates: z.number().int().min(0).default(0),
  new: z.number().int().min(0).default(0),
  updated: z.number().int().min(0).default(0),
  stale: z.number().int().min(0).default(0),
  errors: z.number().int().min(0).default(0),
});
export type DiscoveryRunStats = z.infer<typeof discoveryRunStatsSchema>;

// ── User-provided sources (Parts 23, 24) ────────────────────────────────────

export const USER_SOURCE_STATUSES = [
  'pending_validation',
  'validated',
  'rejected',
  'active',
  'disabled',
] as const;
export type UserSourceStatus = (typeof USER_SOURCE_STATUSES)[number];

/**
 * A source the operator typed in.
 *
 * Not activated on submission. A URL supplied by a human is still untrusted
 * input to a system that makes outbound requests, so it is validated,
 * fingerprinted and only then turned into a real source row.
 */
export const userProvidedSourceSchema = z.object({
  url: z.string().url().max(2000),
  displayName: z.string().trim().max(200).nullable().default(null),
  sourceType: z.enum(SOURCE_TYPES).nullable().default(null),
  scanFrequencyMinutes: z.number().int().min(15).max(10_080).default(360),
  searchTerms: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  location: z.string().trim().max(160).nullable().default(null),
  enabled: z.boolean().default(true),
  notes: z.string().trim().max(1000).nullable().default(null),
});
export type UserProvidedSource = z.infer<typeof userProvidedSourceSchema>;

export const DETECTED_SOURCE_KINDS = [
  'ats',
  'rss_feed',
  'atom_feed',
  'sitemap',
  'structured_data',
  'job_listing_page',
  'unknown',
] as const;
export type DetectedSourceKind = (typeof DETECTED_SOURCE_KINDS)[number];

/** One thing the detector found while inspecting a URL. */
export const detectionSignalSchema = z.object({
  kind: z.enum(DETECTED_SOURCE_KINDS),
  detail: z.string().max(400),
  /** The URL that actually carries this capability, when different. */
  url: z.string().max(2000).nullable().default(null),
  confidence: z.number().min(0).max(1),
});
export type DetectionSignal = z.infer<typeof detectionSignalSchema>;

/**
 * The detector's recommendation.
 *
 * Recommends a connector rather than silently choosing one: "this looks like a
 * Greenhouse board, use the Greenhouse adapter" is information the operator
 * should see and be able to override, because a wrong guess produces a source
 * that quietly returns nothing.
 */
export const sourceDetectionResultSchema = z.object({
  url: z.string().max(2000),
  reachable: z.boolean(),
  /** robots.txt verdict for the submitted path. */
  robotsAllowed: z.boolean(),
  robotsDetail: z.string().max(400).nullable().default(null),
  signals: z.array(detectionSignalSchema).default([]),
  recommendedConnectorId: z.string().max(100).nullable().default(null),
  recommendedConfig: z.record(z.string(), z.unknown()).prefault({}),
  /** Plain-language explanation, shown verbatim in the UI. */
  recommendation: z.string().max(600).default(''),
  /** Present when the URL cannot be used at all. */
  rejectionReason: z.string().max(400).nullable().default(null),
  inspectedAt: z.coerce.date().default(() => new Date()),
});
export type SourceDetectionResult = z.infer<typeof sourceDetectionResultSchema>;

// ── Company monitoring (Parts 9, 10) ────────────────────────────────────────

export const MONITORED_COMPANY_STATUSES = [
  'pending',
  'resolved',
  'unresolved',
  'active',
  'failing',
  'disabled',
] as const;
export type MonitoredCompanyStatus = (typeof MONITORED_COMPANY_STATUSES)[number];

export const monitoredCompanySchema = z.object({
  id: z.string().max(120),
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(200).nullable().default(null),
  careersUrl: z.string().max(2000).nullable().default(null),
  atsProvider: z.string().max(60).nullable().default(null),
  atsIdentifier: z.string().max(200).nullable().default(null),
  status: z.enum(MONITORED_COMPANY_STATUSES).default('pending'),
  /** Set when resolution produced a real source row. */
  sourceId: z.string().max(120).nullable().default(null),
  lastCheckedAt: z.coerce.date().nullable().default(null),
  detail: z.string().max(500).default(''),
});
export type MonitoredCompany = z.infer<typeof monitoredCompanySchema>;

// ── AI classification (Parts 19, 27) ────────────────────────────────────────

export const CLASSIFIED_CONTENT_TYPES = [
  'job_posting',
  'job_lead',
  'recruiter_announcement',
  'job_board_index',
  'career_advice',
  'discussion',
  'spam',
  'irrelevant',
] as const;
export type ClassifiedContentType = (typeof CLASSIFIED_CONTENT_TYPES)[number];

/**
 * The classifier's output, strictly validated.
 *
 * `null` is meaningful on every optional field and is the *required* answer
 * when the content does not state it. A classifier that invents a company name
 * to fill a field is worse than one that admits it does not know, because the
 * invention flows into a job record and looks like fact.
 */
export const contentClassificationSchema = z.object({
  isJob: z.boolean(),
  contentType: z.enum(CLASSIFIED_CONTENT_TYPES),
  confidence: z.number().min(0).max(1),
  /** One sentence, grounded in the supplied text. */
  reason: z.string().max(400),
  title: z.string().max(300).nullable().default(null),
  company: z.string().max(200).nullable().default(null),
  location: z.string().max(200).nullable().default(null),
  remoteStatus: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).default('unknown'),
  applicationUrl: z.string().max(2000).nullable().default(null),
});
export type ContentClassification = z.infer<typeof contentClassificationSchema>;

// ── Framework configuration ─────────────────────────────────────────────────

export const discoveryFrameworkConfigSchema = z.object({
  confidence: discoveryConfidenceConfigSchema.prefault({}),
  queryPlan: queryPlanConfigSchema.prefault({}),
  budget: discoveryBudgetSchema.prefault({}),
  scheduling: schedulingPolicySchema.prefault({}),
  /** Hosts the generic web crawler may never visit, beyond the SSRF guard. */
  blockedHosts: z.array(z.string().max(200)).default([]),
  /** Maximum pages one generic-web source may fetch in a single run. */
  maxPagesPerCrawl: z.number().int().min(1).max(500).default(40),
  /** Link depth from the seed URL. 1 = the seed and the pages it links to. */
  maxCrawlDepth: z.number().int().min(0).max(4).default(2),
});
export type DiscoveryFrameworkConfig = z.infer<typeof discoveryFrameworkConfigSchema>;
