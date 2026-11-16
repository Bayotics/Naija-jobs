import type { SourceHealthStatus } from '@job-intel/contracts';
import type { DiscoveryRepository, SourceRepository } from '@job-intel/db';
import { isValidCron, nextRunAt } from './scheduler';

/**
 * Source health (Part 18).
 *
 * Derived on read rather than stored, so it cannot go stale. The interesting
 * signal here is **yield**: a source whose HTTP requests succeed while its job
 * count falls to zero has almost certainly changed its markup or its API. That
 * is invisible to an ordinary up/down check and is the single most valuable
 * alert this system has.
 */

export interface SourceHealthReport {
  sourceId: string;
  displayName: string;
  connectorId: string;
  accessTier: string;
  enabled: boolean;
  status: SourceHealthStatus;
  circuitState: string;

  lastRunAt: Date | null;
  lastSuccessfulRunAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;

  scheduleCron: string;
  nextDueAt: Date | null;
  scheduleValid: boolean;

  /** Rolling window statistics. */
  runsInWindow: number;
  successRate: number | null;
  averageDurationMs: number | null;
  jobsDiscoveredInWindow: number;
  jobsPersistedRecently: number;

  /** True when requests succeed but nothing is being extracted. */
  yieldWarning: boolean;
  notes: string[];
}

export interface HealthOptions {
  /** Rolling window for run statistics. */
  windowHours?: number;
  /** Runs inspected per source. */
  runSampleSize?: number;
}

export class SourceHealthService {
  constructor(
    private readonly deps: { sources: SourceRepository; discovery: DiscoveryRepository },
  ) {}

  async report(options: HealthOptions = {}): Promise<SourceHealthReport[]> {
    const windowHours = options.windowHours ?? 24;
    const sampleSize = options.runSampleSize ?? 20;
    const sources = await this.deps.sources.list({ includeArchived: false });

    return Promise.all(
      sources.map((source) => this.reportFor(source, windowHours, sampleSize)),
    );
  }

  async reportForSource(
    sourceId: string,
    options: HealthOptions = {},
  ): Promise<SourceHealthReport | null> {
    const source = await this.deps.sources.get(sourceId);
    if (!source) return null;
    return this.reportFor(source, options.windowHours ?? 24, options.runSampleSize ?? 20);
  }

  private async reportFor(
    source: Awaited<ReturnType<SourceRepository['get']>> & object,
    windowHours: number,
    sampleSize: number,
  ): Promise<SourceHealthReport> {
    const runs = await this.deps.sources.listRuns(source.id, sampleSize);
    const cutoff = Date.now() - windowHours * 3_600_000;
    const inWindow = runs.filter((r) => r.startedAt.getTime() >= cutoff);

    const completed = inWindow.filter((r) => r.completedAt !== null);
    const successes = completed.filter((r) => r.status === 'success' || r.status === 'partial');
    const durations = completed
      .map((r) => r.durationMs)
      .filter((d): d is number => typeof d === 'number');

    const jobsDiscoveredInWindow = inWindow.reduce((sum, r) => sum + r.jobsDiscovered, 0);
    const httpRequestsInWindow = inWindow.reduce((sum, r) => sum + r.httpRequests, 0);
    const jobsPersistedRecently = await this.deps.discovery.countRecentJobs(source.id, windowHours);

    const lastFailure = runs.find((r) => r.status === 'failed');
    const scheduleValid = isValidCron(source.scheduleCron);

    // Requests are going out and succeeding, but nothing is coming back.
    const yieldWarning =
      completed.length > 0 &&
      successes.length > 0 &&
      httpRequestsInWindow > 0 &&
      jobsDiscoveredInWindow === 0;

    const notes: string[] = [];
    if (yieldWarning) {
      notes.push(
        'Requests are succeeding but no jobs are being extracted — the source has probably changed its structure.',
      );
    }
    if (!scheduleValid) notes.push(`Invalid cron expression: "${source.scheduleCron}"`);
    if (source.circuitState === 'open') notes.push('Circuit breaker is open; scheduling skips this source.');
    if (source.accessTier === 'restricted') {
      notes.push(source.restrictionReason ?? 'Registered as restricted and never fetched.');
    }
    if (source.credentialRefs.length > 0) {
      notes.push(`Requires credentials: ${source.credentialRefs.join(', ')}`);
    }

    return {
      sourceId: source.id,
      displayName: source.displayName,
      connectorId: source.connectorId,
      accessTier: source.accessTier,
      enabled: source.enabled,
      status: source.healthStatus,
      circuitState: source.circuitState,

      lastRunAt: source.lastAttemptedRunAt,
      lastSuccessfulRunAt: source.lastSuccessfulRunAt,
      lastFailureAt: lastFailure?.startedAt ?? source.lastErrorAt,
      lastErrorMessage: source.lastErrorMessage,
      consecutiveFailures: source.consecutiveFailures,

      scheduleCron: source.scheduleCron,
      nextDueAt: source.lastAttemptedRunAt
        ? nextRunAt(source.scheduleCron, source.lastAttemptedRunAt)
        : new Date(),
      scheduleValid,

      runsInWindow: inWindow.length,
      successRate: completed.length > 0 ? successes.length / completed.length : null,
      averageDurationMs:
        durations.length > 0
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : null,
      jobsDiscoveredInWindow,
      jobsPersistedRecently,

      yieldWarning,
      notes,
    };
  }
}
