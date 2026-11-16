import { createHash } from 'node:crypto';
import {
  behaviorEventSchema,
  learningConfigSchema,
  type BehaviorEventInput,
  type BehavioralAdjustment,
  type BehavioralProfile,
  type EngagementMetrics,
  type FeatureAffinity,
  type JobFeature,
  type LearningConfig,
  type PreferenceSuggestion,
  type RankingQuality,
} from '@job-intel/contracts';
import type { CandidateRepository, LearningRepository } from '@job-intel/db';
import {
  buildBehavioralProfile,
  computeBehavioralAdjustment,
  computeEngagementMetrics,
  computeRankingQuality,
  extractFeatures,
  generateSuggestions,
  mergeAffinities,
  scoreQueryPerformance,
  scoreSourceUserValue,
  selectExploration,
  type AffinityEventInput,
  type ExplorationCandidate,
  type JobAttributes,
} from '@job-intel/candidate';
import type { EventRecorder, Logger } from '@job-intel/observability';

/**
 * The learning service.
 *
 * Orchestrates the feedback loop: ingest an interaction, fold it into
 * affinities, score jobs, measure whether any of it helped, and — only ever as
 * a *suggestion* — tell the candidate what their behaviour implies.
 *
 * The performance shape the brief asks for is the reason ingestion and
 * recomputation are separate methods. `recordEvent` writes one row and returns;
 * it never recomputes a profile. Aggregation happens in
 * `updateBehavioralProfile`, which is queued and idempotent, so a hundred
 * thousand events cost a hundred thousand inserts and a handful of aggregations
 * rather than a hundred thousand full recomputations.
 */

export interface LearningServiceDependencies {
  learning: LearningRepository;
  candidates: CandidateRepository;
  logger: Logger;
  events: EventRecorder;
  now?: () => Date;
}

export interface RecordEventResult {
  eventId: string | null;
  duplicate: boolean;
}

export class LearningService {
  constructor(private readonly deps: LearningServiceDependencies) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ── Ingestion (Parts 1–4, 35, 47) ────────────────────────────────────────

  /**
   * Records one interaction.
   *
   * Deliberately cheap: one insert, no aggregation, no model call. The brief is
   * explicit that clicking a job must not trigger an LLM call, and the stronger
   * version of that rule is that it must not trigger *any* recomputation —
   * otherwise a burst of activity becomes a burst of full-profile rebuilds.
   *
   * The dedupe key is derived from the semantics of the interaction rather than
   * supplied by the caller, so an at-least-once queue redelivering the same
   * click cannot produce two.
   */
  async recordEvent(input: BehaviorEventInput): Promise<RecordEventResult> {
    const event = behaviorEventSchema.parse({
      ...input,
      eventId: input.eventId ?? crypto.randomUUID(),
      occurredAt: input.occurredAt ?? this.now(),
    });

    const dedupeKey = this.dedupeKey(event);
    const eventId = await this.deps.learning.recordEvent({ ...event, dedupeKey });

    if (eventId === null) {
      this.deps.logger.debug('Duplicate behaviour event ignored', {
        candidateId: event.candidateId,
        eventType: event.eventType,
      });
      return { eventId: null, duplicate: true };
    }

    return { eventId, duplicate: false };
  }

  /**
   * A stable identity for one interaction.
   *
   * Bucketed to the minute so a double-click is one view, while the same job
   * viewed again an hour later is genuinely a second view. Applying and saving
   * are never bucketed — those are deliberate acts and each one counts.
   */
  private dedupeKey(event: ReturnType<typeof behaviorEventSchema.parse>): string {
    const deliberate = event.eventType === 'JOB_APPLIED' || event.eventType === 'JOB_SAVED';
    const bucket = deliberate
      ? event.eventId
      : String(Math.floor(event.occurredAt.getTime() / 60_000));

    return createHash('sha256')
      .update([event.candidateId, event.jobId ?? '', event.eventType, event.context, bucket].join('|'))
      .digest('hex')
      .slice(0, 40);
  }

  // ── Aggregation (Parts 10–15, 36) ────────────────────────────────────────

  /**
   * Folds unprocessed events into the behavioural profile.
   *
   * Idempotent: events carry `processedAt`, so a retried job re-reads nothing.
   * `full` recomputes from the whole retained history, which is how an
   * algorithm-version bump is applied — recomputation rather than migration.
   */
  async updateBehavioralProfile(
    candidateId: string,
    options: { full?: boolean; sinceDays?: number } = {},
  ): Promise<{ profile: BehavioralProfile; affinities: number; eventsProcessed: number }> {
    const config = await this.deps.learning.getConfig(candidateId);
    const stored = await this.deps.candidates.getActivePreferences(candidateId).catch(() => null);
    const preferences = stored?.preferences ?? null;

    if (config.frozen && !options.full) {
      // Frozen means existing affinities still apply but stop changing. The
      // events are still recorded — freezing personalisation is not the same as
      // deleting history, and conflating them would make "unfreeze" lossy.
      const existing = await this.deps.learning.getProfile(candidateId);
      const affinities = await this.deps.learning.listAffinities(candidateId);

      return {
        profile: buildBehavioralProfile(candidateId, [], { config, preferences, now: this.now() }),
        affinities: affinities.length,
        eventsProcessed: 0,
        ...(existing ? {} : {}),
      };
    }

    const rows = await this.deps.learning.listEventsWithJobs(candidateId, {
      ...(options.full ? {} : { unprocessedOnly: true }),
      ...(options.sinceDays !== undefined ? { sinceDays: options.sinceDays } : {}),
      limit: options.full ? 50_000 : 5_000,
    });

    const inputs: AffinityEventInput[] = [];
    const processedIds: string[] = [];

    for (const row of rows) {
      processedIds.push(row.event.id);
      if (!row.job) continue;

      const parsed = behaviorEventSchema.safeParse({
        ...row.event,
        eventId: row.event.id,
        candidateId,
      });
      if (!parsed.success) continue;

      inputs.push({ event: parsed.data, features: this.featuresFor(row) });
    }

    const existing = options.full ? [] : await this.deps.learning.listAffinities(candidateId);
    const affinities = mergeAffinities(existing, inputs, {
      config,
      preferences,
      now: this.now(),
    });

    // A full recompute *replaces*; an incremental pass merges. Merging on a
    // full recompute would leave behind rows the new computation no longer
    // produces — stale values surviving the very change meant to remove them.
    if (options.full) {
      await this.deps.learning.replaceAffinities(candidateId, affinities);
    } else {
      await this.deps.learning.saveAffinities(candidateId, affinities);
    }

    // The profile's counts come from the full retained history rather than from
    // this batch, so "you have 340 interactions" stays true after an
    // incremental update.
    let all: AffinityEventInput[] = inputs;
    if (!options.full) {
      const everything = await this.deps.learning.listEventsWithJobs(candidateId, { limit: 50_000 });
      all = [];
      for (const row of everything) {
        const parsed = behaviorEventSchema.safeParse({
          ...row.event,
          eventId: row.event.id,
          candidateId,
        });
        if (parsed.success) all.push({ event: parsed.data, features: this.featuresFor(row) });
      }
    }

    const profile = buildBehavioralProfile(candidateId, all, {
      config,
      preferences,
      now: this.now(),
    });

    await this.deps.learning.saveProfile({ ...profile, affinities });
    await this.deps.learning.markProcessed(processedIds);

    await this.deps.events.emit('FEEDBACK_RECORDED', {
      message: `Behavioural profile updated: ${affinities.length} affinity(ies)`,
      data: {
        candidateId,
        eventsProcessed: processedIds.length,
        affinities: affinities.length,
        algorithmVersion: config.algorithmVersion,
      },
    });

    return { profile: { ...profile, affinities }, affinities: affinities.length, eventsProcessed: processedIds.length };
  }

  /** Job attributes → features, shared by ingestion and scoring. */
  private featuresFor(row: {
    job: {
      id: string;
      title: string | null;
      companyNameRaw: string | null;
      countryCode: string | null;
      city: string | null;
      remoteType: string | null;
      employmentTypes: string[] | null;
      techStack: string[] | null;
      salaryNormalizedAnnualUsd: string | null;
      sourceId: string | null;
    } | null;
    enrichment?: { seniority: string | null; classification: unknown } | null;
  }): JobFeature[] {
    if (!row.job) return [];

    const classification = row.enrichment?.classification as { industries?: string[] } | null;

    const attributes: JobAttributes = {
      jobId: row.job.id,
      title: row.job.title,
      companyName: row.job.companyNameRaw,
      countryCode: row.job.countryCode,
      city: row.job.city,
      remoteType: row.job.remoteType,
      employmentTypes: row.job.employmentTypes ?? [],
      seniority: row.enrichment?.seniority ?? null,
      technologies: row.job.techStack ?? [],
      industries: classification?.industries ?? [],
      salaryAnnualUsd:
        row.job.salaryNormalizedAnnualUsd === null
          ? null
          : Number(row.job.salaryNormalizedAnnualUsd),
      sourceId: row.job.sourceId,
      companySize: null,
    };

    return extractFeatures(attributes);
  }

  // ── Ranking (Parts 16–19) ────────────────────────────────────────────────

  /**
   * The behavioural adjustment for a batch of jobs.
   *
   * Returns points to *add* to each recommendation score. Nothing here reads or
   * writes the match score — that separation is what makes "this moved because
   * of your behaviour" verifiable by subtraction rather than by trust.
   */
  async scoreJobs(
    candidateId: string,
    jobs: ReadonlyArray<{ jobId: string; attributes: JobAttributes }>,
  ): Promise<Map<string, BehavioralAdjustment>> {
    const [config, affinities, profile, stored] = await Promise.all([
      this.deps.learning.getConfig(candidateId),
      this.deps.learning.listAffinities(candidateId),
      this.deps.learning.getProfile(candidateId),
      this.deps.candidates.getActivePreferences(candidateId).catch(() => null),
    ]);

    const result = new Map<string, BehavioralAdjustment>();

    for (const job of jobs) {
      result.set(
        job.jobId,
        computeBehavioralAdjustment({
          jobId: job.jobId,
          features: extractFeatures(job.attributes),
          affinities,
          preferences: stored?.preferences ?? null,
          config,
          hasSufficientData: profile?.hasSufficientData ?? false,
          coldStartReason: profile?.coldStartReason ?? null,
        }),
      );
    }

    return result;
  }

  /** Reserves exploration slots among already-eligible candidates. */
  async selectExploration(
    candidateId: string,
    candidates: readonly ExplorationCandidate[],
    resultSize: number,
  ) {
    const [config, affinities] = await Promise.all([
      this.deps.learning.getConfig(candidateId),
      this.deps.learning.listAffinities(candidateId),
    ]);

    return selectExploration(candidates, affinities, { config, resultSize });
  }

  // ── Suggestions (Parts 27–28) ────────────────────────────────────────────

  /**
   * Generates preference suggestions.
   *
   * Stores rows. Applies nothing. The only way a suggestion becomes a
   * preference is `acceptSuggestion`, below, which routes through the versioned
   * preference-write path a UI edit uses.
   */
  async generatePreferenceSuggestions(candidateId: string): Promise<PreferenceSuggestion[]> {
    const [config, affinities, stored, declined] = await Promise.all([
      this.deps.learning.getConfig(candidateId),
      this.deps.learning.listAffinities(candidateId),
      this.deps.candidates.getActivePreferences(candidateId),
      this.deps.learning.declinedPaths(candidateId),
    ]);

    if (!stored) return [];

    const suggestions = generateSuggestions({
      candidateId,
      preferences: stored.preferences,
      affinities,
      config,
      declinedPaths: declined,
      now: this.now(),
    });

    await this.deps.learning.saveSuggestions(suggestions);
    return suggestions;
  }

  /**
   * Applies a suggestion the candidate accepted.
   *
   * Note the shape: the caller must pass the already-built preference payload,
   * because constructing it is the preference engine's job and duplicating that
   * logic here would create a second, unvalidated write path. This method's
   * responsibility is only to record that the suggestion was accepted and which
   * version resulted.
   */
  async recordSuggestionResponse(
    suggestionId: string,
    response: 'accepted' | 'declined' | 'dismissed',
    appliedVersion?: number | null,
  ): Promise<void> {
    await this.deps.learning.respondToSuggestion(suggestionId, response, appliedVersion ?? null);

    await this.deps.events.emit('FEEDBACK_RECORDED', {
      message: `Preference suggestion ${response}`,
      data: { suggestionId, response, appliedVersion: appliedVersion ?? null },
    });
  }

  // ── Query and source learning (Parts 20–23) ──────────────────────────────

  /** Recomputes which queries and sources actually produce useful jobs. */
  async updatePerformance(
    candidateId: string,
    windowDays = 30,
  ): Promise<{ queries: number; sources: number }> {
    const [queryCounts, sourceCounts, jobsPerSource] = await Promise.all([
      this.deps.learning.queryInteractionCounts(candidateId, windowDays),
      this.deps.learning.sourceInteractionCounts(candidateId, windowDays),
      this.deps.learning.jobsPerSource(windowDays),
    ]);

    const discoveredBySource = new Map(jobsPerSource.map((row) => [row.sourceId, row.total]));
    const now = this.now();

    const queryRows = queryCounts
      .filter((row) => row.queryId)
      .map((row) =>
        scoreQueryPerformance({
          queryId: row.queryId,
          candidateId,
          counts: {
            // Discovery counts come from the discovery layer; interactions from
            // here. Using interaction count as the denominator would make every
            // query look perfect.
            jobsDiscovered: Math.max(1, row.views + row.clicks + row.saves + row.rejections),
            jobsShown: row.views,
            views: row.views,
            clicks: row.clicks,
            saves: row.saves,
            applications: row.applications,
            rejections: row.rejections,
          },
          windowDays,
          now,
        }),
      );

    const sourceRows = sourceCounts
      .filter((row) => row.sourceId)
      .map((row) =>
        scoreSourceUserValue({
          sourceId: row.sourceId,
          candidateId,
          counts: {
            jobsDiscovered: discoveredBySource.get(row.sourceId) ?? row.jobsDiscovered,
            jobsShown: row.jobsDiscovered,
            views: row.views,
            clicks: row.clicks,
            saves: row.saves,
            applications: row.applications,
            rejections: row.rejections,
          },
          windowDays,
          now,
        }),
      );

    await this.deps.learning.saveQueryPerformance(queryRows);
    await this.deps.learning.saveSourceUserValue(sourceRows);

    return { queries: queryRows.length, sources: sourceRows.length };
  }

  // ── Analytics (Parts 39–40) ──────────────────────────────────────────────

  /** Funnel rates and Precision@K, stored as a snapshot for trend analysis. */
  async computeAnalytics(
    candidateId: string,
    windowDays = 30,
  ): Promise<{ metrics: EngagementMetrics; quality: RankingQuality[] }> {
    const [counts, shown, ranked] = await Promise.all([
      this.deps.learning.eventCounts(candidateId, windowDays),
      this.deps.learning.recommendationsShown(candidateId, windowDays),
      this.deps.learning.rankedInteractions(candidateId, windowDays),
    ]);

    const byType = new Map(counts.map((row) => [row.eventType, row.count]));
    const count = (type: string): number => byType.get(type) ?? 0;

    const interactions = ranked
      .filter((row) => row.jobId !== null && row.rank !== null)
      .map((row) => ({
        jobId: row.jobId!,
        rank: row.rank!,
        clicked: row.clicked,
        saved: row.saved,
        applied: row.applied,
      }));

    const accepted = interactions.filter(
      (interaction) => interaction.clicked || interaction.saved || interaction.applied,
    ).length;

    const metrics = computeEngagementMetrics({
      candidateId,
      windowDays,
      recommendationsShown: shown,
      views: count('JOB_VIEWED'),
      clicks: count('JOB_CLICKED') + count('JOB_NOTIFICATION_CLICKED'),
      saves: count('JOB_SAVED'),
      rejections: count('JOB_REJECTED') + count('JOB_DISMISSED'),
      applications: count('JOB_APPLIED'),
      acceptedJobs: accepted,
      now: this.now(),
    });

    /*
     * The denominator for Precision@K.
     *
     * Preferring the recommendation table when it has rows, but falling back to
     * the distinct jobs actually observed at rank ≤ k. Without the fallback the
     * metric silently reports zero whenever ranking history has been trimmed or
     * has not run — which is indistinguishable from "the ranking was useless",
     * and is the more damaging of the two readings.
     */
    const quality = [5, 10, 20].map((k) => {
      const observedAtK = new Set(
        interactions.filter((entry) => entry.rank <= k).map((entry) => entry.jobId),
      ).size;

      return computeRankingQuality({
        candidateId,
        k,
        windowDays,
        interactions,
        shownAtK: shown > 0 ? Math.min(k, shown) : Math.min(k, observedAtK),
        now: this.now(),
      });
    });

    await this.deps.learning.saveEngagementSnapshot(metrics, quality);
    return { metrics, quality };
  }

  // ── Controls (Parts 31–33) ───────────────────────────────────────────────

  async getConfig(candidateId: string): Promise<LearningConfig> {
    return this.deps.learning.getConfig(candidateId);
  }

  async updateConfig(
    candidateId: string,
    patch: Partial<LearningConfig>,
  ): Promise<LearningConfig> {
    const next = await this.deps.learning.saveConfig(candidateId, patch);

    await this.deps.events.emit('CONFIG_CHANGED', {
      message: 'Learning settings updated',
      data: {
        candidateId,
        enabled: next.enabled,
        frozen: next.frozen,
        exploration: next.exploration,
        configurationVersion: next.configurationVersion,
      },
    });

    return next;
  }

  /**
   * Resets learned state.
   *
   * Scoped, and explicitly incapable of touching preferences: the repository
   * method it calls deletes from `feature_affinities` only. "Reset company
   * affinity" is therefore a real, narrow operation rather than a label on a
   * blunt one.
   */
  async resetLearning(
    candidateId: string,
    scope: 'all' | 'company' | 'technology' | 'location' | 'source' = 'all',
  ): Promise<number> {
    const dimensions =
      scope === 'all'
        ? undefined
        : scope === 'location'
          ? ['location', 'country']
          : [scope];

    const removed = await this.deps.learning.resetAffinities(candidateId, dimensions);

    await this.deps.events.emit('CONFIG_CHANGED', {
      message: `Learned ${scope} preferences reset`,
      data: { candidateId, scope, removed, explicitPreferencesUnchanged: true },
    });

    return removed;
  }

  /** Deletes behavioural history entirely. Explicit profile survives. */
  async deleteHistory(candidateId: string): Promise<{ events: number; affinities: number }> {
    const removed = await this.deps.learning.deleteBehaviorHistory(candidateId);

    await this.deps.events.emit('CONFIG_CHANGED', {
      message: 'Behavioural history deleted',
      data: { candidateId, ...removed, explicitPreferencesUnchanged: true },
    });

    return removed;
  }

  // ── Read models for the UI ───────────────────────────────────────────────

  async getLearningState(candidateId: string): Promise<{
    config: LearningConfig;
    profile: Awaited<ReturnType<LearningRepository['getProfile']>>;
    affinities: FeatureAffinity[];
    suggestions: Awaited<ReturnType<LearningRepository['listSuggestions']>>;
    timeline: Awaited<ReturnType<LearningRepository['recentActivity']>>;
  }> {
    const [config, profile, affinities, suggestions, timeline] = await Promise.all([
      this.deps.learning.getConfig(candidateId),
      this.deps.learning.getProfile(candidateId),
      this.deps.learning.listAffinities(candidateId, { limit: 200 }),
      this.deps.learning.listSuggestions(candidateId),
      this.deps.learning.recentActivity(candidateId, 40),
    ]);

    return { config, profile, affinities, suggestions, timeline };
  }
}

/** Star rating for the learning dashboard, from confidence and strength. */
export function affinityStars(affinity: FeatureAffinity): number {
  const magnitude = Math.abs(affinity.affinity) * affinity.confidence;
  if (magnitude >= 0.6) return 5;
  if (magnitude >= 0.4) return 4;
  if (magnitude >= 0.25) return 3;
  if (magnitude >= 0.12) return 2;
  return 1;
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = learningConfigSchema.parse({});
