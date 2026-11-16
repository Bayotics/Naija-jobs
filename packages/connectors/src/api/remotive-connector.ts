import { z } from 'zod';
import { buildKeywordQueries } from '../query/builders';
import type { QueryBuildInput } from '../types';
import type { SourceQuery } from '@job-intel/contracts';
import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import { DEFAULT_CAPABILITIES, type Connector, type ConnectorContext } from '../types';

/**
 * Remotive — public, documented, unauthenticated JSON API.
 * https://remotive.com/api/remote-jobs
 *
 * Remotive asks consumers to attribute the source and not to re-publish the
 * full listing; we link back to `job.url` as the canonical URL, which satisfies
 * that and is also the behaviour we want anyway.
 *
 * The API returns everything in one response with no paging, so `limit` is the
 * only volume control.
 */
export const remotiveConfigSchema = z.object({
  /** Remotive category slug, e.g. "software-dev". Omit for all categories. */
  category: z.string().nullable().default(null),
  /** Free-text search passed to the API. */
  search: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(1000).default(100),
  baseUrl: z.string().url().default('https://remotive.com/api/remote-jobs'),
});

export type RemotiveConfig = z.infer<typeof remotiveConfigSchema>;

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  company_logo?: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

interface RemotiveResponse {
  'job-count'?: number;
  jobs?: RemotiveJob[];
}

export class RemotiveConnector implements Connector<RemotiveConfig> {
  readonly id = 'remotive';
  readonly displayName = 'Remotive (remote jobs API)';
  readonly sourceType = 'job_api' as const;
  readonly accessTier = 'official_api' as const;
  readonly capabilities = { ...DEFAULT_CAPABILITIES, supportsIncremental: true };
  readonly configSchema = remotiveConfigSchema;

  /**
   * Keyword queries (Part 23).
   *
   * Remotive is remote-only, so the remote filter is satisfied by the source
   * itself rather than pushed down as a parameter — and location is residual,
   * because the API has no location filter and the pipeline must apply it.
   */
  buildQueries(input: QueryBuildInput): SourceQuery[] {
    return buildKeywordQueries(this.id, input, { supportsRemoteParameter: false });
  }

  availability() {
    return { available: true, reason: null, requires: [] };
  }

  async healthCheck(ctx: ConnectorContext<RemotiveConfig>) {
    const startedAt = Date.now();
    try {
      const url = this.buildUrl({ ...ctx.config, limit: 1 });
      const response = await ctx.http.getJson<RemotiveResponse>(url, { signal: ctx.signal });
      const count = response.data.jobs?.length ?? 0;
      return {
        healthy: count > 0,
        message: count > 0 ? `API reachable, ${response.data['job-count'] ?? count} jobs` : 'API returned no jobs',
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
    ctx: ConnectorContext<RemotiveConfig>,
  ): AsyncGenerator<SourceJobDraft, { cursor: Record<string, unknown> }, void> {
    const response = await ctx.http.getJson<RemotiveResponse>(this.buildUrl(ctx.config), {
      signal: ctx.signal,
    });

    const since = readCursorDate(ctx.cursor);
    let newest = since;

    for (const job of response.data.jobs ?? []) {
      const postedAt = job.publication_date ? new Date(job.publication_date) : null;
      const validDate = postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null;

      if (validDate) {
        if (since && validDate <= since) continue;
        if (!newest || validDate > newest) newest = validDate;
      }

      const draft = sourceJobDraftSchema.safeParse({
        externalId: String(job.id),
        title: job.title,
        companyName: job.company_name,
        description: job.description ?? null,
        descriptionFormat: 'html',
        // Remotive is a remote-only board; the field describes *where the
        // candidate may live*, which the normalizer reads as location + remote.
        locationText: job.candidate_required_location ?? null,
        remoteFlag: true,
        employmentTypeTexts: job.job_type ? [job.job_type] : [],
        salaryText: job.salary ?? null,
        tags: [...(job.tags ?? []), ...(job.category ? [job.category] : [])],
        postedAt: validDate,
        url: job.url,
        raw: job,
        sourceMetadata: { category: job.category ?? null, companyLogo: job.company_logo ?? null },
      });

      if (draft.success) yield draft.data;
    }

    return { cursor: { newestPublishedAt: newest?.toISOString() ?? null } };
  }

  private buildUrl(config: RemotiveConfig): string {
    const url = new URL(config.baseUrl);
    url.searchParams.set('limit', String(config.limit));
    if (config.category) url.searchParams.set('category', config.category);
    if (config.search) url.searchParams.set('search', config.search);
    return url.toString();
  }
}

function readCursorDate(cursor: Record<string, unknown> | null): Date | null {
  const value = cursor?.newestPublishedAt;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
