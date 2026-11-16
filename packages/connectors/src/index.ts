import { ConnectorRegistry } from './registry';
import { RssConnector } from './feed/rss-connector';
import { SitemapConnector } from './feed/sitemap-connector';
import { JoobleConnector } from './api/jooble-connector';
import { RemotiveConnector } from './api/remotive-connector';
import { ArbeitnowConnector } from './api/arbeitnow-connector';
import { JobicyConnector } from './api/jobicy-connector';
import { RedditConnector } from './social/reddit-connector';
import { SocialConnector } from './social/social-connector';
import { SearchDiscoveryConnector } from './search/search-discovery-connector';
import { RestrictedSourceConnector } from './restricted/restricted-connector';
import { AtsConnector } from './ats/ats-connector';
import { WebConnector } from './web/web-connector';

/**
 * @job-intel/connectors
 *
 * The connector framework and its implementations. Everything a connector
 * needs — politeness, retries, robots compliance, pagination — lives here, so
 * a new source is one class plus one registry line plus one database row.
 */
export * from './errors';
export * from './types';
export * from './registry';
export * from './pagination';
export * from './extract/schema-org';
export * from './extract/content';
export * from './ats/providers';
export * from './ats/ats-connector';
export * from './company/careers-detector';
export * from './web/classifier';
export * from './web/web-connector';
export * from './http/client';
export * from './http/rate-limiter';
export * from './http/retry';
export * from './http/robots';
export * from './http/ssrf';
export * from './http/checkpoint';
export * from './feed/parse-feed';
export * from './feed/rss-connector';
export * from './api/jooble-connector';
export * from './api/remotive-connector';
export * from './api/arbeitnow-connector';
export * from './api/jobicy-connector';
export * from './social/reddit-connector';
export * from './social/social-connector';
export * from './search/search-discovery-connector';
export * from './restricted/restricted-connector';

/**
 * The default registry.
 *
 * A fresh instance per call: registries are cheap, and sharing mutable global
 * state across a worker and its tests is a reliable source of confusion.
 */
export function createDefaultRegistry(): ConnectorRegistry {
  return new ConnectorRegistry()
    .register(new AtsConnector())
    .register(new RssConnector())
    /*
     * Sitemap crawling. Written long before this repo existed and never
     * registered, so nothing could use it. It is the right shape for
     * country-scoped boards: a published sitemap is an explicit invitation to
     * index, and the pages it lists carry Schema.org JobPosting markup.
     */
    .register(new SitemapConnector())
    .register(new JoobleConnector())
    .register(new RemotiveConnector())
    .register(new ArbeitnowConnector())
    .register(new JobicyConnector())
    .register(new RedditConnector())
    .register(new SocialConnector())
    .register(new WebConnector())
    .register(new SearchDiscoveryConnector())
    .register(new RestrictedSourceConnector());
}
export * from './portfolio/portfolio-connector';
export * from './policy';
export * from './concurrency';
export * from './parse/posting-to-draft';
export * from './query/query-plan';
export * from './query/builders';
export * from './change/detect-changes';
export * from './identity/job-identity';
export * from './feed/sitemap-connector';
export * from './platform/platform-strategy';
