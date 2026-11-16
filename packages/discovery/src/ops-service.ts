import { randomUUID } from 'node:crypto';
import {
  PIPELINE_STAGES,
  type ComponentHealth,
  type DashboardOverview,
  type DryRunReport,
  type PipelineStage,
  type PipelineStageStatus,
  type SourceHealthScore,
  type SystemHealth,
} from '@job-intel/contracts';
import type {
  OpsRepository,
  ProfileRepository,
  RecommendationRepository,
  SourceRepository,
} from '@job-intel/db';
import type { FailedQueueJob, QueueDriver, QueueName } from '@job-intel/queue';
import type { EventRecorder, Logger } from '@job-intel/observability';
import {
  buildDataQuality,
  buildFunnel,
  composeHealth,
  probe,
  redact,
  scoreSourceHealth,
  summariseCost,
  summariseLatency,
} from '@job-intel/ops';
import type { RecommendationService } from './recommendation-service';

/**
 * Operations service.
 *
 * Assembles everything the control centre displays and owns the manual
 * controls. Two properties matter more than the aggregation itself:
 *
 *  - **Nothing here throws.** Every probe is wrapped, so a dead email provider
 *    produces a red card rather than a 500. The dashboard is needed *most* when
 *    something is broken, and a page that dies with its dependencies is a page
 *    that is never available during an incident.
 *  - **Dry runs are genuinely inert.** They report intentions and perform no
 *    sends and no preference writes — the only safe way to tune thresholds on a
 *    system that emails a real person.
 */

export interface OpsServiceDependencies {
  ops: OpsRepository;
  sources: SourceRepository;
  profiles: ProfileRepository;
  recommendations: RecommendationRepository;
  queue: QueueDriver;
  logger: Logger;
  events: EventRecorder;
  /** Optional: absent means the corresponding card reports `disabled`. */
  recommendationService?: RecommendationService;
  checkDatabase?: () => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  aiEnabled?: boolean;
  aiModel?: string | null;
  dailyBudgetUsd?: number | null;
}

const MONITORED_QUEUES: QueueName[] = [
  'discovery',
  'enrichment',
  'embedding',
  'match-triage',
  'match-deep',
  'ranking',
  'validation',
  'maintenance',
];

/** Which queue backs each pipeline stage. Null means the stage runs inline. */
const STAGE_QUEUE: Readonly<Record<PipelineStage, QueueName | null>> = {
  discovery: 'discovery',
  normalization: null,
  deduplication: 'dedup',
  enrichment: 'enrichment',
  quality: 'validation',
  matching: 'match-triage',
  ranking: 'ranking',
};

export class OpsService {
  constructor(private readonly deps: OpsServiceDependencies) {}

  // ── Health ────────────────────────────────────────────────────────────────

  /**
   * Probes every component.
   *
   * Each probe is independent and time-bounded, so one hanging dependency
   * cannot stall the page. Failures become `down` cards carrying a redacted
   * message — probe errors routinely contain connection strings, and this text
   * reaches a browser.
   */
  async systemHealth(): Promise<SystemHealth> {
    const components: ComponentHealth[] = await Promise.all([
      probe('database', async () => {
        if (!this.deps.checkDatabase) return { status: 'unknown' as const, detail: 'no probe wired' };
        const result = await this.deps.checkDatabase();
        return result.ok
          ? { status: 'healthy' as const, detail: `responded in ${result.latencyMs ?? 0} ms` }
          : { status: 'down' as const, detail: redact(result.error ?? 'unreachable') };
      }),

      probe('queue', async () => {
        const health = await this.deps.queue.healthCheck();
        if (!health.ok) return { status: 'down' as const, detail: redact(health.error ?? 'unreachable') };
        const backlog = await this.queueBacklog();
        return backlog > 5000
          ? { status: 'degraded' as const, detail: `${backlog} jobs waiting — backlog building` }
          : { status: 'healthy' as const, detail: `${this.deps.queue.kind}, ${backlog} waiting` };
      }),

      probe('scheduler', async () => {
        const [current, recent] = await Promise.all([
          this.deps.ops.currentRun(),
          this.deps.ops.listRuns({ limit: 1 }),
        ]);
        if (current) {
          const minutes = Math.round((Date.now() - current.startedAt.getTime()) / 60_000);
          // A run that has been "running" for hours is stuck, not busy.
          return minutes > 120
            ? { status: 'degraded' as const, detail: `a run has been active for ${minutes} minutes` }
            : { status: 'healthy' as const, detail: `run in progress (${minutes} min)` };
        }
        const last = recent[0];
        if (!last) return { status: 'unknown' as const, detail: 'no pipeline run recorded yet' };
        const hours = Math.round((Date.now() - last.startedAt.getTime()) / 3_600_000);
        return { status: 'healthy' as const, detail: `last run ${hours}h ago (${last.status})` };
      }),

      probe('ai_provider', async () => {
        if (!this.deps.aiEnabled) {
          return { status: 'disabled' as const, detail: 'AI is switched off; the pipeline runs deterministically' };
        }
        const unpriced = await this.deps.ops.unpricedModels();
        return unpriced.length > 0
          ? {
              status: 'degraded' as const,
              detail: `no pricing configured for ${unpriced.join(', ')}; costs under-reported`,
            }
          : { status: 'healthy' as const, detail: this.deps.aiModel ?? 'enabled' };
      }),

      probe('sources', async () => {
        const scores = await this.sourceHealthScores();
        const failing = scores.filter((s) => s.status === 'down').length;
        const degraded = scores.filter((s) => s.status === 'degraded').length;
        if (scores.length === 0) return { status: 'unknown' as const, detail: 'no sources registered' };
        if (failing > 0) {
          return { status: 'degraded' as const, detail: `${failing} source(s) failing, ${degraded} degraded` };
        }
        return degraded > 0
          ? { status: 'degraded' as const, detail: `${degraded} source(s) degraded` }
          : { status: 'healthy' as const, detail: `${scores.length} source(s) healthy` };
      }),
    ]);

    return composeHealth(components);
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  /**
   * The overview.
   *
   * Every section is fetched independently and defaults to zeros, so a broken
   * sub-query degrades one card rather than the page.
   */
  async overview(): Promise<DashboardOverview> {
    const profile = await this.deps.profiles.getActiveProfile().catch(() => null);
    const profileId = profile?.profileId ?? null;

    const [health, counters, recommendations, sourceScores, current, recent, backlog] =
      await Promise.all([
        this.systemHealth(),
        this.deps.ops.pipelineCounters(profileId).catch(() => null),
        profileId
          ? this.deps.ops.recommendationStats(profileId).catch(() => null)
          : Promise.resolve(null),
        this.sourceHealthScores().catch(() => [] as SourceHealthScore[]),
        this.deps.ops.currentRun().catch(() => null),
        this.deps.ops.listRuns({ limit: 1 }).catch(() => []),
        this.queueBacklog().catch(() => 0),
      ]);

    const last = recent[0] ?? null;

    return {
      health,
      pipeline: {
        discoveredToday: counters?.discoveredToday ?? 0,
        discoveredThisHour: counters?.discoveredThisHour ?? 0,
        enriched: counters?.enriched ?? 0,
        matched: counters?.matched ?? 0,
        recommended: counters?.recommended ?? 0,
        duplicates: counters?.duplicates ?? 0,
        stale: counters?.stale ?? 0,
      },
      recommendations: {
        exceptional: recommendations?.exceptional ?? 0,
        strong: recommendations?.strong ?? 0,
        averageScore: recommendations?.averageScore ?? 0,
        averageConfidence: recommendations?.averageConfidence ?? 0,
      },
      sources: {
        healthy: sourceScores.filter((s) => s.status === 'healthy').length,
        degraded: sourceScores.filter((s) => s.status === 'degraded').length,
        failing: sourceScores.filter((s) => s.status === 'down').length,
        disabled: sourceScores.filter((s) => s.status === 'disabled').length,
      },
      scheduler: {
        lastRunAt: last?.startedAt ?? null,
        lastRunStatus: last?.status ?? null,
        currentRunId: current?.id ?? null,
        nextRunAt: null,
        queueBacklog: backlog,
      },
      generatedAt: new Date(),
    };
  }

  // ── Pipeline visualisation ────────────────────────────────────────────────

  async pipelineStages(): Promise<PipelineStageStatus[]> {
    // The candidate-scoped stages (matching, ranking, notification) count rows
    // that only exist per profile. Passing null here silently reported zero for
    // three of the eight stages while the dashboard's own counters, computed
    // against the active profile, showed hundreds.
    const profile = await this.deps.profiles.getActiveProfile().catch(() => null);

    const [counters, queueCounts, lastRun] = await Promise.all([
      this.deps.ops.pipelineCounters(profile?.profileId ?? null).catch(() => null),
      this.queueCounts(),
      this.deps.ops.listRuns({ limit: 1 }).then((r) => r[0] ?? null).catch(() => null),
    ]);

    const stageFromRun = new Map(
      (lastRun?.stages ?? []).map((stage) => [stage.stage, stage] as const),
    );

    return PIPELINE_STAGES.map((stage): PipelineStageStatus => {
      const recorded = stageFromRun.get(stage);
      const queueName = STAGE_QUEUE[stage];
      const counts = queueName ? queueCounts.get(queueName) : undefined;

      // Counters from the last recorded run when we have them; live totals
      // otherwise. Never a placeholder — an unobserved stage reports zeros.
      const processed =
        recorded?.processed ??
        (stage === 'discovery'
          ? (counters?.discoveredToday ?? 0)
          : stage === 'enrichment'
            ? (counters?.enriched ?? 0)
            : stage === 'deduplication'
              ? (counters?.duplicates ?? 0)
              : stage === 'matching'
                ? (counters?.matched ?? 0)
                : stage === 'ranking'
                  ? (counters?.recommended ?? 0)
                  : 0);

      const failed = recorded?.failed ?? (stage === 'enrichment' ? (counters?.enrichmentFailed ?? 0) : 0);
      const waiting = counts ? counts.waiting + counts.delayed : (recorded?.waiting ?? 0);

      return {
        stage,
        status:
          failed > 0 && failed > processed * 0.2
            ? 'degraded'
            : waiting > 1000
              ? 'degraded'
              : processed > 0 || waiting > 0
                ? 'healthy'
                : 'unknown',
        processed,
        succeeded: recorded?.succeeded ?? Math.max(0, processed - failed),
        failed,
        waiting,
        lastRunAt: recorded?.lastRunAt ?? lastRun?.startedAt ?? null,
        lastDurationMs: recorded?.lastDurationMs ?? null,
        detail: queueName ? `queue: ${queueName}` : 'runs inline',
      };
    });
  }

  // ── Queues ────────────────────────────────────────────────────────────────

  async queueCounts() {
    const results = new Map<QueueName, Awaited<ReturnType<QueueDriver['counts']>>>();
    await Promise.all(
      MONITORED_QUEUES.map(async (name) => {
        try {
          results.set(name, await this.deps.queue.counts(name));
        } catch (error) {
          // One unreachable queue must not blank the whole panel.
          this.deps.logger.debug('Queue counts unavailable', { queue: name, err: error });
        }
      }),
    );
    return results;
  }

  async queueBacklog(): Promise<number> {
    const counts = await this.queueCounts();
    let backlog = 0;
    for (const value of counts.values()) backlog += value.waiting + value.delayed;
    return backlog;
  }

  /**
   * Every dead job across every monitored queue, newest first.
   *
   * Failure reasons are redacted: a connector that died on a authenticated URL
   * puts that URL in the message, and this text is rendered in a browser.
   */
  async failedJobs(limit = 50): Promise<FailedQueueJob[]> {
    const perQueue = await Promise.all(
      MONITORED_QUEUES.map(async (name) => {
        try {
          return await this.deps.queue.failedJobs(name, limit);
        } catch (error) {
          this.deps.logger.debug('Failed-job listing unavailable', { queue: name, err: error });
          return [] as FailedQueueJob[];
        }
      }),
    );

    return perQueue
      .flat()
      .map((job) => ({
        ...job,
        failedReason: redact(job.failedReason),
        stack: job.stack === null ? null : redact(job.stack),
      }))
      .sort((a, b) => (b.failedAt?.getTime() ?? 0) - (a.failedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  /** Re-queues or discards one dead job. Audited by the caller. */
  async actOnFailedJob(
    queue: QueueName,
    jobId: string,
    action: 'retry' | 'discard',
  ): Promise<boolean> {
    return action === 'retry'
      ? this.deps.queue.retryJob(queue, jobId)
      : this.deps.queue.discardJob(queue, jobId);
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  async sourceHealthScores(): Promise<SourceHealthScore[]> {
    const [sources, runsBySource, baselines, rateLimits] = await Promise.all([
      this.deps.sources.list({ includeArchived: false }),
      this.deps.ops.recentSourceRuns(),
      this.deps.ops.sourceVolumeBaseline(),
      this.deps.ops.rateLimitSummaries(24),
    ]);

    const limitsBySource = new Map<string, number>();
    for (const row of rateLimits) {
      limitsBySource.set(row.sourceId, (limitsBySource.get(row.sourceId) ?? 0) + row.rateLimited);
    }

    return sources.map((source) =>
      scoreSourceHealth({
        sourceId: source.id,
        enabled: source.enabled,
        runs: runsBySource.get(source.id) ?? [],
        consecutiveFailures: source.consecutiveFailures,
        lastSuccessAt: source.lastSuccessfulRunAt ?? null,
        circuitState: source.circuitState ?? null,
        rateLimitEvents: limitsBySource.get(source.id) ?? 0,
        baselineDiscovered: baselines.get(source.id) ?? null,
      }),
    );
  }

  // ── Funnel, quality, cost, metrics ────────────────────────────────────────

  async funnel(windowHours = 24) {
    const profile = await this.deps.profiles.getActiveProfile().catch(() => null);
    const counts = await this.deps.ops.funnelCounts(profile?.profileId ?? null, windowHours);
    return buildFunnel(counts, windowHours);
  }

  async dataQuality() {
    return buildDataQuality(await this.deps.ops.dataQualityCounts());
  }

  async aiCost(windowHours = 24 * 7) {
    const records = await this.deps.ops.aiUsageRecords(windowHours);
    return summariseCost({
      records,
      windowHours,
      dailyBudgetUsd: this.deps.dailyBudgetUsd ?? null,
    });
  }

  async latencies(windowHours = 24) {
    const samples = await this.deps.ops.latencySamples(windowHours);
    return [...samples.entries()].map(([operation, values]) =>
      summariseLatency(operation, values),
    );
  }

  // ── Manual controls ───────────────────────────────────────────────────────

  /**
   * A dry run.
   *
   * Executes the decision half of the pipeline and writes nothing. The
   * shortlist is computed from stored state, so the report shows exactly what
   * the dashboard would put at the top of the list — which is the thing an
   * operator wants to see before moving a threshold.
   */
  async dryRun(options: { triggeredBy: string; reason?: string }): Promise<DryRunReport> {
    const startedAt = Date.now();
    const profile = await this.deps.profiles.getActiveProfile();
    const runId = await this.deps.ops.startRun({
      trigger: 'MANUAL',
      dryRun: true,
      triggeredBy: options.triggeredBy,
      note: options.reason ?? 'dry run',
    });

    const skippedWrites: string[] = [
      'no candidate preferences modified',
      'no job records written',
      'no recommendations persisted',
    ];

    if (!profile) {
      await this.deps.ops.completeRun(runId, { status: 'success' });
      return {
        runId,
        wouldDiscover: 0,
        wouldEnrich: 0,
        wouldMatch: 0,
        wouldRecommend: 0,
        wouldShortlist: 0,
        shortlist: [],
        suppressed: [],
        skippedWrites,
        durationMs: Date.now() - startedAt,
        generatedAt: new Date(),
      };
    }

    const counters = await this.deps.ops.pipelineCounters(profile.profileId);

    const ranked = await this.deps.recommendations.topRecommendations({
      profileId: profile.profileId,
      limit: 50,
      notificationEligibleOnly: true,
    });

    const shortlist: DryRunReport['shortlist'] = ranked.map((row) => ({
      jobId: row.job.id,
      title: row.job.title,
      company: row.job.companyNameRaw,
      tier: row.recommendation.tier,
      priority: row.recommendation.tier === 'EXCEPTIONAL' ? 'URGENT' : 'NORMAL',
      headline: `${row.job.title} — ${row.job.companyNameRaw}`,
      reason: `Recommendation ${Math.round(row.recommendation.finalScore)} clears your thresholds`,
    }));

    /*
     * Nothing is suppressed here any more.
     *
     * This list used to hold jobs held back because they had already been
     * emailed. A dashboard has no equivalent: a job you have already seen is
     * still a job you can scroll back to, so hiding it would lose it. Kept in
     * the shape because scam and duplicate suppression still populate it
     * upstream.
     */
    const suppressed: DryRunReport['suppressed'] = [];

    await this.deps.ops.completeRun(runId, {
      status: 'success',
      counters: {
        jobsDiscovered: 0,
        jobsProcessed: counters.totalJobs,
        jobsMatched: counters.matched,
        jobsRecommended: counters.recommended,
      },
    });

    return {
      runId,
      wouldDiscover: 0,
      wouldEnrich: Math.max(0, counters.totalJobs - counters.enriched),
      wouldMatch: counters.matched,
      wouldRecommend: counters.recommended,
      wouldShortlist: shortlist.length,
      shortlist,
      suppressed,
      skippedWrites,
      durationMs: Date.now() - startedAt,
      generatedAt: new Date(),
    };
  }

  /** Opens a run record for a manually triggered pipeline pass. */
  async beginManualRun(input: { triggeredBy: string; note?: string }): Promise<string> {
    const traceId = randomUUID();
    const runId = await this.deps.ops.startRun({
      trigger: 'MANUAL',
      triggeredBy: input.triggeredBy,
      note: input.note ?? null,
      traceId,
    });

    await this.deps.ops.appendTimeline(runId, [
      {
        at: new Date(),
        stage: 'discovery',
        event: 'Run started',
        detail: `Triggered manually by ${input.triggeredBy}`,
        severity: 'info',
      },
    ]);

    await this.deps.events.emit('SYSTEM_STARTED', {
      message: `Manual pipeline run started by ${input.triggeredBy}`,
      data: { runId, traceId },
    });

    return runId;
  }
}
