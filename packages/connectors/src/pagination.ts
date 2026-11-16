import { z } from 'zod';

/**
 * Pagination strategies.
 *
 * Sources disagree about how to walk a list, so the strategy is data attached
 * to a source rather than a global rule. `paginate` drives any of them from one
 * loop, which means a connector expresses "how do I read one page" and never
 * "how do I walk the whole thing".
 *
 * Every strategy is bounded. An unbounded pagination loop against a source that
 * always returns a next-link is an accidental denial-of-service.
 */

export const paginationStrategySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('none'),
  }),
  z.object({
    type: z.literal('page'),
    /** Query parameter carrying the page number. */
    param: z.string().default('page'),
    startPage: z.number().int().min(0).default(1),
    pageSizeParam: z.string().nullable().default(null),
    pageSize: z.number().int().min(1).max(500).default(50),
  }),
  z.object({
    type: z.literal('offset'),
    param: z.string().default('offset'),
    limitParam: z.string().default('limit'),
    pageSize: z.number().int().min(1).max(500).default(50),
  }),
  z.object({
    type: z.literal('cursor'),
    /** Query parameter that carries the cursor on the *next* request. */
    param: z.string().default('cursor'),
    /** Dotted path to the next cursor in the response body. */
    cursorPath: z.string().default('meta.next_cursor'),
  }),
  z.object({
    type: z.literal('next_url'),
    /** Dotted path to an absolute next-page URL in the response body. */
    urlPath: z.string().default('links.next'),
  }),
  z.object({
    type: z.literal('date_window'),
    /** Walks backwards in fixed windows — for feeds with no paging at all. */
    fromParam: z.string().default('from'),
    toParam: z.string().default('to'),
    windowDays: z.number().int().min(1).max(90).default(7),
  }),
]);

export type PaginationStrategy = z.infer<typeof paginationStrategySchema>;

/** A page request the connector should perform. */
export interface PageRequest {
  /** Query parameters to merge into the base URL. */
  params: Record<string, string>;
  /** Absolute URL that overrides the base entirely (`next_url` strategy). */
  absoluteUrl: string | null;
  pageNumber: number;
}

/** What the connector reports after reading a page. */
export interface PageResult<T> {
  items: T[];
  /** Raw body, so cursor/next-url strategies can read their continuation. */
  body?: unknown;
  /** Explicit stop signal, e.g. the source said `has_more: false`. */
  done?: boolean;
}

export interface PaginateOptions {
  maxPages: number;
  /** Stops early once this many items have been yielded. */
  maxItems?: number;
}

/**
 * Drives any strategy through one loop.
 *
 * Stops on the first of: `maxPages`, `maxItems`, an empty page, an explicit
 * `done`, or the strategy running out of continuations. The empty-page stop
 * matters — several sources return `200 []` forever past the end rather than
 * signalling completion.
 */
export async function* paginate<T>(
  strategy: PaginationStrategy,
  options: PaginateOptions,
  fetchPage: (request: PageRequest) => Promise<PageResult<T>>,
): AsyncGenerator<T, { pagesFetched: number; truncated: boolean }, void> {
  let pageNumber = 0;
  let itemCount = 0;
  let cursor: string | null = null;
  let nextUrl: string | null = null;
  let windowEnd = new Date();

  const maxPages = strategy.type === 'none' ? 1 : Math.max(1, options.maxPages);

  while (pageNumber < maxPages) {
    const request = buildRequest(strategy, pageNumber, cursor, nextUrl, windowEnd);
    if (!request) break;

    const page = await fetchPage(request);
    pageNumber += 1;

    for (const item of page.items) {
      yield item;
      itemCount += 1;
      if (options.maxItems !== undefined && itemCount >= options.maxItems) {
        return { pagesFetched: pageNumber, truncated: true };
      }
    }

    if (page.done || page.items.length === 0) {
      return { pagesFetched: pageNumber, truncated: false };
    }

    switch (strategy.type) {
      case 'cursor': {
        cursor = readPath(page.body, strategy.cursorPath);
        if (!cursor) return { pagesFetched: pageNumber, truncated: false };
        break;
      }
      case 'next_url': {
        nextUrl = readPath(page.body, strategy.urlPath);
        if (!nextUrl) return { pagesFetched: pageNumber, truncated: false };
        break;
      }
      case 'date_window': {
        windowEnd = new Date(windowEnd.getTime() - strategy.windowDays * 86_400_000);
        break;
      }
      default:
        break;
    }
  }

  // Exhausting maxPages while pages were still non-empty means data was left.
  return { pagesFetched: pageNumber, truncated: pageNumber >= maxPages };
}

function buildRequest(
  strategy: PaginationStrategy,
  pageIndex: number,
  cursor: string | null,
  nextUrl: string | null,
  windowEnd: Date,
): PageRequest | null {
  const pageNumber = pageIndex + 1;

  switch (strategy.type) {
    case 'none':
      return pageIndex === 0 ? { params: {}, absoluteUrl: null, pageNumber } : null;

    case 'page': {
      const params: Record<string, string> = {
        [strategy.param]: String(strategy.startPage + pageIndex),
      };
      if (strategy.pageSizeParam) params[strategy.pageSizeParam] = String(strategy.pageSize);
      return { params, absoluteUrl: null, pageNumber };
    }

    case 'offset':
      return {
        params: {
          [strategy.param]: String(pageIndex * strategy.pageSize),
          [strategy.limitParam]: String(strategy.pageSize),
        },
        absoluteUrl: null,
        pageNumber,
      };

    case 'cursor': {
      if (pageIndex > 0 && !cursor) return null;
      return {
        params: cursor ? { [strategy.param]: cursor } : {},
        absoluteUrl: null,
        pageNumber,
      };
    }

    case 'next_url': {
      if (pageIndex > 0 && !nextUrl) return null;
      return { params: {}, absoluteUrl: pageIndex === 0 ? null : nextUrl, pageNumber };
    }

    case 'date_window': {
      const from = new Date(windowEnd.getTime() - strategy.windowDays * 86_400_000);
      return {
        params: {
          [strategy.fromParam]: from.toISOString().slice(0, 10),
          [strategy.toParam]: windowEnd.toISOString().slice(0, 10),
        },
        absoluteUrl: null,
        pageNumber,
      };
    }

    default:
      return null;
  }
}

/** Reads a dotted path, returning a string or null. Never throws. */
export function readPath(value: unknown, path: string): string | null {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' && current.length > 0 ? current : null;
}

/** Merges query parameters into a base URL without discarding existing ones. */
export function applyParams(baseUrl: string, params: Record<string, string>): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
