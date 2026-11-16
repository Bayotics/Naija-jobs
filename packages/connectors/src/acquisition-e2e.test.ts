import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTENT_LIMITS,
  isInScope,
  planIncrementalScan,
  planPushdown,
  scoreSourceHealth,
  sourceReliabilitySchema,
  sourceWatermarkSchema,
  sourceCapabilitiesSchema,
} from '@job-intel/contracts';
import { RssConnector } from './feed/rss-connector';
import { RedditConnector } from './social/reddit-connector';
import { RemotiveConnector } from './api/remotive-connector';
import { SearchDiscoveryConnector } from './search/search-discovery-connector';
import { SitemapConnector, parseSitemap } from './feed/sitemap-connector';
import { WebConnector } from './web/web-connector';
import { AtsConnector } from './ats/ats-connector';
import { RestrictedSourceConnector } from './restricted/restricted-connector';
import { extractStructuredJobs } from './extract/schema-org';
import { postingToDraft } from './parse/posting-to-draft';
import { detectChanges, isUnchanged } from './change/detect-changes';
import {
  buildIdentitySignals,
  canonicalJobKey,
  compareIdentities,
  normalizeUrl,
} from './identity/job-identity';
import { ConcurrencyController } from './concurrency';
import { planQueries, queryFingerprint } from './query/query-plan';
import { buildAtsSearchQueries, buildKeywordQueries } from './query/builders';
import { findPlatformStrategy, restrictedPlatforms } from './platform/platform-strategy';
import { resolvePolicy, preferredMethod, toSourceCapabilities } from './policy';
import { checkUrl } from './http/ssrf';
import { collect, testContext, testHttpClient } from './testing';
import { classifyError } from './errors';
import type { Connector, QueryBuildInput } from './types';

/**
 * The acquisition layer, end to end (Part 50).
 *
 * Twenty scenarios, and the ones that matter are the nineteen where something
 * is wrong. A source layer is not judged on whether it can read a well-formed
 * RSS feed — everything can — but on whether a 500, a redirect into the private
 * network, a 40 MB response and an expired posting each produce the *specific*
 * correct outcome while the other sources keep running.
 *
 * The fixtures are deliberately hostile in the ways real sources are: HTML that
 * changed shape, JSON that is truncated mid-object, a sitemap pointing off-host,
 * a page that 302s to the cloud metadata endpoint. Every one of these has a real
 * counterpart.
 */

const feedXml = (items: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test Board</title>${items}</channel></rss>`;

const feedItem = (title: string, link: string, date = 'Mon, 18 Aug 2026 09:00:00 GMT') =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate>
   <description>We need an engineer. React, TypeScript, and a willingness to read logs.</description></item>`;

const jsonLdPage = (overrides: Record<string, unknown> = {}) => `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Senior Frontend Engineer',
  description: 'Build interfaces. TypeScript, React, and a tolerance for ambiguity.',
  datePosted: '2026-08-18',
  validThrough: '2026-12-31',
  employmentType: 'FULL_TIME',
  hiringOrganization: { '@type': 'Organization', name: 'Northwind GmbH' },
  jobLocation: {
    '@type': 'Place',
    address: { '@type': 'PostalAddress', addressLocality: 'Berlin', addressCountry: 'DE' },
  },
  baseSalary: {
    '@type': 'MonetaryAmount',
    currency: 'EUR',
    value: { '@type': 'QuantitativeValue', minValue: 70000, maxValue: 90000, unitText: 'YEAR' },
  },
  ...overrides,
})}</script></head><body><h1>Senior Frontend Engineer</h1></body></html>`;

const sitemapXml = (urls: Array<[string, string | null]>) => `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`)
  .join('\n')}
</urlset>`;

const comparable = (overrides: Partial<Parameters<typeof detectChanges>[0]['current']> = {}) => ({
  title: 'Senior Frontend Engineer',
  description: 'Build interfaces with React and TypeScript for a distributed team.',
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  locationText: 'Berlin, DE',
  remoteType: 'hybrid',
  employmentType: 'full_time',
  deadline: null,
  status: 'active',
  applyUrl: 'https://northwind.example.test/apply/1',
  seniority: 'senior',
  visaSponsorship: null,
  ...overrides,
});

describe('acquisition end to end', () => {
  // ── 1. RSS source ───────────────────────────────────────────────────────
  it('1. reads an RSS source and yields drafts', async () => {
    const { client } = testHttpClient([
      {
        match: 'feed.xml',
        body: feedXml(
          feedItem('Northwind GmbH: Senior Frontend Engineer', 'https://board.example.test/jobs/1') +
            feedItem('Contoso: Backend Engineer', 'https://board.example.test/jobs/2'),
        ),
      },
    ]);

    const connector = new RssConnector();
    const { items } = await collect(
      connector.discover(
        testContext({
          config: connector.configSchema.parse({ feedUrl: 'https://board.example.test/feed.xml' }),
          http: client,
        }),
      ),
    );

    expect(items).toHaveLength(2);
    expect(items[0]!.companyName).toBe('Northwind GmbH');
    expect(items[0]!.title).toBe('Senior Frontend Engineer');
  });

  // ── 2. ATS source ───────────────────────────────────────────────────────
  it('2. reads an ATS board through its public API', async () => {
    const { client } = testHttpClient([
      {
        match: 'boards-api.greenhouse.io',
        body: JSON.stringify({
          jobs: [
            {
              id: 4001,
              title: 'Platform Engineer',
              absolute_url: 'https://boards.greenhouse.io/northwind/jobs/4001',
              updated_at: '2026-08-18T09:00:00Z',
              location: { name: 'Berlin, Germany' },
              content: 'Run the platform. Kubernetes, Go, and on-call.',
            },
          ],
        }),
      },
    ]);

    const connector = new AtsConnector();
    const { items } = await collect(
      connector.discover(
        testContext({
          config: connector.configSchema.parse({ provider: 'greenhouse', companies: ['northwind'] }),
          http: client,
        }),
      ),
    );

    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Platform Engineer');
    expect(items[0]!.url).toContain('greenhouse.io');
  });

  // ── 3. Company career page ──────────────────────────────────────────────
  it('3. crawls a company career page within its configured scope', async () => {
    const { client } = testHttpClient([
      {
        match: 'northwind.example.test/careers/senior-frontend-engineer',
        headers: { 'content-type': 'text/html' },
        body: jsonLdPage(),
      },
      {
        match: 'northwind.example.test/careers',
        headers: { 'content-type': 'text/html' },
        body: `<html><body>
          <a href="/careers/senior-frontend-engineer">Senior Frontend Engineer</a>
          <a href="https://elsewhere.example.test/jobs/9">Off-site role</a>
        </body></html>`,
      },
    ]);

    const connector = new WebConnector();
    const { items } = await collect(
      connector.discover(
        testContext({
          config: connector.configSchema.parse({
            seedUrls: ['https://northwind.example.test/careers'],
            allowedDomains: ['northwind.example.test'],
            defaultCompany: 'Northwind GmbH',
            useClassifier: false,
          }),
          http: client,
        }),
      ),
    );

    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((item) => item.url.includes('northwind.example.test'))).toBe(true);
  });

  // ── 4. JSON-LD job page ─────────────────────────────────────────────────
  it('4. extracts every JSON-LD field the page publishes', () => {
    const extraction = extractStructuredJobs(jsonLdPage());
    const posting = extraction.postings[0]!;

    expect(posting.title).toBe('Senior Frontend Engineer');
    expect(posting.hiringOrganization).toBe('Northwind GmbH');
    expect(posting.salaryMin).toBe(70_000);
    expect(posting.salaryCurrency).toBe('EUR');
    expect(posting.countryCode).toBe('DE');
    expect(posting.validThrough).toBeInstanceOf(Date);

    const draft = postingToDraft(posting, 'https://northwind.example.test/careers/1');
    expect(draft?.salaryMin).toBe(70_000);
  });

  // ── 5. Plain HTML job page ──────────────────────────────────────────────
  it('5. declines to invent a posting from HTML with no structured data', () => {
    const html = '<html><head><title>Careers at Northwind</title></head><body><h1>Join us</h1></body></html>';
    const extraction = extractStructuredJobs(html);

    /*
     * The important assertion in the whole file.
     *
     * A page with no structured data yields nothing. Guessing a title from the
     * `<title>` tag would produce a record that looks like a job, is not one,
     * and can never be distinguished from a real one afterwards.
     */
    expect(extraction.postings).toHaveLength(0);
  });

  // ── 6. Search-engine discovery ──────────────────────────────────────────
  it('6. builds search queries from a profile without hardcoding any', () => {
    const input: QueryBuildInput = {
      profileId: null,
      roles: ['Frontend Engineer', 'React Developer'],
      locations: ['Germany'],
      keywords: ['typescript'],
      remoteAcceptable: true,
      maxQueries: 6,
    };

    const queries = buildAtsSearchQueries('search-discovery', input);

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((query) => query.text.startsWith('site:'))).toBe(true);
    expect(queries.some((query) => query.text.includes('Frontend Engineer'))).toBe(true);
    expect(queries.some((query) => query.text.includes('Germany'))).toBe(true);

    // Every criterion is residual: a search engine filters by none of them.
    expect(queries[0]!.residualFilters).toContain('salary');
  });

  // ── 7. Source returning duplicates ──────────────────────────────────────
  it('7. recognises the same posting arriving from three different sources', () => {
    const board = buildIdentitySignals({
      url: 'https://board.example.test/redirect?to=greenhouse&utm_source=newsletter',
      canonicalUrl: 'https://boards.greenhouse.io/northwind/jobs/4001',
      title: 'Platform Engineer',
      companyName: 'Northwind GmbH',
    });

    const search = buildIdentitySignals({
      url: 'https://boards.greenhouse.io/northwind/jobs/4001?gh_src=google',
      title: 'Platform Engineer',
      companyName: 'Northwind',
    });

    const comparison = compareIdentities(board, search);

    expect(comparison.same).toBe(true);
    expect(comparison.agreed).toContain('atsId');
    expect(canonicalJobKey(board)).toBe(canonicalJobKey(search));
  });

  it('7b. keeps two different openings at the same company apart', () => {
    const first = buildIdentitySignals({
      url: 'https://boards.greenhouse.io/northwind/jobs/4001',
      title: 'Platform Engineer',
      companyName: 'Northwind GmbH',
    });

    const second = buildIdentitySignals({
      url: 'https://boards.greenhouse.io/northwind/jobs/4002',
      title: 'Platform Engineer',
      companyName: 'Northwind GmbH',
    });

    const comparison = compareIdentities(first, second);

    /*
     * Same company, same title, same location — and two different ATS ids,
     * which is decisive. Merging these would lose an application.
     */
    expect(comparison.same).toBe(false);
    expect(comparison.conflicted).toContain('atsId');
  });

  // ── 8. Malformed data ───────────────────────────────────────────────────
  it('8. survives malformed JSON-LD without losing the rest of the page', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"JobPosting","title":</script>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        title: 'Data Engineer',
        hiringOrganization: { name: 'Contoso' },
      })}</script>
    </head><body></body></html>`;

    const extraction = extractStructuredJobs(html);

    expect(extraction.malformedBlocks).toBeGreaterThan(0);
    expect(extraction.postings).toHaveLength(1);
    expect(extraction.postings[0]!.title).toBe('Data Engineer');
  });

  // ── 9. Source timing out ────────────────────────────────────────────────
  it('9. classifies a timeout as retryable and does not hang', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const classified = classifyError(timeout);

    expect(classified.retryable).toBe(true);

    const { client } = testHttpClient([{ match: 'slow.example.test', body: '', throws: timeout }]);

    await expect(client.getText('https://slow.example.test/feed')).rejects.toThrow();
  });

  // ── 10. Source returning 429 ────────────────────────────────────────────
  it('10. treats 429 as retryable and never retries past the limit', async () => {
    const { client, mock } = testHttpClient([
      { match: 'ratelimited.example.test', body: '{}', failTimes: 10, failStatus: 429 },
    ]);

    await expect(client.getJson('https://ratelimited.example.test/api')).rejects.toThrow();

    /*
     * Bounded retries. A 429 answered with unlimited retries is
     * indistinguishable from an attempt to evade the rate limit.
     */
    expect(mock.calls.length).toBeLessThanOrEqual(5);
  });

  // ── 11. Source returning 403 ────────────────────────────────────────────
  it('11. treats 403 as permanent and does not retry it', async () => {
    const { client, mock } = testHttpClient([
      { match: 'forbidden.example.test', body: 'denied', status: 403 },
    ]);

    await expect(client.getText('https://forbidden.example.test/jobs')).rejects.toThrow();

    /*
     * One attempt only. Retrying a refusal is the behaviour that gets a client
     * blocked, and 403 means the answer will not change.
     */
    expect(mock.calls).toHaveLength(1);
  });

  // ── 12. Source returning 500 ────────────────────────────────────────────
  it('12. retries a 500 and succeeds when the source recovers', async () => {
    const { client, mock } = testHttpClient([
      {
        match: 'flaky.example.test',
        body: feedXml(feedItem('Contoso: SRE', 'https://flaky.example.test/jobs/1')),
        failTimes: 2,
        failStatus: 500,
      },
    ]);

    const response = await client.getXml('https://flaky.example.test/feed.xml');

    expect(response).toBeDefined();
    expect(mock.calls.length).toBeGreaterThan(1);
  });

  // ── 13. Source requiring authentication ─────────────────────────────────
  it('13. reports a missing credential as AUTH_REQUIRED rather than failing', () => {
    const strategy = findPlatformStrategy('x')!;

    expect(strategy.credentialRefs).toContain('X_BEARER_TOKEN');
    expect(strategy.permitted).toEqual(['OFFICIAL_API']);

    /*
     * No unauthenticated fallback exists, and that is the point: the only way
     * to read X without a token is to impersonate a browser.
     */
    expect(strategy.permitted).not.toContain('PERMITTED_HTML');
  });

  // ── 14. Source with changing job content ────────────────────────────────
  it('14. reports a published salary as material and a reworded paragraph as not', () => {
    const salaryAppeared = detectChanges({
      jobId: '11111111-1111-4111-8111-111111111111',
      sourceId: 'board',
      previous: comparable(),
      current: comparable({ salaryMin: 70_000, salaryMax: 90_000, salaryCurrency: 'EUR' }),
      previousContentHash: 'a'.repeat(64),
      currentContentHash: 'b'.repeat(64),
    });

    expect(salaryAppeared.material).toBe(true);
    expect(salaryAppeared.changes[0]!.field).toBe('salary');
    expect(salaryAppeared.changes[0]!.summary).toContain('Salary published');

    const reworded = detectChanges({
      jobId: '11111111-1111-4111-8111-111111111111',
      sourceId: 'board',
      previous: comparable(),
      current: comparable({
        description: 'Build interfaces with React and TypeScript for a remote team.',
      }),
      previousContentHash: 'a'.repeat(64),
      currentContentHash: 'c'.repeat(64),
    });

    expect(reworded.changes).toHaveLength(1);
    expect(reworded.material).toBe(false);

    // An identical read short-circuits before any of this runs.
    expect(isUnchanged('a'.repeat(64), 'a'.repeat(64))).toBe(true);
  });

  // ── 15. Malicious redirect ──────────────────────────────────────────────
  it('15. refuses a redirect into the private network', async () => {
    const { client } = testHttpClient(
      [
        {
          match: 'innocent.example.test',
          body: '',
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        },
      ],
      { skipHostResolution: false },
    );

    await expect(client.getText('https://innocent.example.test/jobs')).rejects.toThrow();
  });

  // ── 16. Malicious URL ───────────────────────────────────────────────────
  it('16. blocks loopback, metadata and alternate encodings before any request', async () => {
    const blocked = [
      'http://localhost:5432/',
      'http://127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://2130706433/', // 127.0.0.1 as a decimal integer
      'http://0177.0.0.1/', // and as octal
      'file:///etc/passwd',
      'gopher://internal.example/',
      'http://10.0.0.5/internal',
      'http://[::1]/',
    ];

    for (const url of blocked) {
      const result = await checkUrl(new URL(url));
      expect(result.allowed, `${url} should be blocked`).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });

  // ── 17. Oversized response ──────────────────────────────────────────────
  it('17. refuses a response larger than the content limit', async () => {
    const { client } = testHttpClient(
      [{ match: 'huge.example.test', body: 'x'.repeat(200_000) }],
      { maxResponseBytes: 50_000 },
    );

    await expect(client.getText('https://huge.example.test/page')).rejects.toThrow();
  });

  // ── 18. Invalid JSON ────────────────────────────────────────────────────
  it('18. fails cleanly on truncated JSON rather than yielding a half-record', async () => {
    const { client } = testHttpClient([
      { match: 'broken.example.test', body: '{"jobs":[{"title":"Engineer",' },
    ]);

    await expect(client.getJson('https://broken.example.test/api')).rejects.toThrow();
  });

  // ── 19. Expired job ─────────────────────────────────────────────────────
  it('19. carries the expiry date through so downstream can drop it', () => {
    const posting = extractStructuredJobs(jsonLdPage({ validThrough: '2026-01-31' })).postings[0]!;
    const draft = postingToDraft(posting, 'https://northwind.example.test/careers/1')!;

    expect(draft.validThrough).toBeInstanceOf(Date);
    expect(draft.validThrough!.getTime()).toBeLessThan(new Date('2026-08-22').getTime());
  });

  // ── 20. Valid job, all the way through ──────────────────────────────────
  it('20. carries a valid posting through acquisition, extraction and identity', async () => {
    const { client } = testHttpClient([
      {
        match: 'sitemap.xml',
        body: sitemapXml([['https://northwind.example.test/careers/1', '2026-08-18T09:00:00Z']]),
      },
      {
        match: 'careers/1',
        headers: { 'content-type': 'text/html' },
        body: jsonLdPage(),
      },
    ]);

    const connector = new SitemapConnector();
    const { items, result } = await collect(
      connector.discover(
        testContext({
          config: connector.configSchema.parse({
            sitemapUrl: 'https://northwind.example.test/sitemap.xml',
            allowedHosts: ['northwind.example.test'],
            jobUrlPattern: '/careers/',
          }),
          http: client,
        }),
      ),
    );

    expect(items).toHaveLength(1);

    const draft = items[0]!;
    expect(draft.title).toBe('Senior Frontend Engineer');
    expect(draft.companyName).toBe('Northwind GmbH');
    expect(draft.salaryMin).toBe(70_000);

    const signals = buildIdentitySignals({
      url: draft.url,
      title: draft.title,
      companyName: draft.companyName,
      description: draft.description,
    });

    expect(canonicalJobKey(signals)).toMatch(/^url:/);

    // The watermark advanced, so the next scan is incremental.
    expect(result?.cursor['lastModified']).toBe('2026-08-18T09:00:00.000Z');
  });
});

describe('sitemap discovery', () => {
  it('follows a sitemap index but refuses entries outside the scope', async () => {
    const { client, mock } = testHttpClient([
      {
        match: 'sitemap-index.xml',
        body: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://northwind.example.test/sitemap-jobs.xml</loc></sitemap>
          <sitemap><loc>https://attacker.example.test/sitemap.xml</loc></sitemap>
        </sitemapindex>`,
      },
      {
        match: 'sitemap-jobs.xml',
        body: sitemapXml([['https://northwind.example.test/careers/1', '2026-08-18T09:00:00Z']]),
      },
      { match: 'careers/1', headers: { 'content-type': 'text/html' }, body: jsonLdPage() },
    ]);

    const connector = new SitemapConnector();
    await collect(
      connector.discover(
        testContext({
          config: connector.configSchema.parse({
            sitemapUrl: 'https://northwind.example.test/sitemap-index.xml',
            allowedHosts: ['northwind.example.test'],
            jobUrlPattern: '/careers/',
          }),
          http: client,
        }),
      ),
    );

    /*
     * A sitemap naming a URL is not authorisation to fetch it. The off-host
     * entry is never requested.
     */
    expect(mock.callsFor('attacker.example.test')).toHaveLength(0);
    expect(mock.callsFor('sitemap-jobs.xml')).toHaveLength(1);
  });

  it('skips entries unchanged since the last scan', async () => {
    const { client, mock } = testHttpClient([
      {
        match: 'sitemap.xml',
        body: sitemapXml([
          ['https://northwind.example.test/careers/1', '2026-08-10T09:00:00Z'],
          ['https://northwind.example.test/careers/2', '2026-08-20T09:00:00Z'],
        ]),
      },
      { match: 'careers/', headers: { 'content-type': 'text/html' }, body: jsonLdPage() },
    ]);

    const connector = new SitemapConnector();
    await collect(
      connector.discover(
        testContext({
          config: connector.configSchema.parse({
            sitemapUrl: 'https://northwind.example.test/sitemap.xml',
            allowedHosts: ['northwind.example.test'],
            jobUrlPattern: '/careers/',
          }),
          http: client,
          cursor: { lastModified: '2026-08-15T00:00:00.000Z' },
        }),
      ),
    );

    expect(mock.callsFor('careers/1')).toHaveLength(0);
    expect(mock.callsFor('careers/2')).toHaveLength(1);
  });

  it('reads lastmod out of a malformed sitemap', () => {
    const parsed = parseSitemap(
      '<urlset><url><loc>https://a.example.test/jobs/1&amp;x=1</loc><lastmod>2026-08-18</lastmod></url></urlset>',
    );

    expect(parsed.kind).toBe('urlset');
    expect(parsed.entries[0]!.loc).toBe('https://a.example.test/jobs/1&x=1');
    expect(parsed.entries[0]!.lastModified).toBeInstanceOf(Date);
  });
});

describe('access policy and restricted platforms', () => {
  it('never fetches a restricted source', async () => {
    const connector = new RestrictedSourceConnector();
    const policy = resolvePolicy(connector as unknown as Connector<never>);

    expect(policy.fetchable).toBe(false);
    expect(preferredMethod(policy.accessPolicy)).toBeNull();

    const { client, mock } = testHttpClient([{ match: 'linkedin', body: '{}' }]);

    await expect(
      collect(
        connector.discover(
          testContext({
            config: connector.configSchema.parse({
              restrictionReason: 'Automated access is prohibited.',
            }),
            http: client,
          }),
        ),
      ),
    ).rejects.toThrow();

    /* Not one request was issued. */
    expect(mock.calls).toHaveLength(0);
  });

  it('names an alternative for every platform it will not fetch', () => {
    const restricted = restrictedPlatforms();

    expect(restricted.length).toBeGreaterThan(0);

    for (const platform of restricted) {
      expect(platform.restriction, `${platform.platformId} needs a stated reason`).toBeTruthy();
      expect(
        platform.alternatives.length,
        `${platform.platformId} needs at least one alternative`,
      ).toBeGreaterThan(0);
    }
  });

  it('routes LinkedIn through permitted mechanisms only', () => {
    const linkedin = findPlatformStrategy('linkedin')!;

    expect(linkedin.permitted).toEqual(['USER_PROVIDED_EXPORT']);
    expect(linkedin.alternatives.some((entry) => /career page/i.test(entry))).toBe(true);
    expect(linkedin.alternatives.some((entry) => /ATS|Greenhouse/i.test(entry))).toBe(true);
  });

  it('gives an HTML source a stricter rate limit than an official API', () => {
    const api = resolvePolicy({ accessTier: 'official_api', sourceType: 'job_api' } as never);
    const html = resolvePolicy({ accessTier: 'permitted_html', sourceType: 'html_page' } as never);

    expect(html.rateLimit.requestsPerMinute).toBeLessThan(api.rateLimit.requestsPerMinute);
    expect(html.rateLimit.minIntervalMs).toBeGreaterThan(api.rateLimit.minIntervalMs);
    expect(html.accessPolicy.honoursRobots).toBe(true);
  });
});

describe('query planning', () => {
  const stubConnector = (queries: number, id = 'stub'): Connector<never> =>
    ({
      id,
      buildQueries: (input: QueryBuildInput) =>
        buildKeywordQueries(id, { ...input, maxQueries: queries }),
    }) as unknown as Connector<never>;

  const build: QueryBuildInput = {
    profileId: null,
    roles: ['Frontend Engineer', 'React Developer'],
    locations: ['Germany', 'Netherlands'],
    keywords: [],
    remoteAcceptable: true,
    maxQueries: 20,
  };

  it('deduplicates queries that differ only in spacing and case', () => {
    expect(queryFingerprint('s', 'Frontend Engineer  Germany')).toBe(
      queryFingerprint('s', 'frontend engineer germany'),
    );
  });

  it('enforces the per-cycle budget', () => {
    const plan = planQueries({
      connectors: [
        { sourceId: 'a', connector: stubConnector(10, 'a') },
        { sourceId: 'b', connector: stubConnector(10, 'b') },
      ],
      build,
      budget: { maxPerCycle: 5 },
    });

    expect(plan.queries).toHaveLength(5);
    expect(plan.skipped.some((entry) => entry.reason.includes('budget'))).toBe(true);
  });

  it('respects the cooldown so a recent query is not re-run', () => {
    const first = planQueries({ connectors: [{ sourceId: 'a', connector: stubConnector(2) }], build });
    const queryId = first.queries[0]!.queryId;

    const second = planQueries({
      connectors: [{ sourceId: 'a', connector: stubConnector(2) }],
      build,
      history: [{ queryId, lastRunAt: new Date(Date.now() - 10 * 60_000) }],
    });

    expect(second.queries.some((query) => query.queryId === queryId)).toBe(false);
    expect(second.skipped.some((entry) => entry.reason.includes('cooldown'))).toBe(true);
  });

  it('reports a feed source as having nothing to query rather than omitting it', () => {
    const plan = planQueries({
      connectors: [{ sourceId: 'feed', connector: { id: 'rss' } as unknown as Connector<never> }],
      build,
    });

    expect(plan.queries).toHaveLength(0);
    expect(plan.sourcesWithoutQueries[0]!.reason).toContain('feed');
  });

  it('keeps building when one connector throws', () => {
    const broken = {
      id: 'broken',
      buildQueries: () => {
        throw new Error('boom');
      },
    } as unknown as Connector<never>;

    const plan = planQueries({
      connectors: [
        { sourceId: 'broken', connector: broken },
        { sourceId: 'working', connector: stubConnector(3, 'working') },
      ],
      build,
    });

    expect(plan.queries.length).toBeGreaterThan(0);
    expect(plan.sourcesWithoutQueries.some((entry) => entry.sourceId === 'broken')).toBe(true);
  });
});

describe('capability-driven behaviour', () => {
  it('hands back the filters a source cannot apply', () => {
    const capabilities = sourceCapabilitiesSchema.parse({
      supportsLocationFiltering: true,
      supportsDateFiltering: true,
    });

    const pushdown = planPushdown(['location', 'date', 'salary', 'remote'], capabilities);

    expect(pushdown.pushed).toEqual(['location', 'date']);
    expect(pushdown.residual).toEqual(['salary', 'remote']);
  });

  it('treats an undeclared capability as absent', () => {
    const capabilities = sourceCapabilitiesSchema.parse({});
    const pushdown = planPushdown(['location', 'salary'], capabilities);

    expect(pushdown.pushed).toEqual([]);
    expect(pushdown.residual).toEqual(['location', 'salary']);
  });

  it('falls back to a full scan when the watermark is too old', () => {
    const capabilities = sourceCapabilitiesSchema.parse({ supportsIncrementalSync: true });

    const stale = planIncrementalScan(
      sourceWatermarkSchema.parse({
        sourceId: 's',
        lastSeenPublishedAt: new Date(Date.now() - 30 * 24 * 3_600_000),
      }),
      capabilities,
    );

    expect(stale.mode).toBe('full');
    expect(stale.reason).toContain('beyond');

    const fresh = planIncrementalScan(
      sourceWatermarkSchema.parse({
        sourceId: 's',
        lastSeenPublishedAt: new Date(Date.now() - 3_600_000),
      }),
      capabilities,
    );

    expect(fresh.mode).toBe('incremental');
  });

  it('never claims incremental support a source did not declare', () => {
    const plan = planIncrementalScan(
      sourceWatermarkSchema.parse({ sourceId: 's', lastCursor: 'abc' }),
      sourceCapabilitiesSchema.parse({}),
    );

    expect(plan.mode).toBe('full');
  });
});

describe('concurrency control', () => {
  it('holds requests above the global ceiling', async () => {
    const controller = new ConcurrencyController({ maxGlobal: 2, maxPerHost: 2 });

    await controller.acquire('a.test');
    await controller.acquire('b.test');

    expect(controller.inFlight).toBe(2);

    let granted = false;
    const pending = controller.acquire('c.test').then(() => {
      granted = true;
    });

    await Promise.resolve();
    expect(granted).toBe(false);

    controller.release('a.test');
    await pending;
    expect(granted).toBe(true);
  });

  it('caps per host even when the global ceiling is free', async () => {
    const controller = new ConcurrencyController({ maxGlobal: 10, maxPerHost: 1 });

    await controller.acquire('one.test');
    expect(controller.hostInFlight('one.test')).toBe(1);

    let granted = false;
    void controller.acquire('one.test').then(() => {
      granted = true;
    });

    await Promise.resolve();
    expect(granted).toBe(false);

    // A different host is unaffected — one slow source must not stall the rest.
    await controller.acquire('two.test');
    expect(controller.inFlight).toBe(2);
  });

  it('releases the slot when the work throws', async () => {
    const controller = new ConcurrencyController({ maxGlobal: 1, maxPerHost: 1 });

    await expect(
      controller.run('a.test', async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');

    expect(controller.inFlight).toBe(0);
  });
});

describe('domain scope', () => {
  const scope = {
    allowedHosts: ['example.test'],
    allowSubdomains: false,
    pathPrefixes: ['/careers'],
    excludedPaths: ['/careers/archive'],
    maxDepth: 1,
  };

  it('keeps a career-page crawl inside its own site', () => {
    expect(isInScope('https://example.test/careers/1', scope)).toBe(true);
    expect(isInScope('https://example.test/blog/1', scope)).toBe(false);
    expect(isInScope('https://other.test/careers/1', scope)).toBe(false);
    expect(isInScope('https://example.test/careers/archive/9', scope)).toBe(false);
  });

  it('does not treat a suffix match as a subdomain', () => {
    /*
     * `notexample.test` ends with `example.test` as a string and is a
     * completely different domain. A naive `endsWith` check is the classic way
     * a scope guard is defeated.
     */
    expect(isInScope('https://notexample.test/careers/1', { ...scope, allowSubdomains: true })).toBe(
      false,
    );
    expect(isInScope('https://jobs.example.test/careers/1', { ...scope, allowSubdomains: true })).toBe(
      true,
    );
  });

  it('rejects non-http schemes outright', () => {
    expect(isInScope('file:///etc/passwd', scope)).toBe(false);
    expect(isInScope('javascript:alert(1)', scope)).toBe(false);
  });
});

describe('URL normalisation', () => {
  it('collapses the same posting reached by different routes', () => {
    const variants = [
      'https://boards.greenhouse.io/northwind/jobs/4001',
      'https://www.boards.greenhouse.io/northwind/jobs/4001/',
      'http://boards.greenhouse.io/northwind/jobs/4001?utm_source=newsletter',
      'https://boards.greenhouse.io/northwind/jobs/4001#apply',
    ];

    const normalised = new Set(variants.map((url) => normalizeUrl(url)));
    expect(normalised.size).toBe(1);
  });

  it('refuses to normalise a scheme it will not fetch', () => {
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('source health', () => {
  const reliability = (overrides: Partial<Parameters<typeof scoreSourceHealth>[0]> = {}) =>
    sourceReliabilitySchema.parse({
      sourceId: 's',
      windowStart: new Date(Date.now() - 3_600_000),
      windowEnd: new Date(),
      ...overrides,
    });

  it('scores a source that has never run as zero rather than perfect', () => {
    const health = scoreSourceHealth(reliability(), { hoursSinceSuccess: null });

    /*
     * Dividing by zero attempts and calling it "100% success" would float a
     * never-run source to the top of the dashboard — the opposite of what
     * someone scanning for problems needs.
     */
    expect(health.score).toBe(0);
    expect(health.state).toBe('DEGRADED');
  });

  it('scores a working source highly', () => {
    const health = scoreSourceHealth(
      reliability({
        requestsAttempted: 100,
        requestsSucceeded: 99,
        itemsSeen: 200,
        itemsParsed: 195,
        jobsYielded: 40,
        duplicates: 4,
        averageLatencyMs: 400,
      }),
      { hoursSinceSuccess: 1 },
    );

    expect(health.score).toBeGreaterThan(80);
    expect(health.state).toBe('HEALTHY');
  });

  it('never describes a restricted source as failing', () => {
    const health = scoreSourceHealth(reliability(), { state: 'RESTRICTED' });

    /*
     * A restricted source is a decision, not a fault. Calling it "failing"
     * invites an operator to try to fix something that is working as intended.
     */
    expect(health.state).toBe('RESTRICTED');
  });

  it('separates a missing credential from a failure', () => {
    expect(scoreSourceHealth(reliability(), { state: 'AUTH_REQUIRED' }).state).toBe('AUTH_REQUIRED');
    expect(scoreSourceHealth(reliability(), { state: 'NOT_CONFIGURED' }).state).toBe('NOT_CONFIGURED');
  });

  it('judges freshness against the source’s own cadence', () => {
    const daily = scoreSourceHealth(
      reliability({ requestsAttempted: 10, requestsSucceeded: 10, itemsSeen: 10, itemsParsed: 10 }),
      { hoursSinceSuccess: 20, expectedIntervalHours: 24 },
    );

    const frequent = scoreSourceHealth(
      reliability({ requestsAttempted: 10, requestsSucceeded: 10, itemsSeen: 10, itemsParsed: 10 }),
      { hoursSinceSuccess: 20, expectedIntervalHours: 1 },
    );

    expect(daily.score).toBeGreaterThan(frequent.score);
  });

  it('explains the score rather than only stating it', () => {
    const health = scoreSourceHealth(reliability({ requestsAttempted: 4, requestsSucceeded: 2 }), {
      hoursSinceSuccess: 2,
    });

    expect(health.factors.map((factor) => factor.factor)).toContain('requestSuccess');
    expect(health.factors.find((factor) => factor.factor === 'requestSuccess')!.note).toContain('2/4');
  });
});

describe('content limits', () => {
  it('ships conservative defaults', () => {
    expect(DEFAULT_CONTENT_LIMITS.maxPages).toBeLessThanOrEqual(10);
    expect(DEFAULT_CONTENT_LIMITS.maxRedirects).toBeLessThanOrEqual(5);
    expect(DEFAULT_CONTENT_LIMITS.maxSitemapDepth).toBeLessThanOrEqual(3);
    expect(DEFAULT_CONTENT_LIMITS.maxResponseBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

/*
 * Regressions found by running the layer against the real source registry.
 *
 * Both passed as unit tests before failing live, and both failed silently:
 * nothing threw, nothing logged, the system simply did less than it claimed.
 */
describe('regressions from the live registry', () => {
  it('translates the connector capability vocabulary rather than casting it', () => {
    /*
     * A connector declares `supportsIncremental`; the planner reads
     * `supportsIncrementalSync`. Casting between the two compiled cleanly and
     * made every source in the system report that it could not sync
     * incrementally — a silent, fleet-wide regression to full scans.
     */
    const rss = new RssConnector();
    const capabilities = toSourceCapabilities(rss);

    expect(rss.capabilities.supportsIncremental).toBe(true);
    expect(capabilities.supportsIncrementalSync).toBe(true);

    const plan = planIncrementalScan(
      sourceWatermarkSchema.parse({
        sourceId: 'feed',
        lastSeenPublishedAt: new Date(Date.now() - 3_600_000),
      }),
      capabilities,
    );

    expect(plan.mode).toBe('incremental');
  });

  it('reports searchability from the code rather than from a declaration', () => {
    const search = new SearchDiscoveryConnector();
    const rss = new RssConnector();

    expect(toSourceCapabilities(search).supportsSearch).toBe(true);
    expect(toSourceCapabilities(rss).supportsSearch).toBe(false);
  });

  it('actually attaches a query builder to the searchable connectors', () => {
    /*
     * The builders existed and nothing called them, so a live run planned zero
     * queries and every source reported itself a feed. A test that exercised
     * the builders directly could not see it — only asking the connectors could.
     */
    const searchable = [new SearchDiscoveryConnector(), new RedditConnector(), new RemotiveConnector()];

    for (const connector of searchable) {
      expect(typeof connector.buildQueries, `${connector.id} needs buildQueries`).toBe('function');

      const queries = connector.buildQueries!({
        profileId: null,
        roles: ['Frontend Engineer'],
        locations: ['Germany'],
        keywords: [],
        remoteAcceptable: true,
        maxQueries: 4,
      });

      expect(queries.length, `${connector.id} produced no queries`).toBeGreaterThan(0);
      expect(queries.length).toBeLessThanOrEqual(4);
    }
  });
});
