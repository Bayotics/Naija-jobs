import { z } from 'zod';
import { buildAtsSearchQueries, buildCareerPageSearchQueries } from '../query/builders';
import type { QueryBuildInput } from '../types';
import type { SourceQuery } from '@job-intel/contracts';
import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import { htmlToText } from '@job-intel/core';
import { NotPermittedError, ParseError } from '../errors';
import { DEFAULT_CAPABILITIES, type Connector, type ConnectorContext } from '../types';
import type { HttpClient } from '../http/client';

/**
 * Search-engine job discovery.
 *
 * Two deliberate design points:
 *
 *  1. **The search provider is pluggable.** Search APIs are commercial and
 *     change often; the connector depends on a `SearchProvider` port, so
 *     swapping SerpAPI for Google PSE (or a self-hosted index) is a config
 *     change. No provider configured ⇒ the source reports unavailable rather
 *     than degrading into scraping a search engine directly, which those
 *     engines prohibit.
 *
 *  2. **Snippets are never treated as job records.** A search result is a
 *     *candidate URL*. The real page is fetched and extracted; the snippet is
 *     only a fallback when the page cannot be retrieved, and is marked as such.
 *     Treating snippets as authoritative is how a discovery system fills up
 *     with truncated, stale, half-wrong postings.
 */

export interface SearchResult {
  url: string;
  title: string;
  snippet: string | null;
  publishedAt?: Date | null;
}

/** Port implemented per search vendor. */
export interface SearchProvider {
  readonly id: string;
  /** Names of the environment variables this provider needs. */
  readonly credentialNames: string[];
  isConfigured(getSecret: (name: string) => string | undefined): boolean;
  search(input: {
    query: string;
    limit: number;
    http: HttpClient;
    getSecret: (name: string) => string | undefined;
    signal: AbortSignal;
  }): Promise<SearchResult[]>;
}

/**
 * SerpAPI — a licensed provider that handles the legal and technical side of
 * querying search engines, including Google for Jobs.
 */
export const serpApiProvider: SearchProvider = {
  id: 'serpapi',
  credentialNames: ['SERPAPI_KEY'],
  isConfigured: (getSecret) => Boolean(getSecret('SERPAPI_KEY')),
  async search({ query, limit, http, getSecret, signal }) {
    const key = getSecret('SERPAPI_KEY');
    if (!key) throw new NotPermittedError('SERPAPI_KEY is not configured');

    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(Math.min(limit, 100)));
    url.searchParams.set('api_key', key);

    const response = await http.getJson<{
      organic_results?: Array<{ link?: string; title?: string; snippet?: string; date?: string }>;
    }>(url.toString(), { signal, skipRobots: true });

    return (response.data.organic_results ?? [])
      .filter((r): r is { link: string; title: string; snippet?: string; date?: string } =>
        Boolean(r.link && r.title),
      )
      .map((r) => ({
        url: r.link,
        title: r.title,
        snippet: r.snippet ?? null,
        publishedAt: r.date ? new Date(r.date) : null,
      }));
  },
};

/** Google Programmable Search JSON API — official, quota-limited. */
export const googlePseProvider: SearchProvider = {
  id: 'google_pse',
  credentialNames: ['GOOGLE_PSE_KEY', 'GOOGLE_PSE_CX'],
  isConfigured: (getSecret) => Boolean(getSecret('GOOGLE_PSE_KEY') && getSecret('GOOGLE_PSE_CX')),
  async search({ query, limit, http, getSecret, signal }) {
    const key = getSecret('GOOGLE_PSE_KEY');
    const cx = getSecret('GOOGLE_PSE_CX');
    if (!key || !cx) throw new NotPermittedError('Google PSE credentials are not configured');

    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', key);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(Math.min(limit, 10)));

    const response = await http.getJson<{
      items?: Array<{ link?: string; title?: string; snippet?: string }>;
    }>(url.toString(), { signal, skipRobots: true });

    return (response.data.items ?? [])
      .filter((r): r is { link: string; title: string; snippet?: string } => Boolean(r.link && r.title))
      .map((r) => ({ url: r.link, title: r.title, snippet: r.snippet ?? null }));
  },
};

export const SEARCH_PROVIDERS: SearchProvider[] = [serpApiProvider, googlePseProvider];

export const searchDiscoveryConfigSchema = z.object({
  provider: z.enum(['serpapi', 'google_pse']).default('serpapi'),
  /**
   * Query templates. `{{terms}}` expands to the terms below, so a source can
   * express `"software engineer" "Germany" site:greenhouse.io`.
   */
  queries: z.array(z.string().trim().min(1)).min(1),
  /** Substituted into `{{terms}}`; kept separate so queries stay reusable. */
  terms: z.array(z.string().trim().min(1)).default([]),
  resultsPerQuery: z.number().int().min(1).max(100).default(20),
  /** Only these hosts are fetched. Prevents wandering the open web. */
  allowedDomains: z.array(z.string().trim().min(1)).default([]),
  /** Fetch and extract each result page rather than trusting the snippet. */
  fetchPages: z.boolean().default(true),
  maxPageFetches: z.number().int().min(0).max(200).default(25),
});

export type SearchDiscoveryConfig = z.infer<typeof searchDiscoveryConfigSchema>;

export class SearchDiscoveryConnector implements Connector<SearchDiscoveryConfig> {
  readonly id = 'search_discovery';
  readonly displayName = 'Search-engine discovery';
  readonly sourceType = 'search_discovery' as const;
  readonly accessTier = 'search_discovery' as const;
  readonly capabilities = { ...DEFAULT_CAPABILITIES, supportsDetailFetch: true };
  readonly configSchema = searchDiscoveryConfigSchema;

  /**
   * Search queries built from the profile (Parts 21, 23).
   *
   * `site:` against ATS hosts first, because that is where the postings a job
   * board never carries actually live, then career pages. Nothing here is a
   * hardcoded query string: the template is fixed and every term comes from the
   * profile, which is what lets the search change when the profile does without
   * a deploy.
   */
  buildQueries(input: QueryBuildInput): SourceQuery[] {
    const half = Math.max(1, Math.floor(input.maxQueries / 2));

    return [
      ...buildAtsSearchQueries(this.id, { ...input, maxQueries: half }),
      ...buildCareerPageSearchQueries(this.id, { ...input, maxQueries: input.maxQueries - half }),
    ].slice(0, input.maxQueries);
  }

  constructor(private readonly providers: SearchProvider[] = SEARCH_PROVIDERS) {}

  private provider(id: string): SearchProvider {
    const found = this.providers.find((p) => p.id === id);
    if (!found) throw new ParseError(`Unknown search provider "${id}"`);
    return found;
  }

  availability(ctx: {
    config: SearchDiscoveryConfig;
    getSecret(name: string): string | undefined;
  }) {
    const provider = this.providers.find((p) => p.id === ctx.config.provider);
    if (!provider) {
      return {
        available: false,
        reason: `Unknown search provider "${ctx.config.provider}"`,
        requires: [],
      };
    }
    if (!provider.isConfigured(ctx.getSecret)) {
      return {
        available: false,
        reason:
          `Search discovery needs a licensed search provider. Scraping a search engine ` +
          `directly is prohibited by its terms and is not implemented.`,
        requires: provider.credentialNames,
      };
    }
    return { available: true, reason: null, requires: [] };
  }

  async healthCheck(ctx: ConnectorContext<SearchDiscoveryConfig>) {
    const availability = this.availability(ctx);
    if (!availability.available) {
      return {
        healthy: false,
        message: `${availability.reason} Missing: ${availability.requires.join(', ')}`,
        checkedAt: new Date(),
      };
    }

    const startedAt = Date.now();
    try {
      const results = await this.provider(ctx.config.provider).search({
        query: this.expandTemplates(ctx.config)[0] ?? 'software engineer jobs',
        limit: 1,
        http: ctx.http,
        getSecret: (name) => ctx.getSecret(name),
        signal: ctx.signal,
      });
      return {
        healthy: true,
        message: `Provider responded with ${results.length} result(s)`,
        checkedAt: new Date(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date(),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  async *discover(ctx: ConnectorContext<SearchDiscoveryConfig>): AsyncGenerator<SourceJobDraft, void, void> {
    const availability = this.availability(ctx);
    if (!availability.available) {
      throw new NotPermittedError(availability.reason ?? 'Search provider unavailable', {
        requires: availability.requires,
      });
    }

    const { config } = ctx;
    const provider = this.provider(config.provider);
    const seen = new Set<string>();
    let fetches = 0;

    for (const query of this.expandTemplates(config)) {
      let results: SearchResult[];
      try {
        results = await provider.search({
          query,
          limit: config.resultsPerQuery,
          http: ctx.http,
          getSecret: (name) => ctx.getSecret(name),
          signal: ctx.signal,
        });
      } catch (error) {
        ctx.log('warn', `Search query failed: ${query}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      for (const result of results) {
        if (seen.has(result.url)) continue;
        seen.add(result.url);

        if (!this.isAllowedDomain(result.url, config.allowedDomains)) continue;

        // URL → fetch → extract. The snippet is only a fallback.
        let description = result.snippet;
        let format: 'html' | 'text' = 'text';
        let extracted = false;

        if (config.fetchPages && fetches < config.maxPageFetches) {
          fetches += 1;
          try {
            const page = await ctx.http.getText(result.url, { signal: ctx.signal });
            const text = htmlToText(page.data);
            if (text && text.length > 200) {
              description = text;
              format = 'text';
              extracted = true;
            }
          } catch (error) {
            ctx.log('debug', `Could not fetch ${result.url}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const draft = sourceJobDraftSchema.safeParse({
          title: result.title,
          companyName: hostOf(result.url) ?? 'Unknown',
          description,
          descriptionFormat: format,
          postedAt: result.publishedAt ?? null,
          url: result.url,
          raw: result,
          sourceMetadata: {
            query,
            provider: provider.id,
            // Records whether this came from the real page or only a snippet,
            // so downstream stages can discount unverified records.
            extractedFromPage: extracted,
            snippetOnly: !extracted,
          },
        });

        if (draft.success) yield draft.data;
      }
    }
  }

  private expandTemplates(config: SearchDiscoveryConfig): string[] {
    const terms = config.terms.map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' ');
    return config.queries.map((q) => q.replace(/\{\{terms\}\}/g, terms).trim());
  }

  private isAllowedDomain(url: string, allowed: string[]): boolean {
    if (allowed.length === 0) return true;
    const host = hostOf(url);
    if (!host) return false;
    return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
