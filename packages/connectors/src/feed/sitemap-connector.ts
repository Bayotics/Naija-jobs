import { z } from 'zod';
import {
  DEFAULT_CONTENT_LIMITS,
  isInScope,
  type DomainScope,
  type SourceJobDraft,
} from '@job-intel/contracts';
import { ParseError } from '../errors';
import { extractStructuredJobs } from '../extract/schema-org';
import { postingToDraft } from '../parse/posting-to-draft';
import { DEFAULT_CAPABILITIES, type Connector, type ConnectorContext } from '../types';

/**
 * Sitemap-driven discovery.
 *
 * A sitemap is the most cooperative thing a site can offer short of an API: the
 * publisher is telling you, in a machine-readable file they chose to write,
 * which URLs they want found and when each last changed. Using it is the
 * opposite of crawling — you fetch one file and learn the shape of the site,
 * instead of following links and hoping.
 *
 * The `lastmod` field makes this connector genuinely incremental. A sitemap
 * with timestamps lets a scan skip every URL unchanged since the last run,
 * which for a careers page with forty postings and one new one means one fetch
 * instead of forty-one.
 *
 * Two hazards, both handled here rather than left to the caller:
 *
 *  1. **Sitemap indexes nest.** An index points at sitemaps that can point at
 *     further indexes, and a malicious or misconfigured one can point at
 *     itself. Depth is capped and visited URLs are tracked.
 *  2. **A sitemap can name any URL at all**, including URLs on other hosts.
 *     Every entry is checked against the configured scope before it is fetched,
 *     because "the file said so" is not authorisation.
 */
export const sitemapConfigSchema = z.object({
  /** The sitemap or sitemap index to start from. */
  sitemapUrl: z.string().url(),

  /**
   * Which URLs in the sitemap are job postings.
   *
   * Required rather than inferred. A site's sitemap lists its blog, its
   * marketing pages and its jobs; fetching all of them to find out which is
   * which would be exactly the indiscriminate crawling Part 18 forbids.
   */
  jobUrlPattern: z.string().default('/jobs?/|/careers?/|/positions?/|/vacanc'),

  /** Hosts and paths this connector may fetch. Enforced per URL. */
  allowedHosts: z.array(z.string().trim().toLowerCase()).min(1),
  allowSubdomains: z.boolean().default(false),
  pathPrefixes: z.array(z.string()).default([]),

  maxUrls: z.number().int().min(1).max(2_000).default(200),
  maxDepth: z.number().int().min(1).max(5).default(DEFAULT_CONTENT_LIMITS.maxSitemapDepth),

  /**
   * Fetch each posting, or trust the sitemap alone.
   *
   * A sitemap gives a URL and a date but never a job title, so a scan without
   * detail fetching produces nothing usable. The flag exists for the case where
   * an operator wants to enumerate URLs cheaply and fetch them later.
   */
  fetchDetail: z.boolean().default(true),

  /** Company applied to every posting, for a single-company careers sitemap. */
  defaultCompany: z.string().nullable().default(null),
  defaultLocationText: z.string().nullable().default(null),
});

export type SitemapConfig = z.infer<typeof sitemapConfigSchema>;

/** One `<url>` entry. */
export interface SitemapEntry {
  loc: string;
  lastModified: Date | null;
}

/**
 * Reads a sitemap or sitemap index.
 *
 * Written against the XML rather than a schema-aware parser because sitemaps in
 * the wild are frequently malformed — missing namespaces, stray entities,
 * HTML-escaped URLs — and a strict parse fails on files that browsers and
 * search engines read without complaint.
 */
export function parseSitemap(xml: string): {
  kind: 'index' | 'urlset';
  entries: SitemapEntry[];
} {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? 'index' : 'urlset';
  const entries: SitemapEntry[] = [];

  const blockPattern = kind === 'index' ? /<sitemap[\s>][\s\S]*?<\/sitemap>/gi : /<url[\s>][\s\S]*?<\/url>/gi;

  for (const block of xml.match(blockPattern) ?? []) {
    const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(block)?.[1];
    if (!loc) continue;

    const raw = /<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i.exec(block)?.[1] ?? null;
    const parsed = raw ? new Date(raw) : null;

    entries.push({
      loc: decodeXmlEntities(loc.trim()),
      lastModified: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    });
  }

  return { kind, entries };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export class SitemapConnector implements Connector<SitemapConfig> {
  readonly id = 'sitemap';
  readonly displayName = 'Sitemap discovery';
  readonly sourceType = 'html_page' as const;
  readonly accessTier = 'permitted_html' as const;
  readonly capabilities = {
    ...DEFAULT_CAPABILITIES,
    /*
     * Incremental because `lastmod` exists, not because we track a page number.
     * This is the strongest form of incremental support in the system: the
     * source itself tells us what changed.
     */
    supportsIncremental: true,
    supportsDetailFetch: true,
    supportsExpiryCheck: true,
  };
  readonly configSchema = sitemapConfigSchema;

  availability() {
    return { available: true, reason: null, requires: [] };
  }

  async healthCheck(ctx: ConnectorContext<SitemapConfig>) {
    const startedAt = Date.now();

    try {
      const response = await ctx.http.getText(ctx.config.sitemapUrl, { signal: ctx.signal });
      const sitemap = parseSitemap(response.data);
      const latencyMs = Date.now() - startedAt;

      return {
        healthy: sitemap.entries.length > 0,
        message:
          sitemap.entries.length === 0
            ? 'Sitemap fetched but contained no entries.'
            : `${sitemap.entries.length} entries (${sitemap.kind}).`,
        checkedAt: new Date(),
        latencyMs,
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

  private scopeOf(config: SitemapConfig): DomainScope {
    return {
      allowedHosts: config.allowedHosts,
      allowSubdomains: config.allowSubdomains,
      pathPrefixes: config.pathPrefixes,
      excludedPaths: [],
      maxDepth: config.maxDepth,
    };
  }

  /**
   * Walks a sitemap tree, breadth-first, within depth and visit limits.
   *
   * Breadth-first on purpose: an index usually lists its most useful sitemap
   * first, and a depth-first walk down a pathological branch would exhaust the
   * URL budget before reaching it.
   */
  private async collect(
    ctx: ConnectorContext<SitemapConfig>,
    scope: DomainScope,
  ): Promise<SitemapEntry[]> {
    const { config } = ctx;
    const visited = new Set<string>();
    const collected: SitemapEntry[] = [];

    let frontier: Array<{ url: string; depth: number }> = [{ url: config.sitemapUrl, depth: 0 }];

    while (frontier.length > 0 && collected.length < config.maxUrls) {
      const next: Array<{ url: string; depth: number }> = [];

      for (const { url, depth } of frontier) {
        if (visited.has(url) || depth > config.maxDepth) continue;
        visited.add(url);

        /*
         * The starting sitemap is trusted because an operator typed it; every
         * URL *inside* a sitemap is not, and is checked before being fetched.
         */
        if (depth > 0 && !isInScope(url, scope)) {
          ctx.log('warn', 'Sitemap entry outside the configured scope was skipped', { url });
          continue;
        }

        let xml: string;

        try {
          const response = await ctx.http.getText(url, { signal: ctx.signal });
          xml = response.data;
        } catch (error) {
          ctx.log('warn', 'Sitemap fetch failed', {
            url,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        const sitemap = parseSitemap(xml);

        if (sitemap.kind === 'index') {
          for (const entry of sitemap.entries) {
            next.push({ url: entry.loc, depth: depth + 1 });
          }
          continue;
        }

        for (const entry of sitemap.entries) {
          if (collected.length >= config.maxUrls) break;
          collected.push(entry);
        }
      }

      frontier = next;
    }

    return collected;
  }

  async *discover(
    ctx: ConnectorContext<SitemapConfig>,
  ): AsyncGenerator<SourceJobDraft, { cursor: Record<string, unknown> }, void> {
    const { config } = ctx;
    const scope = this.scopeOf(config);

    let jobPattern: RegExp;

    try {
      jobPattern = new RegExp(config.jobUrlPattern, 'i');
    } catch {
      throw new ParseError('jobUrlPattern is not a valid regular expression.', {
        pattern: config.jobUrlPattern,
      });
    }

    const entries = await this.collect(ctx, scope);

    if (entries.length === 0) {
      throw new ParseError(`No URLs found in sitemap ${config.sitemapUrl}`, {
        sitemapUrl: config.sitemapUrl,
      });
    }

    const since = readCursorDate(ctx.cursor);
    let newest = since;
    let emitted = 0;

    for (const entry of entries) {
      if (emitted >= config.maxUrls) break;
      if (!jobPattern.test(entry.loc)) continue;
      if (!isInScope(entry.loc, scope)) continue;

      /*
       * The incremental skip.
       *
       * Only entries the sitemap dates can be skipped — an undated entry might
       * have changed, and treating "no date" as "unchanged" would freeze a
       * posting at whatever we first read.
       */
      if (entry.lastModified) {
        if (since && entry.lastModified <= since) continue;
        if (!newest || entry.lastModified > newest) newest = entry.lastModified;
      }

      if (!config.fetchDetail) continue;

      let html: string;

      try {
        const response = await ctx.http.getText(entry.loc, { signal: ctx.signal });
        html = response.data;
      } catch (error) {
        ctx.log('warn', 'Job page fetch failed', {
          url: entry.loc,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const posting = extractStructuredJobs(html).postings[0];

      /*
       * No structured data means no posting.
       *
       * The alternative — guessing a title from the `<title>` tag and calling
       * it a job — produces records that look real and are not. A sitemap URL
       * matching a jobs pattern is a hint, not a posting.
       */
      if (!posting) {
        ctx.log('debug', 'No JobPosting structured data on sitemap URL', { url: entry.loc });
        continue;
      }

      const draft = postingToDraft(posting, entry.loc, {
        defaultCompany: config.defaultCompany,
        defaultLocationText: config.defaultLocationText,
        discoveryMethod: 'sitemap',
        metadata: {
          sitemapUrl: config.sitemapUrl,
          lastModified: entry.lastModified?.toISOString() ?? null,
        },
      });

      if (!draft) {
        ctx.log('debug', 'Sitemap posting failed validation', { url: entry.loc });
        continue;
      }

      yield draft;
      emitted += 1;
    }

    return { cursor: { lastModified: newest ? newest.toISOString() : null } };
  }

  /** One posting, for expiry checks and change detection. */
  async fetchJob(
    ctx: ConnectorContext<SitemapConfig>,
    url: string,
  ): Promise<SourceJobDraft | null> {
    if (!isInScope(url, this.scopeOf(ctx.config))) return null;

    const response = await ctx.http.getText(url, { signal: ctx.signal });
    const posting = extractStructuredJobs(response.data).postings[0];

    if (!posting) return null;

    return postingToDraft(posting, url, {
      defaultCompany: ctx.config.defaultCompany,
      defaultLocationText: ctx.config.defaultLocationText,
      discoveryMethod: 'sitemap',
    });
  }
}

function readCursorDate(cursor: Record<string, unknown> | null): Date | null {
  const value = cursor?.['lastModified'];
  if (typeof value !== 'string') return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
