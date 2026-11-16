import { z } from 'zod';
import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import { DEFAULT_CAPABILITIES, type Connector, type ConnectorContext } from '../types';

/**
 * Jobicy — public remote-jobs API.
 * https://jobicy.com/api/v2/remote-jobs
 *
 * The only free source here that returns *structured* salary (min, max,
 * currency, period) rather than prose, which the normalizer prefers over any
 * regex over text.
 */
export const jobicyConfigSchema = z.object({
  baseUrl: z.string().url().default('https://jobicy.com/api/v2/remote-jobs'),
  count: z.number().int().min(1).max(50).default(50),
  /** Jobicy industry slug, e.g. "engineering". */
  industry: z.string().nullable().default(null),
  /** Geo filter slug, e.g. "usa", "europe". */
  geo: z.string().nullable().default(null),
});

export type JobicyConfig = z.infer<typeof jobicyConfigSchema>;

interface JobicyJob {
  id: number;
  url: string;
  jobSlug?: string;
  jobTitle: string;
  companyName: string;
  companyLogo?: string;
  jobIndustry?: string[] | string;
  jobType?: string[] | string;
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
  salaryMin?: number | string | null;
  salaryMax?: number | string | null;
  salaryCurrency?: string | null;
  salaryPeriod?: string | null;
}

interface JobicyResponse {
  jobCount?: number;
  jobs?: JobicyJob[];
}

/** Jobicy returns some list fields as either an array or a single string. */
function toList(value: string[] | string | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Maps Jobicy's period wording onto the internal enum. */
function toPeriod(value: string | null | undefined): 'hour' | 'day' | 'week' | 'month' | 'year' | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.startsWith('hour')) return 'hour';
  if (v.startsWith('dai') || v.startsWith('day')) return 'day';
  if (v.startsWith('week')) return 'week';
  if (v.startsWith('month')) return 'month';
  if (v.startsWith('year') || v.startsWith('annual')) return 'year';
  return null;
}

export class JobicyConnector implements Connector<JobicyConfig> {
  readonly id = 'jobicy';
  readonly displayName = 'Jobicy (remote jobs API)';
  readonly sourceType = 'job_api' as const;
  readonly accessTier = 'official_api' as const;
  readonly capabilities = { ...DEFAULT_CAPABILITIES, providesStructuredSalary: true };
  readonly configSchema = jobicyConfigSchema;

  availability() {
    return { available: true, reason: null, requires: [] };
  }

  async healthCheck(ctx: ConnectorContext<JobicyConfig>) {
    const startedAt = Date.now();
    try {
      const response = await ctx.http.getJson<JobicyResponse>(
        this.buildUrl({ ...ctx.config, count: 1 }),
        { signal: ctx.signal },
      );
      const count = response.data.jobs?.length ?? 0;
      return {
        healthy: count > 0,
        message: count > 0 ? `API reachable, ${response.data.jobCount ?? count} jobs` : 'API returned no jobs',
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

  async *discover(ctx: ConnectorContext<JobicyConfig>): AsyncGenerator<SourceJobDraft, void, void> {
    const response = await ctx.http.getJson<JobicyResponse>(this.buildUrl(ctx.config), {
      signal: ctx.signal,
    });

    for (const job of response.data.jobs ?? []) {
      const postedAt = job.pubDate ? new Date(job.pubDate) : null;

      const draft = sourceJobDraftSchema.safeParse({
        externalId: String(job.id),
        title: job.jobTitle,
        companyName: job.companyName,
        description: job.jobDescription ?? job.jobExcerpt ?? null,
        descriptionFormat: 'html',
        locationText: job.jobGeo ?? null,
        remoteFlag: true,
        employmentTypeTexts: toList(job.jobType),
        salaryMin: toNumber(job.salaryMin),
        salaryMax: toNumber(job.salaryMax),
        salaryCurrency: job.salaryCurrency ?? null,
        salaryPeriod: toPeriod(job.salaryPeriod),
        tags: toList(job.jobIndustry),
        postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
        url: job.url,
        raw: job,
        sourceMetadata: { jobLevel: job.jobLevel ?? null },
      });

      if (draft.success) yield draft.data;
    }
  }

  private buildUrl(config: JobicyConfig): string {
    const url = new URL(config.baseUrl);
    url.searchParams.set('count', String(config.count));
    if (config.industry) url.searchParams.set('industry', config.industry);
    if (config.geo) url.searchParams.set('geo', config.geo);
    return url.toString();
  }
}
