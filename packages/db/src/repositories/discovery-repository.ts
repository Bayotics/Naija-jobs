import { and, desc, eq, sql } from 'drizzle-orm';
import type { DiscoveryOutcome, NormalizedJob } from '@job-intel/contracts';
import type { Database } from '../client';
import { jobs, jobVersions, rawPostings } from '../schema/jobs';

/**
 * Persistence for the discovery pipeline.
 *
 * Two guarantees the rest of the pipeline relies on:
 *
 *  1. **Idempotent by natural key.** Re-running a source can never create a
 *     duplicate row, because uniqueness is a database constraint on
 *     `(source_id, source_identity)` rather than an application check.
 *  2. **Change-aware.** An unchanged posting costs one cheap UPDATE of
 *     `last_seen_at`. A *changed* posting updates the row and records a
 *     `job_versions` snapshot, so "this job changed after I saw it" stays
 *     answerable.
 */

export interface PersistJobInput {
  job: NormalizedJob;
  sourceId: string;
  rawPostingId: string | null;
  identity: {
    sourceIdentity: string;
    contentHash: string;
    normalizedUrl: string | null;
    urlHash: string | null;
    fingerprint: string;
    simhash: string | null;
  };
  traceId: string | null;
  /** The discovery query that found it, when a query was involved. */
  discoveryQueryId?: string | null;
}

export interface PersistJobResult {
  jobId: string;
  outcome: Extract<DiscoveryOutcome, 'created' | 'updated' | 'unchanged'>;
  changedFields: string[];
  version: number;
}

/**
 * Fields whose change is *material* — worth a new version and a re-match.
 *
 * Deliberately excludes volatile presentation noise: a source that re-renders
 * its HTML every hour must not generate a version record every hour.
 */
const MATERIAL_FIELDS = [
  'title',
  'description',
  'salaryMin',
  'salaryMax',
  'salaryCurrency',
  'salaryPeriod',
  'remoteType',
  'employmentTypes',
  'seniority',
  'locationRaw',
  'countryCode',
  'visaSponsorship',
  'applyUrl',
  'canonicalUrl',
  'status',
] as const;

export class DiscoveryRepository {
  constructor(private readonly db: Database) {}

  /**
   * Stores the untouched source payload.
   *
   * Returns the existing row on a content-hash collision instead of inserting,
   * which is what makes re-crawling free. This is the exact-dedup guard.
   */
  async saveRawPosting(input: {
    sourceId: string;
    sourceRunId: string | null;
    externalId: string | null;
    sourceUrl: string | null;
    payload: unknown;
    payloadFormat: string;
    contentHash: string;
    traceId: string | null;
  }): Promise<{ id: string; isNew: boolean }> {
    const [inserted] = await this.db
      .insert(rawPostings)
      .values({
        sourceId: input.sourceId,
        sourceRunId: input.sourceRunId,
        externalId: input.externalId,
        sourceUrl: input.sourceUrl,
        payload: input.payload as object,
        payloadFormat: input.payloadFormat,
        contentHash: input.contentHash,
        traceId: input.traceId,
      })
      .onConflictDoNothing({ target: [rawPostings.sourceId, rawPostings.contentHash] })
      .returning({ id: rawPostings.id });

    if (inserted) return { id: inserted.id, isNew: true };

    const existing = await this.db
      .select({ id: rawPostings.id })
      .from(rawPostings)
      .where(
        and(eq(rawPostings.sourceId, input.sourceId), eq(rawPostings.contentHash, input.contentHash)),
      )
      .limit(1);

    if (!existing[0]) throw new Error('raw posting insert conflicted but no existing row found');
    return { id: existing[0].id, isNew: false };
  }

  /** Insert-or-update a normalized job, versioning material changes. */
  async upsertJob(input: PersistJobInput): Promise<PersistJobResult> {
    const row = this.toRow(input);

    const existing = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.sourceId, input.sourceId),
          eq(jobs.sourceIdentity, input.identity.sourceIdentity),
        ),
      )
      .limit(1);

    const current = existing[0];

    if (!current) {
      const [created] = await this.db
        .insert(jobs)
        .values(row)
        .onConflictDoNothing({ target: [jobs.sourceId, jobs.sourceIdentity] })
        .returning({ id: jobs.id });

      if (created) {
        return { jobId: created.id, outcome: 'created', changedFields: [], version: 1 };
      }
      // Lost a race with a concurrent worker; fall through and treat as update.
      return this.upsertJob(input);
    }

    // Identical content: only liveness changes. No version, no re-match.
    if (current.contentHash === input.identity.contentHash) {
      await this.db
        .update(jobs)
        .set({ lastSeenAt: new Date() })
        .where(eq(jobs.id, current.id));
      return {
        jobId: current.id,
        outcome: 'unchanged',
        changedFields: [],
        version: current.version,
      };
    }

    const changedFields = diffMaterialFields(current, row);

    // Content hash moved but nothing material did — e.g. whitespace or an ad
    // slot in the markup. Refresh the hash so we stop re-diffing it, but do not
    // manufacture a version.
    if (changedFields.length === 0) {
      await this.db
        .update(jobs)
        .set({ contentHash: input.identity.contentHash, lastSeenAt: new Date(), updatedAt: new Date() })
        .where(eq(jobs.id, current.id));
      return {
        jobId: current.id,
        outcome: 'unchanged',
        changedFields: [],
        version: current.version,
      };
    }

    const nextVersion = current.version + 1;

    await this.db.transaction(async (tx) => {
      // Snapshot the *previous* state before overwriting it.
      await tx.insert(jobVersions).values({
        jobId: current.id,
        version: current.version,
        contentHash: current.contentHash,
        changedFields,
        snapshot: current as unknown as Record<string, unknown>,
      });

      await tx
        .update(jobs)
        .set({
          ...row,
          version: nextVersion,
          // Discovery timestamps must survive an update.
          firstSeenAt: current.firstSeenAt,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, current.id));
    });

    return { jobId: current.id, outcome: 'updated', changedFields, version: nextVersion };
  }

  async listVersions(jobId: string, limit = 20) {
    return this.db
      .select()
      .from(jobVersions)
      .where(eq(jobVersions.jobId, jobId))
      .orderBy(desc(jobVersions.version))
      .limit(limit);
  }

  /** Jobs discovered by a source within a window — powers source health. */
  async countRecentJobs(sourceId: string, sinceHours: number): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        and(
          eq(jobs.sourceId, sourceId),
          sql`${jobs.firstSeenAt} > now() - make_interval(hours => ${sinceHours})`,
        ),
      );
    return rows[0]?.count ?? 0;
  }

  private toRow(input: PersistJobInput) {
    const { job, identity } = input;
    return {
      sourceId: input.sourceId,
      rawPostingId: input.rawPostingId,
      discoveryQueryId: input.discoveryQueryId ?? null,
      title: job.title,
      titleNormalized: job.title.toLowerCase().trim(),
      companyNameRaw: job.company.name,
      companyWebsite: job.company.websiteUrl,
      description: job.description,
      descriptionHtml: job.descriptionHtml,
      responsibilities: job.responsibilities,
      requirements: job.requirements,
      preferredQualifications: job.preferredQualifications,
      benefits: job.benefits,
      techStack: job.techStack,
      employmentTypes: job.employmentTypes,
      remoteType: job.remoteType,
      seniority: job.seniority,
      seniorityConfidence: job.seniorityConfidence,
      locationRaw: job.location.raw,
      city: job.location.city,
      region: job.location.region,
      countryCode: job.location.countryCode,
      latitude: job.location.latitude,
      longitude: job.location.longitude,
      salaryMin: job.salary.min !== null ? String(job.salary.min) : null,
      salaryMax: job.salary.max !== null ? String(job.salary.max) : null,
      salaryCurrency: job.salary.currency,
      salaryPeriod: job.salary.period,
      salaryIsEstimated: job.salary.isEstimated,
      salaryNormalizedAnnualUsd:
        job.salary.normalizedAnnualUsd !== null ? String(job.salary.normalizedAnnualUsd) : null,
      salaryFxRate: job.salary.fxRateUsed !== null ? String(job.salary.fxRateUsed) : null,
      visaSponsorship: job.visaSponsorship,
      relocationSupport: job.relocationSupport,
      educationRequired: job.educationRequired,
      minYearsExperience: job.minYearsExperience,
      maxYearsExperience: job.maxYearsExperience,
      sourceUrl: job.sourceUrl,
      canonicalUrl: job.canonicalUrl,
      applyUrl: job.applyUrl,
      externalId: job.externalId,
      sourceIdentity: identity.sourceIdentity,
      contentHash: identity.contentHash,
      normalizedUrl: identity.normalizedUrl,
      urlHash: identity.urlHash,
      fingerprint: identity.fingerprint,
      simhash: identity.simhash !== null ? BigInt(identity.simhash) : null,
      status: job.status,
      postedAt: job.postedAt,
      validThrough: job.validThrough,
      lastVerifiedAt: new Date(),
      traceId: input.traceId,
    };
  }
}

/** Compares only the fields whose change is meaningful. */
function diffMaterialFields(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  for (const field of MATERIAL_FIELDS) {
    if (!valuesEqual(current[field], next[field])) changed.push(field);
  }
  return changed;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as string).getTime() === new Date(b as string).getTime();
  }
  // Numeric columns come back as strings from Postgres; compare by value.
  return String(a) === String(b);
}
