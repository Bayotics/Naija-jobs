import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  sourceCheckpointSchema,
  type CoverageReport,
  type DiscoveryMethod,
  type DiscoveryQuery,
  type DiscoveryTelemetry,
  type QueryPlan,
  type SourceCapabilities,
  type SourceCheckpoint,
  type SourcePerformance,
  type SourceDetectionResult,
  type UserProvidedSource,
} from '@job-intel/contracts';
import type { Database } from '../client';
import {
  coverageSnapshots,
  discoveryQueries,
  discoveryTelemetry,
  monitoredCompanies,
  sourceCapabilities,
  sourceCheckpoints,
  sourcePerformance,
  userProvidedSources,
} from '../schema/discovery-framework';
import { jobs } from '../schema/jobs';
import { jobSourceRuns } from '../schema/sources';

/**
 * Persistence for the discovery framework.
 *
 * Every write here is an upsert on a natural key. Discovery is at-least-once by
 * nature — a run can be retried, a query re-executed, a feed re-read — so
 * anything that inserts blindly eventually produces duplicate rows that quietly
 * inflate every metric computed from them.
 */
export class DiscoveryFrameworkRepository {
  constructor(private readonly db: Database) {}

  // ── Checkpoints ───────────────────────────────────────────────────────────

  async getCheckpoint(sourceId: string, resource: string): Promise<SourceCheckpoint | null> {
    const rows = await this.db
      .select()
      .from(sourceCheckpoints)
      .where(and(eq(sourceCheckpoints.sourceId, sourceId), eq(sourceCheckpoints.resource, resource)))
      .limit(1);

    const row = rows[0];
    return row ? sourceCheckpointSchema.parse(row) : null;
  }

  async saveCheckpoint(checkpoint: SourceCheckpoint): Promise<void> {
    await this.db
      .insert(sourceCheckpoints)
      .values({
        sourceId: checkpoint.sourceId,
        resource: checkpoint.resource,
        etag: checkpoint.etag,
        lastModified: checkpoint.lastModified,
        contentHash: checkpoint.contentHash,
        cursor: checkpoint.cursor,
        lastItemId: checkpoint.lastItemId,
        lastItemAt: checkpoint.lastItemAt,
        lastSuccessAt: checkpoint.lastSuccessAt,
        unchangedStreak: checkpoint.unchangedStreak,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [sourceCheckpoints.sourceId, sourceCheckpoints.resource],
        set: {
          etag: checkpoint.etag,
          lastModified: checkpoint.lastModified,
          contentHash: checkpoint.contentHash,
          cursor: checkpoint.cursor,
          lastItemId: checkpoint.lastItemId,
          lastItemAt: checkpoint.lastItemAt,
          lastSuccessAt: checkpoint.lastSuccessAt,
          unchangedStreak: checkpoint.unchangedStreak,
          updatedAt: new Date(),
        },
      });
  }

  /** Highest unchanged streak per source, for the adaptive scheduler. */
  async unchangedStreaks(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        sourceId: sourceCheckpoints.sourceId,
        streak: sql<number>`max(${sourceCheckpoints.unchangedStreak})::int`,
      })
      .from(sourceCheckpoints)
      .groupBy(sourceCheckpoints.sourceId);

    return new Map(rows.map((row) => [row.sourceId, row.streak]));
  }

  // ── Capabilities ──────────────────────────────────────────────────────────

  async saveCapabilities(input: {
    sourceId: string;
    capabilities: SourceCapabilities;
    methods: DiscoveryMethod[];
    activeMethod: DiscoveryMethod | null;
    detail?: string | null;
  }): Promise<void> {
    await this.db
      .insert(sourceCapabilities)
      .values({
        sourceId: input.sourceId,
        capabilities: input.capabilities,
        methods: input.methods,
        activeMethod: input.activeMethod,
        detail: input.detail ?? null,
        detectedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: sourceCapabilities.sourceId,
        set: {
          capabilities: input.capabilities,
          methods: input.methods,
          activeMethod: input.activeMethod,
          detail: input.detail ?? null,
          detectedAt: new Date(),
        },
      });
  }

  async listCapabilities() {
    return this.db.select().from(sourceCapabilities);
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /**
   * Persists a plan.
   *
   * Existing rows keep their observed counters — the query id is semantic, so
   * "React Berlin" planned today is the same query that ran last week and its
   * history is what makes historical prioritisation possible.
   */
  async savePlan(plan: QueryPlan): Promise<number> {
    if (plan.queries.length === 0) return 0;

    const now = new Date();
    for (const query of plan.queries) {
      await this.db
        .insert(discoveryQueries)
        .values({
          id: query.id,
          profileId: plan.profileId,
          text: query.text,
          kind: query.kind,
          priority: query.priority,
          score: query.score,
          terms: query.terms,
          rationale: query.rationale,
          preferenceVersion: plan.preferenceVersion,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: discoveryQueries.id,
          set: {
            text: query.text,
            kind: query.kind,
            priority: query.priority,
            score: query.score,
            terms: query.terms,
            rationale: query.rationale,
            preferenceVersion: plan.preferenceVersion,
            // Re-planning revives a retired query rather than duplicating it.
            retiredAt: null,
            updatedAt: now,
          },
        });
    }

    return plan.queries.length;
  }

  async listQueries(profileId: string, options: { limit?: number; activeOnly?: boolean } = {}) {
    const conditions = [eq(discoveryQueries.profileId, profileId)];
    if (options.activeOnly !== false) conditions.push(sql`${discoveryQueries.retiredAt} IS NULL`);

    return this.db
      .select()
      .from(discoveryQueries)
      .where(and(...conditions))
      .orderBy(discoveryQueries.priority, desc(discoveryQueries.score))
      .limit(options.limit ?? 200);
  }

  /** Folds one execution into a query's observed performance. */
  async recordQueryExecution(input: {
    queryId: string;
    discovered: number;
    matched: number;
    at?: Date;
  }): Promise<void> {
    await this.db
      .update(discoveryQueries)
      .set({
        executions: sql`${discoveryQueries.executions} + 1`,
        jobsDiscovered: sql`${discoveryQueries.jobsDiscovered} + ${input.discovered}`,
        jobsMatched: sql`${discoveryQueries.jobsMatched} + ${input.matched}`,
        lastExecutedAt: input.at ?? new Date(),
        lastResultCount: input.discovered,
        updatedAt: new Date(),
      })
      .where(eq(discoveryQueries.id, input.queryId));
  }

  /** Query history for `prioritiseByHistory`. */
  async queryHistory(profileId: string): Promise<Map<string, { matchedJobs: number; discoveredJobs: number }>> {
    const rows = await this.db
      .select({
        id: discoveryQueries.id,
        discovered: discoveryQueries.jobsDiscovered,
        matched: discoveryQueries.jobsMatched,
      })
      .from(discoveryQueries)
      .where(eq(discoveryQueries.profileId, profileId));

    return new Map(
      rows.map((row) => [row.id, { matchedJobs: row.matched, discoveredJobs: row.discovered }]),
    );
  }

  /** Retires queries no longer in the current plan, without deleting history. */
  async retireQueriesOutsidePlan(profileId: string, keepIds: readonly string[]): Promise<number> {
    const result = await this.db
      .update(discoveryQueries)
      .set({ retiredAt: new Date() })
      .where(
        and(
          eq(discoveryQueries.profileId, profileId),
          sql`${discoveryQueries.retiredAt} IS NULL`,
          keepIds.length > 0
            ? sql`${discoveryQueries.id} NOT IN ${keepIds}`
            : sql`true`,
        ),
      )
      .returning({ id: discoveryQueries.id });

    return result.length;
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────

  async startTelemetry(input: {
    sourceId: string | null;
    runId: string | null;
    method: DiscoveryMethod;
    queryId?: string | null;
    queryText?: string | null;
  }): Promise<string> {
    const [row] = await this.db
      .insert(discoveryTelemetry)
      .values({
        sourceId: input.sourceId,
        runId: input.runId,
        method: input.method,
        queryId: input.queryId ?? null,
        queryText: input.queryText ?? null,
        status: 'running',
      })
      .returning({ id: discoveryTelemetry.id });

    return row!.id;
  }

  async completeTelemetry(
    id: string,
    outcome: Partial<Omit<DiscoveryTelemetry, 'sourceId' | 'method' | 'startedAt'>>,
  ): Promise<void> {
    await this.db
      .update(discoveryTelemetry)
      .set({
        completedAt: new Date(),
        status: outcome.status ?? 'success',
        requests: outcome.requests ?? 0,
        results: outcome.results ?? 0,
        uniqueResults: outcome.uniqueResults ?? 0,
        duplicates: outcome.duplicates ?? 0,
        errors: outcome.errors ?? 0,
        rateLimitEvents: outcome.rateLimitEvents ?? 0,
        notModified: outcome.notModified ?? 0,
        costUsd: String(outcome.costUsd ?? 0),
        detail: outcome.detail ?? '',
      })
      .where(eq(discoveryTelemetry.id, id));
  }

  async listTelemetry(options: { sourceId?: string; windowHours?: number; limit?: number } = {}) {
    const conditions = [
      gte(discoveryTelemetry.startedAt, hoursAgo(options.windowHours ?? 24)),
    ];
    if (options.sourceId) conditions.push(eq(discoveryTelemetry.sourceId, options.sourceId));

    return this.db
      .select()
      .from(discoveryTelemetry)
      .where(and(...conditions))
      .orderBy(desc(discoveryTelemetry.startedAt))
      .limit(options.limit ?? 200);
  }

  /** Per-method totals, for the dashboard's discovery panel. */
  async telemetryByMethod(windowHours = 24) {
    return this.db
      .select({
        method: discoveryTelemetry.method,
        operations: sql<number>`count(*)::int`,
        results: sql<number>`coalesce(sum(${discoveryTelemetry.results}), 0)::int`,
        uniqueResults: sql<number>`coalesce(sum(${discoveryTelemetry.uniqueResults}), 0)::int`,
        duplicates: sql<number>`coalesce(sum(${discoveryTelemetry.duplicates}), 0)::int`,
        errors: sql<number>`coalesce(sum(${discoveryTelemetry.errors}), 0)::int`,
        notModified: sql<number>`coalesce(sum(${discoveryTelemetry.notModified}), 0)::int`,
        requests: sql<number>`coalesce(sum(${discoveryTelemetry.requests}), 0)::int`,
        costUsd: sql<number>`coalesce(sum(${discoveryTelemetry.costUsd}), 0)::float8`,
      })
      .from(discoveryTelemetry)
      .where(gte(discoveryTelemetry.startedAt, hoursAgo(windowHours)))
      .groupBy(discoveryTelemetry.method)
      .orderBy(desc(sql`count(*)`));
  }

  // ── Coverage ──────────────────────────────────────────────────────────────

  async saveCoverage(report: CoverageReport): Promise<void> {
    await this.db.insert(coverageSnapshots).values({
      profileId: report.profileId,
      windowHours: report.windowHours,
      sourcesSearched: report.sourcesSearched,
      sourcesAvailable: report.sourcesAvailable,
      queriesExecuted: report.queriesExecuted,
      uniqueJobsDiscovered: report.uniqueJobsDiscovered,
      searchedShare: report.searchedShare,
      productiveShare: report.productiveShare,
      items: report.items,
      gaps: report.gaps,
      generatedAt: report.generatedAt,
    });
  }

  async latestCoverage(profileId: string) {
    const rows = await this.db
      .select()
      .from(coverageSnapshots)
      .where(eq(coverageSnapshots.profileId, profileId))
      .orderBy(desc(coverageSnapshots.generatedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Source performance ────────────────────────────────────────────────────

  async savePerformance(performance: SourcePerformance): Promise<void> {
    await this.db
      .insert(sourcePerformance)
      .values({
        sourceId: performance.sourceId,
        windowDays: performance.windowDays,
        runs: performance.runs,
        averageJobsPerRun: performance.averageJobsPerRun,
        duplicateRate: performance.duplicateRate,
        validJobRate: performance.validJobRate,
        enrichmentSuccessRate: performance.enrichmentSuccessRate,
        matchRate: performance.matchRate,
        staleRate: performance.staleRate,
        errorRate: performance.errorRate,
        averageLatencyMs: performance.averageLatencyMs,
        valueScore: performance.valueScore,
        explanation: performance.explanation,
        computedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: sourcePerformance.sourceId,
        set: {
          windowDays: performance.windowDays,
          runs: performance.runs,
          averageJobsPerRun: performance.averageJobsPerRun,
          duplicateRate: performance.duplicateRate,
          validJobRate: performance.validJobRate,
          enrichmentSuccessRate: performance.enrichmentSuccessRate,
          matchRate: performance.matchRate,
          staleRate: performance.staleRate,
          errorRate: performance.errorRate,
          averageLatencyMs: performance.averageLatencyMs,
          valueScore: performance.valueScore,
          explanation: performance.explanation,
          computedAt: new Date(),
        },
      });
  }

  async listPerformance() {
    return this.db.select().from(sourcePerformance).orderBy(desc(sourcePerformance.valueScore));
  }

  /**
   * Raw inputs for `scoreSourceValue`, per source.
   *
   * One aggregate query rather than a query per source: the scheduler runs this
   * for every source on every tick, and N+1 here is the difference between a
   * scheduler that scales and one that does not.
   */
  async performanceInputs(windowDays = 30) {
    const since = hoursAgo(windowDays * 24);

    const runStats = await this.db
      .select({
        sourceId: jobSourceRuns.sourceId,
        runs: sql<number>`count(*)::int`,
        failedRuns: sql<number>`count(*) FILTER (WHERE ${jobSourceRuns.status} = 'failed')::int`,
        discovered: sql<number>`coalesce(sum(${jobSourceRuns.jobsDiscovered}), 0)::int`,
        duplicates: sql<number>`coalesce(sum(${jobSourceRuns.jobsDuplicated}), 0)::int`,
        accepted: sql<number>`coalesce(sum(${jobSourceRuns.jobsAccepted}), 0)::int`,
        totalLatencyMs: sql<number>`coalesce(sum(${jobSourceRuns.durationMs}), 0)::int`,
      })
      .from(jobSourceRuns)
      .where(gte(jobSourceRuns.startedAt, since))
      .groupBy(jobSourceRuns.sourceId);

    const jobStats = await this.db
      .select({
        sourceId: jobs.sourceId,
        total: sql<number>`count(*)::int`,
        stale: sql<number>`count(*) FILTER (WHERE ${jobs.status} <> 'active')::int`,
      })
      .from(jobs)
      .where(gte(jobs.firstSeenAt, since))
      .groupBy(jobs.sourceId);

    const staleBySource = new Map(jobStats.map((row) => [row.sourceId, row]));

    return runStats.map((row) => ({
      sourceId: row.sourceId,
      windowDays,
      runs: row.runs,
      failedRuns: row.failedRuns,
      jobsDiscovered: row.discovered,
      duplicates: row.duplicates,
      validJobs: row.accepted,
      enrichmentSucceeded: row.accepted,
      matchedJobs: 0,
      staleJobs: staleBySource.get(row.sourceId)?.stale ?? 0,
      totalLatencyMs: row.totalLatencyMs,
    }));
  }

  // ── Monitored companies ───────────────────────────────────────────────────

  async upsertCompany(input: {
    id: string;
    name: string;
    domain?: string | null;
    careersUrl?: string | null;
    atsProvider?: string | null;
    atsIdentifier?: string | null;
    status?: string;
    sourceId?: string | null;
    detail?: string;
  }): Promise<void> {
    const now = new Date();
    await this.db
      .insert(monitoredCompanies)
      .values({
        id: input.id,
        name: input.name,
        domain: input.domain ?? null,
        careersUrl: input.careersUrl ?? null,
        atsProvider: input.atsProvider ?? null,
        atsIdentifier: input.atsIdentifier ?? null,
        status: input.status ?? 'pending',
        sourceId: input.sourceId ?? null,
        detail: input.detail ?? '',
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: monitoredCompanies.id,
        set: {
          name: input.name,
          domain: input.domain ?? null,
          careersUrl: input.careersUrl ?? null,
          atsProvider: input.atsProvider ?? null,
          atsIdentifier: input.atsIdentifier ?? null,
          ...(input.status ? { status: input.status } : {}),
          ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
          lastCheckedAt: now,
          updatedAt: now,
        },
      });
  }

  async listCompanies(status?: string) {
    return this.db
      .select()
      .from(monitoredCompanies)
      .where(status ? eq(monitoredCompanies.status, status) : undefined)
      .orderBy(monitoredCompanies.name);
  }

  // ── User-provided sources ─────────────────────────────────────────────────

  async submitUserSource(input: UserProvidedSource): Promise<string> {
    const [row] = await this.db
      .insert(userProvidedSources)
      .values({
        url: input.url,
        displayName: input.displayName,
        requestedSourceType: input.sourceType,
        scanFrequencyMinutes: input.scanFrequencyMinutes,
        searchTerms: [...input.searchTerms],
        location: input.location,
        enabled: input.enabled,
        notes: input.notes,
        status: 'pending_validation',
      })
      .onConflictDoUpdate({
        target: userProvidedSources.url,
        set: {
          displayName: input.displayName,
          scanFrequencyMinutes: input.scanFrequencyMinutes,
          searchTerms: [...input.searchTerms],
          location: input.location,
          enabled: input.enabled,
          notes: input.notes,
          // Re-submitting an existing URL re-validates it rather than
          // silently reactivating a previously rejected source.
          status: 'pending_validation',
          rejectionReason: null,
          submittedAt: new Date(),
        },
      })
      .returning({ id: userProvidedSources.id });

    return row!.id;
  }

  async recordDetection(
    id: string,
    detection: SourceDetectionResult,
  ): Promise<void> {
    const usable = detection.reachable && detection.robotsAllowed && detection.recommendedConnectorId;
    await this.db
      .update(userProvidedSources)
      .set({
        detection: detection as unknown as Record<string, unknown>,
        status: usable ? 'validated' : 'rejected',
        rejectionReason: usable ? null : (detection.rejectionReason ?? 'No usable connector found'),
        validatedAt: new Date(),
      })
      .where(eq(userProvidedSources.id, id));
  }

  async markActivated(id: string, sourceId: string): Promise<void> {
    await this.db
      .update(userProvidedSources)
      .set({ status: 'active', sourceId, activatedAt: new Date() })
      .where(eq(userProvidedSources.id, id));
  }

  async listUserSources(statuses?: string[]) {
    return this.db
      .select()
      .from(userProvidedSources)
      .where(statuses?.length ? inArray(userProvidedSources.status, statuses) : undefined)
      .orderBy(desc(userProvidedSources.submittedAt));
  }

  async getUserSource(id: string) {
    const rows = await this.db
      .select()
      .from(userProvidedSources)
      .where(eq(userProvidedSources.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
}

const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);

/** Convenience type for a persisted query row. */
export type DiscoveryQueryRow = DiscoveryQuery & {
  executions: number;
  jobsDiscovered: number;
  jobsMatched: number;
};
