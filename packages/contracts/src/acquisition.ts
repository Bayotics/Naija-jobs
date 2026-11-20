import { z } from 'zod';

/**
 * The acquisition layer's contracts.
 *
 * Prompt 16's brief asks for a source layer that makes source #100 as cheap to
 * add as source #2. That is a claim about *coupling*, and coupling is decided
 * here rather than in the connectors: as long as every source describes itself
 * in the same vocabulary — what it is, what it can do, what it needs, how it
 * may be reached — the discovery engine can treat them uniformly and never
 * learn that LinkedIn and an RSS feed are different kinds of thing.
 *
 * Three ideas run through the whole file.
 *
 * **Capability, not assumption.** The engine asks a source what it supports and
 * adapts. It never assumes search, pagination, date filters or detail fetching
 * exist. A source that cannot filter by location is not broken — it is a source
 * that returns more than was asked for, and the engine filters afterwards.
 *
 * **Permission is a property of the source.** `accessPolicy` says how a source
 * may legitimately be reached, and `restricted` is a normal, first-class state
 * rather than a failure. A restricted source stays registered and visible with
 * a stated reason and a list of permitted alternatives; it is simply never
 * fetched. Nothing in this layer has a code path for getting around a
 * restriction, because the way you guarantee a system does not bypass access
 * controls is to not write the code that would.
 *
 * **Evidence, not inference.** Provenance travels with every posting: which
 * source found it, by what method, at which URL, with which parser version.
 * When a job looks wrong six weeks later, that record is the difference between
 * diagnosing it and guessing.
 */

// ── Source taxonomy (Part 3) ────────────────────────────────────────────────

/**
 * What kind of thing a source is.
 *
 * Coarser than the connector list and finer than "website". The categories
 * exist to drive *policy* — an OFFICIAL_API is trusted differently from a
 * SEARCH_ENGINE result, and a USER_PROVIDED_SOURCE is untrusted input that
 * needs SSRF validation the others do not.
 */
export const ACQUISITION_SOURCE_TYPES = [
  'OFFICIAL_API',
  'PUBLIC_API',
  'ATS',
  'RSS',
  'ATOM',
  'SITEMAP',
  'CAREER_PAGE',
  'JOB_BOARD',
  'SEARCH_ENGINE',
  'SOCIAL_PLATFORM',
  'COMMUNITY',
  'USER_PROVIDED_SOURCE',
  'CUSTOM_CONNECTOR',
] as const;

export type AcquisitionSourceType = (typeof ACQUISITION_SOURCE_TYPES)[number];

/**
 * How trustworthy a source's own claims are.
 *
 * An ATS serving a company's own postings is authoritative about that job. A
 * search engine is authoritative about nothing except that a URL exists. This
 * drives conflict resolution during deduplication — when two records disagree
 * about a salary, the more authoritative one wins.
 */
export const SOURCE_AUTHORITY: Readonly<Record<AcquisitionSourceType, number>> = {
  ATS: 1.0,
  CAREER_PAGE: 0.95,
  OFFICIAL_API: 0.9,
  PUBLIC_API: 0.75,
  RSS: 0.7,
  ATOM: 0.7,
  SITEMAP: 0.65,
  JOB_BOARD: 0.6,
  CUSTOM_CONNECTOR: 0.5,
  USER_PROVIDED_SOURCE: 0.5,
  SEARCH_ENGINE: 0.35,
  SOCIAL_PLATFORM: 0.25,
  COMMUNITY: 0.25,
};

// ── Access policy (Parts 7, 8, 41) ──────────────────────────────────────────

/**
 * How a source may legitimately be reached.
 *
 * Ordered from most to least preferred, and the discovery engine reads it in
 * that order: if an official API exists it is used, and HTML acquisition is
 * what remains when nothing better is on offer.
 *
 * `PROHIBITED` is the important one. It means the source's terms or technical
 * controls forbid automated access, and the connector's correct behaviour is to
 * report that and stop. There is no fallback path from `PROHIBITED` to "try
 * anyway" anywhere in this codebase.
 */
export const ACQUISITION_METHODS = [
  'OFFICIAL_API',
  'AUTHORIZED_INTEGRATION',
  'PUBLIC_API',
  'RSS_FEED',
  'ATOM_FEED',
  'SITEMAP',
  'STRUCTURED_DATA',
  'PERMITTED_HTML',
  'SEARCH_ENGINE_DISCOVERY',
  'USER_PROVIDED_EXPORT',
  'MANUAL_ENTRY',
  'PROHIBITED',
] as const;

export type AcquisitionMethod = (typeof ACQUISITION_METHODS)[number];

/** Methods that involve no fetching of the source at all. */
export const NON_FETCHING_METHODS: readonly AcquisitionMethod[] = [
  'MANUAL_ENTRY',
  'USER_PROVIDED_EXPORT',
  'PROHIBITED',
];

export const accessPolicySchema = z.object({
  /** Methods this source permits, best first. Empty means nothing is permitted. */
  permitted: z.array(z.enum(ACQUISITION_METHODS)).max(12).default([]),

  /**
   * Why a method is unavailable, in plain language, for the dashboard.
   *
   * A source showing "unavailable" with no explanation invites someone to
   * "fix" it by removing the guard. Saying *terms of service prohibit automated
   * collection* makes it clear there is nothing to fix.
   */
  reason: z.string().max(500).nullable().default(null),

  /**
   * What to use instead when the direct route is closed.
   *
   * The whole LinkedIn strategy lives in this field: the connector does not
   * scrape, it points at the company career pages, ATS boards and permitted
   * search discovery that surface the same roles.
   */
  alternatives: z.array(z.string().max(200)).max(10).default([]),

  /** Whether robots.txt is consulted. False only for official APIs. */
  honoursRobots: z.boolean().default(true),

  /** Set when a human has reviewed the source's terms, with the date. */
  reviewedAt: z.coerce.date().nullable().default(null),
});

export type AccessPolicy = z.infer<typeof accessPolicySchema>;

// ── Authentication (Parts 6, 7) ─────────────────────────────────────────────

export const AUTH_STRATEGIES = [
  'NONE',
  'API_KEY',
  'OAUTH2',
  'BEARER_TOKEN',
  'SERVICE_ACCOUNT',
  'USER_PROVIDED_TOKEN',
] as const;

export type AuthStrategy = (typeof AUTH_STRATEGIES)[number];

/**
 * How a source authenticates — never *with what*.
 *
 * Every field here is a *reference*: the name of an environment variable, a
 * header name, a scope string. No secret value can be represented by this
 * schema, which is deliberate. The type system is doing the work that a code
 * review would otherwise have to do every time someone touches source config,
 * and a credential cannot leak through an API response that serialises this
 * object because there is nowhere for it to sit.
 */
export const authRequirementSchema = z.object({
  strategy: z.enum(AUTH_STRATEGIES).default('NONE'),

  /** Environment variable names — never values. */
  credentialRefs: z.array(z.string().trim().max(120)).max(10).default([]),

  /** OAuth scopes the integration needs, for the setup instructions. */
  scopes: z.array(z.string().trim().max(120)).max(20).default([]),

  /** Where the operator goes to obtain access. */
  setupUrl: z.string().max(500).nullable().default(null),

  /** Human-readable instructions shown when configuration is missing. */
  instructions: z.string().max(600).nullable().default(null),
});

export type AuthRequirement = z.infer<typeof authRequirementSchema>;

// ── Capability model (Part 4) ───────────────────────────────────────────────

/**
 * What a source can actually do.
 *
 * Every field defaults to `false`, and that direction matters: a new connector
 * that forgets to declare something is treated as *not* supporting it, so the
 * engine over-fetches and filters rather than silently dropping results by
 * asking for a filter the source ignores. Absence of a declaration is absence
 * of a capability, never an assumption of one.
 */
/*
 * The capability model lives in `discovery-framework.ts`, where Prompt 10 put
 * it, and was extended there rather than replaced. A second capability schema
 * would mean two places to declare the same fact and two chances to disagree.
 */
import { sourceCapabilitiesSchema, type SourceCapabilities } from './discovery-framework';

/**
 * Filters the engine wanted to push down, split by what the source supports.
 *
 * The `residual` half is the point: a filter a source cannot apply is not
 * discarded, it is handed back so the pipeline applies it locally. Dropping it
 * would silently widen the search; pretending the source applied it would
 * silently narrow the results.
 */
export interface FilterPushdown {
  pushed: string[];
  residual: string[];
}

export function planPushdown(
  requested: readonly string[],
  capabilities: SourceCapabilities,
): FilterPushdown {
  const supported: Readonly<Record<string, boolean>> = {
    date: capabilities.supportsDateFiltering,
    location: capabilities.supportsLocationFiltering,
    remote: capabilities.supportsRemoteFiltering,
    salary: capabilities.supportsSalaryFiltering,
    keyword: capabilities.supportsKeywordFiltering,
  };

  const pushed: string[] = [];
  const residual: string[] = [];

  for (const filter of requested) {
    (supported[filter] ? pushed : residual).push(filter);
  }

  return { pushed, residual };
}

// ── Rate limits (Parts 37, 38) ──────────────────────────────────────────────

/**
 * Conservative by default, and deliberately so.
 *
 * These numbers are below what most sources would tolerate. A source that
 * publishes its own limits gets those; a source that does not gets these, and
 * the cost of being slower than necessary is much lower than the cost of being
 * rate-limited into a circuit-breaker trip — or of being an impolite client.
 */
export const rateLimitPolicySchema = z.object({
  requestsPerMinute: z.number().int().min(1).max(6_000).default(20),
  requestsPerHour: z.number().int().min(1).max(200_000).default(500),
  requestsPerDay: z.number().int().min(1).max(2_000_000).default(5_000),
  maxConcurrent: z.number().int().min(1).max(64).default(2),

  /** Minimum gap between two requests, on top of the windows above. */
  minIntervalMs: z.number().int().min(0).max(600_000).default(1_000),

  /** Honour a `Retry-After` header even when it exceeds our own backoff. */
  honourRetryAfter: z.boolean().default(true),
});

export type RateLimitPolicy = z.infer<typeof rateLimitPolicySchema>;

export const DEFAULT_RATE_LIMIT: RateLimitPolicy = rateLimitPolicySchema.parse({});

// ── Content limits (Part 44) ────────────────────────────────────────────────

/**
 * Ceilings on everything a hostile or broken source could make large.
 *
 * Each of these has a failure mode behind it: a 400 MB "HTML page" exhausts the
 * worker's heap, a sitemap index pointing at itself crawls forever, and a feed
 * with 200,000 entries turns one scan into an hours-long database write. The
 * limits are enforced during streaming, not after — checking the size of a
 * response you have already buffered is checking after the damage.
 */
export const contentLimitsSchema = z.object({
  maxResponseBytes: z.number().int().min(1_024).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  maxHtmlBytes: z.number().int().min(1_024).max(32 * 1024 * 1024).default(4 * 1024 * 1024),
  maxJsonBytes: z.number().int().min(1_024).max(32 * 1024 * 1024).default(8 * 1024 * 1024),
  maxFeedBytes: z.number().int().min(1_024).max(32 * 1024 * 1024).default(4 * 1024 * 1024),
  maxPdfBytes: z.number().int().min(1_024).max(32 * 1024 * 1024).default(8 * 1024 * 1024),

  maxPages: z.number().int().min(1).max(500).default(10),
  maxLinksPerPage: z.number().int().min(1).max(5_000).default(300),
  maxItemsPerRun: z.number().int().min(1).max(50_000).default(2_000),
  maxRedirects: z.number().int().min(0).max(10).default(4),

  /** Depth for sitemap indexes pointing at sitemaps pointing at sitemaps. */
  maxSitemapDepth: z.number().int().min(1).max(5).default(3),
});

export type ContentLimits = z.infer<typeof contentLimitsSchema>;

export const DEFAULT_CONTENT_LIMITS: ContentLimits = contentLimitsSchema.parse({});

// ── Domain scope (Part 45) ──────────────────────────────────────────────────

/**
 * How far a career-page crawl may wander.
 *
 * The brief's warning is exact: `example.com/careers` must not become "crawl
 * the entire internet". Scope is therefore an allowlist evaluated per link, and
 * the default — the exact host, the exact path prefix — is the narrow one.
 */
export const domainScopeSchema = z.object({
  /** Hosts that may be fetched. Never empty in a valid scope. */
  allowedHosts: z.array(z.string().trim().toLowerCase().max(253)).min(1).max(50),
  /** Whether `jobs.example.com` is in scope for `example.com`. */
  allowSubdomains: z.boolean().default(false),
  /** Path prefixes on those hosts. Empty means the whole host is in scope. */
  pathPrefixes: z.array(z.string().max(300)).max(30).default([]),
  /** Paths never followed, checked after the prefixes. */
  excludedPaths: z.array(z.string().max(300)).max(30).default([]),
  maxDepth: z.number().int().min(0).max(5).default(1),
});

export type DomainScope = z.infer<typeof domainScopeSchema>;

/** Whether one URL is inside a scope. Wrong answers here are SSRF-adjacent. */
export function isInScope(rawUrl: string, scope: DomainScope): boolean {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  const host = url.hostname.toLowerCase();

  const hostAllowed = scope.allowedHosts.some((allowed) => {
    if (host === allowed) return true;
    // A suffix match must land on a dot, or "notexample.com" passes for "example.com".
    return scope.allowSubdomains && host.endsWith(`.${allowed}`);
  });

  if (!hostAllowed) return false;

  const path = url.pathname;

  if (scope.excludedPaths.some((excluded) => path.startsWith(excluded))) return false;
  if (scope.pathPrefixes.length === 0) return true;

  return scope.pathPrefixes.some((prefix) => path.startsWith(prefix));
}

// ── Raw documents (Parts 27, 28) ────────────────────────────────────────────

/**
 * What was actually retrieved, kept apart from what was understood.
 *
 * Two reasons this is a separate record rather than a column on the job. A
 * multi-megabyte HTML page next to every posting makes the jobs table unusable
 * for the queries it exists to serve. And an improved parser needs the original
 * bytes to replay over — without them, a parsing bug found in month four is
 * unfixable for every job discovered in months one to three.
 *
 * `storageReference` rather than the content itself: small payloads live
 * inline, large ones move to object storage, and the pipeline does not change
 * when that threshold moves.
 */
export const rawSourceDocumentSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().max(120),
  requestId: z.string().max(120),
  runId: z.string().uuid().nullable().default(null),

  url: z.string().max(2_000),
  /** Where the content lives: `inline:` or a storage key. */
  storageReference: z.string().max(500),
  /** Present only for payloads small enough to keep inline. */
  inlineContent: z.string().max(1_000_000).nullable().default(null),

  contentType: z.string().max(200).default('application/octet-stream'),
  contentHash: z.string().length(64),
  byteLength: z.number().int().nonnegative().default(0),

  httpStatus: z.number().int().min(0).max(599).default(200),
  retrievedAt: z.coerce.date().default(() => new Date()),

  /** Which parser read it. Bump on any change to extraction behaviour. */
  parserVersion: z.string().max(40).default('1.0.0'),

  acquisitionMethod: z.enum(ACQUISITION_METHODS).default('PERMITTED_HTML'),
  traceId: z.string().max(120).nullable().default(null),
});

export type RawSourceDocument = z.infer<typeof rawSourceDocumentSchema>;

/** Payloads above this move to storage rather than sitting in a column. */
export const INLINE_CONTENT_LIMIT_BYTES = 256 * 1024;

// ── Change detection (Part 29) ──────────────────────────────────────────────

/**
 * The fields whose changes are worth telling someone about.
 *
 * Not every diff is news. A description reworded by a recruiter is noise; a
 * salary appearing where there was none is the single most useful thing this
 * system can tell someone about a job they already saw. The distinction is
 * `significance`, and only `material` changes are allowed to reach the
 * notification layer.
 */
export const TRACKED_JOB_FIELDS = [
  'title',
  'description',
  'salary',
  'location',
  'remoteType',
  'employmentType',
  'deadline',
  'status',
  'applyUrl',
  'seniority',
  'visaSponsorship',
] as const;

export type TrackedJobField = (typeof TRACKED_JOB_FIELDS)[number];

export const CHANGE_SIGNIFICANCE = ['material', 'minor', 'cosmetic'] as const;
export type ChangeSignificance = (typeof CHANGE_SIGNIFICANCE)[number];

/**
 * How much each field's change matters, before looking at the values.
 *
 * A salary appearing is material whatever the numbers; a description edit is
 * cosmetic unless it is large. Encoding this as data rather than as a chain of
 * conditionals means the re-notification policy can be read in one place.
 */
export const FIELD_SIGNIFICANCE: Readonly<Record<TrackedJobField, ChangeSignificance>> = {
  salary: 'material',
  status: 'material',
  deadline: 'material',
  location: 'material',
  remoteType: 'material',
  visaSponsorship: 'material',
  applyUrl: 'minor',
  employmentType: 'minor',
  seniority: 'minor',
  title: 'minor',
  description: 'cosmetic',
};

export const jobFieldChangeSchema = z.object({
  field: z.enum(TRACKED_JOB_FIELDS),
  significance: z.enum(CHANGE_SIGNIFICANCE),
  /** Clipped: these are for a human reading a diff, not for re-parsing. */
  before: z.string().max(500).nullable(),
  after: z.string().max(500).nullable(),
  summary: z.string().max(300),
});

export type JobFieldChange = z.infer<typeof jobFieldChangeSchema>;

export const jobChangeSetSchema = z.object({
  jobId: z.string().uuid(),
  sourceId: z.string().max(120),
  detectedAt: z.coerce.date().default(() => new Date()),

  previousContentHash: z.string().length(64),
  currentContentHash: z.string().length(64),

  changes: z.array(jobFieldChangeSchema).max(30).default([]),

  /** True when at least one change is material. Drives re-notification. */
  material: z.boolean().default(false),
});

export type JobChangeSet = z.infer<typeof jobChangeSetSchema>;

// ── Provenance (Part 48) ────────────────────────────────────────────────────

/*
 * Discovery methods and provenance also live in `discovery-framework.ts` and
 * were extended there with the acquisition trail (source URL, canonical URL,
 * origin host, referrer, parser version, authority) rather than re-declared.
 */
export {
  DISCOVERY_METHODS,
  discoveryProvenanceSchema,
  type DiscoveryMethod,
  type DiscoveryProvenance,
} from './discovery-framework';

// ── Job identity (Part 47) ──────────────────────────────────────────────────

/**
 * The signals that decide whether two postings are the same opening.
 *
 * URL alone is not enough and never was: the same Greenhouse posting appears
 * under a company vanity domain, a board's redirect wrapper and a search
 * result, all with different URLs. Conversely one URL can be reused for a new
 * posting when a company reopens a role.
 *
 * So identity is a tiered agreement between several weak signals. The weights
 * are ordered by how hard each signal is to fake accidentally: an ATS
 * identifier is nearly conclusive, a normalised URL is strong, and a
 * title-plus-company match is only a hint.
 */
export const IDENTITY_SIGNAL_WEIGHTS = {
  atsId: 0.45,
  canonicalUrl: 0.3,
  sourceJobId: 0.25,
  normalizedUrl: 0.2,
  descriptionFingerprint: 0.2,
  companyTitleLocation: 0.15,
} as const;

export type IdentitySignal = keyof typeof IDENTITY_SIGNAL_WEIGHTS;

/** Agreement at or above this is the same opening. */
export const IDENTITY_MATCH_THRESHOLD = 0.5;

export const jobIdentitySignalsSchema = z.object({
  atsProvider: z.string().max(60).nullable().default(null),
  atsJobId: z.string().max(200).nullable().default(null),
  sourceJobId: z.string().max(200).nullable().default(null),

  canonicalUrl: z.string().max(2_000).nullable().default(null),
  normalizedUrl: z.string().max(2_000).nullable().default(null),

  companySlug: z.string().max(200).nullable().default(null),
  titleSlug: z.string().max(300).nullable().default(null),
  locationSlug: z.string().max(200).nullable().default(null),

  /** Hash over the description's shingles, for near-duplicate agreement. */
  descriptionFingerprint: z.string().max(64).nullable().default(null),
});

export type JobIdentitySignals = z.infer<typeof jobIdentitySignalsSchema>;

// ── Source health (Parts 33, 34) ────────────────────────────────────────────

/**
 * What state a source is in.
 *
 * `NOT_CONFIGURED` and `AUTH_REQUIRED` are separated from `FAILING` on purpose.
 * All three stop a source from producing jobs, but only one of them is a
 * problem with the source: the other two are waiting on the operator, and a
 * dashboard that renders them identically sends someone to debug a network
 * error that is really a missing environment variable.
 */
export const ACQUISITION_SOURCE_STATES = [
  'HEALTHY',
  'DEGRADED',
  'FAILING',
  'DISABLED',
  'NOT_CONFIGURED',
  'AUTH_REQUIRED',
  'RESTRICTED',
] as const;

export type AcquisitionSourceState = (typeof ACQUISITION_SOURCE_STATES)[number];

/** States in which the engine will not schedule the source. */
export const NON_SCHEDULABLE_STATES: readonly AcquisitionSourceState[] = [
  'DISABLED',
  'NOT_CONFIGURED',
  'AUTH_REQUIRED',
  'RESTRICTED',
];

export const sourceReliabilitySchema = z.object({
  sourceId: z.string().max(120),
  windowStart: z.coerce.date(),
  windowEnd: z.coerce.date(),

  requestsAttempted: z.number().int().nonnegative().default(0),
  requestsSucceeded: z.number().int().nonnegative().default(0),
  requestsFailed: z.number().int().nonnegative().default(0),

  itemsSeen: z.number().int().nonnegative().default(0),
  itemsParsed: z.number().int().nonnegative().default(0),
  itemsRejected: z.number().int().nonnegative().default(0),

  jobsYielded: z.number().int().nonnegative().default(0),
  duplicates: z.number().int().nonnegative().default(0),
  stale: z.number().int().nonnegative().default(0),
  falsePositives: z.number().int().nonnegative().default(0),

  rateLimitHits: z.number().int().nonnegative().default(0),
  timeouts: z.number().int().nonnegative().default(0),
  averageLatencyMs: z.number().nonnegative().default(0),
});

export type SourceReliability = z.infer<typeof sourceReliabilitySchema>;

/**
 * Weights for the health score.
 *
 * Request success dominates because a source that cannot be reached has no
 * other qualities worth measuring. Yield is weighted low deliberately: a
 * niche source that returns three jobs a week is doing its job, and scoring it
 * down for being small would push the system toward high-volume aggregators
 * that mostly return duplicates.
 */
export const HEALTH_WEIGHTS = {
  requestSuccess: 0.4,
  parseSuccess: 0.3,
  freshness: 0.15,
  yield: 0.1,
  latency: 0.05,
} as const;

/**
 * A single 0–100 number for the dashboard, plus the reasons behind it.
 *
 * Returned together on purpose: a bare score invites the reader to guess what
 * drove it, and the guess is usually "the source is broken" when the truth is
 * "this source legitimately returns few jobs".
 */
export interface SourceHealthAssessment {
  score: number;
  state: AcquisitionSourceState;
  factors: Array<{ factor: string; value: number; weight: number; note: string }>;
}

export function scoreSourceHealth(
  reliability: SourceReliability,
  options: {
    state?: AcquisitionSourceState;
    /** Hours since the last successful scan; null when there has never been one. */
    hoursSinceSuccess?: number | null;
    /** Expected cadence, used to judge whether "stale" is actually stale. */
    expectedIntervalHours?: number;
  } = {},
): SourceHealthAssessment {
  const factors: SourceHealthAssessment['factors'] = [];

  /*
   * A source that has done nothing scores zero rather than one hundred.
   *
   * Dividing by zero attempts and calling the result "100% success" would give
   * a never-run source a perfect score and float it to the top of the
   * dashboard — the exact opposite of what someone scanning for problems needs.
   */
  const attempted = reliability.requestsAttempted;
  const requestSuccess = attempted === 0 ? 0 : reliability.requestsSucceeded / attempted;

  factors.push({
    factor: 'requestSuccess',
    value: requestSuccess,
    weight: HEALTH_WEIGHTS.requestSuccess,
    note: attempted === 0 ? 'No requests recorded in this window.' : `${reliability.requestsSucceeded}/${attempted} requests succeeded.`,
  });

  const seen = reliability.itemsSeen;
  const parseSuccess = seen === 0 ? 0 : reliability.itemsParsed / seen;

  factors.push({
    factor: 'parseSuccess',
    value: parseSuccess,
    weight: HEALTH_WEIGHTS.parseSuccess,
    note: seen === 0 ? 'No items seen in this window.' : `${reliability.itemsParsed}/${seen} items parsed.`,
  });

  const expected = options.expectedIntervalHours ?? 24;
  const since = options.hoursSinceSuccess;

  /*
   * Freshness is measured against the source's own cadence.
   *
   * A daily feed last read twenty hours ago is perfectly fresh; a source polled
   * every fifteen minutes and last read twenty hours ago is broken. One
   * absolute threshold would be wrong for both.
   */
  const freshness =
    since === null || since === undefined
      ? 0
      : since <= expected
        ? 1
        : Math.max(0, 1 - (since - expected) / (expected * 4));

  factors.push({
    factor: 'freshness',
    value: freshness,
    weight: HEALTH_WEIGHTS.freshness,
    note:
      since === null || since === undefined
        ? 'Never scanned successfully.'
        : `Last success ${since.toFixed(1)}h ago against a ${expected}h cadence.`,
  });

  /*
   * Yield rewards *new* jobs, so a source returning the same postings forever
   * settles toward zero rather than looking productive.
   */
  const yielded = reliability.jobsYielded;
  const novelty = yielded === 0 ? 0 : Math.max(0, 1 - reliability.duplicates / yielded);
  const scale = Math.min(1, yielded / 20);
  const yieldScore = novelty * 0.6 + scale * 0.4;

  factors.push({
    factor: 'yield',
    value: yieldScore,
    weight: HEALTH_WEIGHTS.yield,
    note: `${yielded} jobs, ${reliability.duplicates} duplicates.`,
  });

  /*
   * No requests means no latency to score.
   *
   * Giving an unmeasured source half credit let a source that had never run
   * score above zero, which is exactly the "never run looks fine" failure the
   * request-success factor is written to avoid.
   */
  const latency = reliability.averageLatencyMs;
  const latencyScore =
    attempted === 0 ? 0 : latency <= 0 ? 0.5 : Math.max(0, Math.min(1, 1 - (latency - 500) / 10_000));

  factors.push({
    factor: 'latency',
    value: latencyScore,
    weight: HEALTH_WEIGHTS.latency,
    note: `${Math.round(latency)}ms average.`,
  });

  const raw = factors.reduce((total, entry) => total + entry.value * entry.weight, 0);
  const score = Math.round(raw * 100);

  /*
   * An explicit state always wins over the computed one.
   *
   * `NOT_CONFIGURED` and `RESTRICTED` are facts about the source, not opinions
   * derived from its metrics, and a source that is restricted must never be
   * described as "failing" — that would invite someone to try to fix it.
   */
  if (options.state && options.state !== 'HEALTHY') {
    return { score, state: options.state, factors };
  }

  const state: AcquisitionSourceState =
    attempted === 0 ? 'DEGRADED' : score >= 70 ? 'HEALTHY' : score >= 40 ? 'DEGRADED' : 'FAILING';

  return { score, state, factors };
}

// ── Source registry entry (Part 2) ──────────────────────────────────────────

/**
 * Everything the engine knows about one source.
 *
 * Deliberately a *description* rather than an object with behaviour: the
 * scheduler decides what to run from this record alone, without instantiating a
 * connector or knowing that connectors exist. That is what keeps source-specific
 * logic out of the scheduler, which Part 2 asks for explicitly.
 */
export const sourceRegistryEntrySchema = z.object({
  sourceId: z.string().trim().min(1).max(120),
  sourceName: z.string().trim().min(1).max(200),
  sourceType: z.enum(ACQUISITION_SOURCE_TYPES),

  connectorId: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),

  capabilities: sourceCapabilitiesSchema.prefault({}),
  auth: authRequirementSchema.prefault({}),
  accessPolicy: accessPolicySchema.prefault({}),
  rateLimit: rateLimitPolicySchema.prefault({}),
  contentLimits: contentLimitsSchema.prefault({}),

  priority: z.enum(['very_high', 'high', 'medium', 'low']).default('medium'),

  /** Connector-specific configuration. Never contains secrets. */
  config: z.record(z.string(), z.unknown()).prefault({}),

  state: z.enum(ACQUISITION_SOURCE_STATES).default('NOT_CONFIGURED'),
  healthScore: z.number().min(0).max(100).default(0),

  lastSuccessAt: z.coerce.date().nullable().default(null),
  lastFailureAt: z.coerce.date().nullable().default(null),
  lastError: z.string().max(500).nullable().default(null),
});

export type SourceRegistryEntry = z.infer<typeof sourceRegistryEntrySchema>;

// ── Watermarks (Parts 25, 26) ───────────────────────────────────────────────

/**
 * Where the last scan got to.
 *
 * Every field is nullable because sources differ in what they can offer: an API
 * with a cursor uses `lastCursor`, a feed sorted by date uses
 * `lastSeenPublishedAt`, and a source with neither falls back to page numbers.
 * The engine picks whichever the source's capabilities allow, so one record
 * serves all of them.
 */
export const sourceWatermarkSchema = z.object({
  sourceId: z.string().max(120),

  lastSuccessfulScanAt: z.coerce.date().nullable().default(null),
  lastSeenPublishedAt: z.coerce.date().nullable().default(null),
  lastSeenUpdatedAt: z.coerce.date().nullable().default(null),

  lastCursor: z.string().max(1_000).nullable().default(null),
  lastPage: z.number().int().nonnegative().nullable().default(null),
  lastItemId: z.string().max(500).nullable().default(null),

  /** Hash of the last response, to skip parsing when nothing changed. */
  lastContentHash: z.string().length(64).nullable().default(null),

  /** Consecutive scans that produced nothing new. Drives backoff. */
  emptyScans: z.number().int().nonnegative().default(0),
});

export type SourceWatermark = z.infer<typeof sourceWatermarkSchema>;

/**
 * Whether an incremental scan is possible, and what to ask for.
 *
 * Returns a *decision* rather than mutating anything, so the caller can log it.
 * A full scan after a long gap is correct — an incremental request against a
 * three-week-old watermark risks missing everything the source has since
 * dropped from its window.
 */
export function planIncrementalScan(
  watermark: SourceWatermark,
  capabilities: SourceCapabilities,
  options: { now?: Date; maxIncrementalGapHours?: number } = {},
): { mode: 'incremental' | 'full'; since: Date | null; cursor: string | null; reason: string } {
  const now = options.now ?? new Date();
  const maxGap = options.maxIncrementalGapHours ?? 72;

  if (!capabilities.supportsIncrementalSync) {
    return { mode: 'full', since: null, cursor: null, reason: 'Source does not support incremental sync.' };
  }

  if (watermark.lastCursor) {
    return {
      mode: 'incremental',
      since: null,
      cursor: watermark.lastCursor,
      reason: 'Resuming from the stored cursor.',
    };
  }

  const since = watermark.lastSeenPublishedAt ?? watermark.lastSuccessfulScanAt;

  if (!since) {
    return { mode: 'full', since: null, cursor: null, reason: 'No watermark yet — first scan.' };
  }

  const gapHours = (now.getTime() - since.getTime()) / 3_600_000;

  if (gapHours > maxGap) {
    return {
      mode: 'full',
      since: null,
      cursor: null,
      reason: `Watermark is ${Math.round(gapHours)}h old, beyond the ${maxGap}h incremental window.`,
    };
  }

  return {
    mode: 'incremental',
    since,
    cursor: null,
    reason: `Requesting items since ${since.toISOString()}.`,
  };
}

// ── Query planning (Parts 21, 22, 23) ───────────────────────────────────────

export const sourceQuerySchema = z.object({
  /** Stable hash of the query's meaning, for deduplication and caching. */
  queryId: z.string().max(64),
  sourceId: z.string().max(120),

  /** The query as the source will receive it. */
  text: z.string().max(1_000),

  /** Structured parameters, for sources that take them instead of a string. */
  parameters: z.record(z.string(), z.unknown()).prefault({}),

  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  /** Why this query exists, shown in the control centre. */
  rationale: z.string().max(300).default(''),

  /** Which profile asked for it, so results can be attributed. */
  profileId: z.string().uuid().nullable().default(null),

  /** Filters the source cannot apply, to be enforced after acquisition. */
  residualFilters: z.array(z.string().max(60)).max(20).default([]),
});

export type SourceQuery = z.infer<typeof sourceQuerySchema>;

/**
 * Ceilings on query generation.
 *
 * Without these, three profiles times eight sources times four roles times
 * three locations is several hundred queries per cycle, most of them near
 * duplicates, and search quota is both finite and paid for. The limits are per
 * cycle rather than per profile so that adding a profile cannot multiply spend.
 */
export interface QueryBudget {
  maxPerSourcePerCycle: number;
  maxPerCycle: number;
  maxPerProfilePerSource: number;
  /** Identical queries are not re-run inside this window. */
  cooldownMinutes: number;
}

export const QUERY_BUDGET: QueryBudget = {
  maxPerSourcePerCycle: 12,
  maxPerCycle: 60,
  maxPerProfilePerSource: 6,
  cooldownMinutes: 45,
};
