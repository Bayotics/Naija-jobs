import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import {
  type AiOperation,
  type AiUsageRecord,
  type AuditAction,
  type JobExplorerQuery,
  type PipelineRunStatus,
  type PipelineRunTrigger,
  type PipelineStageStatus,
  type RunTimelineEntry,
} from '@job-intel/contracts';
import type { DataQualityCounts, FunnelCounts } from '@job-intel/ops';
import type { Database } from '../client';
import { aiUsage, auditLog, metricSamples, pipelineRuns, rateLimitEvents } from '../schema/ops';
import { jobs } from '../schema/jobs';
import { jobEnrichments } from '../schema/enrichment';
import { jobMatches } from '../schema/matching';
import { jobDuplicates, jobRecommendations, jobSignals } from '../schema/recommendation';
import { jobSourceRuns, jobSources } from '../schema/sources';
import { notificationChannelDeliveries, notificationDecisions, notificationEvents } from '../schema/notification-engine';
import { systemEvents } from '../schema/system';

/**
 * Operations aggregation.
 *
 * Every dashboard number originates here, and every one of them is a `COUNT` or
 * `avg` over an indexed, time-windowed query. Nothing pulls a table into memory
 * to count it — the brief rules out full scans on page load, and an ops console
 * that degrades as the corpus grows is the one you cannot use during an
 * incident.
 *
 * Where a number does not exist yet, these return zero. That is the "no fake
 * data" rule expressed in SQL: an empty system reports empty.
 */

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
const startOfToday = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

export class OpsRepository {
  constructor(private readonly db: Database) {}

  // ── Pipeline runs ─────────────────────────────────────────────────────────

  async startRun(input: {
    trigger: PipelineRunTrigger;
    dryRun?: boolean;
    triggeredBy?: string | null;
    note?: string | null;
    traceId?: string | null;
  }): Promise<string> {
    const [row] = await this.db
      .insert(pipelineRuns)
      .values({
        trigger: input.trigger,
        dryRun: input.dryRun ?? false,
        triggeredBy: input.triggeredBy ?? null,
        note: input.note ?? null,
        traceId: input.traceId ?? null,
        status: 'running',
      })
      .returning({ id: pipelineRuns.id });
    return row!.id;
  }

  /** Appends to the timeline without rewriting it, so concurrent stages are safe. */
  async appendTimeline(runId: string, entries: readonly RunTimelineEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db
      .update(pipelineRuns)
      .set({ timeline: sql`${pipelineRuns.timeline} || ${JSON.stringify(entries)}::jsonb` })
      .where(eq(pipelineRuns.id, runId));
  }

  async completeRun(
    runId: string,
    input: {
      status: PipelineRunStatus;
      counters?: Partial<{
        jobsDiscovered: number;
        jobsProcessed: number;
        jobsMatched: number;
        jobsRecommended: number;
        notificationsGenerated: number;
        duplicatesDetected: number;
        errorCount: number;
        warningCount: number;
      }>;
      stages?: PipelineStageStatus[];
    },
  ): Promise<void> {
    const completedAt = new Date();
    const rows = await this.db
      .select({ startedAt: pipelineRuns.startedAt })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId))
      .limit(1);

    const startedAt = rows[0]?.startedAt ?? completedAt;

    await this.db
      .update(pipelineRuns)
      .set({
        status: input.status,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        ...(input.counters ?? {}),
        ...(input.stages ? { stages: input.stages } : {}),
      })
      .where(eq(pipelineRuns.id, runId));
  }

  async listRuns(options: { limit?: number; offset?: number; status?: PipelineRunStatus } = {}) {
    const conditions = options.status ? [eq(pipelineRuns.status, options.status)] : [];
    return this.db
      .select()
      .from(pipelineRuns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(options.limit ?? 25)
      .offset(options.offset ?? 0);
  }

  async getRun(runId: string) {
    const rows = await this.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1);
    return rows[0] ?? null;
  }

  /** Source-level activity inside a run's window, for the run-detail page. */
  async runSourceActivity(runId: string) {
    const run = await this.getRun(runId);
    if (!run) return [];

    const until = run.completedAt ?? new Date();
    return this.db
      .select({
        sourceId: jobSourceRuns.sourceId,
        status: jobSourceRuns.status,
        startedAt: jobSourceRuns.startedAt,
        durationMs: jobSourceRuns.durationMs,
        jobsDiscovered: jobSourceRuns.jobsDiscovered,
        jobsAccepted: jobSourceRuns.jobsAccepted,
        jobsRejected: jobSourceRuns.jobsRejected,
        jobsDuplicated: jobSourceRuns.jobsDuplicated,
        errorCount: jobSourceRuns.errorCount,
        errors: jobSourceRuns.errors,
      })
      .from(jobSourceRuns)
      .where(and(gte(jobSourceRuns.startedAt, run.startedAt), lt(jobSourceRuns.startedAt, until)))
      .orderBy(jobSourceRuns.startedAt);
  }

  async currentRun() {
    const rows = await this.db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.status, 'running'))
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Dashboard counters ────────────────────────────────────────────────────

  /**
   * The overview numbers, in one round trip.
   *
   * A single query with `FILTER` clauses rather than eight separate counts:
   * the dashboard polls, and eight scans per poll is how an ops console starts
   * costing more than the pipeline it watches.
   */
  async pipelineCounters(profileId: string | null) {
    const today = startOfToday();
    const hourAgo = hoursAgo(1);

    const [discovery] = await this.db
      .select({
        today: sql<number>`count(*) FILTER (WHERE ${jobs.firstSeenAt} >= ${today})::int`,
        thisHour: sql<number>`count(*) FILTER (WHERE ${jobs.firstSeenAt} >= ${hourAgo})::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(jobs);

    const [enrichment] = await this.db
      .select({
        enriched: sql<number>`count(*) FILTER (WHERE ${jobEnrichments.status} = 'enriched')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${jobEnrichments.status} = 'failed')::int`,
      })
      .from(jobEnrichments);

    const [duplicates] = await this.db
      .select({ merged: sql<number>`count(*) FILTER (WHERE ${jobDuplicates.merged})::int` })
      .from(jobDuplicates);

    const [stale] = await this.db
      .select({
        stale: sql<number>`count(*) FILTER (WHERE ${jobSignals.lifecycleStatus} <> 'ACTIVE')::int`,
      })
      .from(jobSignals);

    const matched = profileId
      ? (
          await this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(jobMatches)
            .where(eq(jobMatches.profileId, profileId))
        )[0]?.count ?? 0
      : 0;

    const recommended = profileId
      ? (
          await this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(jobRecommendations)
            .where(
              and(
                eq(jobRecommendations.profileId, profileId),
                eq(jobRecommendations.notificationEligible, true),
              ),
            )
        )[0]?.count ?? 0
      : 0;

    const notified = profileId
      ? (
          await this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(notificationEvents)
            .where(
              and(
                eq(notificationEvents.profileId, profileId),
                gte(notificationEvents.createdAt, today),
              ),
            )
        )[0]?.count ?? 0
      : 0;

    return {
      discoveredToday: discovery?.today ?? 0,
      discoveredThisHour: discovery?.thisHour ?? 0,
      totalJobs: discovery?.total ?? 0,
      enriched: enrichment?.enriched ?? 0,
      enrichmentFailed: enrichment?.failed ?? 0,
      duplicates: duplicates?.merged ?? 0,
      stale: stale?.stale ?? 0,
      matched,
      recommended,
      notified,
    };
  }

  async recommendationStats(profileId: string) {
    const [row] = await this.db
      .select({
        exceptional: sql<number>`count(*) FILTER (WHERE ${jobRecommendations.tier} = 'EXCEPTIONAL')::int`,
        strong: sql<number>`count(*) FILTER (WHERE ${jobRecommendations.tier} IN ('HIGHLY_RECOMMENDED','STRONG'))::int`,
        avgScore: sql<number>`coalesce(avg(${jobRecommendations.matchScore}), 0)::float8`,
        avgConfidence: sql<number>`coalesce(avg(${jobRecommendations.matchConfidence}), 0)::float8`,
      })
      .from(jobRecommendations)
      .where(eq(jobRecommendations.profileId, profileId));

    return {
      exceptional: row?.exceptional ?? 0,
      strong: row?.strong ?? 0,
      averageScore: Math.round((row?.avgScore ?? 0) * 100) / 100,
      averageConfidence: Math.round((row?.avgConfidence ?? 0) * 1000) / 1000,
    };
  }

  async notificationStats(profileId: string) {
    const today = startOfToday();

    const [events] = await this.db
      .select({
        alerts: sql<number>`count(*) FILTER (WHERE ${notificationEvents.type} = 'JOB_ALERT')::int`,
        digests: sql<number>`count(*) FILTER (WHERE ${notificationEvents.type} = 'JOB_DIGEST')::int`,
      })
      .from(notificationEvents)
      .where(
        and(eq(notificationEvents.profileId, profileId), gte(notificationEvents.createdAt, today)),
      );

    const [failures] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationChannelDeliveries)
      .innerJoin(
        notificationEvents,
        eq(notificationEvents.id, notificationChannelDeliveries.eventId),
      )
      .where(
        and(
          eq(notificationEvents.profileId, profileId),
          inArray(notificationChannelDeliveries.status, ['failed', 'bounced']),
        ),
      );

    const [suppressed] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationDecisions)
      .where(
        and(
          eq(notificationDecisions.profileId, profileId),
          gte(notificationDecisions.decidedAt, today),
          sql`${notificationDecisions.outcome}::text LIKE 'SUPPRESSED%'`,
        ),
      );

    return {
      alertsToday: events?.alerts ?? 0,
      digestsToday: events?.digests ?? 0,
      failures: failures?.count ?? 0,
      suppressed: suppressed?.count ?? 0,
    };
  }

  // ── Funnel ────────────────────────────────────────────────────────────────

  async funnelCounts(profileId: string | null, windowHours: number): Promise<FunnelCounts> {
    const since = hoursAgo(windowHours);

    const [discovery] = await this.db
      .select({
        discovered: sql<number>`count(*)::int`,
        unique: sql<number>`count(*) FILTER (WHERE ${jobs.jobGroupId} IS NULL)::int`,
      })
      .from(jobs)
      .where(gte(jobs.firstSeenAt, since));

    const [enrichment] = await this.db
      .select({ enriched: sql<number>`count(*)::int` })
      .from(jobEnrichments)
      .innerJoin(jobs, eq(jobs.id, jobEnrichments.jobId))
      .where(and(gte(jobs.firstSeenAt, since), eq(jobEnrichments.status, 'enriched')));

    const [quality] = await this.db
      .select({ passed: sql<number>`count(*)::int` })
      .from(jobSignals)
      .innerJoin(jobs, eq(jobs.id, jobSignals.jobId))
      .where(
        and(
          gte(jobs.firstSeenAt, since),
          eq(jobSignals.lifecycleStatus, 'ACTIVE'),
          lt(jobSignals.scamRisk, 0.4),
        ),
      );

    if (!profileId) {
      return {
        discovered: discovery?.discovered ?? 0,
        unique: discovery?.unique ?? 0,
        enriched: enrichment?.enriched ?? 0,
        qualityPassed: quality?.passed ?? 0,
        eligible: 0,
        matched: 0,
        recommended: 0,
        notified: 0,
      };
    }

    const [matching] = await this.db
      .select({
        matched: sql<number>`count(*)::int`,
        eligible: sql<number>`count(*) FILTER (WHERE ${jobMatches.eligible})::int`,
      })
      .from(jobMatches)
      .where(eq(jobMatches.profileId, profileId));

    const [recommendation] = await this.db
      .select({
        recommended: sql<number>`count(*) FILTER (WHERE ${jobRecommendations.notificationEligible})::int`,
      })
      .from(jobRecommendations)
      .where(eq(jobRecommendations.profileId, profileId));

    const [notified] = await this.db
      .select({
        // Distinct canonical jobs, not events: a digest carrying ten jobs is
        // ten notified jobs, and one job in two digests is still one.
        count: sql<number>`count(DISTINCT unnested)::int`,
      })
      .from(
        sql`(SELECT unnest(${notificationEvents.canonicalJobIds}) AS unnested
             FROM ${notificationEvents}
             WHERE ${notificationEvents.profileId} = ${profileId}
               AND ${notificationEvents.createdAt} >= ${since}) AS notified_jobs_expanded`,
      );

    return {
      discovered: discovery?.discovered ?? 0,
      unique: discovery?.unique ?? 0,
      enriched: enrichment?.enriched ?? 0,
      qualityPassed: quality?.passed ?? 0,
      eligible: matching?.eligible ?? 0,
      matched: matching?.matched ?? 0,
      recommended: recommendation?.recommended ?? 0,
      notified: notified?.count ?? 0,
    };
  }

  // ── Data quality ──────────────────────────────────────────────────────────

  async dataQualityCounts(): Promise<DataQualityCounts> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        missingSalary: sql<number>`count(*) FILTER (WHERE ${jobs.salaryNormalizedAnnualUsd} IS NULL)::int`,
        missingLocation: sql<number>`count(*) FILTER (WHERE ${jobs.countryCode} IS NULL AND ${jobs.city} IS NULL)::int`,
        uncertainRemote: sql<number>`count(*) FILTER (WHERE ${jobs.remoteType} = 'unknown')::int`,
        missingApplicationUrl: sql<number>`count(*) FILTER (WHERE ${jobs.applyUrl} IS NULL AND ${jobs.canonicalUrl} IS NULL)::int`,
        noCompanyResolved: sql<number>`count(*) FILTER (WHERE ${jobs.companyId} IS NULL)::int`,
        shortDescription: sql<number>`count(*) FILTER (WHERE coalesce(length(${jobs.description}), 0) < 250)::int`,
      })
      .from(jobs);

    const [enrichmentRow] = await this.db
      .select({
        failedEnrichment: sql<number>`count(*) FILTER (WHERE ${jobEnrichments.status} = 'failed')::int`,
        uncertainVisa: sql<number>`count(*) FILTER (WHERE ${jobEnrichments.visaSponsorship} IN ('not_mentioned','unclear'))::int`,
        lowConfidence: sql<number>`count(*) FILTER (WHERE coalesce(${jobEnrichments.titleConfidence}, 0) < 0.5)::int`,
      })
      .from(jobEnrichments);

    return {
      total: row?.total ?? 0,
      missingSalary: row?.missingSalary ?? 0,
      missingLocation: row?.missingLocation ?? 0,
      uncertainRemote: row?.uncertainRemote ?? 0,
      uncertainVisa: enrichmentRow?.uncertainVisa ?? 0,
      shortDescription: row?.shortDescription ?? 0,
      failedEnrichment: enrichmentRow?.failedEnrichment ?? 0,
      lowExtractionConfidence: enrichmentRow?.lowConfidence ?? 0,
      missingApplicationUrl: row?.missingApplicationUrl ?? 0,
      noCompanyResolved: row?.noCompanyResolved ?? 0,
    };
  }

  // ── Source health inputs ──────────────────────────────────────────────────

  /** Recent runs per source, for the health score. One query, not one per source. */
  async recentSourceRuns(limitPerSource = 10) {
    const rows = await this.db
      .select({
        sourceId: jobSourceRuns.sourceId,
        status: jobSourceRuns.status,
        startedAt: jobSourceRuns.startedAt,
        durationMs: jobSourceRuns.durationMs,
        jobsDiscovered: jobSourceRuns.jobsDiscovered,
        jobsAccepted: jobSourceRuns.jobsAccepted,
        errorCount: jobSourceRuns.errorCount,
        httpRequests: jobSourceRuns.httpRequests,
      })
      .from(jobSourceRuns)
      .where(gte(jobSourceRuns.startedAt, hoursAgo(24 * 14)))
      .orderBy(desc(jobSourceRuns.startedAt))
      .limit(limitPerSource * 40);

    const bySource = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = bySource.get(row.sourceId) ?? [];
      if (list.length < limitPerSource) list.push(row);
      bySource.set(row.sourceId, list);
    }
    return bySource;
  }

  /** Median discovery volume per source, the baseline for the zero-result rule. */
  async sourceVolumeBaseline(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        sourceId: jobSourceRuns.sourceId,
        median: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${jobSourceRuns.jobsDiscovered})::float8`,
      })
      .from(jobSourceRuns)
      .where(
        and(
          gte(jobSourceRuns.startedAt, hoursAgo(24 * 30)),
          inArray(jobSourceRuns.status, ['success', 'partial']),
        ),
      )
      .groupBy(jobSourceRuns.sourceId);

    return new Map(rows.map((row) => [row.sourceId, Math.round(row.median ?? 0)]));
  }

  async rateLimitSummaries(windowHours = 24) {
    const rows = await this.db
      .select({
        sourceId: rateLimitEvents.sourceId,
        domain: rateLimitEvents.domain,
        requests: sql<number>`sum(${rateLimitEvents.requests})::int`,
        succeeded: sql<number>`sum(${rateLimitEvents.succeeded})::int`,
        failed: sql<number>`sum(${rateLimitEvents.failed})::int`,
        rateLimited: sql<number>`sum(${rateLimitEvents.rateLimited})::int`,
        backoffUntil: sql<Date | null>`max(${rateLimitEvents.backoffUntil})`,
        remainingQuota: sql<number | null>`min(${rateLimitEvents.remainingQuota})`,
      })
      .from(rateLimitEvents)
      .where(gte(rateLimitEvents.windowStart, hoursAgo(windowHours)))
      .groupBy(rateLimitEvents.sourceId, rateLimitEvents.domain);
    return rows;
  }

  /** Rolls one hour's HTTP outcomes into the per-source bucket. */
  async recordHttpOutcomes(input: {
    sourceId: string;
    domain?: string | null;
    requests: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
    backoffUntil?: Date | null;
    remainingQuota?: number | null;
    at?: Date;
  }): Promise<void> {
    const at = input.at ?? new Date();
    const windowStart = new Date(
      Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()),
    );

    const existing = await this.db
      .select({ id: rateLimitEvents.id })
      .from(rateLimitEvents)
      .where(
        and(
          eq(rateLimitEvents.sourceId, input.sourceId),
          eq(rateLimitEvents.windowStart, windowStart),
          input.domain ? eq(rateLimitEvents.domain, input.domain) : isNull(rateLimitEvents.domain),
        ),
      )
      .limit(1);

    if (existing[0]) {
      await this.db
        .update(rateLimitEvents)
        .set({
          requests: sql`${rateLimitEvents.requests} + ${input.requests}`,
          succeeded: sql`${rateLimitEvents.succeeded} + ${input.succeeded}`,
          failed: sql`${rateLimitEvents.failed} + ${input.failed}`,
          rateLimited: sql`${rateLimitEvents.rateLimited} + ${input.rateLimited}`,
          backoffUntil: input.backoffUntil ?? null,
          remainingQuota: input.remainingQuota ?? null,
        })
        .where(eq(rateLimitEvents.id, existing[0].id));
      return;
    }

    await this.db.insert(rateLimitEvents).values({
      sourceId: input.sourceId,
      domain: input.domain ?? null,
      windowStart,
      requests: input.requests,
      succeeded: input.succeeded,
      failed: input.failed,
      rateLimited: input.rateLimited,
      backoffUntil: input.backoffUntil ?? null,
      remainingQuota: input.remainingQuota ?? null,
    });
  }

  // ── AI usage ──────────────────────────────────────────────────────────────

  async recordAiUsage(
    record: Omit<AiUsageRecord, 'occurredAt'> & { occurredAt?: Date; priced?: boolean; errorMessage?: string | null },
  ): Promise<void> {
    await this.db.insert(aiUsage).values({
      operation: record.operation,
      provider: record.provider,
      model: record.model,
      calls: record.calls,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      costUsd: record.costUsd.toString(),
      priced: record.priced ?? true,
      latencyMs: record.latencyMs === null ? null : Math.round(record.latencyMs ?? 0),
      succeeded: record.succeeded,
      errorMessage: record.errorMessage ?? null,
      jobId: record.jobId,
      runId: record.runId,
      sourceId: record.sourceId,
      occurredAt: record.occurredAt ?? new Date(),
    });
  }

  async aiUsageRecords(windowHours: number): Promise<AiUsageRecord[]> {
    const rows = await this.db
      .select()
      .from(aiUsage)
      .where(gte(aiUsage.occurredAt, hoursAgo(windowHours)))
      .orderBy(desc(aiUsage.occurredAt))
      .limit(5000);

    return rows.map((row) => ({
      operation: row.operation as AiOperation,
      provider: row.provider,
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      calls: row.calls,
      costUsd: Number(row.costUsd),
      latencyMs: row.latencyMs,
      succeeded: row.succeeded,
      jobId: row.jobId,
      runId: row.runId,
      sourceId: row.sourceId,
      occurredAt: row.occurredAt,
    }));
  }

  async unpricedModels(windowHours = 24 * 30): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ model: aiUsage.model })
      .from(aiUsage)
      .where(and(gte(aiUsage.occurredAt, hoursAgo(windowHours)), eq(aiUsage.priced, false)));
    return rows.map((r) => r.model);
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  async recordSample(input: {
    operation: string;
    valueMs: number;
    succeeded?: boolean;
    sourceId?: string | null;
    runId?: string | null;
  }): Promise<void> {
    await this.db.insert(metricSamples).values({
      operation: input.operation,
      valueMs: input.valueMs,
      succeeded: input.succeeded ?? true,
      sourceId: input.sourceId ?? null,
      runId: input.runId ?? null,
    });
  }

  /** Raw samples per operation, so p95/p99 are computable rather than guessed. */
  async latencySamples(windowHours = 24, operations?: string[]): Promise<Map<string, number[]>> {
    const conditions = [gte(metricSamples.occurredAt, hoursAgo(windowHours))];
    if (operations?.length) conditions.push(inArray(metricSamples.operation, operations));

    const rows = await this.db
      .select({ operation: metricSamples.operation, valueMs: metricSamples.valueMs })
      .from(metricSamples)
      .where(and(...conditions))
      .limit(50_000);

    const byOperation = new Map<string, number[]>();
    for (const row of rows) {
      const list = byOperation.get(row.operation) ?? [];
      list.push(row.valueMs);
      byOperation.set(row.operation, list);
    }
    return byOperation;
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  async recordAudit(input: {
    action: AuditAction;
    actor: string;
    target?: string | null;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    requestId?: string | null;
    userAgent?: string | null;
  }): Promise<string> {
    const [row] = await this.db
      .insert(auditLog)
      .values({
        action: input.action,
        actor: input.actor,
        target: input.target ?? null,
        before: (input.before ?? null) as never,
        after: (input.after ?? null) as never,
        reason: input.reason ?? null,
        requestId: input.requestId ?? null,
        userAgent: input.userAgent?.slice(0, 200) ?? null,
      })
      .returning({ id: auditLog.id });
    return row!.id;
  }

  async listAudit(options: { limit?: number; offset?: number; action?: AuditAction } = {}) {
    const conditions = options.action ? [eq(auditLog.action, options.action)] : [];
    return this.db
      .select()
      .from(auditLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.occurredAt))
      .limit(options.limit ?? 50)
      .offset(options.offset ?? 0);
  }

  // ── Structured logs ───────────────────────────────────────────────────────

  /**
   * The log viewer, backed by `system_events`.
   *
   * Structured filtering rather than a text search over a file: the brief rules
   * out a raw-text viewer, and "every event for this job" needs an index, not a
   * grep.
   */
  async queryEvents(options: {
    severity?: string[];
    name?: string[];
    sourceId?: string;
    jobId?: string;
    runId?: string;
    traceId?: string;
    sinceHours?: number;
    limit?: number;
    offset?: number;
  } = {}) {
    const conditions = [gte(systemEvents.createdAt, hoursAgo(options.sinceHours ?? 24))];
    if (options.severity?.length) {
      conditions.push(inArray(systemEvents.severity, options.severity as never));
    }
    if (options.name?.length) conditions.push(inArray(systemEvents.name, options.name as never));
    if (options.sourceId) conditions.push(eq(systemEvents.sourceId, options.sourceId));
    if (options.jobId) conditions.push(eq(systemEvents.jobId, options.jobId));
    if (options.runId) conditions.push(eq(systemEvents.runId, options.runId));
    if (options.traceId) conditions.push(eq(systemEvents.traceId, options.traceId));

    return this.db
      .select()
      .from(systemEvents)
      .where(and(...conditions))
      .orderBy(desc(systemEvents.createdAt))
      .limit(options.limit ?? 100)
      .offset(options.offset ?? 0);
  }

  // ── Job explorer ──────────────────────────────────────────────────────────

  /**
   * Paginated, filtered job search.
   *
   * Left joins to matches/recommendations/signals so a job with none still
   * appears — an explorer that hides everything not yet processed is useless
   * for the exact case you open it for.
   */
  async exploreJobs(query: JobExplorerQuery, profileId: string | null) {
    const conditions = [];

    if (query.q) {
      // Parameterised, not interpolated. This string comes from a URL.
      const pattern = `%${query.q.toLowerCase()}%`;
      conditions.push(
        or(
          sql`lower(${jobs.title}) LIKE ${pattern}`,
          sql`lower(${jobs.companyNameRaw}) LIKE ${pattern}`,
        ),
      );
    }
    if (query.company) {
      conditions.push(sql`lower(${jobs.companyNameRaw}) LIKE ${`%${query.company.toLowerCase()}%`}`);
    }
    if (query.sourceId) conditions.push(eq(jobs.sourceId, query.sourceId));
    if (query.countryCode) conditions.push(eq(jobs.countryCode, query.countryCode));
    if (query.remoteType) conditions.push(eq(jobs.remoteType, query.remoteType));
    if (query.status) conditions.push(eq(jobs.status, query.status));
    if (query.lifecycle) conditions.push(eq(jobSignals.lifecycleStatus, query.lifecycle));
    if (query.minSalaryUsd !== undefined) {
      conditions.push(sql`${jobs.salaryNormalizedAnnualUsd} >= ${query.minSalaryUsd}`);
    }
    if (query.minQualityScore !== undefined) {
      conditions.push(gte(jobSignals.qualityScore, query.minQualityScore));
    }
    if (query.discoveredWithinHours !== undefined) {
      conditions.push(gte(jobs.firstSeenAt, hoursAgo(query.discoveredWithinHours)));
    }
    if (query.postedWithinHours !== undefined) {
      conditions.push(gte(jobs.postedAt, hoursAgo(query.postedWithinHours)));
    }
    if (query.duplicatesOnly) conditions.push(isNotNull(jobs.jobGroupId));
    if (query.minMatchScore !== undefined) {
      conditions.push(gte(jobMatches.overallScore, query.minMatchScore));
    }
    if (query.minRecommendationScore !== undefined) {
      conditions.push(gte(jobRecommendations.finalScore, query.minRecommendationScore));
    }

    const order = {
      discovered: desc(jobs.firstSeenAt),
      posted: desc(jobs.postedAt),
      match: desc(jobMatches.overallScore),
      recommendation: desc(jobRecommendations.finalScore),
      quality: desc(jobSignals.qualityScore),
    }[query.sort];

    const base = this.db
      .select({
        job: jobs,
        signals: jobSignals,
        match: jobMatches,
        recommendation: jobRecommendations,
      })
      .from(jobs)
      .leftJoin(jobSignals, eq(jobSignals.jobId, jobs.id))
      .leftJoin(
        jobMatches,
        profileId
          ? and(eq(jobMatches.jobId, jobs.id), eq(jobMatches.profileId, profileId))
          : sql`false`,
      )
      .leftJoin(
        jobRecommendations,
        profileId
          ? and(eq(jobRecommendations.jobId, jobs.id), eq(jobRecommendations.profileId, profileId))
          : sql`false`,
      );

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [items, [countRow]] = await Promise.all([
      base.where(where).orderBy(order).limit(query.limit).offset(query.offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs)
        .leftJoin(jobSignals, eq(jobSignals.jobId, jobs.id))
        .leftJoin(
          jobMatches,
          profileId
            ? and(eq(jobMatches.jobId, jobs.id), eq(jobMatches.profileId, profileId))
            : sql`false`,
        )
        .leftJoin(
          jobRecommendations,
          profileId
            ? and(eq(jobRecommendations.jobId, jobs.id), eq(jobRecommendations.profileId, profileId))
            : sql`false`,
        )
        .where(where),
    ]);

    return { items, total: countRow?.count ?? 0 };
  }

  /** Everything about one job, for the debugger. */
  async inspectJob(jobId: string, profileId: string | null) {
    const [jobRow] = await this.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!jobRow) return null;

    const [enrichment] = await this.db
      .select()
      .from(jobEnrichments)
      .where(eq(jobEnrichments.jobId, jobId))
      .limit(1);

    const [signals] = await this.db
      .select()
      .from(jobSignals)
      .where(eq(jobSignals.jobId, jobId))
      .limit(1);

    const duplicates = await this.db
      .select()
      .from(jobDuplicates)
      .where(or(eq(jobDuplicates.jobId, jobId), eq(jobDuplicates.duplicateOfJobId, jobId)))
      .orderBy(desc(jobDuplicates.duplicateConfidence))
      .limit(10);

    const match = profileId
      ? (
          await this.db
            .select()
            .from(jobMatches)
            .where(and(eq(jobMatches.jobId, jobId), eq(jobMatches.profileId, profileId)))
            .limit(1)
        )[0] ?? null
      : null;

    const recommendation = profileId
      ? (
          await this.db
            .select()
            .from(jobRecommendations)
            .where(
              and(
                eq(jobRecommendations.jobId, jobId),
                eq(jobRecommendations.profileId, profileId),
              ),
            )
            .limit(1)
        )[0] ?? null
      : null;

    const decisions = profileId
      ? await this.db
          .select()
          .from(notificationDecisions)
          .where(
            and(
              eq(notificationDecisions.profileId, profileId),
              or(
                eq(notificationDecisions.jobId, jobId),
                eq(notificationDecisions.canonicalJobId, jobId),
              ),
            ),
          )
          .orderBy(desc(notificationDecisions.decidedAt))
          .limit(20)
      : [];

    const events = await this.db
      .select()
      .from(systemEvents)
      .where(eq(systemEvents.jobId, jobId))
      .orderBy(desc(systemEvents.createdAt))
      .limit(50);

    return {
      job: jobRow,
      enrichment: enrichment ?? null,
      signals: signals ?? null,
      duplicates,
      match,
      recommendation,
      decisions,
      events,
    };
  }

  // ── Recommendation analytics ──────────────────────────────────────────────

  /**
   * Score distribution, tiers, and where recommendations actually come from.
   *
   * The distribution is the calibration check the brief asks for: if every job
   * lands in the 90–99 bucket, the score has stopped discriminating and the
   * histogram says so before anyone has to argue about a single job.
   *
   * Bucketing happens in SQL. Pulling every recommendation into the process to
   * count them would work today and stop working at ten thousand.
   */
  async recommendationAnalytics(profileId: string) {
    const [distribution, tiers, companies, sources, outcomes] = await Promise.all([
      this.db
        .select({
          bucket: sql<number>`least(9, floor(${jobRecommendations.finalScore} / 10))::int`,
          count: sql<number>`count(*)::int`,
        })
        .from(jobRecommendations)
        .where(eq(jobRecommendations.profileId, profileId))
        .groupBy(sql`least(9, floor(${jobRecommendations.finalScore} / 10))`)
        .orderBy(sql`least(9, floor(${jobRecommendations.finalScore} / 10))`),

      this.db
        .select({
          tier: jobRecommendations.tier,
          count: sql<number>`count(*)::int`,
          avgScore: sql<number>`coalesce(avg(${jobRecommendations.finalScore}), 0)::float8`,
          notifiable: sql<number>`count(*) FILTER (WHERE ${jobRecommendations.notificationEligible})::int`,
        })
        .from(jobRecommendations)
        .where(eq(jobRecommendations.profileId, profileId))
        .groupBy(jobRecommendations.tier),

      this.db
        .select({
          company: jobs.companyNameRaw,
          count: sql<number>`count(*)::int`,
          bestScore: sql<number>`coalesce(max(${jobRecommendations.finalScore}), 0)::float8`,
        })
        .from(jobRecommendations)
        .innerJoin(jobs, eq(jobs.id, jobRecommendations.jobId))
        .where(eq(jobRecommendations.profileId, profileId))
        .groupBy(jobs.companyNameRaw)
        .orderBy(desc(sql`count(*)`))
        .limit(15),

      this.db
        .select({
          sourceId: jobs.sourceId,
          count: sql<number>`count(*)::int`,
          avgScore: sql<number>`coalesce(avg(${jobRecommendations.finalScore}), 0)::float8`,
          notifiable: sql<number>`count(*) FILTER (WHERE ${jobRecommendations.notificationEligible})::int`,
        })
        .from(jobRecommendations)
        .innerJoin(jobs, eq(jobs.id, jobRecommendations.jobId))
        .where(eq(jobRecommendations.profileId, profileId))
        .groupBy(jobs.sourceId)
        .orderBy(desc(sql`count(*)`)),

      this.db
        .select({
          outcome: notificationDecisions.outcome,
          count: sql<number>`count(*)::int`,
        })
        .from(notificationDecisions)
        .where(eq(notificationDecisions.profileId, profileId))
        .groupBy(notificationDecisions.outcome)
        .orderBy(desc(sql`count(*)`)),
    ]);

    // Every bucket present, including the empty ones — a histogram with holes
    // in it reads as a narrower distribution than it is.
    const buckets = Array.from({ length: 10 }, (_, index) => ({
      from: index * 10,
      to: index * 10 + 10,
      count: distribution.find((row) => row.bucket === index)?.count ?? 0,
    }));

    return { buckets, tiers, companies, sources, outcomes };
  }

  // ── Source overview ───────────────────────────────────────────────────────

  async sourceOverview() {
    return this.db
      .select({
        id: jobSources.id,
        displayName: jobSources.displayName,
        sourceType: jobSources.sourceType,
        accessTier: jobSources.accessTier,
        enabled: jobSources.enabled,
        healthStatus: jobSources.healthStatus,
        consecutiveFailures: jobSources.consecutiveFailures,
        lastSuccessfulRunAt: jobSources.lastSuccessfulRunAt,
        lastRunAt: jobSources.lastAttemptedRunAt,
        lastErrorMessage: jobSources.lastErrorMessage,
        circuitState: jobSources.circuitState,
      })
      .from(jobSources)
      .orderBy(jobSources.id);
  }
}
