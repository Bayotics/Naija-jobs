import {
  DEFAULT_CONTENT_LIMITS,
  DEFAULT_RATE_LIMIT,
  NON_FETCHING_METHODS,
  SOURCE_AUTHORITY,
  accessPolicySchema,
  authRequirementSchema,
  rateLimitPolicySchema,
  type AccessPolicy,
  type AccessTier,
  type AcquisitionMethod,
  type AcquisitionSourceType,
  sourceCapabilitiesSchema,
  type AuthRequirement,
  type RateLimitPolicy,
  type SourceCapabilities,
} from '@job-intel/contracts';
import type { Connector, ConnectorCapabilities } from './types';

/**
 * Default policy, derived from what a source *is*.
 *
 * A connector declares its access tier and its type; everything else — which
 * acquisition methods are permitted, how hard to hit it, whether robots.txt
 * applies — follows from those two facts unless the connector says otherwise.
 *
 * Deriving rather than requiring has a specific benefit: a new connector that
 * declares nothing gets the *strictest* defaults, not the loosest. Forgetting
 * to set a rate limit yields twenty requests a minute, and forgetting to
 * declare an access policy yields permitted-HTML-with-robots rather than
 * unrestricted access. The failure mode of carelessness is being too polite.
 */

/** Which acquisition methods each access tier implies, best first. */
const TIER_METHODS: Readonly<Record<AccessTier, AcquisitionMethod[]>> = {
  official_api: ['OFFICIAL_API', 'AUTHORIZED_INTEGRATION'],
  public_feed: ['PUBLIC_API', 'RSS_FEED', 'ATOM_FEED'],
  permitted_html: ['PERMITTED_HTML', 'STRUCTURED_DATA', 'SITEMAP'],
  search_discovery: ['SEARCH_ENGINE_DISCOVERY'],
  user_provided: ['USER_PROVIDED_EXPORT', 'PERMITTED_HTML', 'MANUAL_ENTRY'],
  restricted: ['PROHIBITED'],
};

/**
 * Rate limits by tier.
 *
 * An official API publishes its own limits and is built to be called; an HTML
 * page belongs to someone who did not ask to be crawled. The gap between the
 * two numbers is that difference, expressed as politeness.
 */
const TIER_RATE_LIMITS: Readonly<Record<AccessTier, Partial<RateLimitPolicy>>> = {
  official_api: { requestsPerMinute: 60, requestsPerHour: 2_000, maxConcurrent: 4, minIntervalMs: 250 },
  public_feed: { requestsPerMinute: 20, requestsPerHour: 600, maxConcurrent: 2, minIntervalMs: 1_000 },
  permitted_html: { requestsPerMinute: 6, requestsPerHour: 200, maxConcurrent: 1, minIntervalMs: 5_000 },
  search_discovery: { requestsPerMinute: 10, requestsPerHour: 100, maxConcurrent: 1, minIntervalMs: 3_000 },
  user_provided: { requestsPerMinute: 6, requestsPerHour: 120, maxConcurrent: 1, minIntervalMs: 5_000 },
  restricted: { requestsPerMinute: 1, requestsPerHour: 1, maxConcurrent: 1, minIntervalMs: 600_000 },
};

/** The acquisition taxonomy a legacy `sourceType` maps onto. */
const SOURCE_TYPE_MAP: Readonly<Record<string, AcquisitionSourceType>> = {
  ats: 'ATS',
  job_api: 'PUBLIC_API',
  rss_feed: 'RSS',
  mailbox: 'USER_PROVIDED_SOURCE',
  search_discovery: 'SEARCH_ENGINE',
  social: 'SOCIAL_PLATFORM',
  html_page: 'CAREER_PAGE',
  manual: 'USER_PROVIDED_SOURCE',
};

export function acquisitionTypeOf(sourceType: string): AcquisitionSourceType {
  return SOURCE_TYPE_MAP[sourceType] ?? 'CUSTOM_CONNECTOR';
}

export function authorityOf(sourceType: string): number {
  return SOURCE_AUTHORITY[acquisitionTypeOf(sourceType)];
}

export function defaultAccessPolicy(tier: AccessTier): AccessPolicy {
  return accessPolicySchema.parse({
    permitted: TIER_METHODS[tier] ?? ['PERMITTED_HTML'],
    /*
     * Official APIs are the only tier exempt from robots.txt, and only because
     * robots.txt governs crawling rather than documented API use. Everything
     * else consults it, including sources we believe permit us.
     */
    honoursRobots: tier !== 'official_api',
    reason: tier === 'restricted' ? 'Automated access is not permitted for this source.' : null,
  });
}

export function defaultRateLimit(tier: AccessTier): RateLimitPolicy {
  return rateLimitPolicySchema.parse({ ...DEFAULT_RATE_LIMIT, ...(TIER_RATE_LIMITS[tier] ?? {}) });
}

/**
 * The full policy for one connector, with its own declarations winning.
 *
 * Resolved centrally rather than in each connector so that a change to what
 * "permitted_html" means reaches every HTML source at once, instead of ten
 * connectors that each remembered a slightly different number.
 */
export interface ResolvedPolicy {
  accessPolicy: AccessPolicy;
  auth: AuthRequirement;
  rateLimit: RateLimitPolicy;
  contentLimits: typeof DEFAULT_CONTENT_LIMITS;
  acquisitionType: AcquisitionSourceType;
  authority: number;
  /** False when nothing about this source may be fetched. */
  fetchable: boolean;
}

export function resolvePolicy(connector: Connector<never>): ResolvedPolicy {
  const accessPolicy = connector.accessPolicy ?? defaultAccessPolicy(connector.accessTier);
  const auth = connector.auth ?? authRequirementSchema.parse({});
  const rateLimit = connector.rateLimit ?? defaultRateLimit(connector.accessTier);

  /*
   * Fetchable means at least one permitted method involves a request.
   *
   * Computed rather than stored as a flag, so a source cannot end up marked
   * fetchable while every method it permits is `PROHIBITED` or manual — the
   * two would have to be kept in agreement by hand, and eventually would not
   * be.
   */
  const fetchable = accessPolicy.permitted.some(
    (method) => !NON_FETCHING_METHODS.includes(method),
  );

  return {
    accessPolicy,
    auth,
    rateLimit,
    contentLimits: DEFAULT_CONTENT_LIMITS,
    acquisitionType: acquisitionTypeOf(connector.sourceType),
    authority: authorityOf(connector.sourceType),
    fetchable,
  };
}

/**
 * The best method available for a source right now.
 *
 * Returns null when nothing is permitted, which the caller must treat as "do
 * not run this source" rather than as an error. A source with no permitted
 * method is correctly configured — it is simply one we do not fetch.
 */
export function preferredMethod(policy: AccessPolicy): AcquisitionMethod | null {
  const usable = policy.permitted.filter((method) => !NON_FETCHING_METHODS.includes(method));
  return usable[0] ?? null;
}

/**
 * The connector's own capability flags, in the framework's vocabulary.
 *
 * Two capability shapes exist: `ConnectorCapabilities`, which a connector
 * declares inline, and `sourceCapabilitiesSchema`, which the engine reasons
 * about. They overlap but do not agree on names — `supportsIncremental` versus
 * `supportsIncrementalSync`, `requiresCredentials` versus
 * `requiresAuthentication` — and until this function existed the engine read
 * the field the connector had not set and concluded that every source lacked
 * incremental support.
 *
 * Translating in one place is the fix. Renaming the connector field would touch
 * every connector; keeping two vocabularies and hoping is what produced the bug.
 */
export function toSourceCapabilities(connector: {
  capabilities?: Partial<ConnectorCapabilities>;
  buildQueries?: unknown;
}): SourceCapabilities {
  const declared = connector.capabilities ?? {};

  return sourceCapabilitiesSchema.parse({
    /*
     * Searchability is inferred from whether the connector can build a query
     * rather than declared, because those two can drift and the code is the
     * one that decides what actually happens.
     */
    supportsSearch: typeof connector.buildQueries === 'function',
    supportsPagination: declared.supportsPagination ?? false,
    supportsDetailFetch: declared.supportsDetailFetch ?? false,
    supportsExpiryCheck: declared.supportsExpiryCheck ?? false,
    supportsIncrementalSync: declared.supportsIncremental ?? false,
    providesStructuredSalary: declared.providesStructuredSalary ?? false,
    providesVisaFlag: declared.providesVisaFlag ?? false,
    requiresBrowser: declared.requiresBrowser ?? false,
  });
}
