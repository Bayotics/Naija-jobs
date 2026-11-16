import { z } from 'zod';
import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import { NotPermittedError } from '../errors';
import { DEFAULT_CAPABILITIES, type Connector, type ConnectorContext, type DiscoverySummary } from '../types';
import { extractStructuredJobs, type ExtractedJobPosting } from '../extract/schema-org';
import { extractMainContent, shouldClassify } from '../extract/content';
import { careersLinkScore } from '../company/careers-detector';
import { classifyContent, type ClassificationProvider } from './classifier';

/**
 * Bounded discovery over permitted public pages.
 *
 * This is the mechanism of last resort, and it is written to behave like one.
 * Every one of the limits below exists because the alternative is a crawler
 * that wanders:
 *
 *  - **Domain allowlist.** A seed page links to LinkedIn, Twitter and a CDN.
 *    Without an allowlist, "follow the job links" becomes "crawl the web".
 *  - **Depth and page caps.** Two levels and forty pages covers a careers page
 *    and the postings it lists. It does not cover a blog archive.
 *  - **Visited set and a queue, not recursion.** A site with a calendar widget
 *    generates infinite distinct URLs; a bounded queue simply stops.
 *  - **Link scoring.** Following every link wastes the page budget on privacy
 *    policies. Following only job-shaped links spends it on postings.
 *
 * robots.txt is enforced inside the HTTP client, so a disallowed path is never
 * fetched here regardless of what a page links to.
 */
export const webConfigSchema = z.object({
  seedUrls: z.array(z.string().url()).min(1).max(50),
  /** Hosts the crawl may visit. Empty means "the seeds' own hosts only". */
  allowedDomains: z.array(z.string().trim().min(1).max(200)).default([]),
  maxPages: z.number().int().min(1).max(500).default(40),
  maxDepth: z.number().int().min(0).max(4).default(2),
  /** Minimum link score to enqueue. Higher crawls less and more precisely. */
  minLinkScore: z.number().int().min(0).max(20).default(4),
  /** Use Schema.org markup when present rather than reading prose. */
  preferStructuredData: z.boolean().default(true),
  /** Allow the classifier to adjudicate ambiguous pages. */
  useClassifier: z.boolean().default(true),
  maxClassifierCalls: z.number().int().min(0).max(200).default(20),
  /** Applied when the page states no location — country-scoped boards need it. */
  defaultLocationText: z.string().nullable().default(null),
  defaultCompany: z.string().nullable().default(null),
});

export type WebConfig = z.infer<typeof webConfigSchema>;

export interface WebConnectorDeps {
  classifier?: ClassificationProvider | null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Strips tracking parameters and fragments so one page is one URL. */
function canonicalise(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(key)) parsed.searchParams.delete(key);
    }
    // A trailing slash is the same page; normalising it halves the visited set.
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function linksWithText(html: string, base: string): Array<{ url: string; text: string }> {
  const found: Array<{ url: string; text: string }> = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const href = match[1];
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) {
      continue;
    }
    try {
      found.push({
        url: canonicalise(new URL(href, base).toString()),
        text: (match[2] ?? '').replace(/<[^>]+>/g, ' ').trim(),
      });
    } catch {
      // A malformed href on someone else's page is not our problem.
    }
    if (found.length >= 300) break;
  }
  return found;
}

function postingToDraft(
  posting: ExtractedJobPosting,
  url: string,
  config: WebConfig,
): SourceJobDraft | null {
  const parsed = sourceJobDraftSchema.safeParse({
    title: posting.title,
    companyName: posting.hiringOrganization ?? config.defaultCompany ?? hostOf(url) ?? 'Unknown',
    companyWebsite: posting.organizationUrl,
    description: posting.description,
    descriptionFormat: posting.descriptionIsHtml ? 'html' : 'text',
    locationText: posting.locationText ?? config.defaultLocationText,
    remoteFlag: posting.jobLocationType ? /telecommute|remote/i.test(posting.jobLocationType) : null,
    employmentTypeTexts: posting.employmentTypes,
    salaryMin: posting.salaryMin,
    salaryMax: posting.salaryMax,
    salaryCurrency: posting.salaryCurrency,
    salaryPeriod: posting.salaryPeriod,
    postedAt: posting.datePosted,
    validThrough: posting.validThrough,
    url: posting.directApplyUrl ?? url,
    applyUrl: posting.directApplyUrl,
    externalId: posting.identifier,
    raw: posting,
    sourceMetadata: {
      discoveryMethod: 'structured_data',
      extractedFrom: posting.extractedFrom,
      fieldsPresent: posting.fieldsPresent,
      applicantLocationRequirements: posting.applicantLocationRequirements,
    },
  });
  return parsed.success ? parsed.data : null;
}

export class WebConnector implements Connector<WebConfig> {
  readonly id = 'web';
  readonly displayName = 'Public web page';
  readonly sourceType = 'html_page' as const;
  readonly accessTier = 'permitted_html' as const;
  readonly capabilities = {
    ...DEFAULT_CAPABILITIES,
    supportsDetailFetch: true,
    supportsPagination: true,
  };
  readonly configSchema = webConfigSchema;

  constructor(private readonly deps: WebConnectorDeps = {}) {}

  availability() {
    return { available: true, reason: null, requires: [] };
  }

  async healthCheck(ctx: ConnectorContext<WebConfig>) {
    const startedAt = Date.now();
    const seed = ctx.config.seedUrls[0];
    if (!seed) {
      return { healthy: false, message: 'No seed URLs configured', checkedAt: new Date() };
    }

    try {
      const response = await ctx.http.getText(seed, { signal: ctx.signal });
      const structured = extractStructuredJobs(response.data);
      const content = extractMainContent(response.data);

      return {
        healthy: true,
        message:
          structured.postings.length > 0
            ? `${structured.postings.length} structured posting(s) found`
            : `Page readable (${content.wordCount} words, ${content.strategy} extraction)`,
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

  async *discover(
    ctx: ConnectorContext<WebConfig>,
  ): AsyncGenerator<SourceJobDraft, DiscoverySummary, void> {
    const { config } = ctx;

    const allowed = new Set(
      config.allowedDomains.length > 0
        ? config.allowedDomains.map((domain) => domain.replace(/^www\./, '').toLowerCase())
        : config.seedUrls.map((url) => hostOf(url)).filter((host): host is string => Boolean(host)),
    );

    if (allowed.size === 0) {
      throw new NotPermittedError('Web discovery requires at least one allowed domain', {
        seedUrls: config.seedUrls,
      });
    }

    const visited = new Set<string>();
    const emitted = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = config.seedUrls.map((url) => ({
      url: canonicalise(url),
      depth: 0,
    }));

    let pagesFetched = 0;
    let classifierCalls = 0;
    let structuredPages = 0;
    let classifiedPages = 0;

    while (queue.length > 0 && pagesFetched < config.maxPages) {
      if (ctx.signal.aborted) break;

      const next = queue.shift()!;
      if (visited.has(next.url)) continue;
      visited.add(next.url);

      const host = hostOf(next.url);
      if (!host || !isAllowedHost(host, allowed)) continue;

      let html: string;
      try {
        const response = await ctx.http.getText(next.url, { signal: ctx.signal });
        html = response.data;
        pagesFetched += 1;
      } catch (error) {
        // A disallowed or dead page is one page, not the end of the crawl.
        ctx.log('debug', `Skipped ${next.url}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      // ── Structured data first, always ────────────────────────────────────
      let yieldedFromPage = 0;
      if (config.preferStructuredData) {
        const structured = extractStructuredJobs(html);
        for (const posting of structured.postings) {
          if (!posting.title) continue;
          const draft = postingToDraft(posting, next.url, config);
          if (!draft || emitted.has(draft.url)) continue;
          emitted.add(draft.url);
          yieldedFromPage += 1;
          yield draft;
        }
        if (yieldedFromPage > 0) structuredPages += 1;
      }

      // ── Otherwise, is this page itself a posting? ────────────────────────
      if (yieldedFromPage === 0) {
        const content = extractMainContent(html);
        const gate = shouldClassify(content, next.url);

        if (gate.worthClassifying && config.useClassifier && classifierCalls < config.maxClassifierCalls) {
          const result = await classifyContent(
            {
              text: content.text,
              url: next.url,
              metadata: { title: titleOf(html) },
            },
            {
              provider: this.deps.classifier ?? null,
              canSpend: () => classifierCalls < config.maxClassifierCalls,
            },
          );

          if (result.method === 'ai' || result.method === 'ai_failed_fallback') classifierCalls += 1;

          if (result.classification.isJob && result.classification.confidence >= 0.5) {
            classifiedPages += 1;
            const draft = sourceJobDraftSchema.safeParse({
              title: result.classification.title ?? titleOf(html) ?? 'Untitled posting',
              companyName:
                result.classification.company ?? config.defaultCompany ?? host ?? 'Unknown',
              description: content.text,
              descriptionFormat: 'text',
              locationText: result.classification.location ?? config.defaultLocationText,
              remoteFlag:
                result.classification.remoteStatus === 'remote'
                  ? true
                  : result.classification.remoteStatus === 'onsite'
                    ? false
                    : null,
              url: next.url,
              applyUrl: result.classification.applicationUrl,
              raw: { extraction: content.strategy, classification: result.classification },
              sourceMetadata: {
                discoveryMethod: 'permitted_html',
                extractionStrategy: content.strategy,
                classificationMethod: result.method,
                classificationConfidence: result.classification.confidence,
                classificationReason: result.classification.reason,
                aiClassified: result.method === 'ai',
                model: result.modelUsed,
              },
            });

            if (draft.success && !emitted.has(draft.data.url)) {
              emitted.add(draft.data.url);
              yield draft.data;
            }
          }
        } else if (!gate.worthClassifying) {
          ctx.log('debug', `Not classified: ${next.url}`, { reason: gate.reason });
        }
      }

      // ── Enqueue promising links ──────────────────────────────────────────
      if (next.depth < config.maxDepth) {
        for (const link of linksWithText(html, next.url)) {
          if (visited.has(link.url) || queue.length > config.maxPages * 4) continue;
          const linkHost = hostOf(link.url);
          if (!linkHost || !isAllowedHost(linkHost, allowed)) continue;
          if (careersLinkScore(link.url, link.text) < config.minLinkScore) continue;
          queue.push({ url: link.url, depth: next.depth + 1 });
        }
      }
    }

    ctx.log('info', 'Web crawl finished', {
      pagesFetched,
      structuredPages,
      classifiedPages,
      classifierCalls,
      emitted: emitted.size,
      queueRemaining: queue.length,
    });

    return {
      pagesFetched,
      truncated: queue.length > 0 && pagesFetched >= config.maxPages,
      cursor: { lastCrawlAt: new Date().toISOString(), pagesFetched },
    };
  }
}

function isAllowedHost(host: string, allowed: Set<string>): boolean {
  for (const domain of allowed) {
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function titleOf(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html);
  const title = match?.[1]?.replace(/\s+/g, ' ').trim();
  return title && title.length > 0 ? title : null;
}
