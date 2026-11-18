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

  /**
   * Deletes jobs older than `days`, keeping the ones the candidate acted on.
   *
   * ── Why anything is kept ──────────────────────────────────────────────
   *
   * Every table that references a job cascades on delete — twenty-five of
   * them, `applications` among them. So the obvious implementation, a single
   * `DELETE FROM jobs WHERE posted_at < cutoff`, also deletes the record that
   * you applied to a role three weeks ago and are waiting to hear back on.
   * Everything else in this database can be re-fetched from the source; that
   * cannot.
   *
   * A row in `applications` covers both senses: the Saved page reads it with
   * state `saved`, and applying writes the same table. One `NOT EXISTS` keeps
   * both.
   *
   * ── Why `posted_at` falls back to `first_seen_at` ─────────────────────
   *
   * Most Nigerian listings state no posting date. Treating an absent date as
   * "infinitely old" would delete every such job on the first pass — which is
   * most of the corpus — and treating it as "brand new" would keep them
   * forever. The day it was first seen is the one honest answer available,
   * and it is never later than the real posting date.
   */
  /**
   * What `purgeExpired` would remove, without removing it.
   *
   * A separate method rather than a `dryRun` flag on the delete. A flag means
   * the code that deletes has a mode in which it does not, and the only thing
   * standing between a preview and a purge is one boolean read correctly —
   * on the one operation here that cannot be undone.
   */
  async countExpired(options: {
    days: number;
    now?: Date;
  }): Promise<{ wouldDelete: number; wouldKeep: number }> {
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - options.days * 86_400_000);

    const expired = sql`coalesce(${jobs.postedAt}, ${jobs.firstSeenAt}) < ${cutoff}`;
    const actedOn = sql`exists (select 1 from applications a where a.job_id = ${jobs.id})`;

    const [row] = await this.db
      .select({
        wouldDelete: sql<number>`count(*) FILTER (WHERE NOT ${actedOn})::int`,
        wouldKeep: sql<number>`count(*) FILTER (WHERE ${actedOn})::int`,
      })
      .from(jobs)
      .where(expired);

    return { wouldDelete: row?.wouldDelete ?? 0, wouldKeep: row?.wouldKeep ?? 0 };
  }

  async purgeExpired(options: {
    days: number;
    now?: Date;
  }): Promise<{ deleted: number; keptBecauseActedOn: number }> {
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - options.days * 86_400_000);

    const expired = sql`coalesce(${jobs.postedAt}, ${jobs.firstSeenAt}) < ${cutoff}`;
    const actedOn = sql`exists (select 1 from applications a where a.job_id = ${jobs.id})`;

    // Counted before the delete, in the same statement shape, so the number
    // reported is the number this pass actually spared rather than an
    // estimate taken at a different moment.
    const [kept] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(and(expired, actedOn));

    const deleted = await this.db
      .delete(jobs)
      .where(and(expired, sql`not ${actedOn}`))
      .returning({ id: jobs.id });

    return { deleted: deleted.length, keptBecauseActedOn: kept?.count ?? 0 };
  }
}
