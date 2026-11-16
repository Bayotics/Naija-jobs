import { and, desc, eq, gte, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { JobListQuery } from '@job-intel/contracts';
import type { Database } from '../client';
import { companies, jobs } from '../schema/jobs';
import { jobSources } from '../schema/sources';

/**
 * Read access to normalized jobs.
 *
 * Writes deliberately live in `DiscoveryRepository`: upsert, change detection
 * and versioning are one cohesive operation, and splitting them across two
 * repositories is how two subtly different upsert paths appear.
 */
export class JobRepository {
  constructor(private readonly db: Database) {}

  async list(query: JobListQuery) {
    const conditions: SQL[] = [];
    if (query.status) conditions.push(eq(jobs.status, query.status));
    if (query.countryCode) conditions.push(eq(jobs.countryCode, query.countryCode));
    if (query.remoteType) conditions.push(eq(jobs.remoteType, query.remoteType));
    if (query.sourceId) conditions.push(eq(jobs.sourceId, query.sourceId));
    if (query.company) conditions.push(ilike(jobs.companyNameRaw, `%${query.company}%`));
    if (query.postedSince) conditions.push(gte(jobs.postedAt, query.postedSince));
    if (query.search) {
      const term = `%${query.search}%`;
      const search = or(ilike(jobs.title, term), ilike(jobs.companyNameRaw, term));
      if (search) conditions.push(search);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [items, total] = await Promise.all([
      this.db
        .select({
          id: jobs.id,
          title: jobs.title,
          companyName: jobs.companyNameRaw,
          sourceId: jobs.sourceId,
          sourceName: jobSources.displayName,
          locationRaw: jobs.locationRaw,
          countryCode: jobs.countryCode,
          remoteType: jobs.remoteType,
          seniority: jobs.seniority,
          salaryMin: jobs.salaryMin,
          salaryMax: jobs.salaryMax,
          salaryCurrency: jobs.salaryCurrency,
          status: jobs.status,
          postedAt: jobs.postedAt,
          firstSeenAt: jobs.firstSeenAt,
          canonicalUrl: jobs.canonicalUrl,
          sourceUrl: jobs.sourceUrl,
        })
        .from(jobs)
        .leftJoin(jobSources, eq(jobs.sourceId, jobSources.id))
        .where(where)
        .orderBy(desc(jobs.firstSeenAt))
        .limit(query.limit)
        .offset(query.offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(where),
    ]);

    return { items, total: total[0]?.count ?? 0 };
  }

  async getById(id: string) {
    const rows = await this.db
      .select()
      .from(jobs)
      .leftJoin(companies, eq(jobs.companyId, companies.id))
      .where(eq(jobs.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { ...row.jobs, company: row.companies };
  }

  /** Powers the dashboard's discovery counters. */
  async countsByStatus() {
    const rows = await this.db
      .select({ status: jobs.status, count: sql<number>`count(*)::int` })
      .from(jobs)
      .groupBy(jobs.status);
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  }
}
