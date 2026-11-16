/**
 * RSS 2.0 / Atom 1.0 normalization.
 *
 * Feeds are wildly inconsistent: RSS uses `pubDate`, Atom uses `published` or
 * `updated`; a `link` is a string in RSS and an attributed element in Atom;
 * single-item feeds collapse the array. This module absorbs all of that so
 * connectors see one shape.
 */

export interface FeedItem {
  title: string | null;
  link: string | null;
  guid: string | null;
  description: string | null;
  /** True when the description carried HTML markup. */
  descriptionIsHtml: boolean;
  publishedAt: Date | null;
  author: string | null;
  categories: string[];
}

export interface ParsedFeed {
  title: string | null;
  link: string | null;
  items: FeedItem[];
  /** `rss` or `atom`, for diagnostics. */
  kind: 'rss' | 'atom' | 'unknown';
}

/** fast-xml-parser collapses single-element arrays; restore them. */
function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Reads a node that may be a bare scalar, a CDATA wrapper, or an object with
 * a `#text` child — all three occur in real feeds.
 */
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const node = value as Record<string, unknown>;
    const candidate = node.__cdata ?? node['#text'] ?? node._ ?? null;
    if (candidate !== null) return text(candidate);
  }
  return null;
}

function parseDate(value: unknown): Date | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Atom links are `<link href="..." rel="alternate"/>`, often several per entry.
 * Prefer `rel="alternate"`, then the first link with an href.
 */
function atomLink(value: unknown): string | null {
  for (const candidate of toArray(value)) {
    if (typeof candidate === 'string') return candidate.trim() || null;
    if (candidate && typeof candidate === 'object') {
      const node = candidate as Record<string, unknown>;
      const rel = node['@_rel'];
      const href = node['@_href'];
      if (typeof href === 'string' && (rel === undefined || rel === 'alternate')) {
        return href.trim() || null;
      }
    }
  }
  for (const candidate of toArray(value)) {
    if (candidate && typeof candidate === 'object') {
      const href = (candidate as Record<string, unknown>)['@_href'];
      if (typeof href === 'string') return href.trim() || null;
    }
  }
  return null;
}

const HTML_HINT = /<\/?[a-z][\s\S]*>/i;

export function parseFeed(document: unknown): ParsedFeed {
  if (!document || typeof document !== 'object') {
    return { title: null, link: null, items: [], kind: 'unknown' };
  }
  const root = document as Record<string, unknown>;

  const rss = root.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  if (channel) return parseRss(channel);

  const feed = root.feed as Record<string, unknown> | undefined;
  if (feed) return parseAtom(feed);

  // Some feeds omit the <rss> wrapper and expose <channel> at the root.
  const bareChannel = root.channel as Record<string, unknown> | undefined;
  if (bareChannel) return parseRss(bareChannel);

  return { title: null, link: null, items: [], kind: 'unknown' };
}

function parseRss(channel: Record<string, unknown>): ParsedFeed {
  const items = toArray(channel.item as unknown).map((raw): FeedItem => {
    const item = (raw ?? {}) as Record<string, unknown>;
    // content:encoded carries the full body when <description> is a summary.
    const encoded = text(item['content:encoded']);
    const description = encoded ?? text(item.description);

    return {
      title: text(item.title),
      link: text(item.link) ?? atomLink(item['atom:link']),
      guid: text(item.guid) ?? text(item.link),
      description,
      descriptionIsHtml: description !== null && HTML_HINT.test(description),
      publishedAt: parseDate(item.pubDate ?? item['dc:date'] ?? item.date),
      author: text(item.author ?? item['dc:creator']),
      categories: toArray(item.category as unknown)
        .map((c) => text(c))
        .filter((c): c is string => c !== null),
    };
  });

  return {
    title: text(channel.title),
    link: text(channel.link),
    items,
    kind: 'rss',
  };
}

function parseAtom(feed: Record<string, unknown>): ParsedFeed {
  const items = toArray(feed.entry as unknown).map((raw): FeedItem => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const content = text(entry.content) ?? text(entry.summary);
    const author = entry.author as Record<string, unknown> | undefined;

    return {
      title: text(entry.title),
      link: atomLink(entry.link),
      guid: text(entry.id) ?? atomLink(entry.link),
      description: content,
      descriptionIsHtml: content !== null && HTML_HINT.test(content),
      publishedAt: parseDate(entry.published ?? entry.updated),
      author: author ? text(author.name) : null,
      categories: toArray(entry.category as unknown)
        .map((c) => {
          if (c && typeof c === 'object') {
            const term = (c as Record<string, unknown>)['@_term'];
            if (typeof term === 'string') return term;
          }
          return text(c);
        })
        .filter((c): c is string => c !== null),
    };
  });

  return {
    title: text(feed.title),
    link: atomLink(feed.link),
    items,
    kind: 'atom',
  };
}
