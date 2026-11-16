import { z } from 'zod';
import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import { applyParams, paginate, type PageResult } from '../pagination';
import { DEFAULT_CAPABILITIES, type Connector, type ConnectorContext } from '../types';

/**
 * Arbeitnow — public job-board API, Europe-weighted.
 * https://www.arbeitnow.com/api/job-board-api
 *
 * Notable because it carries an explicit `visa_sponsorship` tag, which almost
 * no other free source does — that maps to a preference the system treats as a
 * hard constraint, so it is worth surfacing.
 *
 * Uses `next_url` pagination: the response carries `links.next`.
 */
export const arbeitnowConfigSchema = z.object({
  baseUrl: z.string().url().default('https://www.arbeitnow.com/api/job-board-api'),
  maxPages: z.number().int().min(1).max(50).default(3),
  maxItems: z.number().int().min(1).max(5000).default(300),
  /** Keeps only postings whose tags/title match, e.g. "engineer|developer". */
  keywordFilter: z.string().nullable().default(null),
});

export type ArbeitnowConfig = z.infer<typeof arbeitnowConfigSchema>;

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description?: string;
  remote?: boolean;
  url: string;
  tags?: string[];
  job_types?: string[];
  location?: string;
  created_at?: number;
  visa_sponsorship?: boolean;
}

interface ArbeitnowResponse {
  data?: ArbeitnowJob[];
  links?: { next?: string | null };
}

export class ArbeitnowConnector implements Connector<ArbeitnowConfig> {
  readonly id = 'arbeitnow';
  readonly displayName = 'Arbeitnow (EU job board API)';
  readonly sourceType = 'job_api' as const;
  readonly accessTier = 'official_api' as const;
  readonly capabilities = {
    ...DEFAULT_CAPABILITIES,
    supportsPagination: true,
    providesVisaFlag: true,
  };
  readonly configSchema = arbeitnowConfigSchema;

  availability() {
    return { available: true, reason: null, requires: [] };
  }

  async healthCheck(ctx: ConnectorContext<ArbeitnowConfig>) {
    const startedAt = Date.now();
    try {
      const response = await ctx.http.getJson<ArbeitnowResponse>(ctx.config.baseUrl, {
        signal: ctx.signal,
      });
      const count = response.data.data?.length ?? 0;
      return {
        healthy: count > 0,
        message: count > 0 ? `API reachable, ${count} jobs on first page` : 'API returned no jobs',
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
    ctx: ConnectorContext<ArbeitnowConfig>,
  ): AsyncGenerator<SourceJobDraft, { pagesFetched: number; truncated: boolean }, void> {
    const { config } = ctx;
    const keyword = safeRegex(config.keywordFilter);

    const pages = paginate<ArbeitnowJob>(
      { type: 'next_url', urlPath: 'links.next' },
      { maxPages: config.maxPages, maxItems: config.maxItems },
      async (request): Promise<PageResult<ArbeitnowJob>> => {
        const url = request.absoluteUrl ?? applyParams(config.baseUrl, request.params);
        const response = await ctx.http.getJson<ArbeitnowResponse>(url, { signal: ctx.signal });
        return { items: response.data.data ?? [], body: response.data };
      },
    );

    let summary = { pagesFetched: 0, truncated: false };
    for (;;) {
      const next = await pages.next();
      if (next.done) {
        summary = next.value ?? summary;
        break;
      }
      const job = next.value;

      if (keyword && !keyword.test(`${job.title} ${(job.tags ?? []).join(' ')}`)) continue;

      const draft = sourceJobDraftSchema.safeParse({
        externalId: job.slug,
        title: job.title,
        companyName: job.company_name,
        description: job.description ?? null,
        descriptionFormat: 'html',
        locationText: job.location ?? null,
        remoteFlag: job.remote ?? null,
        employmentTypeTexts: job.job_types ?? [],
        tags: job.tags ?? [],
        // `created_at` is a Unix timestamp in seconds.
        postedAt: job.created_at ? new Date(job.created_at * 1000) : null,
        /*
         * `job.url` is the board's own canonical page
         * (`/jobs/companies/<company>/<slug>`) and is what this must use.
         *
         * The slug-derived `/view/<slug>` form was chosen originally as the
         * more stable target. It is not: Arbeitnow now answers it with a 301 to
         * itself, so every one of those links dies in the browser with
         * ERR_TOO_MANY_REDIRECTS. Verified against the live site — the
         * `/jobs/companies/` form returns 200 with zero redirects, the `/view/`
         * form exhausts the redirect limit.
         *
         * The slug form is kept only as a fallback for a record that arrives
         * without a URL, where a possibly-broken link still beats none.
         */
        url: job.url ?? `https://www.arbeitnow.com/view/${job.slug}`,
        applyUrl: job.url ?? null,
        raw: job,
        sourceMetadata: { visaSponsorship: job.visa_sponsorship ?? null },
      });

      if (draft.success) yield draft.data;
    }

    return summary;
  }
}

function safeRegex(pattern: string | null): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}
