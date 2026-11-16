# Adding a source

A source is a database row. Adding *a kind of source* is a connector: one class,
one registry line, and a contract test.

Nothing in `matching`, `ranking`, `notifications` or `candidate` changes when you
add one. If you find yourself editing those, the connector is doing something it
should not — most likely reading candidate preferences, which discovery must
never do. Discovery answers "what postings exist"; matching answers "which ones
suit this person".

## The interface

```ts
interface Connector<TConfig> {
  readonly id: string;                  // stable, lowercase, snake_case
  readonly displayName: string;
  readonly sourceType: SourceType;      // ats | job_api | rss_feed | social | html_page | …
  readonly accessTier: AccessTier;      // official_api | public_feed | permitted_html | …
  readonly capabilities: ConnectorCapabilities;
  readonly configSchema: z.ZodType<TConfig, z.ZodTypeDef, unknown>;

  availability(ctx): ConnectorAvailability;                 // cheap, no network
  healthCheck(ctx): Promise<ConnectorHealthResult>;         // one probe
  discover(ctx): AsyncGenerator<SourceJobDraft, DiscoverySummary | void>;
}
```

Four methods, and the ordering of concerns matters:

- **`availability`** must not touch the network. It answers "could this run at
  all", and the settings UI and the scheduler both call it before starting
  anything. A missing credential is reported here, not discovered mid-run.
- **`healthCheck`** makes exactly one probe. It powers the "Test" button.
- **`discover`** is an async generator, so drafts reach the pipeline as they are
  found. Memory stays flat regardless of source size, and a run that hits its
  time budget still contributes everything fetched so far.
- **`configSchema`** validates the source row *and* generates its settings form.

## What the framework gives you

You never write any of this:

| Concern | Where it lives |
| --- | --- |
| Rate limiting, per domain | `HttpClient` → `DomainRateLimiter` |
| Retries with backoff and jitter | `HttpClient` → `withRetry` |
| `robots.txt` compliance | `HttpClient` → `RobotsCache` |
| SSRF protection, incl. redirects and DNS | `HttpClient` → `checkUrl` |
| Conditional requests (ETag / Last-Modified) | `RequestOptions.conditional`, `evaluateConditional` |
| Pagination of any shape | `paginate(strategy, options, fetchPage)` |
| Structured-data extraction | `extractStructuredJobs(html)` |
| Content extraction and LLM gating | `extractMainContent`, `shouldClassify` |
| Job / not-job classification | `classifyContent` |
| Circuit breaking and scheduling | `SourceRepository.completeRun`, `decideSchedule` |

A connector that reaches for `fetch` directly has bypassed all of it. There is
no way to obtain a raw `fetch` from a `ConnectorContext`, and that is deliberate.

## A worked example

Suppose a board publishes `https://api.exampleboard.test/v2/jobs?page=1`.

```ts
import { z } from 'zod';
import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import {
  DEFAULT_CAPABILITIES,
  applyParams,
  paginate,
  type Connector,
  type ConnectorContext,
  type DiscoverySummary,
} from '@job-intel/connectors';

export const exampleBoardConfigSchema = z.object({
  /** Everything variable is configuration. Nothing candidate-specific. */
  category: z.string().trim().min(1).default('engineering'),
  maxPages: z.number().int().min(1).max(20).default(5),
});

type Config = z.infer<typeof exampleBoardConfigSchema>;

interface ApiJob {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remote: boolean | null;
  description_html: string | null;
  posted_at: string | null;
  url: string;
}

export class ExampleBoardConnector implements Connector<Config> {
  readonly id = 'example_board';
  readonly displayName = 'Example Board';
  readonly sourceType = 'job_api' as const;
  readonly accessTier = 'official_api' as const;
  readonly capabilities = { ...DEFAULT_CAPABILITIES, supportsPagination: true };
  readonly configSchema = exampleBoardConfigSchema;

  availability() {
    // Public API, no credentials. Report honestly — do not claim availability
    // you cannot deliver, and do not claim unavailability you could fix.
    return { available: true, reason: null, requires: [] };
  }

  async healthCheck(ctx: ConnectorContext<Config>) {
    const startedAt = Date.now();
    try {
      const response = await ctx.http.getJson<{ jobs?: ApiJob[] }>(
        'https://api.exampleboard.test/v2/jobs?page=1',
        { signal: ctx.signal },
      );
      return {
        healthy: true,
        message: `${response.data.jobs?.length ?? 0} job(s) on page 1`,
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
    ctx: ConnectorContext<Config>,
  ): AsyncGenerator<SourceJobDraft, DiscoverySummary, void> {
    const base = 'https://api.exampleboard.test/v2/jobs';

    // The framework walks the pages; you describe how to read one.
    const pages = paginate<ApiJob>(
      { type: 'page', param: 'page', startPage: 1, pageSizeParam: null, pageSize: 50 },
      { maxPages: ctx.config.maxPages },
      async (request) => {
        const response = await ctx.http.getJson<{ jobs?: ApiJob[] }>(
          applyParams(base, { ...request.params, category: ctx.config.category }),
          { signal: ctx.signal },
        );
        return { items: response.data.jobs ?? [], body: response.data };
      },
    );

    for (;;) {
      const next = await pages.next();
      if (next.done) {
        return { pagesFetched: next.value.pagesFetched, truncated: next.value.truncated };
      }

      const job = next.value;

      // `safeParse`, not `parse`: one malformed record must not end the run.
      const draft = sourceJobDraftSchema.safeParse({
        externalId: job.id,
        title: job.title,
        companyName: job.company,
        description: job.description_html,
        descriptionFormat: 'html',
        locationText: job.location,
        remoteFlag: job.remote,
        postedAt: job.posted_at ? new Date(job.posted_at) : null,
        url: job.url,
        // Verbatim, so an improved normalizer can be replayed over history.
        raw: job,
        sourceMetadata: { category: ctx.config.category },
      });

      if (draft.success) yield draft.data;
      else ctx.log('debug', `Dropped malformed job ${job.id}`);
    }
  }
}
```

Register it:

```ts
// packages/connectors/src/index.ts
export function createDefaultRegistry(): ConnectorRegistry {
  return new ConnectorRegistry()
    // …
    .register(new ExampleBoardConnector());
}
```

Then insert a row:

```sql
INSERT INTO job_sources (id, connector_id, display_name, source_type, access_tier, config)
VALUES ('exampleboard:eng', 'example_board', 'Example Board — Engineering',
        'job_api', 'official_api', '{"category":"engineering"}');
```

## Contract tests

Every connector gets the same checklist for free:

```ts
import { connectorContractAssertions } from '@job-intel/connectors/testing';

describe('ExampleBoardConnector', () => {
  const assertions = connectorContractAssertions({
    connector: new ExampleBoardConnector(),
    config: { category: 'engineering' },
    routes: [{ match: 'api.exampleboard.test', body: FIXTURE }],
    minDrafts: 2,
    failingRoutes: [{ match: 'api.exampleboard.test', status: 500, body: 'boom' }],
  });

  for (const assertion of assertions) {
    it(assertion.name, () => assertion.run());
  }
});
```

These check: stable identity, a config schema that actually rejects, availability
without network access, drafts that satisfy the schema, absolute URLs, real
`Date` objects (never `Invalid Date`), a deduplication identity on every draft,
non-empty title and company, a preserved raw payload, graceful handling of an
empty response, failures surfaced rather than swallowed, and a cursor when the
connector claims incremental support.

## The rules

1. **No candidate preferences.** A connector never sees them. If a source needs
   search terms, they arrive as *configuration*, generated by the query planner
   from preference data.
2. **No raw `fetch`.** Use `ctx.http`, or the politeness and safety guarantees
   are yours to re-implement and yours to get wrong.
3. **`safeParse` every record.** One malformed posting must not end a run.
4. **Never fabricate a field.** `null` is a valid answer and a useful one. A
   guessed company name breaks deduplication far more badly than a missing one.
5. **Report unavailability honestly.** A source requiring credentials you do not
   have is `unavailable` with the credential named — never a silent empty run,
   and never a fallback that evades an access control.
6. **Preserve `raw`.** It is what makes an improved normalizer replayable.
7. **Bound everything.** Pages, items, depth, time. An unbounded loop against
   someone else's server is an outage you caused.

## Choosing a mechanism

When a source offers several, prefer the earliest that works:

```
official API  →  ATS API  →  public feed  →  structured data
              →  sitemap  →  permitted HTML  →  search result
```

Each step down costs more requests, more parsing and more uncertainty for the
same posting. `detectSource()` implements this ordering and will tell you which
one a given URL supports — start there rather than guessing.
