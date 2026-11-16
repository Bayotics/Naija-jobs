import { XMLParser } from 'fast-xml-parser';
import {
  ConfigurationError,
  NotPermittedError,
  ParseError,
  errorFromStatus,
  classifyError,
} from '../errors';
import { DomainRateLimiter, type RateLimitSettings } from './rate-limiter';
import { withRetry, type RetryAttempt, type RetrySettings } from './retry';
import { RobotsCache, isAllowed } from './robots';
import { checkUrl, type HostResolver } from './ssrf';

/**
 * The single outbound HTTP path for every connector.
 *
 * Centralising it means politeness, retries, timeouts, robots compliance and
 * SSRF protection are properties of the system rather than things each
 * connector has to remember. A connector cannot accidentally bypass them
 * because it is never handed a raw `fetch`.
 */

export interface HttpClientOptions {
  userAgent: string;
  contactEmail?: string | undefined;
  timeoutMs?: number;
  rateLimiter?: DomainRateLimiter;
  /** Disable only for fixture-driven tests. */
  respectRobots?: boolean;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  /**
   * Host resolution for the SSRF guard.
   *
   * Injectable so tests can exercise "this public hostname resolves to a
   * private address" without owning a domain that actually does.
   */
  resolveHost?: HostResolver;
  /** Extra hosts to refuse, from runtime configuration. */
  blockedHosts?: readonly string[];
  /**
   * Skips DNS resolution in the SSRF guard.
   *
   * For fixture-backed tests only: `example.test` does not resolve, and a
   * guard that refuses unresolvable hosts would fail every offline test. The
   * literal-address and hostname checks still run.
   */
  skipHostResolution?: boolean;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retry?: Partial<RetrySettings>;
  rateLimit?: Partial<RateLimitSettings>;
  signal?: AbortSignal;
  onRetry?: (attempt: RetryAttempt) => void;
  /** Skips the robots check. Only for robots.txt itself. */
  skipRobots?: boolean;
  /**
   * Conditional-request validators from the previous fetch.
   *
   * When the server answers 304 the response carries `notModified: true` and
   * no body — the caller is expected to keep what it already had. This is the
   * single largest saving available to a polling discovery system.
   */
  conditional?: { etag?: string | null; lastModified?: string | null };
}

export interface HttpResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  url: string;
  bytes: number;
  /** True when the server answered 304; `data` is then meaningless. */
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
}

export interface RequestStats {
  requests: number;
  bytes: number;
  retries: number;
  rateLimitWaits: number;
  /** Responses the server told us were unchanged. Work correctly avoided. */
  notModified: number;
  redirects: number;
  /** Requests refused by the SSRF guard, for the security panel. */
  blocked: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class HttpClient {
  readonly stats: RequestStats = {
    requests: 0,
    bytes: 0,
    retries: 0,
    rateLimitWaits: 0,
    notModified: 0,
    redirects: 0,
    blocked: 0,
  };

  private readonly rateLimiter: DomainRateLimiter;
  private readonly robots: RobotsCache;
  private readonly fetchImpl: typeof fetch;
  private readonly respectRobots: boolean;
  private readonly maxBytes: number;

  constructor(private readonly options: HttpClientOptions) {
    this.rateLimiter = options.rateLimiter ?? new DomainRateLimiter();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.respectRobots = options.respectRobots ?? true;
    this.maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
    this.robots = new RobotsCache(async (url) => {
      try {
        const response = await this.raw(url, { skipRobots: true, timeoutMs: 10_000 });
        return response.status === 200 ? await response.text() : null;
      } catch {
        return null;
      }
    });
  }

  async getJson<T = unknown>(url: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    const response = await this.request(url, {
      ...options,
      headers: { accept: 'application/json', ...options.headers },
    });
    if (response.status === 304) return notModifiedResponse<T>(response, url);

    const text = assertWithinLimit(await response.text(), url, this.maxBytes);
    try {
      return { ...toMeta(response, text), data: JSON.parse(text) as T };
    } catch (error) {
      throw new ParseError(
        `Invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`,
        { url, preview: text.slice(0, 200) },
      );
    }
  }

  async getText(url: string, options: RequestOptions = {}): Promise<HttpResponse<string>> {
    const response = await this.request(url, options);
    if (response.status === 304) return notModifiedResponse<string>(response, url, '');

    const text = assertWithinLimit(await response.text(), url, this.maxBytes);
    return { ...toMeta(response, text), data: text };
  }

  /** Parses RSS/Atom/XML. Attribute keys are prefixed `@_`. */
  async getXml<T = unknown>(url: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    const response = await this.request(url, {
      ...options,
      headers: { accept: 'application/rss+xml, application/xml, text/xml, */*', ...options.headers },
    });
    if (response.status === 304) return notModifiedResponse<T>(response, url);

    const text = assertWithinLimit(await response.text(), url, this.maxBytes);
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        trimValues: true,
        // Feeds wrap HTML in CDATA; keep it as a string rather than parsing it.
        cdataPropName: '__cdata',
        /**
         * Entity expansion is disabled rather than merely capped. Large feeds
         * legitimately exceed the parser's default limit (WeWorkRemotely does),
         * and raising it re-opens the billion-laughs class of attack. We decode
         * entities ourselves in `decodeEntities`, downstream and bounded.
         */
        processEntities: false,
      });
      return { ...toMeta(response, text), data: parser.parse(text) as T };
    } catch (error) {
      throw new ParseError(
        `Invalid XML from ${url}: ${error instanceof Error ? error.message : String(error)}`,
        { url, preview: text.slice(0, 200) },
      );
    }
  }

  /** Full pipeline: validate → robots → rate limit → retry → fetch → redirects. */
  private async request(url: string, options: RequestOptions): Promise<Response> {
    const parsed = await this.validateUrl(url);

    if (this.respectRobots && !options.skipRobots) {
      await this.assertRobotsAllows(parsed);
    }

    return this.rateLimiter.schedule(
      parsed.hostname,
      () =>
        withRetry(
          async () => {
            const response = await this.fetchFollowing(url, options);
            // 304 is a success the caller asked for, not an error status.
            if (!response.ok && response.status !== 304) {
              const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
              if (response.status === 429 && retryAfter) {
                this.rateLimiter.penalize(parsed.hostname, retryAfter);
                this.stats.rateLimitWaits += 1;
              }
              throw errorFromStatus(response.status, url, retryAfter);
            }
            if (response.status === 304) this.stats.notModified += 1;
            return response;
          },
          {
            ...(options.retry ? { settings: options.retry } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            onRetry: (attempt) => {
              this.stats.retries += 1;
              options.onRetry?.(attempt);
            },
          },
        ),
      options.rateLimit,
      options.signal,
    );
  }

  /**
   * Follows redirects manually, validating every hop.
   *
   * `redirect: 'follow'` performs the hop inside the runtime, where the SSRF
   * guard cannot see it — so a public URL that 302s to `169.254.169.254` would
   * be fetched with no check at all. Following by hand costs a loop and buys
   * the guarantee that every address we actually connect to was approved.
   */
  private async fetchFollowing(url: string, options: RequestOptions): Promise<Response> {
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.raw(current, options);

      const location = response.headers.get('location');
      const isRedirect = response.status >= 300 && response.status < 400 && location;
      if (!isRedirect) return response;

      const next = new URL(location, current);
      this.stats.redirects += 1;

      // Each hop is a fresh fetch decision: revalidate the destination, and
      // re-check robots because a redirect can land on a disallowed path.
      await this.validateUrl(next.toString());
      if (this.respectRobots && !options.skipRobots) await this.assertRobotsAllows(next);

      current = next.toString();
    }

    throw new NotPermittedError(`Too many redirects (>${MAX_REDIRECTS}) starting at ${url}`, { url });
  }

  /** One attempt, with a hard timeout. No retry, no rate limit, no redirects. */
  private async raw(url: string, options: RequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const conditional: Record<string, string> = {};
    if (options.conditional?.etag) conditional['if-none-match'] = options.conditional.etag;
    if (options.conditional?.lastModified) {
      conditional['if-modified-since'] = options.conditional.lastModified;
    }

    try {
      this.stats.requests += 1;
      return await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: {
          'user-agent': this.userAgentHeader(),
          'accept-language': 'en',
          ...conditional,
          ...options.headers,
        },
        ...(options.body !== undefined ? { body: options.body } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      throw classifyError(error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Identifies the bot honestly and gives sources a way to reach the operator. */
  private userAgentHeader(): string {
    return this.options.contactEmail
      ? `${this.options.userAgent} (contact: ${this.options.contactEmail})`
      : this.options.userAgent;
  }

  /**
   * Parses and clears one URL for fetching.
   *
   * The SSRF check resolves DNS, so this is async and is performed on the
   * initial URL and on every redirect target — see `fetchFollowing`.
   */
  private async validateUrl(url: string): Promise<URL> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConfigurationError(`Invalid URL: ${url}`, { url });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConfigurationError(`Unsupported protocol: ${parsed.protocol}`, { url });
    }

    const verdict = await checkUrl(parsed, {
      ...(this.options.resolveHost ? { resolve: this.options.resolveHost } : {}),
      ...(this.options.blockedHosts ? { blockedHosts: this.options.blockedHosts } : {}),
      ...(this.options.skipHostResolution ? { skipResolution: true } : {}),
    });

    if (!verdict.allowed) {
      this.stats.blocked += 1;
      throw new NotPermittedError(`Refusing to fetch ${parsed.host}: ${verdict.reason}`, {
        url,
        reason: verdict.reason,
      });
    }

    return parsed;
  }

  private async assertRobotsAllows(url: URL): Promise<void> {
    const rules = await this.robots.get(url.origin);
    const decision = isAllowed(rules, this.options.userAgent, url.pathname);
    if (!decision.allowed) {
      throw new NotPermittedError(
        `robots.txt disallows ${url.pathname} for ${this.options.userAgent} (${decision.matchedRule})`,
        { url: url.toString(), rule: decision.matchedRule },
      );
    }
    if (decision.crawlDelaySeconds) {
      this.rateLimiter.applyCrawlDelay(url.hostname, decision.crawlDelaySeconds);
    }
  }

  /** Exposes the parsed policy so the UI can show a source's stated terms. */
  async describePolicy(origin: string): Promise<{
    contentSignals: Record<string, string>;
    crawlDelaySeconds: number | null;
    assumedPermissive: boolean;
  }> {
    const rules = await this.robots.get(origin);
    const decision = isAllowed(rules, this.options.userAgent, '/');
    return {
      contentSignals: rules.contentSignals,
      crawlDelaySeconds: decision.crawlDelaySeconds,
      assumedPermissive: rules.assumedPermissive,
    };
  }
}

function toMeta(response: Response, text: string): Omit<HttpResponse<never>, 'data'> {
  return {
    status: response.status,
    headers: response.headers,
    url: response.url,
    bytes: Buffer.byteLength(text, 'utf8'),
    notModified: false,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  };
}

/**
 * A 304, shaped like a response.
 *
 * `data` is a caller-supplied empty value rather than something invented: the
 * server sent no body, and the whole point of `notModified` is that the caller
 * should use what it already had instead of this.
 */
function notModifiedResponse<T>(response: Response, url: string, empty?: unknown): HttpResponse<T> {
  return {
    data: (empty ?? null) as T,
    status: 304,
    headers: response.headers,
    url,
    bytes: 0,
    notModified: true,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  };
}

/**
 * Guards against a source returning an unbounded body.
 * Enforced after reading rather than while streaming because `fetch` bodies are
 * consumed whole here; the cap still prevents an oversized payload from
 * reaching the parser or the database.
 */
function assertWithinLimit(text: string, url: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    throw new ParseError(
      `Response from ${url} is ${bytes} bytes, above the ${maxBytes}-byte limit`,
      { url, bytes, maxBytes },
    );
  }
  return text;
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.round((date - Date.now()) / 1_000));
}
