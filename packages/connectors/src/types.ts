import type { z } from 'zod';
import type {
  AccessPolicy,
  AccessTier,
  AuthRequirement,
  JobSource,
  RateLimitPolicy,
  SourceJobDraft,
  SourceQuery,
  SourceType,
  SourceWatermark,
} from '@job-intel/contracts';
import type { HttpClient } from './http/client';

/**
 * The connector contract.
 *
 * This is the seam that keeps "where jobs come from" out of the rest of the
 * system. A connector's entire job is: given a validated configuration, yield
 * `SourceJobDraft` objects. It does not normalize, deduplicate, score, persist,
 * or know that matching exists.
 *
 * Consequently a connector never sees candidate preferences. Discovery answers
 * "what postings exist"; matching answers "which ones suit this person". Fusing
 * them would make every source re-implement preference logic and would break
 * the moment preferences changed.
 */

export interface ConnectorCapabilities {
  /** Can resume from a cursor instead of re-reading everything. */
  supportsIncremental: boolean;
  /** Can fetch a full description for a summary-only listing. */
  supportsDetailFetch: boolean;
  /** Can check whether a specific posting is still open. */
  supportsExpiryCheck: boolean;
  /** Supplies numeric salary fields rather than only prose. */
  providesStructuredSalary: boolean;
  /** Supplies an explicit visa-sponsorship flag. */
  providesVisaFlag: boolean;
  /** Needs a headless browser (none do yet; Playwright arrives later). */
  requiresBrowser: boolean;
  /** Paginates, and therefore honours `maxPages`. */
  supportsPagination: boolean;
}

export const DEFAULT_CAPABILITIES: ConnectorCapabilities = {
  supportsIncremental: false,
  supportsDetailFetch: false,
  supportsExpiryCheck: false,
  providesStructuredSalary: false,
  providesVisaFlag: false,
  requiresBrowser: false,
  supportsPagination: false,
};

/**
 * Why a connector cannot run right now.
 *
 * `unavailable` is a first-class outcome, not an error. A source whose
 * credentials are absent, or whose terms forbid automated access, must report
 * that clearly instead of failing loudly every cycle or pretending to work.
 */
export interface ConnectorAvailability {
  available: boolean;
  reason: string | null;
  /** What the operator must do — missing env var names, a required plan. */
  requires: string[];
}

export interface ConnectorHealthResult {
  healthy: boolean;
  message: string;
  checkedAt: Date;
  /** Round-trip time of the probe, when one was made. */
  latencyMs?: number;
}

/** Everything a connector is allowed to touch. */
export interface ConnectorContext<TConfig = unknown> {
  readonly source: JobSource;
  /** Already parsed by the connector's own `configSchema`. */
  readonly config: TConfig;
  /** Watermark from the previous run; null on first run. */
  readonly cursor: Record<string, unknown> | null;
  /** The only outbound HTTP path. Politeness and robots are enforced inside. */
  readonly http: HttpClient;
  readonly signal: AbortSignal;
  readonly traceId: string;
  /** Resolves a credential by name. Values never come from the database. */
  getSecret(name: string): string | undefined;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: object): void;
}

/** What a completed discovery reports back, beyond the drafts themselves. */
export interface DiscoverySummary {
  /** Watermark to persist for the next incremental run. */
  cursor?: Record<string, unknown> | null;
  pagesFetched?: number;
  /** Set when the source signalled more data than `maxPages` allowed. */
  truncated?: boolean;
}

/**
 * Minimal context for an availability check.
 *
 * Narrower than the full `ConnectorContext` on purpose: deciding "can this run"
 * must not require an HTTP client or an abort signal, so it stays callable from
 * the API and the settings UI without starting a run.
 */
export interface ConnectorAvailabilityContext<TConfig> {
  readonly config: TConfig;
  getSecret(name: string): string | undefined;
}

/**
 * What a connector needs in order to turn a search profile into queries.
 *
 * Deliberately not the `SearchProfile` type itself. A connector receiving the
 * whole profile would be one refactor away from reading salary preferences and
 * filtering on them, which is matching logic and belongs nowhere near
 * acquisition. This carries only the terms a query can be built from.
 */
export interface QueryBuildInput {
  profileId: string | null;
  /** Role titles, most important first. */
  roles: readonly string[];
  /** Location labels as a human would write them. */
  locations: readonly string[];
  /** Skills worth naming in a query. Not every source can use them. */
  keywords: readonly string[];
  /** Whether remote work is acceptable, for sources that can express it. */
  remoteAcceptable: boolean;
  /** Ceiling on how many queries this connector may return. */
  maxQueries: number;
}

export interface Connector<TConfig = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly sourceType: SourceType;
  readonly accessTier: AccessTier;
  readonly capabilities: ConnectorCapabilities;
  /**
   * Validates `JobSource.config`; also drives the settings form.
   *
   * The input type is `unknown` rather than `TConfig`: a schema with defaults
   * accepts a *partial* object and produces a complete one, so tying input to
   * output would reject every connector that has a default.
   *
   * Zod 4 reordered these parameters to `<Output, Input>` and dropped the
   * separate def slot, so the pair below says exactly what the three used to.
   */
  readonly configSchema: z.ZodType<TConfig, unknown>;

  /** Cheap, side-effect-free check of whether this source can run. */
  availability(ctx: ConnectorAvailabilityContext<TConfig>): ConnectorAvailability;

  /** Probes the source. Powers the "Test" button and source health. */
  healthCheck(ctx: ConnectorContext<TConfig>): Promise<ConnectorHealthResult>;

  /**
   * Streams postings.
   *
   * An async generator rather than an array so drafts reach the pipeline as
   * they are found: memory stays flat regardless of source size, and a run
   * that hits its time budget still contributes everything fetched so far.
   */
  discover(ctx: ConnectorContext<TConfig>): AsyncGenerator<SourceJobDraft, DiscoverySummary | void, void>;

  // ── Optional members ────────────────────────────────────────────────────
  //
  // Every member below is optional, and that is what lets source #100 be added
  // without touching the nine that came before. A connector that does not
  // implement `buildQueries` is a feed, not a search endpoint, and the engine
  // reads it whole rather than pretending it can be queried. Defaults are
  // resolved centrally in the registry so each connector declares only what is
  // actually true of it.

  /**
   * Turns a profile into queries this source can answer (Part 23).
   *
   * Per connector rather than one central function, because "frontend engineer
   * in Germany" is `site:lever.co "frontend engineer" Germany` to a search
   * engine, a subreddit plus a keyword to Reddit, and a board token plus a
   * location parameter to an ATS. One function covering all three becomes a
   * switch statement that every new source has to be added to — which is the
   * coupling this layer exists to avoid.
   */
  buildQueries?(input: QueryBuildInput): SourceQuery[];

  /** How this source may legitimately be reached. Defaults by access tier. */
  readonly accessPolicy?: AccessPolicy;

  /** What credentials it needs, by name. Never values. */
  readonly auth?: AuthRequirement;

  /** Source-specific limits. Falls back to conservative defaults. */
  readonly rateLimit?: RateLimitPolicy;

  /**
   * Fetches one posting by URL (Part 1).
   *
   * Separate from `discover` because expiry checks and change detection need a
   * single posting without re-running a whole scan.
   */
  fetchJob?(ctx: ConnectorContext<TConfig>, url: string): Promise<SourceJobDraft | null>;

  /**
   * Computes the next watermark from a finished run (Parts 25, 26).
   *
   * The connector knows which of cursor, timestamp or page number its source
   * actually honours; the engine does not.
   */
  nextWatermark?(
    previous: SourceWatermark,
    drafts: readonly SourceJobDraft[],
    summary: DiscoverySummary,
  ): SourceWatermark;

  /** Releases anything long-lived. Called when a source is disabled or removed. */
  close?(): Promise<void>;
}

/** Convenience alias for a connector whose config type is not known statically. */
export type AnyConnector = Connector<never>;
