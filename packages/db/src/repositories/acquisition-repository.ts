import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  INLINE_CONTENT_LIMIT_BYTES,
  jobChangeSetSchema,
  rawSourceDocumentSchema,
  sourceReliabilitySchema,
  sourceWatermarkSchema,
  type JobChangeSet,
  type RawSourceDocument,
  type SourceReliability,
  type SourceWatermark,
} from '@job-intel/contracts';
import type { Database } from '../client';
import {
  jobChangeEvents,
  rawSourceDocuments,
  sourceReliabilityWindows,
  sourceWatermarks,
} from '../schema/acquisition';

/**
 * Persistence for the acquisition layer.
 *
 * Every write here is idempotent by database constraint rather than by
 * application check. That distinction matters more in this layer than
 * anywhere else in the system: acquisition retries, runs concurrently across
 * sources, and re-reads the same pages on a schedule, so "check then insert"
 * loses the race routinely rather than rarely.
 */
export class AcquisitionRepository {
  constructor(private readonly db: Database) {}

  // ── Raw documents (Parts 27, 28) ────────────────────────────────────────

  /**
   * Stores a retrieved document, or returns the one already stored.
   *
   * Content under the inline limit is kept in the row; anything larger gets a
   * storage reference and the caller is responsible for having written the
   * bytes. The split is here rather than at the call site so that every caller
   * gets the same threshold.
   */
  async storeRawDocument(input: {
    sourceId: string;
    runId?: string | null;
    requestId: string;
    url: string;
    content: string;
    contentHash: string;
    contentType?: string;
    httpStatus?: number;
    acquisitionMethod?: string;
    parserVersion?: string;
    traceId?: string | null;
    /** Set when the caller has already written the bytes elsewhere. */
    storageReference?: string | null;
  }): Promise<RawSourceDocument> {
    const byteLength = Buffer.byteLength(input.content, 'utf8');
    const inline = byteLength <= INLINE_CONTENT_LIMIT_BYTES;

    const values = {
      sourceId: input.sourceId,
      runId: input.runId ?? null,
      requestId: input.requestId,
      url: input.url.slice(0, 2_000),
      storageReference: input.storageReference ?? (inline ? `inline:${input.contentHash}` : `pending:${input.contentHash}`),
      inlineContent: inline ? input.content : null,
      contentType: input.contentType ?? 'application/octet-stream',
      contentHash: input.contentHash,
      byteLength,
      httpStatus: input.httpStatus ?? 200,
      acquisitionMethod: input.acquisitionMethod ?? 'PERMITTED_HTML',
      parserVersion: input.parserVersion ?? '1.0.0',
      traceId: input.traceId ?? null,
    };

    const [row] = await this.db
      .insert(rawSourceDocuments)
      .values(values)
      .onConflictDoNothing({ target: [rawSourceDocuments.sourceId, rawSourceDocuments.contentHash] })
      .returning();

    if (row) return rawSourceDocumentSchema.parse(row);

    /*
     * The conflict path.
     *
     * `onConflictDoNothing` returns nothing when the row already existed, which
     * is the *expected* outcome for an unchanged page rather than an error —
     * so the existing document is read back and returned as though it had just
     * been written. Callers do not need to know which happened.
     */
    const [existing] = await this.db
      .select()
      .from(rawSourceDocuments)
      .where(
        and(
          eq(rawSourceDocuments.sourceId, input.sourceId),
          eq(rawSourceDocuments.contentHash, input.contentHash),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new Error(
        `Raw document for ${input.sourceId} conflicted on insert but could not be read back.`,
      );
    }

    return rawSourceDocumentSchema.parse(existing);
  }

  /** The most recent document for a URL, for change detection. */
  async latestDocumentFor(sourceId: string, url: string): Promise<RawSourceDocument | null> {
    const [row] = await this.db
      .select()
      .from(rawSourceDocuments)
      .where(and(eq(rawSourceDocuments.sourceId, sourceId), eq(rawSourceDocuments.url, url)))
      .orderBy(desc(rawSourceDocuments.retrievedAt))
      .limit(1);

    return row ? rawSourceDocumentSchema.parse(row) : null;
  }

  /**
   * Documents a given parser version has not yet read.
   *
   * The replay path: ship a parser fix, then re-read every document the old
   * parser saw. Without this the fix only applies to jobs discovered after it.
   */
  async documentsForReplay(
    sourceId: string,
    parserVersion: string,
    limit = 100,
  ): Promise<RawSourceDocument[]> {
    const rows = await this.db
      .select()
      .from(rawSourceDocuments)
      .where(
        and(
          eq(rawSourceDocuments.sourceId, sourceId),
          sql`${rawSourceDocuments.parserVersion} <> ${parserVersion}`,
        ),
      )
      .orderBy(desc(rawSourceDocuments.retrievedAt))
      .limit(limit);

    return rows.map((row) => rawSourceDocumentSchema.parse(row));
  }

  // ── Change events (Part 29) ─────────────────────────────────────────────

  /**
   * Records a change set, unless this exact transition is already recorded.
   *
   * Returns null when the transition was a duplicate, so a caller can tell "I
   * detected a change" from "this change was already known" — the difference
   * between notifying someone and notifying them twice.
   */
  async recordChanges(changeSet: JobChangeSet): Promise<JobChangeSet | null> {
    const [row] = await this.db
      .insert(jobChangeEvents)
      .values({
        jobId: changeSet.jobId,
        sourceId: changeSet.sourceId,
        previousContentHash: changeSet.previousContentHash,
        currentContentHash: changeSet.currentContentHash,
        changes: changeSet.changes,
        material: changeSet.material,
        detectedAt: changeSet.detectedAt,
      })
      .onConflictDoNothing({
        target: [
          jobChangeEvents.jobId,
          jobChangeEvents.previousContentHash,
          jobChangeEvents.currentContentHash,
        ],
      })
      .returning();

    return row ? jobChangeSetSchema.parse(row) : null;
  }

  /** Material changes the notification layer has not yet considered. */
  async pendingMaterialChanges(limit = 100): Promise<JobChangeSet[]> {
    const rows = await this.db
      .select()
      .from(jobChangeEvents)
      .where(and(eq(jobChangeEvents.material, true), isNull(jobChangeEvents.notifiedAt)))
      .orderBy(desc(jobChangeEvents.detectedAt))
      .limit(limit);

    return rows.map((row) => jobChangeSetSchema.parse(row));
  }

  async markChangesNotified(jobId: string, currentContentHash: string): Promise<void> {
    await this.db
      .update(jobChangeEvents)
      .set({ notifiedAt: new Date() })
      .where(
        and(
          eq(jobChangeEvents.jobId, jobId),
          eq(jobChangeEvents.currentContentHash, currentContentHash),
        ),
      );
  }

  async changesForJob(jobId: string, limit = 20): Promise<JobChangeSet[]> {
    const rows = await this.db
      .select()
      .from(jobChangeEvents)
      .where(eq(jobChangeEvents.jobId, jobId))
      .orderBy(desc(jobChangeEvents.detectedAt))
      .limit(limit);

    return rows.map((row) => jobChangeSetSchema.parse(row));
  }

  // ── Watermarks (Parts 25, 26) ───────────────────────────────────────────

  async getWatermark(sourceId: string): Promise<SourceWatermark> {
    const [row] = await this.db
      .select()
      .from(sourceWatermarks)
      .where(eq(sourceWatermarks.sourceId, sourceId))
      .limit(1);

    /*
     * A source with no watermark gets an empty one rather than null.
     *
     * "Never scanned" and "scanned but reached nothing" are the same instruction
     * to the planner — start from the beginning — and forcing every caller to
     * handle a null adds a branch that does nothing.
     */
    return sourceWatermarkSchema.parse(row ?? { sourceId });
  }

  async saveWatermark(watermark: SourceWatermark): Promise<SourceWatermark> {
    const values = {
      sourceId: watermark.sourceId,
      lastSuccessfulScanAt: watermark.lastSuccessfulScanAt,
      lastSeenPublishedAt: watermark.lastSeenPublishedAt,
      lastSeenUpdatedAt: watermark.lastSeenUpdatedAt,
      lastCursor: watermark.lastCursor,
      lastPage: watermark.lastPage,
      lastItemId: watermark.lastItemId,
      lastContentHash: watermark.lastContentHash,
      emptyScans: watermark.emptyScans,
      updatedAt: new Date(),
    };

    const [row] = await this.db
      .insert(sourceWatermarks)
      .values(values)
      .onConflictDoUpdate({ target: sourceWatermarks.sourceId, set: values })
      .returning();

    return sourceWatermarkSchema.parse(row);
  }

  // ── Reliability (Part 33) ───────────────────────────────────────────────

  /** Start of the hour a moment falls in. */
  private static windowStart(at: Date): Date {
    const start = new Date(at);
    start.setUTCMinutes(0, 0, 0);
    return start;
  }

  /**
   * Adds counters to the current hour's window.
   *
   * An upsert that *increments* rather than replaces, so concurrent scans of
   * different sources — or two workers on one source — accumulate instead of
   * overwriting each other. Read-modify-write here would lose counts silently
   * and produce a health score quietly biased toward whichever worker finished
   * last.
   */
  async recordReliability(
    sourceId: string,
    delta: Partial<Omit<SourceReliability, 'sourceId' | 'windowStart' | 'windowEnd'>>,
    at = new Date(),
  ): Promise<void> {
    const windowStart = AcquisitionRepository.windowStart(at);
    const windowEnd = new Date(windowStart.getTime() + 3_600_000);

    const counters = {
      requestsAttempted: delta.requestsAttempted ?? 0,
      requestsSucceeded: delta.requestsSucceeded ?? 0,
      requestsFailed: delta.requestsFailed ?? 0,
      itemsSeen: delta.itemsSeen ?? 0,
      itemsParsed: delta.itemsParsed ?? 0,
      itemsRejected: delta.itemsRejected ?? 0,
      jobsYielded: delta.jobsYielded ?? 0,
      duplicates: delta.duplicates ?? 0,
      stale: delta.stale ?? 0,
      falsePositives: delta.falsePositives ?? 0,
      rateLimitHits: delta.rateLimitHits ?? 0,
      timeouts: delta.timeouts ?? 0,
    };

    await this.db
      .insert(sourceReliabilityWindows)
      .values({
        sourceId,
        windowStart,
        windowEnd,
        ...counters,
        averageLatencyMs: delta.averageLatencyMs ?? 0,
      })
      .onConflictDoUpdate({
        target: [sourceReliabilityWindows.sourceId, sourceReliabilityWindows.windowStart],
        set: {
          requestsAttempted: sql`${sourceReliabilityWindows.requestsAttempted} + ${counters.requestsAttempted}`,
          requestsSucceeded: sql`${sourceReliabilityWindows.requestsSucceeded} + ${counters.requestsSucceeded}`,
          requestsFailed: sql`${sourceReliabilityWindows.requestsFailed} + ${counters.requestsFailed}`,
          itemsSeen: sql`${sourceReliabilityWindows.itemsSeen} + ${counters.itemsSeen}`,
          itemsParsed: sql`${sourceReliabilityWindows.itemsParsed} + ${counters.itemsParsed}`,
          itemsRejected: sql`${sourceReliabilityWindows.itemsRejected} + ${counters.itemsRejected}`,
          jobsYielded: sql`${sourceReliabilityWindows.jobsYielded} + ${counters.jobsYielded}`,
          duplicates: sql`${sourceReliabilityWindows.duplicates} + ${counters.duplicates}`,
          stale: sql`${sourceReliabilityWindows.stale} + ${counters.stale}`,
          falsePositives: sql`${sourceReliabilityWindows.falsePositives} + ${counters.falsePositives}`,
          rateLimitHits: sql`${sourceReliabilityWindows.rateLimitHits} + ${counters.rateLimitHits}`,
          timeouts: sql`${sourceReliabilityWindows.timeouts} + ${counters.timeouts}`,
          /*
           * Latency is averaged rather than summed. A running mean of two
           * numbers is not the true mean of all samples, but it tracks the
           * recent value closely and needs no sample count column.
           */
          averageLatencyMs: sql`(${sourceReliabilityWindows.averageLatencyMs} + ${delta.averageLatencyMs ?? 0}) / 2`,
        },
      });
  }

  /** Counters for one source over a recent period, summed across windows. */
  async reliabilityFor(sourceId: string, sinceHours = 24): Promise<SourceReliability> {
    const since = new Date(Date.now() - sinceHours * 3_600_000);

    const [row] = await this.db
      .select({
        requestsAttempted: sql<number>`coalesce(sum(${sourceReliabilityWindows.requestsAttempted}), 0)`,
        requestsSucceeded: sql<number>`coalesce(sum(${sourceReliabilityWindows.requestsSucceeded}), 0)`,
        requestsFailed: sql<number>`coalesce(sum(${sourceReliabilityWindows.requestsFailed}), 0)`,
        itemsSeen: sql<number>`coalesce(sum(${sourceReliabilityWindows.itemsSeen}), 0)`,
        itemsParsed: sql<number>`coalesce(sum(${sourceReliabilityWindows.itemsParsed}), 0)`,
        itemsRejected: sql<number>`coalesce(sum(${sourceReliabilityWindows.itemsRejected}), 0)`,
        jobsYielded: sql<number>`coalesce(sum(${sourceReliabilityWindows.jobsYielded}), 0)`,
        duplicates: sql<number>`coalesce(sum(${sourceReliabilityWindows.duplicates}), 0)`,
        stale: sql<number>`coalesce(sum(${sourceReliabilityWindows.stale}), 0)`,
        falsePositives: sql<number>`coalesce(sum(${sourceReliabilityWindows.falsePositives}), 0)`,
        rateLimitHits: sql<number>`coalesce(sum(${sourceReliabilityWindows.rateLimitHits}), 0)`,
        timeouts: sql<number>`coalesce(sum(${sourceReliabilityWindows.timeouts}), 0)`,
        averageLatencyMs: sql<number>`coalesce(avg(${sourceReliabilityWindows.averageLatencyMs}), 0)`,
      })
      .from(sourceReliabilityWindows)
      .where(
        and(
          eq(sourceReliabilityWindows.sourceId, sourceId),
          gte(sourceReliabilityWindows.windowStart, since),
        ),
      );

    return sourceReliabilitySchema.parse({
      sourceId,
      windowStart: since,
      windowEnd: new Date(),
      ...(row ?? {}),
    });
  }
}
