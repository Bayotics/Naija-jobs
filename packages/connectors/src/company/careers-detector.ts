import {
  sourceDetectionResultSchema,
  type DetectionSignal,
  type SourceDetectionResult,
} from '@job-intel/contracts';
import type { HttpClient } from '../http/client';
import { detectAts } from '../ats/providers';
import { extractStructuredJobs } from '../extract/schema-org';
import { extractMainContent } from '../extract/content';

/**
 * Careers-page and source detection.
 *
 * Answers two related questions:
 *
 *  - Given `company.com`, where do its jobs live?
 *  - Given a URL an operator pasted, which connector should read it?
 *
 * The brief is explicit that neither answer may come from blindly crawling
 * guessed paths, and that constraint is a good one for reasons beyond
 * politeness: guessing produces false positives (a `/careers` marketing page
 * with no listings) while the signals below produce evidence. So the order is
 * always: what the site *told* us, then what it *links to*, and only then a
 * small set of conventional paths — each probed with a single HEAD-like GET,
 * bounded, and only when the earlier signals found nothing.
 *
 * The output is a recommendation, never an activation. A detector that silently
 * created a source would turn one typo into a scheduled crawler.
 */

/** Conventional careers paths, tried last and only a handful of times. */
const CAREER_PATHS = [
  '/careers',
  '/jobs',
  '/career',
  '/join-us',
  '/work-with-us',
  '/opportunities',
  '/about/careers',
  '/company/careers',
];

const FEED_HINTS = [
  /<link[^>]+type=["']application\/rss\+xml["'][^>]+href=["']([^"']+)["']/i,
  /<link[^>]+type=["']application\/atom\+xml["'][^>]+href=["']([^"']+)["']/i,
  /<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/(?:rss|atom)\+xml["']/i,
];

export interface DetectorDeps {
  http: HttpClient;
  signal: AbortSignal;
  log?: (level: 'debug' | 'info' | 'warn', message: string, data?: object) => void;
}

function absolute(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/** Every same-origin link on a page, capped. */
function linksOn(html: string, base: string, limit = 400): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1];
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) {
      continue;
    }
    const resolved = absolute(href, base);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    found.push(resolved);
    if (found.length >= limit) break;
  }

  return found;
}

/** Scores a link by how likely it is to be a careers or job page. */
export function careersLinkScore(url: string, anchorText = ''): number {
  const haystack = `${url} ${anchorText}`.toLowerCase();
  let score = 0;

  if (/\/(careers?|jobs|vacancies|openings|opportunities)\b/.test(haystack)) score += 5;
  if (/(join[-\s]?us|work[-\s]?with[-\s]?us|we[-\s]?are[-\s]?hiring|hiring)/.test(haystack)) score += 3;
  if (/(greenhouse|lever|ashby|workable|smartrecruiters|recruitee|personio|teamtailor)/.test(haystack)) {
    score += 6;
  }
  if (/\/(job|position|opening|vacancy)\/[a-z0-9-]+/.test(haystack)) score += 4;
  // Penalise the pages that look like careers but never list anything.
  if (/(blog|news|press|privacy|terms|cookie|login|signin)/.test(haystack)) score -= 4;

  return score;
}

/**
 * Inspects one URL and recommends a connector.
 *
 * Each probe is independent and failure-tolerant: a site with no robots.txt, no
 * sitemap and no feed still yields a usable recommendation from its markup.
 */
export async function detectSource(
  url: string,
  deps: DetectorDeps,
): Promise<SourceDetectionResult> {
  const signals: DetectionSignal[] = [];
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return sourceDetectionResultSchema.parse({
      url,
      reachable: false,
      robotsAllowed: false,
      rejectionReason: 'Not a valid absolute URL',
    });
  }

  // ── robots.txt, first ────────────────────────────────────────────────────
  let robotsAllowed = true;
  let robotsDetail: string | null = null;
  let sitemaps: string[] = [];

  try {
    const policy = await deps.http.describePolicy(parsed.origin);
    robotsDetail = policy.assumedPermissive
      ? 'No robots.txt found; treated as permitted'
      : `robots.txt read${policy.crawlDelaySeconds ? `, crawl-delay ${policy.crawlDelaySeconds}s` : ''}`;
    sitemaps = await readSitemapUrls(parsed.origin, deps);
  } catch (error) {
    robotsDetail = `robots.txt could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }

  // ── Fetch the page ───────────────────────────────────────────────────────
  let html: string | null = null;
  try {
    const response = await deps.http.getText(parsed.toString(), { signal: deps.signal });
    html = response.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A robots refusal is a *policy* answer, not an outage, and must be
    // reported as such — the operator can choose a different mechanism.
    const disallowed = /robots\.txt disallows/i.test(message);
    if (disallowed) robotsAllowed = false;

    return sourceDetectionResultSchema.parse({
      url,
      reachable: false,
      robotsAllowed,
      robotsDetail: robotsDetail ?? null,
      rejectionReason: disallowed
        ? `This URL is disallowed by the site's robots.txt, so it will not be fetched. ${message}`
        : `Could not fetch the URL: ${message}`,
    });
  }

  // ── ATS fingerprint — the strongest signal available ─────────────────────
  const ats = detectAts({ url: parsed.toString(), html });
  if (ats) {
    signals.push({
      kind: 'ats',
      detail: `${ats.provider.displayName} board detected (identifier "${ats.identifier}")`,
      url: ats.provider.boardUrl(ats.identifier),
      confidence: ats.confidence,
    });
  }

  // ── Structured data ──────────────────────────────────────────────────────
  const structured = extractStructuredJobs(html);
  if (structured.postings.length > 0) {
    signals.push({
      kind: 'structured_data',
      detail: `${structured.postings.length} Schema.org JobPosting object(s) in the markup`,
      url: parsed.toString(),
      confidence: 0.95,
    });
  }

  // ── Feeds ────────────────────────────────────────────────────────────────
  for (const pattern of FEED_HINTS) {
    const match = pattern.exec(html);
    const href = match?.[1];
    if (!href) continue;
    const feedUrl = absolute(href, parsed.toString());
    if (!feedUrl) continue;
    signals.push({
      kind: /atom/i.test(match[0]) ? 'atom_feed' : 'rss_feed',
      detail: 'Feed advertised in the page head',
      url: feedUrl,
      confidence: 0.9,
    });
    break;
  }

  // Conventional feed paths, but only when the page advertised none.
  if (!signals.some((s) => s.kind === 'rss_feed' || s.kind === 'atom_feed')) {
    for (const candidate of ['/feed', '/rss', '/jobs.rss', '/jobs/feed', '/careers/feed']) {
      const feedUrl = absolute(candidate, parsed.origin);
      if (!feedUrl) continue;
      try {
        const response = await deps.http.getText(feedUrl, { signal: deps.signal });
        if (/<(?:rss|feed)\b/i.test(response.data)) {
          signals.push({
            kind: /<feed\b/i.test(response.data) ? 'atom_feed' : 'rss_feed',
            detail: `Feed found at ${candidate}`,
            url: feedUrl,
            confidence: 0.85,
          });
          break;
        }
      } catch {
        // Absent feed paths are the normal case; nothing to report.
      }
    }
  }

  // ── Sitemap ──────────────────────────────────────────────────────────────
  const jobSitemap = sitemaps.find((entry) => /job|career|vacan/i.test(entry));
  if (jobSitemap) {
    signals.push({
      kind: 'sitemap',
      detail: 'Sitemap that appears to index job pages',
      url: jobSitemap,
      confidence: 0.8,
    });
  } else if (sitemaps.length > 0) {
    signals.push({
      kind: 'sitemap',
      detail: `${sitemaps.length} sitemap(s) declared in robots.txt`,
      url: sitemaps[0] ?? null,
      confidence: 0.5,
    });
  }

  // ── Listing-page shape ───────────────────────────────────────────────────
  const jobLinks = linksOn(html, parsed.toString()).filter((link) => careersLinkScore(link) >= 4);
  if (jobLinks.length >= 3) {
    signals.push({
      kind: 'job_listing_page',
      detail: `${jobLinks.length} links that look like individual postings`,
      url: parsed.toString(),
      confidence: Math.min(0.85, 0.4 + jobLinks.length * 0.03),
    });
  }

  const content = extractMainContent(html);

  return sourceDetectionResultSchema.parse({
    url: parsed.toString(),
    reachable: true,
    robotsAllowed,
    robotsDetail,
    signals,
    ...recommend(signals, parsed, content.wordCount),
  });
}

/**
 * Turns signals into one connector recommendation.
 *
 * The ordering is the framework's central preference — an ATS API beats a feed
 * beats structured markup beats HTML — and it is stated in the explanation so
 * the operator can see *why* a generic crawler was not chosen.
 */
function recommend(
  signals: DetectionSignal[],
  url: URL,
  wordCount: number,
): Pick<
  SourceDetectionResult,
  'recommendedConnectorId' | 'recommendedConfig' | 'recommendation' | 'rejectionReason'
> {
  const byKind = (kind: DetectionSignal['kind']) => signals.find((signal) => signal.kind === kind);

  const ats = byKind('ats');
  if (ats) {
    const identifier = /identifier "([^"]+)"/.exec(ats.detail)?.[1] ?? '';
    const provider = ats.detail.split(' ')[0]?.toLowerCase() ?? '';
    return {
      recommendedConnectorId: 'ats',
      recommendedConfig: { provider, companies: [identifier] },
      recommendation:
        `This is a ${ats.detail}. Use the ATS connector rather than a generic HTML crawler: ` +
        `the platform publishes a documented JSON endpoint, so one request returns every posting ` +
        `with structured locations and dates, and nothing has to be parsed out of markup.`,
      rejectionReason: null,
    };
  }

  const feed = byKind('rss_feed') ?? byKind('atom_feed');
  if (feed?.url) {
    return {
      recommendedConnectorId: 'rss',
      recommendedConfig: { feedUrl: feed.url },
      recommendation:
        `A feed is available at ${feed.url}. Use the RSS connector: feeds support conditional ` +
        `requests, so repeat polls cost almost nothing when nothing has changed.`,
      rejectionReason: null,
    };
  }

  const structured = byKind('structured_data');
  const listing = byKind('job_listing_page');

  if (structured || listing) {
    return {
      recommendedConnectorId: 'web',
      recommendedConfig: {
        seedUrls: [url.toString()],
        allowedDomains: [url.hostname.replace(/^www\./, '')],
        preferStructuredData: Boolean(structured),
      },
      recommendation: structured
        ? `The page carries Schema.org JobPosting markup. Use the web connector with ` +
          `structured-data extraction — the publisher has already structured the data, so no ` +
          `guessing is required.`
        : `No API, feed or structured markup was found, but the page links to what look like ` +
          `individual postings. The web connector can follow those links within this domain, ` +
          `bounded by depth and page limits.`,
      rejectionReason: null,
    };
  }

  if (wordCount < 60) {
    return {
      recommendedConnectorId: null,
      recommendedConfig: {},
      recommendation: '',
      rejectionReason:
        'The page returned almost no readable text. It is likely rendered entirely in the ' +
        'browser, which this system does not execute. Look for the JSON endpoint the page ' +
        'calls, or the ATS board behind it, and add that instead.',
    };
  }

  return {
    recommendedConnectorId: null,
    recommendedConfig: {},
    recommendation: '',
    rejectionReason:
      'No API, feed, structured markup or posting links were found at this URL. It may be a ' +
      'marketing page rather than a job listing — try the page that actually lists open roles.',
  };
}

/** Sitemap URLs declared in robots.txt. Never fetches them. */
async function readSitemapUrls(origin: string, deps: DetectorDeps): Promise<string[]> {
  try {
    const response = await deps.http.getText(`${origin}/robots.txt`, {
      signal: deps.signal,
      skipRobots: true,
    });
    return response.data
      .split(/\r?\n/)
      .map((line) => /^sitemap:\s*(\S+)/i.exec(line.trim())?.[1])
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 20);
  } catch {
    return [];
  }
}

/**
 * Finds a company's careers page from its domain alone.
 *
 * Homepage links first — a company that wants to be found links to its own
 * careers page — then the conventional paths, bounded to a handful of probes.
 * Returns candidates with evidence rather than picking one silently.
 */
export async function findCareersPages(
  domain: string,
  deps: DetectorDeps,
  options: { maxProbes?: number } = {},
): Promise<Array<{ url: string; score: number; via: 'homepage_link' | 'conventional_path' }>> {
  const maxProbes = options.maxProbes ?? 6;
  const origin = domain.startsWith('http') ? domain : `https://${domain}`;
  const found: Array<{ url: string; score: number; via: 'homepage_link' | 'conventional_path' }> = [];

  try {
    const home = await deps.http.getText(origin, { signal: deps.signal });
    for (const link of linksOn(home.data, origin)) {
      const score = careersLinkScore(link);
      if (score >= 5) found.push({ url: link, score, via: 'homepage_link' });
    }
  } catch (error) {
    deps.log?.('debug', `Homepage unreachable for ${domain}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Only when the site linked to nothing. Probing paths on a site that already
  // told us where its jobs are would be requests for no information.
  if (found.length === 0) {
    let probes = 0;
    for (const path of CAREER_PATHS) {
      if (probes >= maxProbes) break;
      probes += 1;
      const candidate = `${origin.replace(/\/$/, '')}${path}`;
      try {
        const response = await deps.http.getText(candidate, { signal: deps.signal });
        if (response.status === 200 && /job|career|vacanc|position|opening/i.test(response.data)) {
          found.push({ url: candidate, score: careersLinkScore(candidate), via: 'conventional_path' });
        }
      } catch {
        // A 404 on a guessed path is the expected outcome, not an error.
      }
    }
  }

  return found
    .sort((a, b) => b.score - a.score)
    .filter(
      (entry, index, all) => all.findIndex((other) => other.url === entry.url) === index,
    )
    .slice(0, 10);
}
