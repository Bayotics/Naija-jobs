import { describe, expect, it } from 'vitest';
import {
  ClientError,
  ConfigurationError,
  ConnectorRegistry,
  DomainRateLimiter,
  NotPermittedError,
  RateLimitError,
  RssConnector,
  ArbeitnowConnector,
  JobicyConnector,
  RemotiveConnector,
  RedditConnector,
  SearchDiscoveryConnector,
  RestrictedSourceConnector,
  ServerError,
  classifyError,
  computeDelay,
  createDefaultRegistry,
  errorFromStatus,
  isAllowed,
  paginate,
  parseFeed,
  parseRetryAfter,
  parseRobotsTxt,
  withRetry,
  type PageResult,
} from './index';
import { collect, testContext, testHttpClient } from './testing/index';

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Test Board</title><link>https://board.test</link>
  <item>
    <title>Acme Corp: Senior Backend Engineer</title>
    <link>https://board.test/jobs/1?utm_source=rss&amp;ref=feed</link>
    <guid>job-1</guid>
    <description><![CDATA[<p>Build <strong>services</strong>. Remote friendly.</p>]]></description>
    <pubDate>Mon, 10 Aug 2026 09:00:00 +0000</pubDate>
    <category>backend</category>
  </item>
  <item>
    <title>Data Analyst at Globex Limited</title>
    <link>https://board.test/jobs/2</link>
    <guid>job-2</guid>
    <description>Analyse data.</description>
    <pubDate>Tue, 11 Aug 2026 09:00:00 +0000</pubDate>
  </item>
</channel></rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Board</title>
  <link href="https://atom.test" rel="alternate"/>
  <entry>
    <title>Platform Engineer</title>
    <link href="https://atom.test/jobs/9" rel="alternate"/>
    <id>urn:job:9</id>
    <published>2026-08-12T10:00:00Z</published>
    <content>Operate platforms.</content>
    <category term="platform"/>
  </entry>
</feed>`;

describe('ConnectorRegistry', () => {
  it('resolves a connector by id without the caller knowing its internals', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('reddit').id).toBe('reddit');
    expect(registry.ids()).toEqual(
      expect.arrayContaining(['rss', 'remotive', 'arbeitnow', 'jobicy', 'reddit', 'search_discovery', 'restricted']),
    );
  });

  it('throws a helpful error for an unknown connector', () => {
    expect(() => createDefaultRegistry().get('nope')).toThrow(ConfigurationError);
    expect(createDefaultRegistry().find('nope')).toBeNull();
  });

  it('refuses duplicate registrations', () => {
    const registry = new ConnectorRegistry().register(new RssConnector());
    expect(() => registry.register(new RssConnector())).toThrow(/already registered/);
  });

  it('validates source config against the connector schema', () => {
    const registry = createDefaultRegistry();
    expect(registry.validateConfig('rss', { feedUrl: 'https://x.test/f.rss' }).ok).toBe(true);

    const bad = registry.validateConfig('rss', { feedUrl: 'not-a-url' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toContain('feedUrl');
  });

  it('describes itself for the settings UI', () => {
    const described = createDefaultRegistry().describe();
    expect(described.find((d) => d.id === 'arbeitnow')?.capabilities.providesVisaFlag).toBe(true);
    expect(described.find((d) => d.id === 'restricted')?.accessTier).toBe('restricted');
  });
});

describe('failure classification', () => {
  it('separates transient from permanent failures', () => {
    expect(errorFromStatus(503, 'https://x.test')).toBeInstanceOf(ServerError);
    expect(errorFromStatus(503, 'https://x.test').retryable).toBe(true);

    expect(errorFromStatus(404, 'https://x.test')).toBeInstanceOf(ClientError);
    expect(errorFromStatus(404, 'https://x.test').retryable).toBe(false);

    expect(errorFromStatus(429, 'https://x.test', 30)).toBeInstanceOf(RateLimitError);
    expect(errorFromStatus(429, 'https://x.test', 30).retryAfterSeconds).toBe(30);

    // 403 is "you may not", which retrying cannot fix.
    expect(errorFromStatus(403, 'https://x.test')).toBeInstanceOf(NotPermittedError);
    expect(errorFromStatus(403, 'https://x.test').retryable).toBe(false);
  });

  it('classifies socket errors as retryable network failures', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(classifyError(err).retryable).toBe(true);
    expect(classifyError(err).kind).toBe('network');
  });

  it('defaults unknown failures to NON-retryable', () => {
    // Retrying something we do not understand is how a bug becomes a DoS.
    expect(classifyError(new Error('mystery')).retryable).toBe(false);
  });

  it('parses Retry-After as seconds or a date', () => {
    expect(parseRetryAfter('42')).toBe(42);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('garbage')).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThanOrEqual(9);
  });
});

describe('retry behaviour', () => {
  it('retries transient failures and eventually succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new ServerError(503, 'temporary');
        return 'ok';
      },
      { settings: { baseDelayMs: 1, jitter: false, maxAttempts: 5 } },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does NOT retry a permanent failure', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new ConfigurationError('bad config');
        },
        { settings: { baseDelayMs: 1, jitter: false, maxAttempts: 5 } },
      ),
    ).rejects.toThrow(ConfigurationError);
    // A malformed configuration must not be retried 20 times.
    expect(attempts).toBe(1);
  });

  it('gives up after maxAttempts', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new ServerError(500, 'always down');
        },
        { settings: { baseDelayMs: 1, jitter: false, maxAttempts: 3 } },
      ),
    ).rejects.toThrow(ServerError);
    expect(attempts).toBe(3);
  });

  it('backs off exponentially and honours Retry-After', () => {
    const settings = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000, factor: 2, jitter: false };
    expect(computeDelay(1, settings)).toBe(100);
    expect(computeDelay(2, settings)).toBe(200);
    expect(computeDelay(3, settings)).toBe(400);
    expect(computeDelay(9, settings)).toBe(10_000); // capped
    // The source's own instruction wins over our guess.
    expect(computeDelay(1, settings, 7)).toBe(7_000);
  });

  it('applies full jitter within the computed bound', () => {
    const settings = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 10_000, factor: 2, jitter: true };
    expect(computeDelay(3, settings, undefined, () => 0)).toBe(0);
    expect(computeDelay(3, settings, undefined, () => 1)).toBe(4_000);
  });
});

describe('rate limiting', () => {
  it('serialises beyond the concurrency limit', async () => {
    const limiter = new DomainRateLimiter({ requestsPerMinute: 600, maxConcurrent: 1, minDelayMs: 0 });
    const order: string[] = [];

    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        limiter.schedule('example.test', async () => {
          order.push(`start-${id}`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`end-${id}`);
        }),
      ),
    );

    // With concurrency 1 every start must be followed by its own end.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]?.replace('start-', '')).toBe(order[i + 1]?.replace('end-', ''));
    }
  });

  it('enforces a minimum delay between requests', async () => {
    const limiter = new DomainRateLimiter({ requestsPerMinute: 600, maxConcurrent: 4, minDelayMs: 40 });
    const started = Date.now();
    await limiter.schedule('slow.test', async () => undefined);
    await limiter.schedule('slow.test', async () => undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it('releases its slot even when the task throws', async () => {
    const limiter = new DomainRateLimiter({ requestsPerMinute: 600, maxConcurrent: 1, minDelayMs: 0 });
    await expect(
      limiter.schedule('err.test', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // A leaked permit would deadlock this second call.
    await expect(limiter.schedule('err.test', async () => 'ok')).resolves.toBe('ok');
  });

  it('tracks per-domain state independently', () => {
    const limiter = new DomainRateLimiter({ requestsPerMinute: 10, maxConcurrent: 1, minDelayMs: 0 });
    limiter.applyCrawlDelay('a.test', 2);
    expect(limiter.stats('b.test').blockedForMs).toBe(0);
  });
});

describe('robots.txt', () => {
  const robots = `
User-agent: *
Content-Signal: search=yes,ai-train=no
Allow: /
Crawl-delay: 2

User-agent: BadBot
Disallow: /

User-agent: PartialBot
Disallow: /private
Allow: /private/public
`;

  it('parses groups, crawl-delay and content signals', () => {
    const rules = parseRobotsTxt(robots);
    expect(rules.contentSignals['ai-train']).toBe('no');
    expect(isAllowed(rules, 'JobIntelBot', '/jobs').crawlDelaySeconds).toBe(2);
  });

  it('allows a general agent and blocks a specifically disallowed one', () => {
    const rules = parseRobotsTxt(robots);
    expect(isAllowed(rules, 'JobIntelBot', '/jobs').allowed).toBe(true);
    expect(isAllowed(rules, 'BadBot', '/jobs').allowed).toBe(false);
  });

  it('resolves longest-match, with Allow winning ties', () => {
    const rules = parseRobotsTxt(robots);
    expect(isAllowed(rules, 'PartialBot', '/private/secret').allowed).toBe(false);
    expect(isAllowed(rules, 'PartialBot', '/private/public/x').allowed).toBe(true);
  });

  it('treats an empty Disallow as permission, not prohibition', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow:');
    expect(isAllowed(rules, 'AnyBot', '/anything').allowed).toBe(true);
  });
});

describe('pagination', () => {
  const pageOf = (n: number, size: number): PageResult<number> => ({
    items: Array.from({ length: size }, (_, i) => n * 100 + i),
  });

  it('walks page-number pagination and stops on an empty page', async () => {
    const requests: number[] = [];
    const { items, result } = await collect(
      paginate<number>({ type: 'page', param: 'page', startPage: 1, pageSizeParam: null, pageSize: 2 }, { maxPages: 10 }, async (req) => {
        requests.push(Number(req.params.page));
        return requests.length <= 2 ? pageOf(requests.length, 2) : { items: [] };
      }),
    );
    expect(requests).toEqual([1, 2, 3]);
    expect(items).toHaveLength(4);
    expect(result?.truncated).toBe(false);
  });

  it('walks offset pagination with correct offsets', async () => {
    const offsets: number[] = [];
    await collect(
      paginate<number>({ type: 'offset', param: 'offset', limitParam: 'limit', pageSize: 25 }, { maxPages: 3 }, async (req) => {
        offsets.push(Number(req.params.offset));
        return offsets.length < 3 ? pageOf(1, 25) : { items: [] };
      }),
    );
    expect(offsets).toEqual([0, 25, 50]);
  });

  it('follows cursors and stops when none is returned', async () => {
    let call = 0;
    const cursors: Array<string | undefined> = [];
    await collect(
      paginate<number>({ type: 'cursor', param: 'cursor', cursorPath: 'meta.next' }, { maxPages: 5 }, async (req) => {
        cursors.push(req.params.cursor);
        call += 1;
        return { items: [call], body: call < 3 ? { meta: { next: `c${call}` } } : {} };
      }),
    );
    expect(cursors).toEqual([undefined, 'c1', 'c2']);
  });

  it('follows next_url links', async () => {
    const urls: Array<string | null> = [];
    await collect(
      paginate<number>({ type: 'next_url', urlPath: 'links.next' }, { maxPages: 4 }, async (req) => {
        urls.push(req.absoluteUrl);
        const page = urls.length;
        return {
          items: [page],
          body: page < 2 ? { links: { next: `https://x.test/p${page + 1}` } } : {},
        };
      }),
    );
    expect(urls).toEqual([null, 'https://x.test/p2']);
  });

  it('respects maxItems and reports truncation', async () => {
    const { items, result } = await collect(
      paginate<number>({ type: 'page', param: 'page', startPage: 1, pageSizeParam: null, pageSize: 10 }, { maxPages: 10, maxItems: 15 }, async () => pageOf(1, 10)),
    );
    expect(items).toHaveLength(15);
    expect(result?.truncated).toBe(true);
  });

  it('bounds an endless source with maxPages', async () => {
    const { result } = await collect(
      paginate<number>({ type: 'page', param: 'page', startPage: 1, pageSizeParam: null, pageSize: 1 }, { maxPages: 3 }, async () => pageOf(1, 1)),
    );
    expect(result?.pagesFetched).toBe(3);
    expect(result?.truncated).toBe(true);
  });
});

describe('feed parsing', () => {
  it('parses RSS items including CDATA descriptions', () => {
    const parser = new (class {
      parse = (x: string) => x;
    })();
    void parser;
    const feed = parseFeed(
      // Parsed shape as fast-xml-parser would produce it.
      {
        rss: {
          channel: {
            title: 'Test Board',
            item: [
              {
                title: 'A Job',
                link: 'https://x.test/1',
                guid: 'g1',
                description: { __cdata: '<p>Hello</p>' },
                pubDate: 'Mon, 10 Aug 2026 09:00:00 +0000',
                category: ['a', 'b'],
              },
            ],
          },
        },
      },
    );
    expect(feed.kind).toBe('rss');
    expect(feed.items[0]?.title).toBe('A Job');
    expect(feed.items[0]?.description).toBe('<p>Hello</p>');
    expect(feed.items[0]?.descriptionIsHtml).toBe(true);
    expect(feed.items[0]?.categories).toEqual(['a', 'b']);
  });

  it('parses Atom entries and attributed links', () => {
    const feed = parseFeed({
      feed: {
        title: 'Atom',
        entry: {
          title: 'Solo Entry',
          link: { '@_href': 'https://x.test/9', '@_rel': 'alternate' },
          id: 'urn:9',
          published: '2026-08-12T10:00:00Z',
          content: 'Body',
        },
      },
    });
    expect(feed.kind).toBe('atom');
    // A single entry must not be dropped by array collapsing.
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]?.link).toBe('https://x.test/9');
  });

  it('returns an empty feed rather than throwing on junk', () => {
    expect(parseFeed(null).items).toEqual([]);
    expect(parseFeed({ nonsense: true }).kind).toBe('unknown');
  });
});

describe('RssConnector', () => {
  const config = (over: Record<string, unknown> = {}) =>
    new RssConnector().configSchema.parse({ feedUrl: 'https://board.test/feed.rss', ...over });

  it('extracts company and title from configured patterns', async () => {
    const connector = new RssConnector();
    const { client } = testHttpClient([{ match: 'feed.rss', body: RSS_FIXTURE, headers: { 'content-type': 'application/xml' } }]);
    const { items } = await collect(
      connector.discover(testContext({ config: config(), http: client })),
    );

    expect(items).toHaveLength(2);
    expect(items[0]?.companyName).toBe('Acme Corp');
    expect(items[0]?.title).toBe('Senior Backend Engineer');
    // Second item matches the "<title> at <company>" pattern.
    expect(items[1]?.companyName).toBe('Globex Limited');
    expect(items[1]?.title).toBe('Data Analyst');
  });

  it('applies a default location for country-scoped boards', async () => {
    const connector = new RssConnector();
    const { client } = testHttpClient([{ match: 'feed.rss', body: RSS_FIXTURE }]);
    const { items } = await collect(
      connector.discover(testContext({ config: config({ defaultLocationText: 'Nigeria' }), http: client })),
    );
    expect(items[0]?.locationText).toBe('Nigeria');
  });

  it('skips items matching the exclusion pattern', async () => {
    const connector = new RssConnector();
    const { client } = testHttpClient([{ match: 'feed.rss', body: RSS_FIXTURE }]);
    const { items } = await collect(
      connector.discover(testContext({ config: config({ excludeTitlePattern: 'Data Analyst' }), http: client })),
    );
    expect(items).toHaveLength(1);
  });

  it('resumes incrementally from a cursor', async () => {
    const connector = new RssConnector();
    const { client } = testHttpClient([{ match: 'feed.rss', body: RSS_FIXTURE }]);
    const { items, result } = await collect(
      connector.discover(
        testContext({
          config: config(),
          http: client,
          cursor: { newestPublishedAt: '2026-08-10T09:00:00.000Z' },
        }),
      ),
    );
    // Only the item newer than the watermark survives.
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Data Analyst');
    expect(result?.cursor?.newestPublishedAt).toBe('2026-08-11T09:00:00.000Z');
  });

  it('parses Atom feeds through the same connector', async () => {
    const connector = new RssConnector();
    const { client } = testHttpClient([{ match: 'atom.rss', body: ATOM_FIXTURE }]);
    const { items } = await collect(
      connector.discover(
        testContext({ config: config({ feedUrl: 'https://atom.test/atom.rss' }), http: client }),
      ),
    );
    expect(items[0]?.title).toBe('Platform Engineer');
  });

  it('reports unhealthy when the feed is empty', async () => {
    const connector = new RssConnector();
    const { client } = testHttpClient([
      { match: 'feed.rss', body: '<?xml version="1.0"?><rss><channel><title>x</title></channel></rss>' },
    ]);
    const health = await connector.healthCheck(testContext({ config: config(), http: client }));
    expect(health.healthy).toBe(false);
  });
});

describe('JSON API connectors', () => {
  it('maps Remotive fields and marks postings remote', async () => {
    const body = JSON.stringify({
      jobs: [
        {
          id: 1,
          url: 'https://remotive.com/jobs/1',
          title: 'Backend Engineer',
          company_name: 'Acme',
          job_type: 'full_time',
          publication_date: '2026-08-10T10:00:00',
          candidate_required_location: 'Europe',
          salary: '$100,000 - $130,000',
          description: '<p>Work</p>',
          tags: ['go'],
        },
      ],
    });
    const { client } = testHttpClient([{ match: 'remotive.com', body }]);
    const connector = new RemotiveConnector();
    const { items } = await collect(
      connector.discover(testContext({ config: connector.configSchema.parse({}), http: client })),
    );

    expect(items[0]?.remoteFlag).toBe(true);
    expect(items[0]?.locationText).toBe('Europe');
    expect(items[0]?.salaryText).toBe('$100,000 - $130,000');
    expect(items[0]?.externalId).toBe('1');
  });

  it('maps Arbeitnow, following next_url pagination', async () => {
    const page1 = JSON.stringify({
      data: [
        {
          slug: 'a-1',
          company_name: 'Preiswecker',
          title: 'Software Engineer',
          location: 'Berlin',
          remote: false,
          job_types: ['Full-time'],
          created_at: 1786516800,
          url: 'https://company.test/job',
          visa_sponsorship: true,
        },
      ],
      links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' },
    });
    const page2 = JSON.stringify({ data: [], links: {} });

    const { client, mock } = testHttpClient([
      { match: 'page=2', body: page2 },
      { match: 'job-board-api', body: page1 },
    ]);
    const connector = new ArbeitnowConnector();
    const { items } = await collect(
      connector.discover(
        testContext({ config: connector.configSchema.parse({ maxPages: 3 }), http: client }),
      ),
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.locationText).toBe('Berlin');
    expect(items[0]?.remoteFlag).toBe(false);
    /*
     * The API's own `url` is canonical, not the slug-derived `/view/` path.
     *
     * This previously asserted the opposite. Arbeitnow answers `/view/<slug>`
     * with a 301 to itself, so every link built that way died in the browser
     * with ERR_TOO_MANY_REDIRECTS — verified against the live site, where the
     * `url` field returns 200 with no redirects and `/view/` exhausts the
     * redirect limit. The test was encoding a comment's claim rather than the
     * board's behaviour.
     */
    expect(items[0]?.url).toBe('https://company.test/job');
    expect(items[0]?.applyUrl).toBe('https://company.test/job');
    expect(items[0]?.sourceMetadata.visaSponsorship).toBe(true);
    expect(mock.callsFor('page=2')).toHaveLength(1);
  });

  it('maps Jobicy structured salary, tolerating string numbers', async () => {
    const body = JSON.stringify({
      jobs: [
        {
          id: 7,
          url: 'https://jobicy.com/jobs/7',
          jobTitle: 'Rust Developer',
          companyName: '1Password',
          jobType: 'Full-Time',
          jobGeo: 'Canada, USA',
          salaryMin: '123000',
          salaryMax: 172000,
          salaryCurrency: 'USD',
          salaryPeriod: 'yearly',
          pubDate: '2026-08-17T14:49:16+00:00',
        },
      ],
    });
    const { client } = testHttpClient([{ match: 'jobicy.com', body }]);
    const connector = new JobicyConnector();
    const { items } = await collect(
      connector.discover(testContext({ config: connector.configSchema.parse({}), http: client })),
    );

    expect(items[0]?.salaryMin).toBe(123_000);
    expect(items[0]?.salaryMax).toBe(172_000);
    expect(items[0]?.salaryPeriod).toBe('year');
    expect(items[0]?.employmentTypeTexts).toEqual(['Full-Time']);
  });

  it('skips malformed records instead of failing the batch', async () => {
    const body = JSON.stringify({
      jobs: [
        { id: 1, url: 'not-a-url', title: 'Broken', company_name: 'X' },
        { id: 2, url: 'https://remotive.com/jobs/2', title: 'Good', company_name: 'Y' },
      ],
    });
    const { client } = testHttpClient([{ match: 'remotive.com', body }]);
    const connector = new RemotiveConnector();
    const { items } = await collect(
      connector.discover(testContext({ config: connector.configSchema.parse({}), http: client })),
    );
    // One bad record must not destroy the run.
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Good');
  });
});

describe('restricted and credential-gated sources', () => {
  it('never fetches a restricted source and explains why', async () => {
    const connector = new RestrictedSourceConnector();
    const config = connector.configSchema.parse({
      restrictionReason: 'Terms prohibit automated collection.',
      alternatives: ['Mailbox ingestion'],
    });
    const { client, mock } = testHttpClient([]);

    expect(connector.availability({ config, getSecret: () => undefined }).available).toBe(false);

    const health = await connector.healthCheck(testContext({ config, http: client }));
    expect(health.healthy).toBe(false);
    expect(health.message).toContain('Mailbox ingestion');

    await expect(
      collect(connector.discover(testContext({ config, http: client }))),
    ).rejects.toThrow(NotPermittedError);
    // The decisive assertion: not a single request was made.
    expect(mock.calls).toHaveLength(0);
  });

  it('reports Reddit unavailable without credentials, naming what is missing', () => {
    const connector = new RedditConnector();
    const config = connector.configSchema.parse({ subreddits: ['forhire'] });

    const missing = connector.availability({ config, getSecret: () => undefined });
    expect(missing.available).toBe(false);
    expect(missing.requires).toEqual(['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET']);

    const present = connector.availability({
      config,
      getSecret: (n) => (n.startsWith('REDDIT') ? 'x' : undefined),
    });
    expect(present.available).toBe(true);
  });

  it('reports search discovery unavailable without a licensed provider', () => {
    const connector = new SearchDiscoveryConnector();
    const config = connector.configSchema.parse({ queries: ['engineer'] });
    const result = connector.availability({ config, getSecret: () => undefined });

    expect(result.available).toBe(false);
    expect(result.requires).toContain('SERPAPI_KEY');
    expect(result.reason).toMatch(/prohibited|licensed/i);
  });
});

describe('Reddit connector parsing', () => {
  it('extracts hiring posts and marks them unverified', async () => {
    const token = JSON.stringify({ access_token: 't', expires_in: 3600 });
    const listing = JSON.stringify({
      data: {
        children: [
          {
            data: {
              id: 'abc',
              name: 't3_abc',
              title: '[Hiring] Senior Go Engineer, remote',
              // A realistic body: the connector now classifies content, and
              // 200 repeated characters is correctly not a job posting.
              selftext:
                'We are hiring a Senior Go Engineer to join our platform team. ' +
                'Responsibilities: design and build backend services, own deployments. ' +
                'Requirements: 5+ years of experience with Go and distributed systems. ' +
                'Fully remote within Europe. To apply, send your CV to https://company.test/apply',
              author: 'someone',
              subreddit: 'forhire',
              permalink: '/r/forhire/comments/abc/post',
              url: 'https://company.test/apply',
              created_utc: 1_786_516_800,
              link_flair_text: 'Hiring',
            },
          },
          {
            data: {
              id: 'def',
              title: '[For Hire] I am looking for work',
              selftext:
                'I am a backend developer seeking work. My journey started three years ago. ' +
                'Happy to share career advice or interview tips if useful. Ask me anything.',
              subreddit: 'forhire',
              created_utc: 1_786_516_900,
            },
          },
        ],
      },
    });

    const { client } = testHttpClient([
      { match: 'access_token', body: token },
      { match: 'oauth.reddit.com', body: listing },
    ]);
    const connector = new RedditConnector();
    const { items } = await collect(
      connector.discover(
        testContext({
          config: connector.configSchema.parse({ subreddits: ['forhire'] }),
          http: client,
          secrets: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'secret' },
        }),
      ),
    );

    // The "[For Hire]" post is someone seeking work, not a vacancy.
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('Senior Go Engineer');
    expect(items[0]?.applyUrl).toBe('https://company.test/apply');
    expect(items[0]?.sourceMetadata.subreddit).toBe('forhire');
    expect(items[0]?.sourceMetadata.verifiedEmployer).toBe(false);
    // Classified deterministically — no model was configured, and none was needed.
    expect(items[0]?.sourceMetadata.contentType).toBe('job_posting');
    expect(items[0]?.sourceMetadata.classificationMethod).toBe('heuristic');
  });
});
