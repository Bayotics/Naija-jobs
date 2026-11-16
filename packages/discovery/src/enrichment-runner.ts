import type { SalaryPeriod } from '@job-intel/contracts';
import type { EnrichmentRepository } from '@job-intel/db';
import type { EventRecorder, Logger } from '@job-intel/observability';
import {
  ENRICHMENT_VERSION,
  enrichJob,
  NullAiProvider,
  type AiExtractionProvider,
  type AiGateOptions,
} from '@job-intel/enrichment';

/**
 * Asynchronous enrichment.
 *
 * Discovery persists a job and returns; enrichment happens afterwards, off the
 * crawl path. That separation is the point — extraction is CPU-bound and, when
 * AI is enabled, network-bound, and doing it inline would slow every crawl to
 * the speed of its slowest posting.
 *
 * Two guarantees:
 *
 *  - **Idempotent.** Re-running over the same jobs upserts one enrichment row
 *    each. Safe to retry, safe to run concurrently with discovery.
 *  - **Isolated.** One job that throws is recorded and skipped; the batch
 *    continues. A single bad posting cannot stall the queue.
 */

export interface EnrichmentRunnerDependencies {
  enrichment: EnrichmentRepository;
  logger: Logger;
  events: EventRecorder;
  aiProvider?: AiExtractionProvider;
  /**
   * Optional operations sink for per-job latency.
   *
   * Per job, not per batch: a batch mean cannot be turned back into a p99, and
   * the tail is what makes a nightly run miss its window. Optional so a metrics
   * write can never be the reason enrichment fails.
   */
  ops?: { recordSample(input: { operation: string; valueMs: number }): Promise<void> };
}

export interface EnrichmentRunOptions {
  /** Jobs per batch. */
  limit?: number;
  /** Specific jobs to enrich, bypassing the pending query. */
  jobIds?: string[];
  aiGate?: Partial<AiGateOptions>;
  /** Re-enrich even when already at the current version. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface EnrichmentRunResult {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  aiCalls: number;
  aiFailures: number;
  totalDurationMs: number;
  averageDurationMs: number;
  /** Bounded sample of failures, for the operator. */
  failures: Array<{ jobId: string; error: string }>;
}

export class EnrichmentRunner {
  constructor(private readonly deps: EnrichmentRunnerDependencies) {}

  async run(options: EnrichmentRunOptions = {}): Promise<EnrichmentRunResult> {
    const startedAt = Date.now();
    const result: EnrichmentRunResult = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      aiCalls: 0,
      aiFailures: 0,
      totalDurationMs: 0,
      averageDurationMs: 0,
      failures: [],
    };

    const pending = await this.deps.enrichment.findPending({
      limit: options.limit ?? 100,
      // `force` re-enriches everything by claiming a higher current version.
      currentVersion: options.force ? ENRICHMENT_VERSION + 1 : ENRICHMENT_VERSION,
    });

    const targets = options.jobIds
      ? pending.filter((job) => options.jobIds?.includes(job.id))
      : pending;

    if (targets.length === 0) {
      this.deps.logger.debug('Enrichment: nothing pending');
      return result;
    }

    // Shared so the AI budget is per-run rather than per-job.
    const aiCallCounter = { count: 0 };
    const provider = this.deps.aiProvider ?? new NullAiProvider();
    const durations: number[] = [];

    for (const job of targets) {
      if (options.signal?.aborted) break;
      result.processed += 1;

      try {
        const enrichment = await enrichJob(
          {
            jobId: job.id,
            title: job.title,
            companyName: job.companyNameRaw,
            companyWebsite: job.companyWebsite,
            description: job.description,
            descriptionHtml: job.descriptionHtml,
            locationText: job.locationRaw,
            remoteFlag: job.remoteType === 'remote' ? true : job.remoteType === 'onsite' ? false : null,
            sourceUrl: job.sourceUrl,
            applyUrl: job.applyUrl,
            salaryText: null,
            salaryMin: job.salaryMin !== null ? Number(job.salaryMin) : null,
            salaryMax: job.salaryMax !== null ? Number(job.salaryMax) : null,
            salaryCurrency: job.salaryCurrency,
            salaryPeriod: job.salaryPeriod as SalaryPeriod | null,
            tags: job.techStack ?? [],
          },
          {
            aiProvider: provider,
            ...(options.aiGate ? { aiGate: options.aiGate } : {}),
            aiCallCounter,
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );

        await this.deps.enrichment.save(job.id, enrichment);

        durations.push(enrichment.totalDurationMs);
        result.succeeded += 1;
        if (enrichment.aiUsed) result.aiCalls += 1;
        if (enrichment.aiError) result.aiFailures += 1;

        await this.deps.events.emit('JOB_NORMALIZED', {
          jobId: job.id,
          sourceId: job.sourceId,
          message: `Enriched: ${enrichment.normalizedTitle}`,
          data: {
            roleSlug: enrichment.roleSlug,
            seniority: enrichment.seniority,
            workMode: enrichment.workArrangement.mode,
            skills: enrichment.skills.length,
            qualityScore: enrichment.quality.qualityScore,
            scamScore: enrichment.quality.scamScore,
            aiUsed: enrichment.aiUsed,
            durationMs: enrichment.totalDurationMs,
          },
        });

        // Quarantine is a flag, never a delete. The ranking engine decides how
        // harshly to penalise; here we only make the signal visible.
        if (enrichment.quality.scamScore >= 0.6) {
          await this.deps.events.emit('JOB_QUARANTINED', {
            jobId: job.id,
            severity: 'warn',
            message: `High scam score (${enrichment.quality.scamScore})`,
            data: { flags: enrichment.quality.flags.map((f) => f.flag) },
          });
        }
      } catch (error) {
        // One job failing must not stop the batch.
        const message = error instanceof Error ? error.message : String(error);
        result.failed += 1;
        if (result.failures.length < 20) {
          result.failures.push({ jobId: job.id, error: message.slice(0, 300) });
        }
        this.deps.logger.error('Enrichment failed for job', { jobId: job.id, err: error });
        await this.deps.enrichment.markFailed(job.id, message).catch(() => undefined);
      }
    }

    result.totalDurationMs = Date.now() - startedAt;
    result.averageDurationMs =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;

    if (this.deps.ops) {
      try {
        for (const valueMs of durations) {
          await this.deps.ops.recordSample({ operation: 'enrichment', valueMs });
        }
      } catch (error) {
        this.deps.logger.debug('Enrichment metrics write skipped', { err: error });
      }
    }

    this.deps.logger.info('Enrichment batch complete', {
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
      aiCalls: result.aiCalls,
      averageDurationMs: result.averageDurationMs,
    });

    return result;
  }
}
