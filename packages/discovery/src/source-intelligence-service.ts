import {
  NON_SCHEDULABLE_STATES,
  sourceCapabilitiesSchema,
  planIncrementalScan,
  scoreSourceHealth,
  type AcquisitionSourceState,
  type JobSource,
  type SourceHealthAssessment,
  type SourceRegistryEntry,
  type SourceWatermark,
} from '@job-intel/contracts';
import type { AcquisitionRepository, SourceRepository } from '@job-intel/db';
import type { Logger } from '@job-intel/observability';
import {
  findPlatformStrategy,
  preferredMethod,
  resolvePolicy,
  suggestedAlternatives,
  toSourceCapabilities,
  type ConnectorRegistry,
} from '@job-intel/connectors';

/**
 * The source registry, assembled.
 *
 * Part 2 asks for a registry that knows what every source is, what it can do,
 * what it needs and how healthy it is — and asks explicitly that source logic
 * stay out of the scheduler. This service is where those facts are joined:
 * connector declarations (static), database rows (configuration), reliability
 * counters (observed) and watermarks (progress).
 *
 * The scheduler consumes `schedulable()` and never touches a connector. That is
 * the property that makes source #100 cheap: it appears in this list because it
 * was registered and has a row, and nothing else in the system had to learn its
 * name.
 */

export interface SourceIntelligenceDependencies {
  registry: ConnectorRegistry;
  sources: SourceRepository;
  acquisition: AcquisitionRepository;
  logger: Logger;
  getSecret(name: string): string | undefined;
}

/** One source, fully described, for the dashboard and the scheduler. */
export interface SourceIntelligence {
  entry: SourceRegistryEntry;
  health: SourceHealthAssessment;
  watermark: SourceWatermark;

  /** How this source will actually be reached, or null when it is not. */
  method: string | null;

  /** Why it will not run, when it will not. */
  blockedReason: string | null;

  /** What to enable instead, for restricted platforms. */
  alternatives: string[];

  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;

  /** Observed counters behind the health score. */
  metrics: {
    requestsAttempted: number;
    requestsSucceeded: number;
    itemsSeen: number;
    itemsParsed: number;
    parseSuccessRate: number;
    jobsYielded: number;
    duplicateRate: number;
    rateLimitHits: number;
    timeouts: number;
    averageLatencyMs: number;
  };
}

/** `job_sources.priority` (0 highest) as the registry's named levels. */
const PRIORITY_LABELS: Readonly<Record<number, SourceRegistryEntry['priority']>> = {
  0: 'very_high',
  1: 'high',
  2: 'medium',
  3: 'low',
};

export class SourceIntelligenceService {
  constructor(private readonly deps: SourceIntelligenceDependencies) {}

  /**
   * Decides what state a source is in, before looking at any metrics.
   *
   * Order is the whole content of this function. A source that is disabled is
   * disabled whatever its credentials say; a restricted source is restricted
   * whatever its configuration says; and a source missing credentials is
   * `AUTH_REQUIRED` rather than `FAILING`, because the two send an operator to
   * completely different places. Only when none of these apply do the observed
   * metrics get a vote.
   */
  private declaredState(
    source: JobSource,
    connectorId: string,
  ): { state: AcquisitionSourceState | null; reason: string | null } {
    const connector = this.deps.registry.find(connectorId);

    if (!connector) {
      return { state: 'NOT_CONFIGURED', reason: `No connector registered as "${connectorId}".` };
    }

    const policy = resolvePolicy(connector);

    if (!policy.fetchable) {
      return {
        state: 'RESTRICTED',
        reason:
          policy.accessPolicy.reason ??
          'No permitted acquisition method is available for this source.',
      };
    }

    if (!source.enabled) {
      return { state: 'DISABLED', reason: 'Turned off in the control centre.' };
    }

    const parsed = connector.configSchema.safeParse(source.config);

    if (!parsed.success) {
      return {
        state: 'NOT_CONFIGURED',
        reason: `Configuration is invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}.`,
      };
    }

    const availability = connector.availability({
      config: parsed.data as never,
      getSecret: (name) => this.deps.getSecret(name),
    });

    if (!availability.available) {
      /*
       * Missing credentials are distinguished from every other unavailability.
       *
       * The `requires` list names environment variables, so an operator reading
       * the dashboard is told exactly what to set rather than being told the
       * source is broken.
       */
      const needsCredentials = availability.requires.length > 0;

      return {
        state: needsCredentials ? 'AUTH_REQUIRED' : 'NOT_CONFIGURED',
        reason: availability.reason ?? 'The source reported itself unavailable.',
      };
    }

    return { state: null, reason: null };
  }

  /** Everything known about one source. */
  async describe(source: JobSource, sinceHours = 24): Promise<SourceIntelligence> {
    const connector = this.deps.registry.find(source.connectorId);
    const declared = this.declaredState(source, source.connectorId);

    const [reliability, watermark] = await Promise.all([
      this.deps.acquisition.reliabilityFor(source.id, sinceHours),
      this.deps.acquisition.getWatermark(source.id),
    ]);

    const hoursSinceSuccess = watermark.lastSuccessfulScanAt
      ? (Date.now() - watermark.lastSuccessfulScanAt.getTime()) / 3_600_000
      : null;

    const health = scoreSourceHealth(reliability, {
      ...(declared.state ? { state: declared.state } : {}),
      hoursSinceSuccess,
      expectedIntervalHours: 24,
    });

    const policy = connector ? resolvePolicy(connector) : null;
    const platform = findPlatformStrategy(source.connectorId) ?? findPlatformStrategy(source.id);

    const entry: SourceRegistryEntry = {
      sourceId: source.id,
      sourceName: source.displayName,
      sourceType: policy?.acquisitionType ?? 'CUSTOM_CONNECTOR',
      connectorId: source.connectorId,
      enabled: source.enabled,
      capabilities: connector ? toSourceCapabilities(connector) : sourceCapabilitiesSchema.parse({}),
      auth: policy?.auth ?? { strategy: 'NONE', credentialRefs: [], scopes: [], setupUrl: null, instructions: null },
      accessPolicy: policy?.accessPolicy ?? {
        permitted: [],
        reason: 'No connector is registered for this source.',
        alternatives: [],
        honoursRobots: true,
        reviewedAt: null,
      },
      rateLimit: policy?.rateLimit ?? {
        requestsPerMinute: 20,
        requestsPerHour: 500,
        requestsPerDay: 5_000,
        maxConcurrent: 2,
        minIntervalMs: 1_000,
        honourRetryAfter: true,
      },
      contentLimits: policy?.contentLimits ?? ({} as SourceRegistryEntry['contentLimits']),
      /*
       * `job_sources.priority` is a 0–3 integer; the registry entry names the
       * levels. Mapped rather than widened, because a number silently
       * reinterpreted as a label is the kind of mismatch that produces a
       * dashboard confidently showing the wrong thing.
       */
      priority: PRIORITY_LABELS[source.priority] ?? 'medium',
      config: source.config,
      state: health.state,
      healthScore: health.score,
      lastSuccessAt: watermark.lastSuccessfulScanAt,
      lastFailureAt: null,
      lastError: source.restrictionReason ?? null,
    };

    const parseSuccessRate =
      reliability.itemsSeen === 0 ? 0 : reliability.itemsParsed / reliability.itemsSeen;
    const duplicateRate =
      reliability.jobsYielded === 0 ? 0 : reliability.duplicates / reliability.jobsYielded;

    return {
      entry,
      health,
      watermark,
      method: policy ? preferredMethod(policy.accessPolicy) : null,
      blockedReason: declared.reason,
      /*
       * Alternatives come from the platform strategy when the source names a
       * known platform, and from the global suggestion list otherwise. A
       * restricted source that offers no way forward is a dead end on the
       * dashboard; one that names three is a task.
       */
      alternatives: platform
        ? [...platform.alternatives]
        : declared.state === 'RESTRICTED'
          ? suggestedAlternatives()
          : [],
      lastSuccessAt: watermark.lastSuccessfulScanAt,
      lastFailureAt: null,
      lastError: source.restrictionReason ?? null,
      metrics: {
        requestsAttempted: reliability.requestsAttempted,
        requestsSucceeded: reliability.requestsSucceeded,
        itemsSeen: reliability.itemsSeen,
        itemsParsed: reliability.itemsParsed,
        parseSuccessRate,
        jobsYielded: reliability.jobsYielded,
        duplicateRate,
        rateLimitHits: reliability.rateLimitHits,
        timeouts: reliability.timeouts,
        averageLatencyMs: reliability.averageLatencyMs,
      },
    };
  }

  /** Every registered source, described. */
  async describeAll(sinceHours = 24): Promise<SourceIntelligence[]> {
    const sources = await this.deps.sources.list({});

    const described = await Promise.all(
      sources.map((source) =>
        this.describe(source, sinceHours).catch((error): SourceIntelligence | null => {
          /*
           * One source failing to describe itself must not blank the dashboard.
           * The same isolation rule that governs fetching governs reporting.
           */
          this.deps.logger.warn('Could not describe source', {
            sourceId: source.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }),
      ),
    );

    return described
      .filter((entry): entry is SourceIntelligence => entry !== null)
      .sort((a, b) => b.health.score - a.health.score);
  }

  /**
   * Sources the scheduler may run.
   *
   * The scheduler calls this and nothing else. It never asks whether a source
   * is LinkedIn, whether it needs a token, or whether its terms permit
   * fetching — those questions are all answered here, in one place, from data.
   */
  async schedulable(): Promise<SourceIntelligence[]> {
    const all = await this.describeAll();
    return all.filter((entry) => !NON_SCHEDULABLE_STATES.includes(entry.entry.state));
  }

  /**
   * How a source's next scan should be requested.
   *
   * Returns the plan rather than performing it, so the decision — incremental
   * from a cursor, incremental from a date, or a full re-read — is loggable and
   * testable without a network.
   */
  async scanPlanFor(sourceId: string) {
    const source = await this.deps.sources.get(sourceId);
    if (!source) return null;

    const connector = this.deps.registry.find(source.connectorId);
    if (!connector) return null;

    const watermark = await this.deps.acquisition.getWatermark(sourceId);

    /*
     * Translated rather than cast.
     *
     * The connector declares `supportsIncremental`; the planner reads
     * `supportsIncrementalSync`. Casting between the two shapes compiled fine
     * and made every source report that it could not sync incrementally — a
     * silent, system-wide regression to full scans.
     */
    return planIncrementalScan(watermark, toSourceCapabilities(connector), {
      maxIncrementalGapHours: 72,
    });
  }

  /**
   * A one-line summary for the operations dashboard.
   *
   * Counts by state rather than an average health score, because "four sources
   * need credentials" is actionable and "average health 62" is not.
   */
  async summary(): Promise<{
    total: number;
    byState: Record<AcquisitionSourceState, number>;
    schedulable: number;
    needingAttention: SourceIntelligence[];
  }> {
    const all = await this.describeAll();

    const byState = {
      HEALTHY: 0,
      DEGRADED: 0,
      FAILING: 0,
      DISABLED: 0,
      NOT_CONFIGURED: 0,
      AUTH_REQUIRED: 0,
      RESTRICTED: 0,
    } as Record<AcquisitionSourceState, number>;

    for (const entry of all) byState[entry.entry.state] += 1;

    /*
     * "Needing attention" excludes restricted and disabled sources.
     *
     * Both are working as intended — a restricted source is a decision, not a
     * fault — and listing them alongside genuine failures would train an
     * operator to ignore the list.
     */
    const needingAttention = all.filter(
      (entry) =>
        entry.entry.state === 'FAILING' ||
        entry.entry.state === 'AUTH_REQUIRED' ||
        entry.entry.state === 'NOT_CONFIGURED',
    );

    return {
      total: all.length,
      byState,
      schedulable: all.filter((entry) => !NON_SCHEDULABLE_STATES.includes(entry.entry.state)).length,
      needingAttention,
    };
  }
}
