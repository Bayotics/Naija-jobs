import { randomUUID } from 'node:crypto';
import {
  jobSourceSchema,
  type JobSource,
  type RunErrorDetail,
  type RunTrigger,
  type SourceJobDraft,
} from '@job-intel/contracts';
import { JobIdentityService } from '@job-intel/core';
import type { DiscoveryRepository, SourceRepository } from '@job-intel/db';
import type { EventRecorder, Logger } from '@job-intel/observability';
import {
  type ConnectorRegistry,
  type HttpClient,
  classifyError,
  type ConnectorContext,
  type DiscoverySummary,
} from '@job-intel/connectors';
import { processDraft, defaultValidationRules, type PipelineOptions } from './pipeline/discovery-pipeline';
import { relevanceRule, type RelevanceProfile } from './pipeline/relevance';

/**
 * Executes one source, end to end.
 *
 * The contract that matters most: **a failure in one source never affects
 * another**, and a failure inside one posting never aborts its source. Every
 * error is caught, classified, counted and recorded against the run rather than
 * propagated.
 */

export interface SourceRunnerDependencies {
  registry: ConnectorRegistry;
  sources: SourceRepository;
  discovery: DiscoveryRepository;
  logger: Logger;
  events: EventRecorder;
  getSecret(name: string): string | undefined;
  /** Injected so tests can supply a fixture-backed client. */
  createHttpClient(source: JobSource): HttpClient;
  /**
   * Optional operations sink.
   *
   * When present, each run contributes a latency sample and an HTTP outcome
   * bucket. Optional rather than required because the observability write must
   * never be the reason a discovery run fails — and because tests should not
   * have to wire a metrics table to exercise a connector.
   */
  /**
   * Optional acquisition sink.
   *
   * Feeds the reliability counters and watermarks behind the source
   * intelligence dashboard. Optional for the same reason `ops` is: a
   * bookkeeping write must never be the reason a discovery run fails, and a
   * connector test should not have to wire four tables to exercise a feed.
   */
  acquisition?: {
    recordReliability(
      sourceId: string,
      delta: {
        requestsAttempted?: number;
        requestsSucceeded?: number;
        requestsFailed?: number;
        itemsSeen?: number;
        itemsParsed?: number;
        itemsRejected?: number;
        jobsYielded?: number;
        duplicates?: number;
        rateLimitHits?: number;
        timeouts?: number;
        averageLatencyMs?: number;
      },
      at?: Date,
    ): Promise<void>;
    getWatermark(sourceId: string): Promise<{ emptyScans: number } & Record<string, unknown>>;
    saveWatermark(watermark: Record<string, unknown>): Promise<unknown>;
  };
  ops?: {
    recordSample(input: {
      operation: string;
      valueMs: number;
      sourceId?: string | null;
    }): Promise<void>;
    recordHttpOutcomes(input: {
      sourceId: string;
      requests: number;
      succeeded: number;
      failed: number;
      rateLimited: number;
      at?: Date;
    }): Promise<void>;
  };
}

export interface RunOptions {
  trigger?: RunTrigger;
  /** Hard ceiling on wall-clock time for one source. */
  timeBudgetMs?: number;
  /** Stops after this many drafts, regardless of what the source offers. */
  maxItems?: number;
  pipeline?: PipelineOptions;
  signal?: AbortSignal;
  /**
   * The candidate's relevance vocabulary.
   *
   * Optional so that probes, tests and one-off scripts can run a source
   * unfiltered. Absent means every structurally valid posting is stored, which
   * is the behaviour every caller had before the gate existed.
   */
  relevance?: RelevanceProfile | null;
}

export interface RunResult {
  runId: string;
  sourceId: string;
  status: 'success' | 'partial' | 'failed' | 'skipped';
  stats: {
    jobsDiscovered: number;
    jobsAccepted: number;
    jobsUpdated: number;
    jobsDuplicated: number;
    jobsRejected: number;
    errorCount: number;
    httpRequests: number;
    bytesFetched: number;
  };
  errors: RunErrorDetail[];
  durationMs: number;
  skippedReason?: string;
}

const DEFAULT_TIME_BUDGET_MS = 5 * 60 * 1000;

/** Per-job events retained for the trace. Bounded — see the emission site. */
const JOB_EVENT_CAP = 200;

interface JobEventRecord {
  name: 'JOB_DISCOVERED' | 'JOB_UPDATED' | 'JOB_DUPLICATE';
  jobId: string;
  severity: 'info' | 'warn' | 'error';
  message: string;
}

export class SourceRunner {
  private readonly identity = new JobIdentityService();

  constructor(private readonly deps: SourceRunnerDependencies) {}

  /**
   * Runs every enabled source.
   *
   * Sequential by default so a burst of sources cannot collectively overwhelm
   * the host or the database; each is independently isolated regardless.
   */
  async runAll(options: RunOptions = {}): Promise<RunResult[]> {
    const sources = await this.deps.sources.list({ enabledOnly: true });
    const results: RunResult[] = [];

    for (const source of sources) {
      if (options.signal?.aborted) break;
      // Never let one source's failure escape into the loop.
      results.push(await this.run(source.id, options));
    }
    return results;
  }

  async runMany(sourceIds: string[], options: RunOptions = {}): Promise<RunResult[]> {
    const results: RunResult[] = [];
    for (const id of sourceIds) {
      if (options.signal?.aborted) break;
      results.push(await this.run(id, options));
    }
    return results;
  }

  /** Runs one source. Resolves with a result even when everything fails. */
  async run(sourceId: string, options: RunOptions = {}): Promise<RunResult> {
    const startedAt = Date.now();
    const traceId = randomUUID();
    const logger = this.deps.logger.child({ sourceId, traceId });

    const stats = {
      jobsDiscovered: 0,
      jobsAccepted: 0,
      jobsUpdated: 0,
      jobsDuplicated: 0,
      jobsRejected: 0,
      errorCount: 0,
      httpRequests: 0,
      bytesFetched: 0,
    };
    const errors: RunErrorDetail[] = [];
    const jobEvents: JobEventRecord[] = [];

    // ── 1. Load source ────────────────────────────────────────────────────
    const row = await this.deps.sources.get(sourceId);
    if (!row) {
      return this.skipped('', sourceId, `Source "${sourceId}" not found`, stats, startedAt);
    }
    if (row.archivedAt) {
      return this.skipped('', sourceId, 'Source is archived', stats, startedAt);
    }

    const source = this.toJobSource(row);

    // ── 2. Resolve connector + validate configuration ─────────────────────
    const connector = this.deps.registry.find(source.connectorId);
    if (!connector) {
      const reason = `Unknown connector "${source.connectorId}"`;
      await this.recordConfigFailure(sourceId, reason, traceId);
      return this.skipped('', sourceId, reason, stats, startedAt);
    }

    const configResult = this.deps.registry.validateConfig(source.connectorId, source.config);
    if (!configResult.ok) {
      // A malformed configuration is permanent: recorded as a failure, never retried.
      const reason = `Invalid source configuration: ${configResult.errors.join('; ')}`;
      await this.recordConfigFailure(sourceId, reason, traceId);
      return this.skipped('', sourceId, reason, stats, startedAt);
    }
    const config = configResult.value;

    const availability = connector.availability({
      config: config as never,
      getSecret: (name) => this.deps.getSecret(name),
    });
    if (!availability.available) {
      const reason = `${availability.reason ?? 'Connector unavailable'}${
        availability.requires.length > 0 ? ` (requires: ${availability.requires.join(', ')})` : ''
      }`;
      logger.warn('Source skipped: connector unavailable', { reason });
      await this.deps.sources.update(sourceId, {
        healthStatus: 'disabled',
        lastErrorMessage: reason,
      } as never);
      return this.skipped('', sourceId, reason, stats, startedAt);
    }

    // ── 3. Start the run ──────────────────────────────────────────────────
    const run = await this.deps.sources.startRun(sourceId, options.trigger ?? 'manual', traceId);
    await this.deps.events.emit('SOURCE_RUN_STARTED', {
      sourceId,
      runId: run.id,
      traceId,
      message: `Discovery started for ${source.displayName}`,
      data: { connectorId: source.connectorId, trigger: options.trigger ?? 'manual' },
    });

    const http = this.deps.createHttpClient(source);
    const controller = new AbortController();
    const budgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
    const budgetTimer = setTimeout(() => controller.abort(), budgetMs);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const ctx: ConnectorContext<unknown> = {
      source,
      config,
      cursor: (row.cursor as Record<string, unknown> | null) ?? null,
      http,
      signal: controller.signal,
      traceId,
      getSecret: (name) => this.deps.getSecret(name),
      log: (level, message, data) => logger[level](message, data as Record<string, unknown>),
    };

    /*
     * The relevance gate runs last, after the structural rules.
     *
     * Ordering matters for the reason recorded against a rejection: a posting
     * with no title is malformed, not irrelevant, and reporting it as the
     * latter would send anyone debugging a source in the wrong direction.
     */
    const rules = [
      ...defaultValidationRules(options.pipeline ?? {}),
      ...(options.relevance ? [relevanceRule(options.relevance)] : []),
    ];
    let summary: DiscoverySummary | void = undefined;

    try {
      // ── 4–8. Discover → normalize → validate → persist ──────────────────
      const generator = connector.discover(ctx as never);
      const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;

      for (;;) {
        const next = await generator.next();
        if (next.done) {
          summary = next.value;
          break;
        }

        const draft: SourceJobDraft = next.value;
        stats.jobsDiscovered += 1;

        /*
         * Query attribution.
         *
         * Search connectors record the query they ran in `sourceMetadata`;
         * everything else leaves it absent. Reading it here rather than adding
         * a field to the draft contract keeps connectors that have no concept
         * of a query unchanged, and closes the join query learning needs:
         * query → job → behaviour event.
         */
        const queryContext = draft.sourceMetadata as { queryId?: unknown; query?: unknown };
        const discoveryQueryId =
          typeof queryContext.queryId === 'string'
            ? queryContext.queryId
            : typeof queryContext.query === 'string'
              ? queryContext.query.slice(0, 120)
              : null;

        const result = await processDraft(
          draft,
          {
            repository: this.deps.discovery,
            identity: this.identity,
            sourceId,
            sourceRunId: run.id,
            traceId,
            discoveryQueryId,
            onEvent: (event) => {
              if (jobEvents.length >= JOB_EVENT_CAP) return;
              if (event.type === 'JOB_DISCOVERED') {
                jobEvents.push({
                  name: 'JOB_DISCOVERED',
                  jobId: event.jobId,
                  severity: 'info',
                  message: `Discovered "${event.title}"`,
                });
              } else if (event.type === 'JOB_UPDATED') {
                jobEvents.push({
                  name: 'JOB_UPDATED',
                  jobId: event.jobId,
                  severity: 'info',
                  message:
                    event.changedFields.length > 0
                      ? `Updated: ${event.changedFields.join(', ')}`
                      : 'Updated',
                });
              } else if (event.type === 'JOB_DUPLICATE') {
                jobEvents.push({
                  name: 'JOB_DUPLICATE',
                  jobId: event.jobId,
                  severity: 'info',
                  message: 'Seen again with no material change',
                });
              }
            },
          },
          options.pipeline ?? {},
          rules,
        );

        switch (result.outcome) {
          case 'created':
            stats.jobsAccepted += 1;
            break;
          case 'updated':
            stats.jobsUpdated += 1;
            break;
          case 'unchanged':
          case 'duplicate':
            stats.jobsDuplicated += 1;
            break;
          case 'rejected':
            stats.jobsRejected += 1;
            break;
          case 'failed':
            stats.jobsRejected += 1;
            stats.errorCount += 1;
            // Item-level failures are recorded but capped: 200 identical
            // failures should not produce 200 rows of noise.
            if (errors.length < 20) {
              errors.push({
                type: 'item_failed',
                message: result.reason ?? 'unknown item failure',
                retryable: false,
                occurredAt: new Date(),
                context: { url: draft.url },
              });
            }
            break;
        }

        if (stats.jobsDiscovered >= maxItems) {
          logger.info('Reached item limit for this run', { maxItems });
          break;
        }
        if (controller.signal.aborted) {
          errors.push({
            type: 'time_budget_exceeded',
            message: `Run exceeded its ${budgetMs}ms budget`,
            retryable: true,
            occurredAt: new Date(),
          });
          break;
        }
      }
    } catch (error) {
      // ── 10. Source-level failure ────────────────────────────────────────
      const classified = classifyError(error);
      stats.errorCount += 1;
      errors.push({
        type: classified.kind,
        message: classified.message,
        retryable: classified.retryable,
        occurredAt: new Date(),
        context: classified.context,
      });
      logger.error('Source run failed', { err: classified, kind: classified.kind });
    } finally {
      clearTimeout(budgetTimer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }

    stats.httpRequests = http.stats.requests;
    stats.bytesFetched = http.stats.bytes;

    // ── 11. Finish the run ────────────────────────────────────────────────
    const status = decideStatus(stats, errors);
    await this.deps.sources.completeRun(run.id, { status, stats, errors });

    // Persist the cursor only on a clean run: saving a watermark from a
    // partial crawl would silently skip everything the failure missed.
    if (summary && typeof summary === 'object' && 'cursor' in summary && status === 'success') {
      await this.deps.sources.update(sourceId, {
        cursor: summary.cursor ?? null,
      } as never);
    }

    // ── 12. Emit events ───────────────────────────────────────────────────

    /*
     * Per-job events, carrying the job id and the trace id.
     *
     * This is what makes a posting traceable from the source that produced it
     * to the email that mentioned it: without a `job_id` on an event, "show me
     * everything that happened to this job" has no index to run against and the
     * console can only show aggregates.
     *
     * Emitted after the loop rather than inside it, and capped: a run that
     * discovers ten thousand postings should not write ten thousand rows before
     * it can finish, and the first two hundred are enough to diagnose one.
     */
    for (const event of jobEvents.slice(0, JOB_EVENT_CAP)) {
      await this.deps.events.emit(event.name, {
        sourceId,
        runId: run.id,
        traceId,
        jobId: event.jobId,
        severity: event.severity,
        message: event.message,
      });
    }
    if (jobEvents.length > JOB_EVENT_CAP) {
      await this.deps.events.emit('SOURCE_RUN_COMPLETED', {
        sourceId,
        runId: run.id,
        traceId,
        severity: 'info',
        message: `Per-job events truncated: ${jobEvents.length - JOB_EVENT_CAP} not recorded`,
        data: { emitted: JOB_EVENT_CAP, total: jobEvents.length },
      });
    }

    await this.deps.events.emit(
      status === 'failed' ? 'SOURCE_RUN_FAILED' : 'SOURCE_RUN_COMPLETED',
      {
        sourceId,
        runId: run.id,
        traceId,
        severity: status === 'failed' ? 'error' : 'info',
        message: `Discovery ${status} for ${source.displayName}`,
        data: { ...stats, status },
      },
    );

    const durationMs = Date.now() - startedAt;
    logger.info('Source run finished', { status, durationMs, ...stats });

    // Observability, best-effort. A metrics write that could fail the run it is
    // measuring would make the system less reliable for being watched.
    if (this.deps.ops) {
      try {
        await this.deps.ops.recordSample({ operation: 'discovery', valueMs: durationMs, sourceId });
        if (stats.httpRequests > 0) {
          await this.deps.ops.recordHttpOutcomes({
            sourceId,
            requests: stats.httpRequests,
            // Transport-level outcomes: an HTTP 200 that yielded an unusable
            // posting is a success here and a rejection in the pipeline stats.
            succeeded: Math.max(0, stats.httpRequests - stats.errorCount),
            failed: Math.min(stats.errorCount, stats.httpRequests),
            rateLimited: errors.filter((error) => error.type === 'rate_limited').length,
          });
        }
      } catch (error) {
        logger.debug('Metrics write skipped', { err: error });
      }
    }

    /*
     * Acquisition bookkeeping, also best-effort.
     *
     * `emptyScans` is the interesting counter: a source that returns nothing
     * new for several consecutive runs is a candidate for a longer interval,
     * and the adaptive scheduler reads this rather than re-deriving it.
     */
    if (this.deps.acquisition) {
      try {
        await this.deps.acquisition.recordReliability(sourceId, {
          requestsAttempted: stats.httpRequests,
          requestsSucceeded: Math.max(0, stats.httpRequests - stats.errorCount),
          requestsFailed: Math.min(stats.errorCount, stats.httpRequests),
          itemsSeen: stats.jobsDiscovered,
          itemsParsed: stats.jobsAccepted + stats.jobsUpdated + stats.jobsDuplicated,
          itemsRejected: stats.jobsRejected,
          jobsYielded: stats.jobsAccepted + stats.jobsUpdated,
          duplicates: stats.jobsDuplicated,
          rateLimitHits: errors.filter((error) => error.type === 'rate_limited').length,
          timeouts: errors.filter((error) => error.type === 'timeout').length,
          averageLatencyMs: stats.httpRequests > 0 ? durationMs / stats.httpRequests : 0,
        });

        if (status === 'success') {
          const previous = await this.deps.acquisition.getWatermark(sourceId);
          const producedSomething = stats.jobsAccepted + stats.jobsUpdated > 0;

          await this.deps.acquisition.saveWatermark({
            ...previous,
            sourceId,
            lastSuccessfulScanAt: new Date(),
            emptyScans: producedSomething ? 0 : previous.emptyScans + 1,
          });
        }
      } catch (error) {
        logger.debug('Acquisition bookkeeping skipped', { err: error });
      }
    }

    return { runId: run.id, sourceId, status, stats, errors, durationMs };
  }

  private skipped(
    runId: string,
    sourceId: string,
    reason: string,
    stats: RunResult['stats'],
    startedAt: number,
  ): RunResult {
    this.deps.logger.warn('Source run skipped', { sourceId, reason });
    return {
      runId,
      sourceId,
      status: 'skipped',
      stats,
      errors: [],
      durationMs: Date.now() - startedAt,
      skippedReason: reason,
    };
  }

  private async recordConfigFailure(sourceId: string, reason: string, traceId: string): Promise<void> {
    await this.deps.sources.update(sourceId, {
      healthStatus: 'failing',
      lastErrorMessage: reason,
    } as never);
    await this.deps.events.emit('SOURCE_RUN_SKIPPED', {
      sourceId,
      traceId,
      severity: 'error',
      message: reason,
    });
  }

  /** Database row → the validated domain shape connectors receive. */
  private toJobSource(row: Record<string, unknown>): JobSource {
    return jobSourceSchema.parse({
      id: row.id,
      connectorId: row.connectorId,
      displayName: row.displayName,
      sourceType: row.sourceType,
      accessTier: row.accessTier,
      enabled: row.enabled,
      priority: row.priority,
      scheduleCron: row.scheduleCron,
      config: row.config ?? {},
      limits: row.limits ?? {},
      credentialRefs: row.credentialRefs ?? [],
      restrictionReason: row.restrictionReason ?? null,
      baseUrl: row.baseUrl ?? null,
      notes: row.notes ?? null,
    });
  }
}

/**
 * A run that discovered nothing but errored is `failed`; one that produced
 * results despite errors is `partial`. The distinction drives the circuit
 * breaker, so conflating them would either mask outages or trip on noise.
 */
function decideStatus(
  stats: RunResult['stats'],
  errors: RunErrorDetail[],
): 'success' | 'partial' | 'failed' {
  const produced = stats.jobsAccepted + stats.jobsUpdated + stats.jobsDuplicated;
  if (errors.length === 0) return 'success';
  if (produced === 0) return 'failed';
  return 'partial';
}
