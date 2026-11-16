import {
  discoveryProvenanceSchema,
  DEFAULT_SOURCE_CAPABILITIES,
  METHOD_PREFERENCE,
  discoveryConfidenceConfigSchema,
  type CoverageReport,
  type DiscoveryConfidenceConfig,
  type DiscoveryMethod,
  type DiscoveryProvenance,
  type QueryPlan,
  type ScheduleDecision,
  type SourceCapabilities,
  type SourceDetectionResult,
  type UserProvidedSource,
} from '@job-intel/contracts';
import type {
  CandidateRepository,
  DiscoveryFrameworkRepository,
  ProfileRepository,
  SourceRepository,
} from '@job-intel/db';
import type { ConnectorRegistry, HttpClient } from '@job-intel/connectors';
import { detectSource, findCareersPages, detectAts } from '@job-intel/connectors';
import type { EventRecorder, Logger } from '@job-intel/observability';
import { planQueries, prioritiseByHistory, ATS_SEARCH_DOMAINS } from './strategy/query-planner';
import { buildCoverage } from './framework/coverage';
import { decideSchedule, orderByValue, scoreSourceValue } from './framework/adaptive-scheduler';
import { DiscoveryBudgetTracker } from './framework/budget';

/**
 * The discovery framework service.
 *
 * Composes the pieces the rest of the system uses: plan queries from
 * preferences, decide what to run and when, validate a URL an operator typed,
 * resolve a company to a source, and report coverage.
 *
 * It deliberately does *not* execute discovery — `SourceRunner` already does
 * that, and duplicating it here would create two places where politeness,
 * robots and failure isolation have to be right.
 */

export interface DiscoveryFrameworkDependencies {
  framework: DiscoveryFrameworkRepository;
  sources: SourceRepository;
  profiles: ProfileRepository;
  candidates: CandidateRepository;
  registry: ConnectorRegistry;
  logger: Logger;
  events: EventRecorder;
  /** For detection and careers probing. Politeness is enforced inside it. */
  http: HttpClient;
  confidence?: Partial<DiscoveryConfidenceConfig>;
}

export class DiscoveryFrameworkService {
  private readonly confidence: DiscoveryConfidenceConfig;

  constructor(private readonly deps: DiscoveryFrameworkDependencies) {
    this.confidence = discoveryConfidenceConfigSchema.parse(deps.confidence ?? {});
  }

  // ── Query planning ────────────────────────────────────────────────────────

  /**
   * Generates and persists a query plan for the active candidate.
   *
   * Historical performance re-orders the plan but never replaces it: an
   * explicit preference outranks anything the system has learned, which is the
   * same rule the matching engine holds to for behavioural signals.
   */
  async planFor(profileId: string, options: { maxQueries?: number } = {}): Promise<QueryPlan> {
    const stored = await this.deps.candidates.getActivePreferences(profileId);
    if (!stored) {
      throw new Error(`No active preferences for profile ${profileId}`);
    }

    // A profile with a current title but no stated *target* titles is the
    // common case for someone who has not curated their preferences yet. Using
    // it as a fallback is the difference between a plan with high-priority
    // title queries and one with none at all.
    const profile = await this.deps.profiles.getActiveProfile().catch(() => null);
    const currentTitle = profile?.payload?.professional?.currentTitle ?? null;

    const base = planQueries({
      profileId,
      preferences: stored.preferences,
      preferenceVersion: stored.version,
      fallbackTitle: currentTitle,
      ...(options.maxQueries !== undefined ? { config: { maxQueries: options.maxQueries } } : {}),
      targetDomains: ATS_SEARCH_DOMAINS,
    });

    const history = await this.deps.framework.queryHistory(profileId);
    const plan = history.size > 0 ? prioritiseByHistory(base, history) : base;

    await this.deps.framework.savePlan(plan);
    await this.deps.framework.retireQueriesOutsidePlan(
      profileId,
      plan.queries.map((query) => query.id),
    );

    await this.deps.events.emit('CONFIG_CHANGED', {
      message: `Planned ${plan.queries.length} discovery query(ies)`,
      data: {
        profileId,
        queries: plan.queries.length,
        dropped: plan.droppedCount,
        preferenceVersion: stored.version,
      },
    });

    return plan;
  }

  // ── Capabilities and mechanism selection ──────────────────────────────────

  /**
   * Records what each source can do, and which mechanism it is being driven by.
   *
   * The capability row is derived from the connector but stored per source,
   * because a source can be more limited than its connector — the same RSS
   * connector serves a feed that sends ETags and one that does not.
   */
  async refreshCapabilities(): Promise<number> {
    const sources = await this.deps.sources.list({ includeArchived: false });
    let updated = 0;

    for (const source of sources) {
      const connector = this.deps.registry.find(source.connectorId);
      if (!connector) continue;

      const capabilities = toSourceCapabilities(connector.capabilities, source.accessTier);
      const methods = methodsFor(source.sourceType, source.accessTier);

      await this.deps.framework.saveCapabilities({
        sourceId: source.id,
        capabilities,
        methods,
        activeMethod: methods[0] ?? null,
        detail: `${connector.displayName} via ${methods[0] ?? 'unknown'}`,
      });
      updated += 1;
    }

    return updated;
  }

  /** Discovery confidence for one record, with the adjustments named. */
  scoreConfidence(input: {
    method: DiscoveryMethod;
    connectorId: string;
    sourceId: string;
    queryId?: string | null;
    aiClassified?: boolean;
    snippetOnly?: boolean;
    inferredFields?: number;
    extractedBy?: string | null;
  }): DiscoveryProvenance {
    const adjustments: string[] = [];
    let confidence = this.confidence.byMethod[input.method] ?? 0.5;

    if (input.aiClassified) {
      // A model decided this is a job. That caps confidence regardless of how
      // the bytes arrived — the mechanism was reliable, the judgement was not
      // the publisher's.
      const capped = Math.min(confidence, this.confidence.aiClassifiedCeiling);
      if (capped < confidence) {
        adjustments.push(`capped at ${capped} because a model classified it`);
        confidence = capped;
      }
    }

    if (input.snippetOnly) {
      confidence -= this.confidence.snippetOnlyPenalty;
      adjustments.push('page never loaded; only a search snippet was available');
    }

    if (input.inferredFields && input.inferredFields > 0) {
      const penalty = this.confidence.inferredFieldPenalty * Math.min(input.inferredFields, 3);
      confidence -= penalty;
      adjustments.push(`${input.inferredFields} field(s) inferred rather than stated`);
    }

    /*
     * Parsed rather than constructed, so the acquisition-trail fields added in
     * Prompt 16 arrive at their defaults instead of having to be repeated at
     * every call site.
     */
    return discoveryProvenanceSchema.parse({
      method: input.method,
      confidence: Math.max(this.confidence.floor, Math.min(1, Number(confidence.toFixed(3)))),
      connectorId: input.connectorId,
      sourceId: input.sourceId,
      queryId: input.queryId ?? null,
      extractedBy: input.extractedBy ?? null,
      aiClassified: input.aiClassified ?? false,
      adjustments,
      discoveredAt: new Date(),
    });
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  /** Cadence for every source, using health, value and unchanged streaks. */
  async schedule(): Promise<ScheduleDecision[]> {
    const [sources, performance, streaks] = await Promise.all([
      this.deps.sources.list({ includeArchived: false }),
      this.deps.framework.listPerformance(),
      this.deps.framework.unchangedStreaks(),
    ]);

    const byId = new Map(performance.map((row) => [row.sourceId, row]));

    return sources.map((source) =>
      decideSchedule({
        sourceId: source.id,
        enabled: source.enabled,
        breaker: {
          circuitState: source.circuitState,
          consecutiveFailures: source.consecutiveFailures,
          circuitOpenedAt: source.circuitOpenedAt ?? null,
        },
        circuitThreshold: source.limits?.circuitBreakerThreshold ?? 5,
        circuitCooldownSeconds: source.limits?.circuitCooldownSeconds ?? 900,
        lastRunAt: source.lastAttemptedRunAt ?? null,
        unchangedStreak: streaks.get(source.id) ?? 0,
        performance: (byId.get(source.id) as never) ?? null,
        priority: source.priority,
      }),
    );
  }

  /** Recomputes value scores from run history. */
  async refreshPerformance(windowDays = 30): Promise<number> {
    const inputs = await this.deps.framework.performanceInputs(windowDays);
    for (const input of inputs) {
      await this.deps.framework.savePerformance(scoreSourceValue(input));
    }
    return inputs.length;
  }

  /** Execution order for a budget-constrained cycle. */
  async executionOrder(): Promise<string[]> {
    const [sources, performance] = await Promise.all([
      this.deps.sources.list({ includeArchived: false, enabledOnly: true }),
      this.deps.framework.listPerformance(),
    ]);

    const byId = new Map(performance.map((row) => [row.sourceId, row]));

    return orderByValue(
      sources.map((source) => ({
        sourceId: source.id,
        performance: (byId.get(source.id) as never) ?? null,
        lastRunAt: source.lastAttemptedRunAt ?? null,
      })),
    );
  }

  // ── User-provided sources ─────────────────────────────────────────────────

  /**
   * Accepts a submitted URL and validates it. Never activates it.
   *
   * A URL typed by a human is untrusted input to a system that makes outbound
   * requests. It is stored, inspected, and turned into a *recommendation* the
   * operator confirms — one typo should not create a scheduled crawler.
   */
  async submitSource(input: UserProvidedSource): Promise<{
    id: string;
    detection: SourceDetectionResult;
  }> {
    const id = await this.deps.framework.submitUserSource(input);

    const detection = await detectSource(input.url, {
      http: this.deps.http,
      signal: new AbortController().signal,
      log: (level, message, data) => this.deps.logger[level](message, data as Record<string, unknown>),
    });

    await this.deps.framework.recordDetection(id, detection);
    return { id, detection };
  }

  /**
   * Turns a validated submission into a real source.
   *
   * Requires the submission to have been validated first: activating something
   * that failed detection would defeat the point of validating it.
   */
  async activateSource(
    id: string,
    overrides: { connectorId?: string; config?: Record<string, unknown> } = {},
  ): Promise<string> {
    const row = await this.deps.framework.getUserSource(id);
    if (!row) throw new Error(`User-provided source ${id} not found`);
    if (row.status !== 'validated') {
      throw new Error(
        `Source ${id} is ${row.status}, not validated. ${row.rejectionReason ?? ''}`.trim(),
      );
    }

    const detection = row.detection as unknown as SourceDetectionResult | null;
    const connectorId = overrides.connectorId ?? detection?.recommendedConnectorId;
    if (!connectorId) throw new Error(`No connector recommended for ${row.url}`);

    const connector = this.deps.registry.find(connectorId);
    if (!connector) throw new Error(`Unknown connector "${connectorId}"`);

    const config = overrides.config ?? detection?.recommendedConfig ?? {};
    const validated = this.deps.registry.validateConfig(connectorId, config);
    if (!validated.ok) {
      throw new Error(`Configuration is invalid: ${validated.errors.join('; ')}`);
    }

    const sourceId = `user:${new URL(row.url).hostname.replace(/^www\./, '')}:${id.slice(0, 8)}`;

    await this.deps.sources.upsert({
      id: sourceId,
      connectorId,
      displayName: row.displayName ?? new URL(row.url).hostname,
      sourceType: connector.sourceType,
      accessTier: 'user_provided',
      enabled: row.enabled,
      priority: 2,
      // Frequency the operator asked for, expressed as cron.
      scheduleCron: cronForMinutes(row.scanFrequencyMinutes),
      config: validated.value as Record<string, unknown>,
      limits: {},
      credentialRefs: [],
      restrictionReason: null,
      baseUrl: row.url,
      notes: row.notes,
    } as never);

    await this.deps.framework.markActivated(id, sourceId);
    await this.deps.events.emit('SOURCE_REGISTERED', {
      sourceId,
      message: `Activated user-provided source ${row.url}`,
      data: { connectorId, userSourceId: id },
    });

    return sourceId;
  }

  // ── Company monitoring ────────────────────────────────────────────────────

  /**
   * Resolves a company to something discoverable.
   *
   * ATS first — a Greenhouse board is one request for every open role, with
   * structured fields. Only when there is no ATS does this fall back to finding
   * a careers page, and it reports which happened.
   */
  async resolveCompany(input: { name: string; domain?: string | null; careersUrl?: string | null }): Promise<{
    status: 'resolved' | 'unresolved';
    atsProvider: string | null;
    atsIdentifier: string | null;
    careersUrl: string | null;
    detail: string;
  }> {
    const id = slug(input.domain ?? input.name);
    const signal = new AbortController().signal;

    const candidates: string[] = [];
    if (input.careersUrl) candidates.push(input.careersUrl);

    if (input.domain && candidates.length === 0) {
      const pages = await findCareersPages(input.domain, {
        http: this.deps.http,
        signal,
        log: (level, message, data) => this.deps.logger[level](message, data as Record<string, unknown>),
      });
      candidates.push(...pages.map((page) => page.url));
    }

    for (const url of candidates.slice(0, 3)) {
      let html: string | null = null;
      try {
        html = (await this.deps.http.getText(url, { signal })).data;
      } catch {
        continue;
      }

      const ats = detectAts({ url, html });
      if (ats) {
        const detail = `${ats.provider.displayName} board "${ats.identifier}"`;
        await this.deps.framework.upsertCompany({
          id,
          name: input.name,
          domain: input.domain ?? null,
          careersUrl: url,
          atsProvider: ats.provider.id,
          atsIdentifier: ats.identifier,
          status: 'resolved',
          detail,
        });
        return {
          status: 'resolved',
          atsProvider: ats.provider.id,
          atsIdentifier: ats.identifier,
          careersUrl: url,
          detail,
        };
      }
    }

    const careersUrl = candidates[0] ?? null;
    const detail = careersUrl
      ? `No ATS detected; a careers page was found at ${careersUrl}`
      : 'No careers page or ATS board could be found';

    await this.deps.framework.upsertCompany({
      id,
      name: input.name,
      domain: input.domain ?? null,
      careersUrl,
      status: careersUrl ? 'resolved' : 'unresolved',
      detail,
    });

    return {
      status: careersUrl ? 'resolved' : 'unresolved',
      atsProvider: null,
      atsIdentifier: null,
      careersUrl,
      detail,
    };
  }

  // ── Coverage ──────────────────────────────────────────────────────────────

  /**
   * Measures how much of the candidate's stated search space was addressed.
   *
   * Never a claim about the web — a report about *their* preferences, which is
   * the only coverage statement that can be verified.
   */
  async reportCoverage(profileId: string, windowHours = 24): Promise<CoverageReport> {
    const [stored, queryRows, sources, telemetry] = await Promise.all([
      this.deps.candidates.getActivePreferences(profileId),
      this.deps.framework.listQueries(profileId, { limit: 500 }),
      this.deps.sources.list({ includeArchived: false }),
      this.deps.framework.listTelemetry({ windowHours, limit: 1_000 }),
    ]);

    if (!stored) throw new Error(`No active preferences for profile ${profileId}`);

    const since = new Date(Date.now() - windowHours * 3_600_000);
    const executed = new Map<string, { discovered: number; matched: number; sourcesSearched: number; at: Date }>();

    for (const row of queryRows) {
      if (!row.lastExecutedAt || row.lastExecutedAt < since) continue;
      executed.set(row.id, {
        discovered: row.jobsDiscovered,
        matched: row.jobsMatched,
        sourcesSearched: 1,
        at: row.lastExecutedAt,
      });
    }

    const productive = new Set(
      telemetry.filter((row) => row.results > 0).map((row) => row.sourceId ?? ''),
    );
    productive.delete('');

    // A preference nobody can search is a different problem from one nobody
    // did search, and the report says which.
    const unavailable = sources.filter((source) => !source.enabled || source.accessTier === 'restricted');
    const uncoveredByCapability =
      sources.length === 0
        ? [{ dimension: 'title' as const, value: 'any', detail: 'No sources are registered at all' }]
        : [];

    const plan = planQueries({
      profileId,
      preferences: stored.preferences,
      preferenceVersion: stored.version,
    });

    const report = buildCoverage({
      profileId,
      preferences: stored.preferences,
      // Coverage is measured against the *persisted* queries, so a plan
      // regenerated a moment ago does not read as fully covered.
      plan: { ...plan, queries: queryRows as never },
      windowHours,
      observation: {
        executedQueries: executed,
        sourcesAvailable: sources.length - unavailable.length,
        sourcesProductive: productive.size,
        uncoveredByCapability,
      },
    });

    await this.deps.framework.saveCoverage(report);
    return report;
  }

  /** A fresh budget tracker for one discovery cycle. */
  budget(overrides?: ConstructorParameters<typeof DiscoveryBudgetTracker>[0]) {
    return new DiscoveryBudgetTracker(overrides);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toSourceCapabilities(
  connector: {
    supportsIncremental: boolean;
    supportsDetailFetch: boolean;
    supportsExpiryCheck: boolean;
    providesStructuredSalary: boolean;
    providesVisaFlag: boolean;
    requiresBrowser: boolean;
    supportsPagination: boolean;
  },
  accessTier: string,
): SourceCapabilities {
  return {
    ...DEFAULT_SOURCE_CAPABILITIES,
    supportsPagination: connector.supportsPagination,
    supportsIncrementalSync: connector.supportsIncremental,
    supportsDetailFetch: connector.supportsDetailFetch,
    supportsExpiryCheck: connector.supportsExpiryCheck,
    providesStructuredSalary: connector.providesStructuredSalary,
    providesVisaFlag: connector.providesVisaFlag,
    requiresBrowser: connector.requiresBrowser,
    supportsApi: accessTier === 'official_api',
    supportsRss: accessTier === 'public_feed',
    supportsConditionalRequests: accessTier === 'public_feed' || accessTier === 'permitted_html',
    supportsStructuredData: accessTier === 'permitted_html',
    supportsSearch: accessTier === 'search_discovery',
    requiresCredentials: accessTier === 'official_api',
  };
}

/** Mechanisms a source can be driven by, cheapest first. */
function methodsFor(sourceType: string, accessTier: string): DiscoveryMethod[] {
  const methods: DiscoveryMethod[] = [];

  if (sourceType === 'ats') methods.push('ats_api');
  if (accessTier === 'official_api') methods.push('official_api');
  if (sourceType === 'rss_feed' || accessTier === 'public_feed') methods.push('public_feed');
  if (sourceType === 'html_page') methods.push('structured_data', 'permitted_html');
  if (sourceType === 'search_discovery') methods.push('search_result');
  if (sourceType === 'social') methods.push('social_post');
  if (accessTier === 'user_provided') methods.push('user_submitted');
  if (methods.length === 0) methods.push('manual');

  return [...new Set(methods)].sort((a, b) => METHOD_PREFERENCE[a] - METHOD_PREFERENCE[b]);
}

/** Cron expression approximating a requested interval. */
function cronForMinutes(minutes: number): string {
  if (minutes < 60) return `*/${Math.max(15, Math.min(59, minutes))} * * * *`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `0 */${Math.min(23, hours)} * * *`;
  return '0 6 * * *';
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}
