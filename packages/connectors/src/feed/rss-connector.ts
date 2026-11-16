import { z } from 'zod';
import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import { ParseError } from '../errors';
import { parseFeed, type FeedItem } from './parse-feed';
import { DEFAULT_CAPABILITIES, type Connector, type ConnectorContext } from '../types';

/**
 * Generic RSS/Atom connector.
 *
 * One implementation serves every feed-based source; which feed, and how to
 * read company/location out of it, is configuration. WeWorkRemotely and
 * HotNigerianJobs are both instances of this connector with different rows.
 *
 * Feeds rarely carry structured company or location fields, so the connector
 * supports optional title-splitting patterns. This is *extraction* — pulling a
 * string out of a title — not interpretation; deciding that "Remote" means
 * `remote` remains the normalizer's job.
 */
export const rssConfigSchema = z.object({
  feedUrl: z.string().url(),
  /**
   * Splits "Company: Job Title" or "Job Title at Company" into parts.
   * The first pattern that matches with named groups wins.
   */
  titlePatterns: z
    .array(z.string())
    .default([
      '^(?<company>[^:]{2,60}):\\s*(?<title>.+)$',
      '^(?<title>.+?)\\s+(?:at|@)\\s+(?<company>.+)$',
    ]),
  /** Used when no pattern matches; feeds from one board share a publisher. */
  defaultCompany: z.string().nullable().default(null),
  /** Extracts a location from the title or description. */
  locationPattern: z.string().nullable().default(null),
  /**
   * Location applied when the feed states none. Country-scoped boards carry
   * this implicitly — a Nigerian board's postings are in Nigeria even though
   * no item says so — and without it every posting resolves to no country.
   */
  defaultLocationText: z.string().nullable().default(null),
  /** Applied to every draft, e.g. ["remote"] for a remote-only board. */
  staticTags: z.array(z.string()).default([]),
  /** Drops items whose title matches — feeds often carry non-job news. */
  excludeTitlePattern: z.string().nullable().default(null),
  maxItems: z.number().int().min(1).max(2000).default(200),
  /** Treat the feed's own description as HTML even without markup hints. */
  descriptionIsHtml: z.boolean().default(true),
});

export type RssConfig = z.infer<typeof rssConfigSchema>;

export class RssConnector implements Connector<RssConfig> {
  readonly id = 'rss';
  readonly displayName = 'RSS / Atom feed';
  readonly sourceType = 'rss_feed' as const;
  readonly accessTier = 'public_feed' as const;
  readonly capabilities = {
    ...DEFAULT_CAPABILITIES,
    supportsIncremental: true,
  };
  readonly configSchema = rssConfigSchema;

  availability() {
    // Public feeds need no credentials, so this connector is always runnable.
    return { available: true, reason: null, requires: [] };
  }

  async healthCheck(ctx: ConnectorContext<RssConfig>) {
    const startedAt = Date.now();
    try {
      const response = await ctx.http.getXml(ctx.config.feedUrl, { signal: ctx.signal });
      const feed = parseFeed(response.data);
      const latencyMs = Date.now() - startedAt;

      if (feed.items.length === 0) {
        return {
          healthy: false,
          message: `Feed parsed but contained no items (kind=${feed.kind})`,
          checkedAt: new Date(),
          latencyMs,
        };
      }
      return {
        healthy: true,
        message: `${feed.items.length} items available (${feed.kind})`,
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

  async *discover(
    ctx: ConnectorContext<RssConfig>,
  ): AsyncGenerator<SourceJobDraft, { cursor: Record<string, unknown> }, void> {
    const { config } = ctx;
    const response = await ctx.http.getXml(config.feedUrl, { signal: ctx.signal });
    const feed = parseFeed(response.data);

    if (feed.items.length === 0) {
      throw new ParseError(`No items found in feed ${config.feedUrl}`, {
        feedUrl: config.feedUrl,
        kind: feed.kind,
      });
    }

    // Incremental: skip anything at or before the newest item of the last run.
    const since = readCursorDate(ctx.cursor);
    const excludePattern = safeRegex(config.excludeTitlePattern);
    const titlePatterns = config.titlePatterns
      .map((p) => safeRegex(p))
      .filter((p): p is RegExp => p !== null);
    const locationPattern = safeRegex(config.locationPattern);

    let newest = since;
    let emitted = 0;

    for (const item of feed.items) {
      if (emitted >= config.maxItems) break;
      if (!item.link || !item.title) continue;
      if (excludePattern?.test(item.title)) continue;

      if (item.publishedAt) {
        if (since && item.publishedAt <= since) continue;
        if (!newest || item.publishedAt > newest) newest = item.publishedAt;
      }

      const draft = this.toDraft(item, config, feed.title, titlePatterns, locationPattern);
      if (draft) {
        yield draft;
        emitted += 1;
      }
    }

    return { cursor: { newestPublishedAt: newest?.toISOString() ?? null } };
  }

  private toDraft(
    item: FeedItem,
    config: RssConfig,
    feedTitle: string | null,
    titlePatterns: RegExp[],
    locationPattern: RegExp | null,
  ): SourceJobDraft | null {
    const rawTitle = item.title ?? '';
    let title = rawTitle;
    let company: string | null = null;

    for (const pattern of titlePatterns) {
      const groups = pattern.exec(rawTitle)?.groups;
      // Accept a match that supplies *either* group. Some feeds only let us
      // recover the employer ("<Employer> Job Recruitment (3 Positions)"), and
      // requiring a title group would silently discard those.
      if (!groups?.title && !groups?.company) continue;
      if (groups.title) title = groups.title.trim();
      if (groups.company) company = groups.company.trim();
      break;
    }

    const companyName = company ?? config.defaultCompany ?? feedTitle ?? 'Unknown';

    let locationText: string | null = null;
    if (locationPattern) {
      const haystack = `${rawTitle}\n${item.description ?? ''}`;
      const match = locationPattern.exec(haystack);
      locationText = match?.groups?.location?.trim() ?? match?.[1]?.trim() ?? null;
    }
    locationText ??= config.defaultLocationText;

    const parsed = sourceJobDraftSchema.safeParse({
      externalId: item.guid,
      title,
      companyName,
      description: item.description,
      descriptionFormat: item.descriptionIsHtml || config.descriptionIsHtml ? 'html' : 'text',
      locationText,
      tags: [...config.staticTags, ...item.categories],
      postedAt: item.publishedAt,
      url: item.link,
      raw: item,
      sourceMetadata: {
        feedUrl: config.feedUrl,
        feedTitle,
        rawTitle,
        author: item.author,
      },
    });

    // A single malformed item must not abort the feed.
    return parsed.success ? parsed.data : null;
  }
}

function readCursorDate(cursor: Record<string, unknown> | null): Date | null {
  const value = cursor?.newestPublishedAt;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Compiles a configured pattern, treating an invalid one as absent. */
function safeRegex(pattern: string | null): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}
