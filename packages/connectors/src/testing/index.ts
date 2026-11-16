import { HttpClient, type HttpClientOptions } from '../http/client';
import type { ConnectorContext } from '../types';
import type { JobSource } from '@job-intel/contracts';
import { jobSourceSchema } from '@job-intel/contracts';

/**
 * Test doubles for connectors.
 *
 * Deterministic by construction: the test suite must never depend on an
 * external website being online, so every fixture-driven test routes through
 * `mockFetch` and robots checking is disabled.
 */

export interface MockRoute {
  /** Substring or regex matched against the request URL. */
  match: string | RegExp;
  status?: number;
  body: string;
  headers?: Record<string, string>;
  /** Fails this many times before succeeding — for retry tests. */
  failTimes?: number;
  failStatus?: number;
  /** Throws a network error instead of responding. */
  throws?: Error;
}

export interface MockFetchHandle {
  fetch: typeof fetch;
  /** Every URL requested, in order. */
  calls: string[];
  callsFor(match: string | RegExp): string[];
}

export function mockFetch(routes: MockRoute[]): MockFetchHandle {
  const calls: string[] = [];
  const failCounts = new Map<MockRoute, number>();

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    const route = routes.find((r) =>
      typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url),
    );

    if (!route) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    if (route.throws) throw route.throws;

    const failures = failCounts.get(route) ?? 0;
    if (route.failTimes !== undefined && failures < route.failTimes) {
      failCounts.set(route, failures + 1);
      return new Response('temporary failure', {
        status: route.failStatus ?? 503,
        headers: { 'content-type': 'text/plain' },
      });
    }

    void init;
    const status = route.status ?? 200;
    // 204/205/304 are null-body statuses; the Response constructor throws if
    // given a body with one, which is exactly what a 304 fixture needs to be.
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : route.body, {
      status,
      headers: { 'content-type': 'application/json', ...route.headers },
    });
  }) as unknown as typeof fetch;

  return {
    fetch: impl,
    calls,
    callsFor: (match) =>
      calls.filter((c) => (typeof match === 'string' ? c.includes(match) : match.test(c))),
  };
}

export function testHttpClient(
  routes: MockRoute[],
  options: Partial<HttpClientOptions> = {},
): { client: HttpClient; mock: MockFetchHandle } {
  const mock = mockFetch(routes);
  const client = new HttpClient({
    userAgent: 'JobIntelTestBot/1.0',
    // Fixtures do not serve robots.txt; the robots path has its own tests.
    respectRobots: false,
    // Fixture hosts (`example.test`) deliberately do not resolve, and a guard
    // that refuses unresolvable hosts would fail every offline test. The
    // literal-address and hostname rules still apply, so the SSRF tests that
    // matter — loopback, metadata, alternate encodings — still run here.
    skipHostResolution: true,
    fetchImpl: mock.fetch,
    ...options,
  });
  return { client, mock };
}

export function testSource(overrides: Partial<JobSource> = {}): JobSource {
  return jobSourceSchema.parse({
    id: 'test-source',
    connectorId: 'test',
    displayName: 'Test Source',
    sourceType: 'job_api',
    accessTier: 'official_api',
    ...overrides,
  });
}

export function testContext<TConfig>(input: {
  config: TConfig;
  http: HttpClient;
  source?: Partial<JobSource>;
  cursor?: Record<string, unknown> | null;
  secrets?: Record<string, string>;
}): ConnectorContext<TConfig> {
  const logs: Array<{ level: string; message: string }> = [];
  return {
    source: testSource(input.source ?? {}),
    config: input.config,
    cursor: input.cursor ?? null,
    http: input.http,
    signal: new AbortController().signal,
    traceId: 'test-trace',
    getSecret: (name) => input.secrets?.[name],
    log: (level, message) => {
      logs.push({ level, message });
    },
  };
}

/** Drains an async generator into an array plus its return value. */
export async function collect<T, R>(
  generator: AsyncGenerator<T, R, void>,
): Promise<{ items: T[]; result: R | undefined }> {
  const items: T[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { items, result: next.value };
    items.push(next.value);
  }
}
export * from './contract';
