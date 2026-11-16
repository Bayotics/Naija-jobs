import { describe, expect, it } from 'vitest';
import { checkUrl, canonicaliseIpv4, classifyAddress } from './http/ssrf';
import {
  MemoryCheckpointStore,
  conditionalHeaders,
  evaluateConditional,
  hashContent,
} from './http/checkpoint';
import { extractJobPostings, extractStructuredJobs, extractMicrodataJobPosting } from './extract/schema-org';
import { extractMainContent, shouldClassify } from './extract/content';
import { detectAts, greenhouseProvider, leverProvider, listingToDraft } from './ats/providers';
import { AtsConnector } from './ats/ats-connector';
import { WebConnector } from './web/web-connector';
import { SocialConnector, linkedInPlatform } from './social/social-connector';
import { classifyContent, heuristicClassify, type ClassificationProvider } from './web/classifier';
import { detectSource, careersLinkScore } from './company/careers-detector';
import { RssConnector } from './feed/rss-connector';
import { paginate, type PaginationStrategy } from './pagination';
import {
  collect,
  connectorContractAssertions,
  testContext,
  testHttpClient,
} from './testing';

/**
 * Discovery framework tests.
 *
 * Organised by the property under test rather than by module, because the
 * properties are what the brief actually asks for: that an SSRF attempt is
 * refused however it is spelled, that a 304 avoids work, that a malformed model
 * response cannot produce a job record.
 */

const GREENHOUSE_BOARD = JSON.stringify({
  jobs: [
    {
      id: 4001,
      title: 'Senior Frontend Engineer',
      absolute_url: 'https://boards.greenhouse.io/acme/jobs/4001',
      content: '&lt;p&gt;Build things with &lt;strong&gt;React&lt;/strong&gt;.&lt;/p&gt;',
      updated_at: '2026-08-18T10:00:00Z',
      first_published: '2026-08-17T09:00:00Z',
      location: { name: 'Berlin, Germany' },
      departments: [{ name: 'Engineering' }],
    },
    {
      id: 4002,
      title: 'Sales Development Representative',
      absolute_url: 'https://boards.greenhouse.io/acme/jobs/4002',
      content: '&lt;p&gt;Sell things.&lt;/p&gt;',
      location: { name: 'Remote' },
    },
  ],
});

const LEVER_BOARD = JSON.stringify([
  {
    id: 'abc-123',
    text: 'Backend Engineer',
    hostedUrl: 'https://jobs.lever.co/acme/abc-123',
    applyUrl: 'https://jobs.lever.co/acme/abc-123/apply',
    description: '<p>Go and Postgres.</p>',
    descriptionPlain: 'Go and Postgres.',
    createdAt: 1_786_000_000_000,
    categories: { location: 'Amsterdam', team: 'Platform', commitment: 'Full-time' },
    workplaceType: 'hybrid',
    lists: [{ text: 'Requirements', content: '<ul><li>5 years</li></ul>' }],
  },
]);

const JOB_PAGE_HTML = `<!doctype html>
<html><head><title>Senior Platform Engineer — Northwind</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting",
 "title":"Senior Platform Engineer","description":"<p>Own our Kubernetes platform.</p>",
 "datePosted":"2026-08-15","validThrough":"2026-10-15","employmentType":"FULL_TIME",
 "hiringOrganization":{"@type":"Organization","name":"Northwind","url":"https://northwind.test"},
 "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Berlin","addressCountry":"DE"}},
 "baseSalary":{"@type":"MonetaryAmount","currency":"EUR","value":{"@type":"QuantitativeValue","minValue":85000,"maxValue":110000,"unitText":"YEAR"}},
 "jobLocationType":"TELECOMMUTE","identifier":{"@type":"PropertyValue","value":"NW-991"},
 "url":"https://northwind.test/jobs/991"}
</script></head>
<body>
<nav class="navbar"><a href="/">Home</a><a href="/about">About</a><a href="/blog">Blog</a></nav>
<div class="cookie-banner">We use cookies. Accept?</div>
<main><h1>Senior Platform Engineer</h1>
<p>About the role: Northwind runs a large Kubernetes estate serving customers across Europe.
We are looking for a senior platform engineer to own it end to end, from cluster provisioning
through to the developer experience of the teams that deploy onto it.</p>
<p>Responsibilities: own our Kubernetes platform and the Terraform modules that describe it,
run and improve the on-call rotation, mentor engineers on the platform team, and drive the
migration of our remaining virtual machines onto the cluster over the next two quarters.</p>
<p>Requirements: 5+ years of experience with Kubernetes and Terraform in production, comfort
with Go or Python for tooling, and experience owning an on-call rotation. Familiarity with
observability tooling such as Prometheus and Grafana is expected. Experience with multi-region
failover would be an advantage but is not required.</p>
<p>What you will do in your first ninety days: ship a change to the deployment pipeline, take
part in the on-call rotation, and produce a plan for the virtual machine migration.</p>
<p>Benefits include a learning budget, fully remote working within the European Union, and
twenty-eight days of holiday. Salary is stated openly in the listing above. Apply now.</p></main>
<footer class="site-footer"><a href="/privacy">Privacy</a><a href="/terms">Terms</a></footer>
</body></html>`;

describe('SSRF protection', () => {
  const cases: Array<[string, string]> = [
    ['http://localhost/jobs', 'loopback hostname'],
    ['http://127.0.0.1/jobs', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'metadata'],
    ['http://10.0.0.5/internal', 'private'],
    ['http://192.168.1.1/', 'private'],
    ['http://172.16.4.4/', 'private'],
    ['http://[::1]/', 'loopback'],
    ['http://api.internal/jobs', 'internal hostname'],
    ['http://board.local/jobs', 'internal hostname'],
    ['file:///etc/passwd', 'protocol'],
    ['http://user:pass@example.com/', 'credentials'],
    ['http://example.com:22/', 'public web port'],
  ];

  for (const [url, expected] of cases) {
    it(`refuses ${url}`, async () => {
      const result = await checkUrl(new URL(url), { skipResolution: true });
      expect(result.allowed).toBe(false);
      expect(result.reason?.toLowerCase()).toContain(expected.toLowerCase());
    });
  }

  it('refuses loopback written in decimal, octal and hex', async () => {
    // All three are 127.0.0.1. A dotted-decimal regex matches none of them.
    for (const host of ['2130706433', '0177.0.0.1', '0x7f000001', '127.1']) {
      const result = await checkUrl(new URL(`http://${host}/`), { skipResolution: true });
      expect(result.allowed, `${host} should be refused`).toBe(false);
    }
  });

  it('canonicalises alternate IPv4 encodings to the same address', () => {
    expect(canonicaliseIpv4('2130706433')).toBe('127.0.0.1');
    expect(canonicaliseIpv4('0177.0.0.1')).toBe('127.0.0.1');
    expect(canonicaliseIpv4('127.1')).toBe('127.0.0.1');
    expect(canonicaliseIpv4('example.com')).toBeNull();
  });

  it('refuses a public hostname that resolves to a private address', async () => {
    // The rebinding case: nothing about the *string* is suspicious.
    const result = await checkUrl(new URL('https://innocent.example.com/jobs'), {
      resolve: () => Promise.resolve(['93.184.216.34', '10.0.0.7']),
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('10.0.0.7');
  });

  it('allows a genuinely public address', async () => {
    const result = await checkUrl(new URL('https://boards.greenhouse.io/acme'), {
      resolve: () => Promise.resolve(['93.184.216.34']),
    });
    expect(result.allowed).toBe(true);
  });

  it('honours configured host blocks', async () => {
    const result = await checkUrl(new URL('https://sub.blocked.test/jobs'), {
      skipResolution: true,
      blockedHosts: ['blocked.test'],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked by configuration');
  });

  it('classifies IPv4-mapped IPv6 by its inner address', () => {
    expect(classifyAddress('::ffff:127.0.0.1').private).toBe(true);
    expect(classifyAddress('2606:4700::1111').private).toBe(false);
  });

  it('refuses a redirect that lands on a private address', async () => {
    const { client } = testHttpClient(
      [
        {
          match: 'public.test/start',
          status: 302,
          body: '',
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        },
      ],
      { skipHostResolution: true },
    );

    await expect(client.getText('https://public.test/start')).rejects.toThrow(/169\.254|metadata/i);
  });
});

describe('conditional requests and caching', () => {
  it('sends validators and reports 304 without a body', async () => {
    const { client, mock } = testHttpClient([
      { match: 'feed.test', status: 304, body: '', headers: { etag: 'W/"v1"' } },
    ]);

    const response = await client.getText('https://feed.test/jobs.xml', {
      conditional: { etag: 'W/"v1"', lastModified: 'Mon, 18 Aug 2026 10:00:00 GMT' },
    });

    expect(response.notModified).toBe(true);
    expect(response.status).toBe(304);
    expect(client.stats.notModified).toBe(1);
    expect(mock.calls).toHaveLength(1);
  });

  it('advances the unchanged streak on a 304', () => {
    const first = evaluateConditional({
      previous: null,
      sourceId: 's1',
      resource: 'https://feed.test/jobs.xml',
      status: 200,
      etag: 'W/"v1"',
      lastModified: null,
      body: '<rss>a</rss>',
    });
    expect(first.unchanged).toBe(false);
    expect(first.next.unchangedStreak).toBe(0);

    const second = evaluateConditional({
      previous: first.next,
      sourceId: 's1',
      resource: 'https://feed.test/jobs.xml',
      status: 304,
      etag: 'W/"v1"',
      lastModified: null,
      body: null,
    });
    expect(second.unchanged).toBe(true);
    expect(second.next.unchangedStreak).toBe(1);
  });

  it('detects an unchanged body by hash when no validator is sent', () => {
    const body = '<rss>identical</rss>';
    const first = evaluateConditional({
      previous: null,
      sourceId: 's1',
      resource: 'r',
      status: 200,
      etag: null,
      lastModified: null,
      body,
    });

    const second = evaluateConditional({
      previous: first.next,
      sourceId: 's1',
      resource: 'r',
      status: 200,
      etag: null,
      lastModified: null,
      body,
    });

    expect(second.unchanged).toBe(true);
    expect(second.reason).toContain('byte-identical');
    expect(hashContent(body)).toBe(first.next.contentHash);
  });

  it('resets the streak when the body actually changes', () => {
    const first = evaluateConditional({
      previous: { unchangedStreak: 5 } as never,
      sourceId: 's1',
      resource: 'r',
      status: 200,
      etag: null,
      lastModified: null,
      body: 'new content',
    });
    expect(first.unchanged).toBe(false);
    expect(first.next.unchangedStreak).toBe(0);
  });

  it('round-trips a checkpoint through the store', async () => {
    const store = new MemoryCheckpointStore();
    const outcome = evaluateConditional({
      previous: null,
      sourceId: 's1',
      resource: 'https://feed.test/x',
      status: 200,
      etag: 'W/"abc"',
      lastModified: 'Mon, 18 Aug 2026 10:00:00 GMT',
      body: 'hello',
    });

    await store.save(outcome.next);
    const loaded = await store.get('s1', 'https://feed.test/x');

    expect(loaded?.etag).toBe('W/"abc"');
    expect(conditionalHeaders(loaded)).toMatchObject({ etag: 'W/"abc"' });
  });
});

describe('structured data extraction', () => {
  it('reads every documented JobPosting field', () => {
    const { postings } = extractJobPostings(JOB_PAGE_HTML);
    expect(postings).toHaveLength(1);

    const posting = postings[0]!;
    expect(posting.title).toBe('Senior Platform Engineer');
    expect(posting.hiringOrganization).toBe('Northwind');
    expect(posting.organizationUrl).toBe('https://northwind.test');
    expect(posting.datePosted?.toISOString().slice(0, 10)).toBe('2026-08-15');
    expect(posting.validThrough?.toISOString().slice(0, 10)).toBe('2026-10-15');
    expect(posting.employmentTypes).toEqual(['FULL_TIME']);
    expect(posting.city).toBe('Berlin');
    expect(posting.countryCode).toBe('DE');
    expect(posting.jobLocationType).toBe('TELECOMMUTE');
    expect(posting.salaryMin).toBe(85_000);
    expect(posting.salaryMax).toBe(110_000);
    expect(posting.salaryCurrency).toBe('EUR');
    expect(posting.salaryPeriod).toBe('year');
    expect(posting.identifier).toBe('NW-991');
    expect(posting.extractedFrom).toBe('json_ld');
  });

  it('reports fields the markup did not state as null, never guessed', () => {
    const html = `<script type="application/ld+json">
      {"@type":"JobPosting","title":"Engineer"}</script>`;
    const posting = extractJobPostings(html).postings[0]!;

    expect(posting.title).toBe('Engineer');
    expect(posting.hiringOrganization).toBeNull();
    expect(posting.salaryMin).toBeNull();
    expect(posting.countryCode).toBeNull();
    expect(posting.datePosted).toBeNull();
    expect(posting.fieldsPresent).toEqual(['title']);
  });

  it('survives malformed JSON-LD and reports it', () => {
    const html = `
      <script type="application/ld+json">{ "@type": "JobPosting", "title": "A", }</script>
      <script type="application/ld+json">{ definitely not json </script>`;

    const result = extractJobPostings(html);
    // The trailing-comma block is recovered; the broken one is counted.
    expect(result.postings).toHaveLength(1);
    expect(result.malformedBlocks).toBe(1);
  });

  it('unwraps @graph and reports non-job types separately', () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"BreadcrumbList"},
        {"@type":"JobPosting","title":"Data Engineer"},
        {"@type":"Organization","name":"Acme"}]}</script>`;

    const result = extractJobPostings(html);
    expect(result.postings).toHaveLength(1);
    expect(result.otherTypes).toEqual(expect.arrayContaining(['BreadcrumbList', 'Organization']));
  });

  it('falls back to microdata when no JSON-LD exists', () => {
    const html = `<div itemscope itemtype="https://schema.org/JobPosting">
      <h1 itemprop="title">QA Engineer</h1>
      <span itemprop="hiringOrganization">Helios</span>
      <meta itemprop="datePosted" content="2026-08-01">
      <span itemprop="addressLocality">Lisbon</span>
      <span itemprop="addressCountry">PT</span></div>`;

    const posting = extractMicrodataJobPosting(html)!;
    expect(posting.title).toBe('QA Engineer');
    expect(posting.countryCode).toBe('PT');
    expect(posting.extractedFrom).toBe('microdata');

    expect(extractStructuredJobs(html).postings).toHaveLength(1);
  });

  it('returns nothing for a page with no job markup', () => {
    expect(extractStructuredJobs('<html><body><p>hello</p></body></html>').postings).toEqual([]);
  });
});

describe('content extraction', () => {
  it('strips navigation, cookie banners and footers', () => {
    const content = extractMainContent(JOB_PAGE_HTML);

    expect(content.text).toContain('Kubernetes');
    expect(content.text).not.toContain('We use cookies');
    expect(content.text).not.toContain('Privacy');
    expect(content.strategy).toBe('semantic');
    expect(content.removedChars).toBeGreaterThan(0);
  });

  it('declines to classify a link-dense listing index', () => {
    const links = Array.from(
      { length: 60 },
      (_, i) => `<a href="/jobs/${i}">Job ${i}</a>`,
    ).join('');
    const html = `<html><body><main>${links} some words here</main></body></html>`;

    const gate = shouldClassify(extractMainContent(html), 'https://example.test/jobs');
    expect(gate.worthClassifying).toBe(false);
    expect(gate.reason).toContain('listing index');
  });

  it('declines to classify a page with no job vocabulary', () => {
    const html = `<html><body><main>${'lorem ipsum dolor sit amet '.repeat(40)}</main></body></html>`;
    const gate = shouldClassify(extractMainContent(html), 'https://example.test/about');
    expect(gate.worthClassifying).toBe(false);
  });

  it('accepts a page that reads like a posting', () => {
    const gate = shouldClassify(extractMainContent(JOB_PAGE_HTML), 'https://northwind.test/jobs/991');
    expect(gate.worthClassifying).toBe(true);
  });
});

describe('ATS framework', () => {
  it('identifies providers from URLs and page markup', () => {
    expect(detectAts({ url: 'https://boards.greenhouse.io/acme' })?.provider.id).toBe('greenhouse');
    expect(detectAts({ url: 'https://jobs.lever.co/acme' })?.provider.id).toBe('lever');
    expect(detectAts({ url: 'https://jobs.ashbyhq.com/acme' })?.provider.id).toBe('ashby');
    expect(detectAts({ url: 'https://acme.recruitee.com/' })?.provider.id).toBe('recruitee');

    const embedded = detectAts({
      url: 'https://acme.test/careers',
      html: '<iframe src="https://boards.greenhouse.io/embed/job_board?for=acmeinc"></iframe>',
    });
    expect(embedded?.provider.id).toBe('greenhouse');
    expect(embedded?.identifier).toBe('acmeinc');
  });

  it('decodes Greenhouse entity-escaped descriptions', async () => {
    const { client } = testHttpClient([{ match: 'greenhouse', body: GREENHOUSE_BOARD }]);
    const listings = await greenhouseProvider.fetchListings({
      identifier: 'acme',
      http: client,
      signal: new AbortController().signal,
    });

    expect(listings).toHaveLength(2);
    expect(listings[0]?.descriptionHtml).toContain('<strong>React</strong>');
    expect(listings[0]?.locationText).toBe('Berlin, Germany');
    expect(listings[0]?.postedAt).toBeInstanceOf(Date);
  });

  it('folds Lever requirement lists back into the description', async () => {
    const { client } = testHttpClient([{ match: 'lever', body: LEVER_BOARD }]);
    const listings = await leverProvider.fetchListings({
      identifier: 'acme',
      http: client,
      signal: new AbortController().signal,
    });

    // Without this the description stops at the intro paragraph.
    expect(listings[0]?.descriptionHtml).toContain('Requirements');
    expect(listings[0]?.descriptionHtml).toContain('5 years');
    expect(listings[0]?.employmentType).toBe('Full-time');
  });

  it('reports a summary-only listing as having no description, not an empty one', () => {
    const draft = listingToDraft(
      {
        externalId: '1',
        title: 'Engineer',
        url: 'https://jobs.smartrecruiters.com/acme/1',
        descriptionHtml: null,
        descriptionText: null,
        locationText: 'Paris',
        department: null,
        team: null,
        employmentType: null,
        remote: null,
        postedAt: null,
        updatedAt: null,
        applyUrl: null,
        raw: {},
      },
      { providerId: 'smartrecruiters', identifier: 'acme' },
    );

    expect(draft?.description).toBeNull();
    expect(draft?.sourceMetadata.descriptionInListing).toBe(false);
  });

  it('filters by title pattern and keeps every company independent', async () => {
    const { client } = testHttpClient([
      { match: 'boards/acme/jobs', body: GREENHOUSE_BOARD },
      { match: 'boards/gone/jobs', status: 404, body: 'not found' },
    ]);

    const connector = new AtsConnector();
    const { items } = await collect(
      connector.discover(
        testContext({
          config: connector.configSchema.parse({
            provider: 'greenhouse',
            companies: ['acme', 'gone'],
            excludeTitlePattern: 'sales|recruiter',
          }),
          http: client,
        }),
      ),
    );

    // One company 404s; the other still yields, minus the excluded title.
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Senior Frontend Engineer');
  });

  it('fails the run when every board is unreachable', async () => {
    const { client } = testHttpClient([{ match: 'greenhouse', status: 500, body: 'boom' }]);
    const connector = new AtsConnector();

    await expect(
      collect(
        connector.discover(
          testContext({
            config: connector.configSchema.parse({ provider: 'greenhouse', companies: ['a', 'b'] }),
            http: client,
          }),
        ),
      ),
    ).rejects.toThrow(/board\(s\) failed/i);
  });
});

describe('pagination', () => {
  const drive = async (strategy: PaginationStrategy, pages: number[][], maxPages = 10) => {
    const seen: Array<Record<string, string>> = [];
    const generator = paginate<number>(strategy, { maxPages }, (request) => {
      seen.push(request.params);
      const index = seen.length - 1;
      return Promise.resolve({
        items: pages[index] ?? [],
        body: { meta: { next_cursor: index < pages.length - 1 ? `c${index + 1}` : null } },
      });
    });
    const { items, result } = await collect(generator);
    return { items, result, seen };
  };

  it('walks page-number pagination and stops on an empty page', async () => {
    const { items, seen } = await drive({ type: 'page', param: 'page', startPage: 1, pageSizeParam: null, pageSize: 50 }, [
      [1, 2],
      [3],
      [],
    ]);
    expect(items).toEqual([1, 2, 3]);
    expect(seen.map((params) => params.page)).toEqual(['1', '2', '3']);
  });

  it('walks offset pagination', async () => {
    const { seen } = await drive({ type: 'offset', param: 'offset', limitParam: 'limit', pageSize: 2 }, [
      [1, 2],
      [3, 4],
      [],
    ]);
    expect(seen.map((params) => params.offset)).toEqual(['0', '2', '4']);
  });

  it('follows a cursor and stops when the source stops supplying one', async () => {
    const { items, seen } = await drive({ type: 'cursor', param: 'cursor', cursorPath: 'meta.next_cursor' }, [
      [1],
      [2],
    ]);
    expect(items).toEqual([1, 2]);
    expect(seen[1]?.cursor).toBe('c1');
  });

  it('never exceeds maxPages, and says it truncated', async () => {
    const { items, result } = await drive(
      { type: 'page', param: 'page', startPage: 1, pageSizeParam: null, pageSize: 10 },
      [[1], [2], [3], [4], [5]],
      2,
    );
    expect(items).toEqual([1, 2]);
    expect(result?.truncated).toBe(true);
  });
});

describe('AI classification', () => {
  const jobText =
    'We are hiring a Senior Go Engineer. Responsibilities: build services. ' +
    'Requirements: 5 years. To apply, email us.';

  it('settles clear cases deterministically without a model call', async () => {
    let called = 0;
    const provider: ClassificationProvider = {
      id: 'test',
      model: 'test-model',
      classify: () => {
        called += 1;
        return Promise.resolve({ isJob: false, contentType: 'spam', confidence: 1, reason: 'x' });
      },
    };

    const result = await classifyContent({ text: jobText, url: null }, { provider });
    expect(result.method).toBe('heuristic');
    expect(result.classification.isJob).toBe(true);
    expect(called).toBe(0);
  });

  it('detects spam deterministically', () => {
    const verdict = heuristicClassify({
      text: 'Earn $5000/week! Work from home guaranteed. Contact us on telegram. Registration fee applies.',
      url: null,
    });
    expect(verdict.classification.contentType).toBe('spam');
    expect(verdict.decisive).toBe(true);
  });

  it('distinguishes career advice from a posting', () => {
    const verdict = heuristicClassify({
      text: 'How to get a job in tech: my journey, interview tips and resume tips. Ask me anything.',
      url: null,
    });
    expect(verdict.classification.isJob).toBe(false);
    expect(verdict.classification.contentType).toBe('career_advice');
  });

  it('falls back rather than repairing a malformed model response', async () => {
    const provider: ClassificationProvider = {
      id: 'test',
      model: 'test-model',
      // `confidence` out of range and `contentType` not in the enum.
      classify: () => Promise.resolve({ isJob: true, contentType: 'maybe', confidence: 7 }),
    };

    const result = await classifyContent(
      { text: 'Ambiguous text mentioning hiring once.', url: null },
      { provider },
    );

    expect(result.method).toBe('ai_failed_fallback');
    expect(result.error).toContain('failed validation');
    // The fabricated fields never reach the classification.
    expect(result.classification.contentType).not.toBe('maybe');
    expect(result.classification.confidence).toBeLessThanOrEqual(1);
  });

  it('falls back when the model throws', async () => {
    const provider: ClassificationProvider = {
      id: 'test',
      model: 'test-model',
      classify: () => Promise.reject(new Error('rate limited')),
    };

    const result = await classifyContent(
      { text: 'Ambiguous text mentioning hiring once.', url: null },
      { provider },
    );
    expect(result.method).toBe('ai_failed_fallback');
    expect(result.error).toContain('rate limited');
  });

  it('respects the budget guard', async () => {
    let called = 0;
    const provider: ClassificationProvider = {
      id: 'test',
      model: 'm',
      classify: () => {
        called += 1;
        return Promise.resolve({ isJob: true, contentType: 'job_posting', confidence: 0.9, reason: 'x' });
      },
    };

    const result = await classifyContent(
      { text: 'Ambiguous text mentioning hiring once.', url: null },
      { provider, canSpend: () => false },
    );

    expect(called).toBe(0);
    expect(result.method).toBe('heuristic');
  });
});

describe('source auto-detection', () => {
  it('recommends the ATS adapter over a generic crawler', async () => {
    const { client } = testHttpClient([
      { match: 'robots.txt', body: 'User-agent: *\nAllow: /', headers: { 'content-type': 'text/plain' } },
      {
        match: 'acme.test/careers',
        body: '<html><body><iframe src="https://boards.greenhouse.io/embed/job_board?for=acmeinc"></iframe></body></html>',
        headers: { 'content-type': 'text/html' },
      },
    ]);

    const result = await detectSource('https://acme.test/careers', {
      http: client,
      signal: new AbortController().signal,
    });

    expect(result.reachable).toBe(true);
    expect(result.recommendedConnectorId).toBe('ats');
    expect(result.recommendedConfig).toMatchObject({ provider: 'greenhouse', companies: ['acmeinc'] });
    expect(result.recommendation).toContain('documented JSON endpoint');
  });

  it('recommends the feed connector when a feed is advertised', async () => {
    const { client } = testHttpClient([
      { match: 'robots.txt', body: '', headers: { 'content-type': 'text/plain' } },
      {
        match: 'boardy.test/jobs',
        body: '<html><head><link rel="alternate" type="application/rss+xml" href="/jobs.rss"></head><body>jobs</body></html>',
        headers: { 'content-type': 'text/html' },
      },
    ]);

    const result = await detectSource('https://boardy.test/jobs', {
      http: client,
      signal: new AbortController().signal,
    });

    expect(result.recommendedConnectorId).toBe('rss');
    expect(result.recommendedConfig.feedUrl).toBe('https://boardy.test/jobs.rss');
  });

  it('recommends the web connector when only structured markup exists', async () => {
    const { client } = testHttpClient([
      { match: 'robots.txt', body: '', headers: { 'content-type': 'text/plain' } },
      { match: 'northwind.test', body: JOB_PAGE_HTML, headers: { 'content-type': 'text/html' } },
    ]);

    const result = await detectSource('https://northwind.test/jobs/991', {
      http: client,
      signal: new AbortController().signal,
    });

    expect(result.recommendedConnectorId).toBe('web');
    expect(result.signals.some((signal) => signal.kind === 'structured_data')).toBe(true);
  });

  it('rejects an unreachable URL with a reason rather than a recommendation', async () => {
    const { client } = testHttpClient([
      { match: 'robots.txt', body: '', headers: { 'content-type': 'text/plain' } },
      { match: 'dead.test', status: 500, body: 'boom' },
    ]);

    const result = await detectSource('https://dead.test/careers', {
      http: client,
      signal: new AbortController().signal,
    });

    expect(result.reachable).toBe(false);
    expect(result.recommendedConnectorId).toBeNull();
    expect(result.rejectionReason).toBeTruthy();
  });

  it('rejects a URL that is not a URL', async () => {
    const { client } = testHttpClient([]);
    const result = await detectSource('not a url', {
      http: client,
      signal: new AbortController().signal,
    });
    expect(result.rejectionReason).toContain('valid absolute URL');
  });

  it('scores careers links above navigation links', () => {
    expect(careersLinkScore('https://acme.test/careers')).toBeGreaterThan(
      careersLinkScore('https://acme.test/blog'),
    );
    expect(careersLinkScore('https://boards.greenhouse.io/acme')).toBeGreaterThan(4);
  });
});

describe('generic web discovery', () => {
  it('extracts structured postings and stays inside the allowed domain', async () => {
    const index = `<html><body><main>
      <a href="/jobs/991">Senior Platform Engineer</a>
      <a href="https://elsewhere.test/jobs/1">Off-domain job</a>
      <a href="/privacy">Privacy policy</a>
    </main></body></html>`;

    const { client, mock } = testHttpClient([
      { match: 'northwind.test/jobs/991', body: JOB_PAGE_HTML, headers: { 'content-type': 'text/html' } },
      { match: 'northwind.test/careers', body: index, headers: { 'content-type': 'text/html' } },
      { match: 'elsewhere.test', body: JOB_PAGE_HTML, headers: { 'content-type': 'text/html' } },
    ]);

    const connector = new WebConnector();
    const { items } = await collect(
      connector.discover(
        testContext({
          config: connector.configSchema.parse({
            seedUrls: ['https://northwind.test/careers'],
            allowedDomains: ['northwind.test'],
            maxPages: 10,
            maxDepth: 1,
          }),
          http: client,
        }),
      ),
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Senior Platform Engineer');
    expect(items[0]?.salaryMin).toBe(85_000);
    expect(items[0]?.sourceMetadata.discoveryMethod).toBe('structured_data');

    // The off-domain link was never fetched.
    expect(mock.callsFor('elsewhere.test')).toHaveLength(0);
  });

  it('respects the page budget', async () => {
    const page = (n: number) =>
      `<html><body><main><a href="/jobs/${n + 1}">Next job</a><p>${'word '.repeat(100)}</p></main></body></html>`;

    const { client, mock } = testHttpClient([
      { match: /crawl\.test\/jobs\/\d+/, body: page(1), headers: { 'content-type': 'text/html' } },
    ]);

    const connector = new WebConnector();
    await collect(
      connector.discover(
        testContext({
          config: connector.configSchema.parse({
            seedUrls: ['https://crawl.test/jobs/1'],
            allowedDomains: ['crawl.test'],
            maxPages: 3,
            maxDepth: 4,
            useClassifier: false,
          }),
          http: client,
        }),
      ),
    );

    expect(mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('requires an allowed domain', async () => {
    const { client } = testHttpClient([]);
    const connector = new WebConnector();

    await expect(
      collect(
        connector.discover(
          testContext({
            // A seed with no parseable host and no explicit allowlist.
            config: { ...connector.configSchema.parse({ seedUrls: ['https://a.test/x'] }), allowedDomains: [], seedUrls: ['not-a-url'] } as never,
            http: client,
          }),
        ),
      ),
    ).rejects.toThrow(/allowed domain/i);
  });
});

describe('social discovery', () => {
  it('marks LinkedIn unavailable with a stated reason instead of pretending', () => {
    const connector = new SocialConnector();
    const availability = connector.availability({
      config: connector.configSchema.parse({ platform: 'linkedin', queries: ['react'] }),
      getSecret: () => 'a-token-that-changes-nothing',
    });

    // Unavailable even *with* a credential, because no implementation exists.
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('partner');
    expect(linkedInPlatform.accessNote).toContain('prohibited');
  });

  it('marks X unavailable without a bearer token, and names it', () => {
    const connector = new SocialConnector();
    const availability = connector.availability({
      config: connector.configSchema.parse({ platform: 'x', queries: ['hiring react'] }),
      getSecret: () => undefined,
    });

    expect(availability.available).toBe(false);
    expect(availability.requires).toContain('X_BEARER_TOKEN');
  });

  it('refuses to discover when unavailable rather than returning empty', async () => {
    const { client } = testHttpClient([]);
    const connector = new SocialConnector();

    await expect(
      collect(
        connector.discover(
          testContext({
            config: connector.configSchema.parse({ platform: 'x', queries: ['hiring'] }),
            http: client,
          }),
        ),
      ),
    ).rejects.toThrow(/X_BEARER_TOKEN|API plan/i);
  });
});

describe('connector contract', () => {
  const rss = new RssConnector();
  const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Board</title>
    <item><title>Acme: Senior Engineer</title><link>https://board.test/jobs/1</link>
      <description>Great role</description><pubDate>Mon, 18 Aug 2026 10:00:00 GMT</pubDate></item>
    <item><title>Helios: Data Engineer</title><link>https://board.test/jobs/2</link>
      <description>Another role</description><pubDate>Mon, 18 Aug 2026 09:00:00 GMT</pubDate></item>
  </channel></rss>`;

  const assertions = connectorContractAssertions({
    connector: rss,
    config: { feedUrl: 'https://board.test/feed.xml' },
    routes: [{ match: 'board.test', body: FEED, headers: { 'content-type': 'application/xml' } }],
    minDrafts: 2,
    // An empty feed is a genuine failure for this connector, which is correct
    // behaviour and is asserted separately.
    skip: { emptyResponse: true },
    failingRoutes: [{ match: 'board.test', status: 500, body: 'boom' }],
  });

  for (const assertion of assertions) {
    it(`RSS connector ${assertion.name}`, () => assertion.run());
  }

  const ats = new AtsConnector();
  const atsAssertions = connectorContractAssertions({
    connector: ats,
    config: { provider: 'greenhouse', companies: ['acme'] },
    routes: [{ match: 'greenhouse', body: GREENHOUSE_BOARD }],
    minDrafts: 2,
    failingRoutes: [{ match: 'greenhouse', status: 500, body: 'boom' }],
  });

  for (const assertion of atsAssertions) {
    it(`ATS connector ${assertion.name}`, () => assertion.run());
  }
});
