/**
 * Real-source probe: `pnpm probe [url ...]`
 *
 * Exercises live public sources through the real fetch path — robots, rate
 * limiting, SSRF checks and all — and reports what each mechanism actually
 * returned. Exists because fixture tests prove the code is correct and prove
 * nothing about whether a given board is reachable, permitted, or shaped the
 * way its documentation claims.
 *
 * Makes no attempt to bypass anything. A source that refuses automated access
 * is reported as refused, which is the useful answer.
 */
import { loadDotenv, loadEnv, EnvSecretProvider } from '@job-intel/config';
import { createLogger } from '@job-intel/observability';
import {
  DomainRateLimiter,
  HttpClient,
  detectSource,
  detectAts,
  extractStructuredJobs,
  extractMainContent,
  greenhouseProvider,
  leverProvider,
  parseFeed,
} from '@job-intel/connectors';

interface ProbeResult {
  target: string;
  mechanism: string;
  ok: boolean;
  results: number;
  latencyMs: number;
  detail: string;
  limitation: string | null;
}

const DEFAULT_TARGETS = [
  // One ATS (Greenhouse), one ATS (Lever), one RSS feed, one public job board
  // API, one company careers page. Every one is a documented public endpoint.
  { kind: 'ats:greenhouse', target: 'vercel' },
  { kind: 'ats:lever', target: 'leverdemo' },
  { kind: 'rss', target: 'https://weworkremotely.com/categories/remote-programming-jobs.rss' },
  { kind: 'api', target: 'https://remotive.com/api/remote-jobs?limit=5' },
  { kind: 'detect', target: 'https://boards.greenhouse.io/vercel' },
];

async function main() {
  loadDotenv();
  const env = loadEnv(process.env, { role: 'worker' });
  const logger = createLogger({ level: 'error', pretty: false, base: { service: 'probe' } });
  void logger;

  const http = new HttpClient({
    userAgent: env.CRAWLER_USER_AGENT,
    contactEmail: env.CRAWLER_CONTACT_EMAIL,
    timeoutMs: 20_000,
    rateLimiter: new DomainRateLimiter(),
  });
  const secrets = new EnvSecretProvider(env);
  void secrets;

  const signal = AbortSignal.timeout(120_000);
  const extra = process.argv.slice(2).map((target) => ({ kind: 'detect', target }));
  const targets = extra.length > 0 ? extra : DEFAULT_TARGETS;
  const results: ProbeResult[] = [];

  for (const { kind, target } of targets) {
    const startedAt = Date.now();
    try {
      switch (kind) {
        case 'ats:greenhouse': {
          const listings = await greenhouseProvider.fetchListings({ identifier: target, http, signal });
          results.push({
            target: `greenhouse:${target}`,
            mechanism: 'ats_api',
            ok: true,
            results: listings.length,
            latencyMs: Date.now() - startedAt,
            detail: listings[0] ? `e.g. "${listings[0].title}" — ${listings[0].locationText}` : 'empty board',
            limitation: listings.some((l) => !l.descriptionHtml)
              ? 'some listings carried no description'
              : null,
          });
          break;
        }

        case 'ats:lever': {
          const listings = await leverProvider.fetchListings({ identifier: target, http, signal });
          results.push({
            target: `lever:${target}`,
            mechanism: 'ats_api',
            ok: true,
            results: listings.length,
            latencyMs: Date.now() - startedAt,
            detail: listings[0] ? `e.g. "${listings[0].title}" — ${listings[0].locationText}` : 'empty board',
            limitation: null,
          });
          break;
        }

        case 'rss': {
          const response = await http.getXml(target, { signal });
          const feed = parseFeed(response.data);
          results.push({
            target,
            mechanism: 'public_feed',
            ok: true,
            results: feed.items.length,
            latencyMs: Date.now() - startedAt,
            detail: `${feed.kind} feed${response.etag ? `, ETag ${response.etag.slice(0, 20)}` : ''}`,
            limitation: response.etag
              ? null
              : 'no ETag or Last-Modified; conditional requests fall back to content hashing',
          });
          break;
        }

        case 'api': {
          const response = await http.getJson<{ jobs?: unknown[] }>(target, { signal });
          results.push({
            target,
            mechanism: 'official_api',
            ok: true,
            results: response.data.jobs?.length ?? 0,
            latencyMs: Date.now() - startedAt,
            detail: `${response.bytes} bytes`,
            limitation: null,
          });
          break;
        }

        default: {
          const detection = await detectSource(target, { http, signal });
          const structured = detection.signals.filter((s) => s.kind === 'structured_data').length;

          results.push({
            target,
            mechanism: detection.recommendedConnectorId ?? 'none',
            ok: detection.reachable && detection.robotsAllowed,
            results: detection.signals.length,
            latencyMs: Date.now() - startedAt,
            detail:
              detection.signals.map((s) => s.kind).join(', ') ||
              (detection.rejectionReason ?? 'no signals'),
            limitation: detection.robotsAllowed
              ? structured === 0
                ? 'no Schema.org markup; extraction would be heuristic'
                : null
              : 'robots.txt disallows this path',
          });
          break;
        }
      }
    } catch (error) {
      results.push({
        target: `${kind}:${target}`,
        mechanism: kind,
        ok: false,
        results: 0,
        latencyMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message.slice(0, 160) : String(error),
        limitation: 'request failed or was refused',
      });
    }
  }

  console.log('\n=== REAL SOURCE PROBE ===\n');
  for (const result of results) {
    console.log(
      `${result.ok ? '✓' : '✗'} ${result.target.padEnd(56)} ${result.mechanism.padEnd(14)} ` +
        `${String(result.results).padStart(4)} result(s)  ${String(result.latencyMs).padStart(6)}ms`,
    );
    console.log(`    ${result.detail}`);
    if (result.limitation) console.log(`    ⚠ ${result.limitation}`);
  }

  const reachable = results.filter((result) => result.ok).length;
  console.log(`\n${reachable}/${results.length} target(s) reachable through a permitted mechanism.`);
  console.log(
    `HTTP: ${http.stats.requests} request(s), ${http.stats.redirects} redirect(s), ` +
      `${http.stats.blocked} blocked by the SSRF guard, ${http.stats.notModified} not-modified.\n`,
  );

  void detectAts;
  void extractStructuredJobs;
  void extractMainContent;
}

main().catch((error: unknown) => {
  console.error('[probe] failed:', error);
  process.exitCode = 1;
});
