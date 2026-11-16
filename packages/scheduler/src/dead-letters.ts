import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  DEFAULT_TASK_PRIORITY,
  TASK_PRIORITY_RANK,
  type TaskPriority,
  type TaskType,
} from '@job-intel/contracts';
import type { Database } from '@job-intel/db';
import { schema } from '@job-intel/db';

/**
 * Dead-letter administration.
 *
 * The queue's job is to stop retrying; this module's job is to make what
 * stopped inspectable and, when someone has fixed the cause, replayable.
 *
 * The one rule that shapes the whole interface: **bulk retry is bounded**.
 * "Retry everything" against a dead-letter queue holding nine thousand tasks
 * that failed for the same unfixed reason produces nine thousand tasks that
 * fail again, and the second failure is worse than the first because it arrives
 * all at once. Every bulk operation takes a limit and defaults to a small one.
 */

export interface DeadLetterFilter {
  type?: TaskType;
  sourceId?: string;
  profileId?: string;
  failureClass?: string;
  /** Excludes entries already retried or cancelled. Defaults to true. */
  openOnly?: boolean;
}

export interface DeadLetterEntry {
  id: string;
  taskId: string;
  type: string;
  priority: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  profileId: string | null;
  sourceId: string | null;
  jobId: string | null;
  attempts: number;
  errors: Array<{ at: string; class: string; error: string }>;
  lastError: string | null;
  lastFailureClass: string | null;
  lastWorkerId: string | null;
  firstFailedAt: Date | null;
  deadLetteredAt: Date;
  retriedAt: Date | null;
  cancelledAt: Date | null;
}

/** Ceiling on one bulk retry, whatever the caller asks for. */
export const MAX_BULK_RETRY = 100;

export class DeadLetterQueue {
  constructor(private readonly db: Database) {}

  private conditions(filter: DeadLetterFilter) {
    const conditions = [];

    if (filter.openOnly !== false) {
      conditions.push(isNull(schema.taskDeadLetters.retriedAt));
      conditions.push(isNull(schema.taskDeadLetters.cancelledAt));
    }

    if (filter.type) conditions.push(eq(schema.taskDeadLetters.type, filter.type));
    if (filter.sourceId) conditions.push(eq(schema.taskDeadLetters.sourceId, filter.sourceId));
    if (filter.profileId) conditions.push(eq(schema.taskDeadLetters.profileId, filter.profileId));
    if (filter.failureClass) {
      conditions.push(eq(schema.taskDeadLetters.lastFailureClass, filter.failureClass));
    }

    return conditions;
  }

  async list(filter: DeadLetterFilter = {}, limit = 50): Promise<DeadLetterEntry[]> {
    const conditions = this.conditions(filter);

    const rows = await this.db
      .select()
      .from(schema.taskDeadLetters)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.taskDeadLetters.deadLetteredAt))
      .limit(Math.min(limit, 500));

    return rows.map((row) => this.toEntry(row));
  }

  async get(id: string): Promise<DeadLetterEntry | null> {
    const [row] = await this.db
      .select()
      .from(schema.taskDeadLetters)
      .where(eq(schema.taskDeadLetters.id, id))
      .limit(1);

    return row ? this.toEntry(row) : null;
  }

  /**
   * Counts, grouped so the dashboard can show a shape rather than a number.
   *
   * "Four thousand dead letters" is alarming and useless; "four thousand dead
   * letters, all `SOURCE_SCAN` for one source, all `AUTHENTICATION`" is a
   * five-minute fix.
   */
  async summary(): Promise<{
    open: number;
    byType: Record<string, number>;
    byFailureClass: Record<string, number>;
    bySource: Record<string, number>;
  }> {
    const rows = await this.db
      .select({
        type: schema.taskDeadLetters.type,
        failureClass: schema.taskDeadLetters.lastFailureClass,
        sourceId: schema.taskDeadLetters.sourceId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.taskDeadLetters)
      .where(and(isNull(schema.taskDeadLetters.retriedAt), isNull(schema.taskDeadLetters.cancelledAt)))
      .groupBy(schema.taskDeadLetters.type, schema.taskDeadLetters.lastFailureClass, schema.taskDeadLetters.sourceId);

    const byType: Record<string, number> = {};
    const byFailureClass: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let open = 0;

    for (const row of rows) {
      open += row.count;
      byType[row.type] = (byType[row.type] ?? 0) + row.count;

      const cls = row.failureClass ?? 'UNKNOWN';
      byFailureClass[cls] = (byFailureClass[cls] ?? 0) + row.count;

      if (row.sourceId) bySource[row.sourceId] = (bySource[row.sourceId] ?? 0) + row.count;
    }

    return { open, byType, byFailureClass, bySource };
  }

  /**
   * Puts one dead letter back on the queue.
   *
   * The attempt counter resets, deliberately. An administrator retrying a task
   * is asserting that the cause has been addressed, and starting from the
   * exhausted count would send it straight back after one failure — which
   * would make the retry button do nothing visible.
   */
  async retry(id: string, now = new Date()): Promise<{ ok: boolean; reason: string }> {
    const entry = await this.get(id);

    if (!entry) return { ok: false, reason: 'No such dead-letter entry.' };
    if (entry.retriedAt) return { ok: false, reason: 'Already retried.' };
    if (entry.cancelledAt) return { ok: false, reason: 'This entry was cancelled.' };

    const priority = (entry.priority as TaskPriority) ?? DEFAULT_TASK_PRIORITY[entry.type as TaskType];

    const [row] = await this.db
      .insert(schema.tasks)
      .values({
        type: entry.type,
        status: 'READY',
        priority,
        priorityRank: TASK_PRIORITY_RANK[priority] ?? 2,
        idempotencyKey: entry.idempotencyKey,
        payload: entry.payload,
        profileId: entry.profileId,
        sourceId: entry.sourceId,
        jobId: entry.jobId,
        attempts: 0,
        maxAttempts: 5,
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.tasks.id });

    /*
     * A conflict means the work is already queued again — by a scheduler tick,
     * most likely. That is success from the administrator's point of view, so
     * the entry is closed rather than reported as an error.
     */
    await this.db
      .update(schema.taskDeadLetters)
      .set({ retriedAt: now })
      .where(eq(schema.taskDeadLetters.id, id));

    return {
      ok: true,
      reason: row ? 'Requeued.' : 'Equivalent work was already queued; entry closed.',
    };
  }

  /**
   * Retries a bounded batch.
   *
   * The limit is a hard ceiling rather than a default the caller can raise.
   * Replaying a whole dead-letter queue is the single most reliable way to turn
   * a contained failure into an outage, and there is no legitimate case for
   * doing it in one action.
   */
  async retryMany(
    filter: DeadLetterFilter = {},
    limit = 20,
    now = new Date(),
  ): Promise<{ requeued: number; failed: number; remaining: number; capped: boolean }> {
    const capped = limit > MAX_BULK_RETRY;
    const effective = Math.min(limit, MAX_BULK_RETRY);

    const entries = await this.list(filter, effective);

    let requeued = 0;
    let failed = 0;

    for (const entry of entries) {
      const result = await this.retry(entry.id, now);
      if (result.ok) requeued += 1;
      else failed += 1;
    }

    const remaining = (await this.list(filter, MAX_BULK_RETRY + 1)).length;

    return { requeued, failed, remaining, capped };
  }

  async cancel(id: string, now = new Date()): Promise<boolean> {
    const updated = await this.db
      .update(schema.taskDeadLetters)
      .set({ cancelledAt: now })
      .where(and(eq(schema.taskDeadLetters.id, id), isNull(schema.taskDeadLetters.cancelledAt)))
      .returning({ id: schema.taskDeadLetters.id });

    return updated.length > 0;
  }

  /** Removes closed entries past the retention window. */
  async purge(olderThanDays = 30, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000);

    const removed = await this.db
      .delete(schema.taskDeadLetters)
      .where(sql`${schema.taskDeadLetters.deadLetteredAt} < ${cutoff}`)
      .returning({ id: schema.taskDeadLetters.id });

    return removed.length;
  }

  private toEntry(row: typeof schema.taskDeadLetters.$inferSelect): DeadLetterEntry {
    return {
      id: row.id,
      taskId: row.taskId,
      type: row.type,
      priority: row.priority,
      idempotencyKey: row.idempotencyKey,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      profileId: row.profileId,
      sourceId: row.sourceId,
      jobId: row.jobId,
      attempts: row.attempts,
      errors: (row.errors ?? []) as DeadLetterEntry['errors'],
      lastError: row.lastError,
      lastFailureClass: row.lastFailureClass,
      lastWorkerId: row.lastWorkerId,
      firstFailedAt: row.firstFailedAt,
      deadLetteredAt: row.deadLetteredAt,
      retriedAt: row.retriedAt,
      cancelledAt: row.cancelledAt,
    };
  }
}
