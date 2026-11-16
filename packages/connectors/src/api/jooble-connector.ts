import { z } from 'zod';
import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import { buildKeywordQueries } from '../query/builders';
import {
  DEFAULT_CAPABILITIES,
  type Connector,
  type ConnectorAvailabilityContext,
  type ConnectorContext,
  type QueryBuildInput,
} from '../types';
import type { SourceQuery } from '@job-intel/contracts';

/**
 * Jooble — authenticated JSON API over an aggregator's whole index.
 * https://ng.jooble.org/api/about
 *
 * ── Why this source rather than Indeed ──────────────────────────────────────
 *
 * Indeed answers a declared crawler with a 403, and the only ways past that
 * are browser impersonation or proxy rotation, both of which this system
 * refuses. Jooble indexes much of the same Nigerian market and publishes a
 * documented API with a key, which is the same data obtained by asking.
 *
 * ── The host carries the country ────────────────────────────────────────────
 *
 * `ng.jooble.org` is not cosmetic. Jooble runs a separate index per country
 * and the hostname selects it, so the Nigerian host returns Nigerian postings
 * and `jooble.org` returns a global mix. There is no country parameter to set;
 * getting this wrong fills the corpus with jobs in the wrong hemisphere and
 * nothing downstream would flag it, because a London job is a perfectly valid
 * job — just not one you can take.
 *
 * The plain `jooble.org` host also answers automated requests with a bot
 * challenge, while `ng.jooble.org` serves normally. One more reason the
 * default is the one it is.
 *
 * ── Keywords are required, which shapes everything ──────────────────────────
 *
 * Unlike a feed, this API has no "everything" mode: a request without keywords
 * returns nothing useful. So the connector is driven by a list of search terms
 * and issues one request per term, which is also how it stays inside the
 * field boundaries — a term list is the only filter this source understands.
 */

export const joobleConfigSchema = z.object({
  /**
   * One request per keyword. These are the field names, not a job title: the
   * API matches loosely, so "customer service" finds the receptionist and
   * front-desk postings too.
   */
  keywords: z.array(z.string().min(2).max(80)).min(1).max(20),

  /** Jooble's `location` is free text. Empty means country-wide. */
  location: z.string().max(80).default(''),

  /** Results per keyword per run. The API caps a page at 20. */
  pagesPerKeyword: z.number().int().min(1).max(10).default(2),

  /**
   * The country index. Changing the host changes which market is searched,
   * so this is deliberately a whole URL rather than a country code — there is
   * no parameter that would do the same job.
   */
  baseUrl: z.string().url().default('https://ng.jooble.org/api'),

  /** Env var holding the API key. Values never come from the database. */
  apiKeySecret: z.string().default('JOOBLE_API_KEY'),
});

export type JoobleConfig = z.infer<typeof joobleConfigSchema>;

interface JoobleJob {
  title?: string;
  location?: string;
  snippet?: string;
  salary?: string;
  source?: string;
  type?: string;
  link?: string;
  company?: string;
  updated?: string;
  id?: number | string;
}

interface JoobleResponse {
  totalCount?: number;
  jobs?: JoobleJob[];
}

export class JoobleConnector implements Connector<JoobleConfig> {
  readonly id = 'jooble';
  readonly displayName = 'Jooble Nigeria (API)';
  readonly sourceType = 'job_api' as const;
  readonly accessTier = 'official_api' as const;
  readonly capabilities = {
    ...DEFAULT_CAPABILITIES,
    supportsPagination: true,
    providesStructuredSalary: false,
  };
  readonly configSchema = joobleConfigSchema;

  /**
   * Reports missing credentials rather than failing the run.
   *
   * A source with no key is unconfigured, not broken. Saying so here puts
   * "needs JOOBLE_API_KEY" on the Sources page instead of a stack trace in the
   * dead-letter queue every hour.
   */
  availability(ctx: ConnectorAvailabilityContext<JoobleConfig>) {
    const key = ctx.getSecret(ctx.config.apiKeySecret);

    if (!key) {
      return {
        available: false,
        reason: `No API key. Set ${ctx.config.apiKeySecret} to the key Jooble emailed you.`,
        requires: [ctx.config.apiKeySecret],
      };
    }

    return { available: true, reason: null, requires: [] };
  }

  /**
   * Queries are the keywords themselves.
   *
   * The profile's roles are already the field names this source is configured
   * around, so there is nothing to translate — and the API has no location
   * parameter worth pushing a preference into, since the host already fixed
   * the country.
   */
  buildQueries(input: QueryBuildInput): SourceQuery[] {
    /*
     * `supportsLocationParameter` is true and remote is not.
     *
     * Jooble takes a free-text location, so a city preference can be pushed
     * down to the API. It has no remote flag, so remote stays residual and the
     * pipeline decides it from the posting text. Claiming otherwise would have
     * the engine skip a filter nobody applied.
     */
    return buildKeywordQueries(this.id, input, {
      supportsLocationParameter: true,
      supportsRemoteParameter: false,
    });
  }

  async healthCheck(ctx: ConnectorContext<JoobleConfig>) {
    const startedAt = Date.now();
    const key = ctx.getSecret(ctx.config.apiKeySecret);

    if (!key) {
      return {
        healthy: false,
        message: `${ctx.config.apiKeySecret} is not set`,
        checkedAt: new Date(),
      };
    }

    try {
      const response = await this.query(ctx, key, ctx.config.keywords[0] ?? 'admin', 1);

      return {
        healthy: true,
        message: `API reachable, ${response.totalCount ?? response.jobs?.length ?? 0} results for "${
          ctx.config.keywords[0] ?? 'admin'
        }"`,
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
    ctx: ConnectorContext<JoobleConfig>,
  ): AsyncGenerator<SourceJobDraft, { pagesFetched: number }, void> {
    const key = ctx.getSecret(ctx.config.apiKeySecret);

    if (!key) {
      ctx.log('warn', 'Jooble skipped: no API key configured', {
        secret: ctx.config.apiKeySecret,
      });
      return { pagesFetched: 0 };
    }

    let pagesFetched = 0;

    /*
     * The same posting comes back under several keywords — "admin" and "office
     * assistant" overlap heavily — so identical links are dropped here rather
     * than left for the deduplicator. Both would work; doing it here saves the
     * pipeline a normalize-and-hash per duplicate, and the duplicate rate
     * across overlapping keyword searches is high enough to be worth it.
     */
    const seen = new Set<string>();

    for (const keyword of ctx.config.keywords) {
      for (let page = 1; page <= ctx.config.pagesPerKeyword; page += 1) {
        if (ctx.signal.aborted) return { pagesFetched };

        let response: JoobleResponse;

        try {
          response = await this.query(ctx, key, keyword, page);
          pagesFetched += 1;
        } catch (error) {
          /*
           * One keyword failing is not the run failing.
           *
           * Twenty keywords means twenty requests, and a single timeout taking
           * the whole pass down would lose nineteen good result sets. The
           * failure is logged and the next keyword proceeds.
           */
          ctx.log('warn', 'Jooble keyword failed', {
            keyword,
            page,
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }

        const jobs = response.jobs ?? [];
        if (jobs.length === 0) break;

        for (const job of jobs) {
          const link = typeof job.link === 'string' ? job.link : null;
          if (!link || seen.has(link)) continue;
          seen.add(link);

          const postedAt = job.updated ? new Date(job.updated) : null;

          const draft = sourceJobDraftSchema.safeParse({
            // The link is the identity. Jooble's numeric `id` is not stable
            // across requests, so keying on it would re-import the corpus.
            externalId: link,
            title: job.title ?? '',
            companyName: job.company?.trim() || 'Unknown',
            /*
             * A snippet, and labelled as one.
             *
             * Jooble returns an excerpt rather than the posting, and
             *  in the metadata records that. Without the flag a
             * truncated paragraph looks like a complete description, and
             * enrichment would score requirements it never actually saw.
             */
            description: job.snippet ?? null,
            descriptionFormat: 'text',
            locationText: job.location ?? null,
            remoteFlag: null,
            employmentTypeTexts: job.type ? [job.type] : [],
            salaryText: job.salary ?? null,
            tags: [],
            postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
            url: link,
            raw: job,
            // Which board Jooble found it on. Worth keeping: it is the only
            // signal of original authority an aggregated listing carries.
            sourceMetadata: { aggregatedFrom: job.source ?? null, keyword, excerptOnly: true },
          });

          if (draft.success) yield draft.data;
        }

        // A short page is the last page.
        if (jobs.length < 20) break;
      }
    }

    return { pagesFetched };
  }

  /**
   * One request.
   *
   * The key travels in the path, which is Jooble's design rather than a
   * choice made here — there is no header form of this API. It therefore
   * never appears in a query string, and the client's own logging records the
   * host and status rather than the full URL.
   */
  private async query(
    ctx: ConnectorContext<JoobleConfig>,
    key: string,
    keyword: string,
    page: number,
  ): Promise<JoobleResponse> {
    const url = `${ctx.config.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(key)}`;

    const response = await ctx.http.getJson<JoobleResponse>(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        keywords: keyword,
        location: ctx.config.location,
        page: String(page),
      }),
      signal: ctx.signal,
    });

    return response.data;
  }
}
