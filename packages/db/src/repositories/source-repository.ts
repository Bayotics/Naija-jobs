import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  jobSourceSchema,
  type JobSource,
  type JobSourceUpdate,
  type RunErrorDetail,
  type RunTrigger,
  type SourceRunStats,
} from '@job-intel/contracts';
import { recordOutcome } from '@job-intel/core';
import type { Database } from '../client';
import { jobSourceRuns, jobSources } from '../schema/sources';

/**
 * Job sources and their run history.
 *
 * Sources are data, not code: everything the scheduler and the connector runner
 * need lives in these rows, so enabling a source, changing its cadence or
 * calming its rate limit never requires a deploy.
 */
export class SourceRepository {
  constructor(private readonly db: Database) {}

  async list(options: { includeArchived?: boolean; enabledOnly?: boolean } = {}) {
    const conditions = [];
    if (!options.includeArchived) conditions.push(isNull(jobSources.archivedAt));
    if (options.enabledOnly) conditions.push(eq(jobSources.enabled, true));

    return this.db
      .select()
      .from(jobSources)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(jobSources.priority, jobSources.id);
  }

  async get(id: string) {
    const rows = await this.db.select().from(jobSources).where(eq(jobSources.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Idempotent upsert, so seeding and config-as-code re-runs are safe.
   * Operational state (health, failure counts, cursor) is deliberately not
   * touched — re-declaring a source must not erase its history.
   */
  async upsert(input: JobSource) {
    const source = jobSourceSchema.parse(input);
    const [row] = await this.db
      .insert(jobSources)
      .values({
        id: source.id,
        connectorId: source.connectorId,
        displayName: source.displayName,
        sourceType: source.sourceType,
        accessTier: source.accessTier,
        enabled: source.enabled,
        priority: source.priority,
        scheduleCron: source.scheduleCron,
        config: source.config,
        limits: source.limits,
        credentialRefs: source.credentialRefs,
        baseUrl: source.baseUrl,
        restrictionReason: source.restrictionReason,
        notes: source.notes,
      })
      .onConflictDoUpdate({
        target: jobSources.id,
        set: {
          displayName: source.displayName,
          sourceType: source.sourceType,
          accessTier: source.accessTier,
          enabled: source.enabled,
          priority: source.priority,
          scheduleCron: source.scheduleCron,
          config: source.config,
          limits: source.limits,
          credentialRefs: source.credentialRefs,
          baseUrl: source.baseUrl,
          restrictionReason: source.restrictionReason,
          notes: source.notes,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row ?? null;
  }

  async update(id: string, patch: JobSourceUpdate) {
    const [row] = await this.db
      .update(jobSources)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(jobSources.id, id))
      .returning();
    return row ?? null;
  }

  /** Soft delete — run history and discovered jobs must outlive the source. */
  async archive(id: string) {
    const [row] = await this.db
      .update(jobSources)
      .set({ archivedAt: new Date(), enabled: false, updatedAt: new Date() })
      .where(eq(jobSources.id, id))
      .returning();
    return row ?? null;
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  async startRun(sourceId: string, trigger: RunTrigger, traceId: string | null) {
    const [run] = await this.db
      .insert(jobSourceRuns)
      .values({ sourceId, trigger, status: 'running', traceId })
      .returning();
    if (!run) throw new Error('Failed to create source run');

    await this.db
      .update(jobSources)
      .set({ lastAttemptedRunAt: new Date(), updatedAt: new Date() })
      .where(eq(jobSources.id, sourceId));

    return run;
  }

  /**
   * Closes a run and folds the outcome into the source's health.
   *
   * Failure counting lives here rather than in the caller so that every code
   * path that finishes a run maintains the circuit-breaker state consistently.
   */
  async completeRun(
    runId: string,
    outcome: {
      status: 'success' | 'partial' | 'failed' | 'skipped';
      stats: Partial<SourceRunStats>;
      errors?: RunErrorDetail[];
    },
  ) {
    const now = new Date();
    const rows = await this.db
      .select({ sourceId: jobSourceRuns.sourceId, startedAt: jobSourceRuns.startedAt })
      .from(jobSourceRuns)
      .where(eq(jobSourceRuns.id, runId))
      .limit(1);
    const existing = rows[0];
    if (!existing) throw new Error(`Source run ${runId} not found`);

    const durationMs = now.getTime() - existing.startedAt.getTime();
    const errors = outcome.errors ?? [];

    const [run] = await this.db
      .update(jobSourceRuns)
      .set({
        status: outcome.status,
        completedAt: now,
        durationMs,
        jobsDiscovered: outcome.stats.jobsDiscovered ?? 0,
        jobsAccepted: outcome.stats.jobsAccepted ?? 0,
        jobsRejected: outcome.stats.jobsRejected ?? 0,
        jobsUpdated: outcome.stats.jobsUpdated ?? 0,
        jobsDuplicated: outcome.stats.jobsDuplicated ?? 0,
        errorCount: outcome.stats.errorCount ?? errors.length,
        httpRequests: outcome.stats.httpRequests ?? 0,
        bytesFetched: outcome.stats.bytesFetched ?? 0,
        errors,
      })
      .where(eq(jobSourceRuns.id, runId))
      .returning();

    // ── Circuit breaker ────────────────────────────────────────────────────
    //
    // The transition lives here because this is the one place every completed
    // run passes through. Previously `consecutiveFailures` incremented but the
    // circuit was never opened, so the scheduler's `circuitState === 'open'`
    // check could not fire and a dead source was retried on every tick forever.
    const source = await this.get(existing.sourceId);
    if (!source) return run ?? null;

    const limits = jobSourceSchema.shape.limits.parse(source.limits ?? {});
    const decision = recordOutcome(
      {
        circuitState: source.circuitState,
        consecutiveFailures: source.consecutiveFailures,
        circuitOpenedAt: source.circuitOpenedAt ?? null,
      },
      outcome.status,
      {
        threshold: limits.circuitBreakerThreshold,
        cooldownSeconds: limits.circuitCooldownSeconds,
      },
      now,
    );

    const succeeded = outcome.status === 'success' || outcome.status === 'partial';

    await this.db
      .update(jobSources)
      .set({
        circuitState: decision.next.circuitState,
        consecutiveFailures: decision.next.consecutiveFailures,
        circuitOpenedAt: decision.next.circuitOpenedAt,
        updatedAt: now,
        ...(succeeded
          ? {
              lastSuccessfulRunAt: now,
              healthStatus: outcome.status === 'success' ? ('healthy' as const) : ('degraded' as const),
            }
          : {}),
        ...(outcome.status === 'failed'
          ? {
              healthStatus: ('failing' as const),
              lastErrorAt: now,
              lastErrorMessage: errors[0]?.message ?? 'Run failed',
            }
          : {}),
      })
      .where(eq(jobSources.id, existing.sourceId));

    return run ?? null;
  }

  async listRuns(sourceId?: string, limit = 50) {
    return this.db
      .select()
      .from(jobSourceRuns)
      .where(sourceId ? eq(jobSourceRuns.sourceId, sourceId) : undefined)
      .orderBy(desc(jobSourceRuns.startedAt))
      .limit(limit);
  }
}
