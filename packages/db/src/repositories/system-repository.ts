import { and, desc, eq, sql } from 'drizzle-orm';
import type { ConfigStore } from '@job-intel/config';
import type { EventSink } from '@job-intel/observability';
import type { SystemEventInput, SystemEventName } from '@job-intel/contracts';
import type { Database } from '../client';
import { appConfig, systemEvents } from '../schema/system';

/**
 * Persists runtime application configuration.
 *
 * Keys are dotted paths ("matching.minimumScore") which are expanded into a
 * nested object and deep-merged onto the code defaults. Storing leaves rather
 * than whole objects means two operators editing unrelated settings do not
 * clobber each other.
 */
export class ConfigRepository implements ConfigStore {
  constructor(private readonly db: Database) {}

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.db.select().from(appConfig);
    const nested: Record<string, unknown> = {};
    for (const row of rows) {
      assignPath(nested, row.key.split('.'), row.value);
    }
    return nested;
  }

  async set(key: string, value: unknown, updatedBy = 'system'): Promise<void> {
    await this.db
      .insert(appConfig)
      .values({ key, value, updatedBy })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value, updatedBy, updatedAt: new Date() },
      });
  }

  async listRaw() {
    return this.db.select().from(appConfig).orderBy(appConfig.key);
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(appConfig).where(eq(appConfig.key, key));
  }
}

function assignPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  const [head, ...rest] = path;
  if (!head) return;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const next = target[head];
  const container =
    typeof next === 'object' && next !== null && !Array.isArray(next)
      ? (next as Record<string, unknown>)
      : {};
  target[head] = container;
  assignPath(container, rest, value);
}

/**
 * Durable event sink.
 *
 * Deliberately best-effort at the call site (see `EventRecorder`): an
 * observability write must never fail the operation it is observing.
 */
export class EventRepository implements EventSink {
  constructor(private readonly db: Database) {}

  async record(event: SystemEventInput): Promise<void> {
    await this.db.insert(systemEvents).values({
      name: event.name,
      severity: event.severity,
      message: event.message,
      traceId: event.traceId,
      sourceId: event.sourceId,
      jobId: event.jobId,
      runId: event.runId,
      data: event.data,
    });
  }

  async list(options: { name?: SystemEventName; traceId?: string; limit?: number } = {}) {
    const conditions = [];
    if (options.name) conditions.push(eq(systemEvents.name, options.name));
    if (options.traceId) conditions.push(eq(systemEvents.traceId, options.traceId));

    return this.db
      .select()
      .from(systemEvents)
      // Every supplied filter must apply. Using only the first silently widened
      // a trace-scoped query back to the whole event stream.
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(systemEvents.createdAt))
      .limit(options.limit ?? 100);
  }

  /** Recent error/warning volume, for the health endpoint. */
  async countsBySeverity(sinceHours = 24) {
    const rows = await this.db
      .select({ severity: systemEvents.severity, count: sql<number>`count(*)::int` })
      .from(systemEvents)
      .where(sql`${systemEvents.createdAt} > now() - make_interval(hours => ${sinceHours})`)
      .groupBy(systemEvents.severity);
    return Object.fromEntries(rows.map((r) => [r.severity, r.count]));
  }
}
