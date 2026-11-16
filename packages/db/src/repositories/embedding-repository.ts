import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { jobEmbeddings, jobs } from '../schema/jobs';
import { candidateEmbeddings } from '../schema/candidate';
import { jobEnrichments } from '../schema/enrichment';

/**
 * Vector storage for jobs and candidates.
 *
 * Two rules the matching engine relies on:
 *
 *  - **A vector is meaningless without its model.** Both tables are keyed by
 *    (subject, model), so two models can coexist during a migration and a
 *    cosine is never computed across incompatible spaces.
 *  - **A vector is meaningless without its content hash.** Re-embedding is
 *    skipped when the text has not changed, and — more importantly — a vector
 *    whose hash no longer matches the current text is detectably stale rather
 *    than quietly wrong.
 */

export interface StoredVector {
  model: string;
  vector: number[];
  contentHash: string;
}

export class EmbeddingRepository {
  constructor(private readonly db: Database) {}

  // ── Jobs ──────────────────────────────────────────────────────────────────

  async saveJobEmbedding(input: {
    jobId: string;
    model: string;
    dimensions: number;
    embedding: number[];
    contentHash: string;
  }): Promise<void> {
    await this.db
      .insert(jobEmbeddings)
      .values({
        jobId: input.jobId,
        model: input.model,
        dimensions: input.dimensions,
        embedding: input.embedding,
        contentHash: input.contentHash,
      })
      .onConflictDoUpdate({
        target: [jobEmbeddings.jobId, jobEmbeddings.model],
        set: {
          dimensions: input.dimensions,
          embedding: input.embedding,
          contentHash: input.contentHash,
        },
      });
  }

  async getJobEmbedding(jobId: string, model: string): Promise<StoredVector | null> {
    const rows = await this.db
      .select()
      .from(jobEmbeddings)
      .where(and(eq(jobEmbeddings.jobId, jobId), eq(jobEmbeddings.model, model)))
      .limit(1);

    const row = rows[0];
    if (!row?.embedding) return null;
    return { model: row.model, vector: row.embedding, contentHash: row.contentHash };
  }

  /** Batch read, so scoring N jobs is one query rather than N. */
  async getJobEmbeddings(
    jobIds: readonly string[],
    model: string,
  ): Promise<Map<string, StoredVector>> {
    if (jobIds.length === 0) return new Map();

    const rows = await this.db
      .select()
      .from(jobEmbeddings)
      .where(
        and(
          eq(jobEmbeddings.model, model),
          sql`${jobEmbeddings.jobId} IN (SELECT unnest(${sql.param(jobIds)}::uuid[]))`,
        ),
      );

    const result = new Map<string, StoredVector>();
    for (const row of rows) {
      if (!row.embedding) continue;
      result.set(row.jobId, {
        model: row.model,
        vector: row.embedding,
        contentHash: row.contentHash,
      });
    }
    return result;
  }

  /**
   * Enriched jobs with no vector for this model.
   *
   * The enrichment join is deliberate: embedding a job before its description
   * has been cleaned would encode boilerplate and tracking junk into the vector.
   */
  async findJobsNeedingEmbedding(model: string, limit = 200): Promise<
    Array<{ jobId: string; title: string; description: string | null }>
  > {
    const rows = await this.db
      .select({
        jobId: jobs.id,
        title: jobs.title,
        description: jobEnrichments.cleanedDescription,
        rawDescription: jobs.description,
      })
      .from(jobs)
      .innerJoin(jobEnrichments, eq(jobEnrichments.jobId, jobs.id))
      .leftJoin(
        jobEmbeddings,
        and(eq(jobEmbeddings.jobId, jobs.id), eq(jobEmbeddings.model, model)),
      )
      .where(and(eq(jobEnrichments.status, 'enriched'), isNull(jobEmbeddings.id)))
      .orderBy(desc(jobs.postedAt))
      .limit(limit);

    return rows.map((row) => ({
      jobId: row.jobId,
      title: row.title,
      description: row.description ?? row.rawDescription,
    }));
  }

  // ── Candidates ────────────────────────────────────────────────────────────

  /**
   * The candidate's vector, or null when it is stale.
   *
   * Returning null for a stale vector rather than the stale value is the point:
   * a match computed against an out-of-date profile embedding is wrong in a way
   * nobody would notice, so the engine is made to skip the semantic dimension
   * instead and to say so in the trace.
   */
  async getCandidateEmbedding(profileId: string, model: string): Promise<StoredVector | null> {
    const rows = await this.db
      .select()
      .from(candidateEmbeddings)
      .where(
        and(eq(candidateEmbeddings.profileId, profileId), eq(candidateEmbeddings.model, model)),
      )
      .limit(1);

    const row = rows[0];
    if (!row?.embedding || row.isStale) return null;
    return { model: row.model, vector: row.embedding, contentHash: row.canonicalHash };
  }
}
