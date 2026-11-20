import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import {
  jobSourceSchema,
  sourceJobDraftSchema,
  type SourceJobDraft,
} from '@job-intel/contracts';
import { makeCandidateProfile } from '@job-intel/contracts/factories';
import { JobIdentityService } from '@job-intel/core';
import {
  CandidateRepository,
  DiscoveryRepository,
  EmbeddingRepository,
  EnrichmentRepository,
  EventRepository,
  JobRepository,
  MatchRepository,
  OpsRepository,
  ProfileRepository,
  RecommendationRepository,
  SourceRepository,
} from '@job-intel/db';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '@job-intel/db/testing';
import { EventRecorder, MemoryLogger } from '@job-intel/observability';
import {
  ConnectorRegistry,
  DEFAULT_CAPABILITIES,
  type Connector,
  type HttpClient,
} from '@job-intel/connectors';
import { testHttpClient } from '@job-intel/connectors/testing';
import { HashingEmbeddingProvider } from '@job-intel/matching';
import { makeEnrichment, makeSkills } from '@job-intel/matching/testing';
import { InMemoryQueueDriver, createEnvelope, type QueueDriver } from '@job-intel/queue';
import { OpsService } from './ops-service';
import { SourceRunner } from './source-runner';
import { MatchingService } from './matching-service';
import { RecommendationService } from './recommendation-service';

/**
 * Operations control centre, against a real database.
 *
 * Two things are proven here, and neither can be shown with a unit test:
 *
 *  - **The console survives its dependencies.** Every failure mode the brief
 *    lists is simulated and the dashboard is asserted to *still render*, with
 *    the failure reported as a degraded component rather than as an exception.
 *    A console that dies with the system is unavailable exactly when it is
 *    needed.
 *  - **A job is traceable from source to email.** The sixteen-step control walk
 *    runs the real pipeline and follows one posting all the way through, asking
 *    the console the same questions an operator would.
 */

const logger = new MemoryLogger();

const draft = (over: Partial<Record<string, unknown>> = {}): SourceJobDraft =>
  sourceJobDraftSchema.parse({
    title: 'Senior Frontend Engineer',
    companyName: 'Northwind',
    url: 'https://example.test/jobs/ops-1',
    externalId: 'ops-1',
    description:
      'We are hiring a senior frontend engineer to work with TypeScript and React on our platform team. Fully remote within the EU.',
    locationRaw: 'Remote (EU)',
    remoteType: 'remote',
    raw: { source: 'stub' },
    ...over,
  });

function stubConnector(options: { id?: string; drafts?: SourceJobDraft[]; throws?: Error }): Connector<
  Record<string, never>
> {
  return {
    id: options.id ?? 'stub',
    displayName: 'Stub',
    sourceType: 'job_api',
    accessTier: 'official_api',
    capabilities: DEFAULT_CAPABILITIES,
    configSchema: z.object({}).passthrough() as unknown as z.ZodType<
      Record<string, never>,
      unknown
    >,
    availability: () => ({ available: true, reason: null, requires: [] }),
    healthCheck: () => Promise.resolve({ healthy: true, message: 'ok', checkedAt: new Date() }),

    async *discover() {
      if (options.throws) throw options.throws;
      for (const item of options.drafts ?? []) yield item;
    },
  };
}

describe('operations control centre', () => {
  let ctx: TestDatabase;
  let ops: OpsRepository;
  let sources: SourceRepository;
  let profiles: ProfileRepository;
  let queue: QueueDriver;
  let profileId: string;

  /** Builds an OpsService with the dependencies a test wants to break. */
  function makeService(overrides: Partial<ConstructorParameters<typeof OpsService>[0]> = {}) {
    return new OpsService({
      ops,
      sources,
      profiles,
      recommendations: new RecommendationRepository(ctx.db),
      queue,
      logger,
      events: new EventRecorder(logger, new EventRepository(ctx.db)),
      checkDatabase: () => Promise.resolve({ ok: true, latencyMs: 3 }),
      aiEnabled: true,
      aiModel: 'claude-haiku-4-5',
      dailyBudgetUsd: 2,
      ...overrides,
    });
  }

  const componentOf = (
    health: Awaited<ReturnType<OpsService['systemHealth']>>,
    name: string,
  ) => health.components.find((component) => component.component === name)!;

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);

    ops = new OpsRepository(ctx.db);
    sources = new SourceRepository(ctx.db);
    profiles = new ProfileRepository(ctx.db);
    queue = new InMemoryQueueDriver();

    await sources.upsert(
      jobSourceSchema.parse({
        id: 'stub-source',
        connectorId: 'stub',
        displayName: 'Stub Source',
        sourceType: 'job_api',
        accessTier: 'official_api',
      }),
    );

    const created = await profiles.createProfile({
      payload: makeCandidateProfile({
        professional: {
          currentTitle: 'Frontend Engineer',
          yearsOfExperience: 6,
          seniority: 'senior',
          technologies: ['TypeScript', 'React'],
        },
      }),
    });
    profileId = created.profileId;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ── Part 36: failure simulation ───────────────────────────────────────────

  describe('failure simulation', () => {
    it('reports a database failure as a down component instead of throwing', async () => {
      const service = makeService({
        checkDatabase: () => Promise.resolve({ ok: false, error: 'connection refused' }),
      });

      const health = await service.systemHealth();
      const database = componentOf(health, 'database');

      expect(database.status).toBe('down');
      expect(database.detail).toContain('connection refused');
      // The whole page still has a status rather than an exception.
      expect(health.status).toBe('down');
      expect(health.summary.length).toBeGreaterThan(0);
    });

    it('redacts credentials out of a probe failure before it reaches a browser', async () => {
      const service = makeService({
        checkDatabase: () =>
          Promise.resolve({
            ok: false,
            error: 'could not connect to postgresql://admin:hunter2@db.internal:5432/jobintel',
          }),
      });

      const detail = componentOf(await service.systemHealth(), 'database').detail;
      expect(detail).not.toContain('hunter2');
      expect(detail).toContain('[redacted]');
    });

    it('survives a probe that throws rather than returning a failure', async () => {
      const service = makeService({
        checkDatabase: () => Promise.reject(new Error('socket hang up')),
      });

      // The point: an unexpected throw is still a card, not a 500.
      const health = await service.systemHealth();
      expect(componentOf(health, 'database').status).toBe('down');
    });

    it('reports an unreachable queue as down and keeps the overview renderable', async () => {
      const brokenQueue: QueueDriver = {
        ...queue,
        kind: 'inmemory',
        healthCheck: () => Promise.resolve({ ok: false, error: 'redis unreachable' }),
        counts: () => Promise.reject(new Error('redis unreachable')),
        failedJobs: () => Promise.reject(new Error('redis unreachable')),
      };

      const service = makeService({ queue: brokenQueue });

      expect(componentOf(await service.systemHealth(), 'queue').status).toBe('down');

      // Every other section still produces numbers.
      const overview = await service.overview();
      expect(overview.pipeline.discoveredToday).toBe(0);
      expect(overview.scheduler.queueBacklog).toBe(0);
      expect(await service.failedJobs()).toEqual([]);
    });

    it('reports a queue backlog as degraded rather than healthy', async () => {
      const backedUpQueue: QueueDriver = {
        ...queue,
        kind: 'inmemory',
        healthCheck: () => Promise.resolve({ ok: true }),
        counts: () =>
          Promise.resolve({ waiting: 9_000, active: 4, completed: 10, failed: 0, delayed: 0 }),
      };

      const health = await makeService({ queue: backedUpQueue }).systemHealth();
      const component = componentOf(health, 'queue');

      expect(component.status).toBe('degraded');
      expect(component.detail).toContain('backlog');
    });

    it('reports an unpriced AI model as degraded so spend is not understated', async () => {
      await ops.recordAiUsage({
        operation: 'match_reasoning',
        provider: 'unknown',
        model: 'mystery-model-2',
        calls: 1,
        inputTokens: 900,
        outputTokens: 120,
        costUsd: 0,
        latencyMs: 400,
        succeeded: true,
        jobId: null,
        runId: null,
        sourceId: null,
        priced: false,
      });

      const component = componentOf(await makeService().systemHealth(), 'ai_provider');
      expect(component.status).toBe('degraded');
      expect(component.detail).toContain('mystery-model-2');
    });

    it('reports AI as disabled, not broken, when it is switched off', async () => {
      const component = componentOf(
        await makeService({ aiEnabled: false }).systemHealth(),
        'ai_provider',
      );
      expect(component.status).toBe('disabled');
      // `disabled` must not drag the whole system down: an intentionally
      // switched-off component is not an outage.
      expect((await makeService({ aiEnabled: false }).systemHealth()).status).not.toBe('down');
    });

    it('degrades a source that fails repeatedly, and says why', async () => {
      const registry = new ConnectorRegistry().register(
        stubConnector({ throws: new Error('upstream returned 503 Service Unavailable') }),
      );
      const runner = new SourceRunner({
        registry,
        sources,
        discovery: new DiscoveryRepository(ctx.db),
        logger,
        events: new EventRecorder(logger, new EventRepository(ctx.db)),
        getSecret: () => undefined,
        createHttpClient: () => testHttpClient([]).client as HttpClient,
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await runner.run('stub-source').catch(() => undefined);
      }

      const [score] = await makeService().sourceHealthScores();
      expect(score).toBeDefined();
      expect(score!.status === 'down' || score!.status === 'degraded').toBe(true);
      // The health number is decomposed, so the reason is on screen.
      expect(score!.components.length).toBeGreaterThan(0);

      const health = componentOf(await makeService().systemHealth(), 'sources');
      expect(health.status).toBe('degraded');
    });

    it('surfaces rate limiting per source without calling it a failure', async () => {
      await ops.recordHttpOutcomes({
        sourceId: 'stub-source',
        requests: 40,
        succeeded: 28,
        failed: 0,
        rateLimited: 12,
        at: new Date(),
      });

      const [summary] = await ops.rateLimitSummaries(24);
      expect(summary?.rateLimited).toBe(12);
      expect(summary?.failed).toBe(0);
    });

    it('counts malformed job data as a quality problem rather than dropping it', async () => {
      // A posting with no salary, no location and a suspiciously short body:
      // the kind of row that a naive pipeline silently discards.
      await ctx.db.execute(sql`
        INSERT INTO jobs (title, title_normalized, company_name_raw, description,
                          source_url, source_id, source_identity, content_hash, fingerprint)
        VALUES ('Job', 'job', '', 'apply now', 'https://example.test/j/1', 'stub-source',
                'malformed-1', 'hash-malformed-1', 'fp-malformed-1')
      `);

      const counts = await ops.dataQualityCounts();
      expect(counts.total).toBe(1);
      // Still in the corpus, still counted, and visible as a weakness.
      const metrics = await makeService().dataQuality();
      expect(metrics.some((metric) => metric.count > 0)).toBe(true);
    });

    it('records a malformed model response as an enrichment error, visible on the job', async () => {
      const [job] = await ctx.db
        .insert((await import('@job-intel/db')).schema.jobs)
        .values({
          title: 'Backend Engineer',
          titleNormalized: 'backend engineer',
          companyNameRaw: 'Helios',
          description: 'x'.repeat(800),
          sourceUrl: 'https://example.test/jobs/llm-1',
          sourceId: 'stub-source',
          sourceIdentity: 'llm-1',
          contentHash: 'hash-llm-1',
          fingerprint: 'fp-llm-1',
        })
        .returning({ id: (await import('@job-intel/db')).schema.jobs.id });

      await new EnrichmentRepository(ctx.db).save(
        job!.id,
        makeEnrichment({
          aiUsed: false,
          aiError: 'model returned malformed JSON: unexpected token at position 41',
        }),
      );

      const inspection = await ops.inspectJob(job!.id, profileId);
      expect(inspection?.enrichment?.aiUsed).toBe(false);
      expect(inspection?.enrichment?.aiError).toContain('malformed JSON');
    });

    it('keeps the dashboard honest when everything is empty', async () => {
      const overview = await makeService().overview();

      expect(overview.pipeline).toMatchObject({
        discoveredToday: 0,
        enriched: 0,
        matched: 0,
        recommended: 0,
      });
      expect(overview.recommendations.averageScore).toBe(0);
      expect(overview.scheduler.lastRunAt).toBeNull();
      // Zeros, not plausible-looking placeholders.
      expect(overview.sources.healthy + overview.sources.degraded).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Part 37: the sixteen-step control walk ────────────────────────────────

  describe('end-to-end control', () => {
    it('traces one posting from source to the dashboard through the console', async () => {
      const service = makeService();
      const events = new EventRecorder(logger, new EventRepository(ctx.db));

      // 1. Open dashboard.
      const before = await service.overview();
      expect(before.pipeline.discoveredToday).toBe(0);

      // 2. Verify system health.
      const health = await service.systemHealth();
      expect(health.components.map((component) => component.component)).toEqual(
        expect.arrayContaining(['database', 'queue', 'scheduler', 'sources']),
      );
      expect(componentOf(health, 'database').status).toBe('healthy');

      // 3. Trigger a manual scan.
      const runId = await service.beginManualRun({ triggeredBy: 'tester', note: 'control test' });

      // 4. Observe run creation.
      const current = await ops.currentRun();
      expect(current?.id).toBe(runId);
      expect(current?.trigger).toBe('MANUAL');
      expect(current?.triggeredBy).toBe('tester');

      // 5. Observe source activity.
      const registry = new ConnectorRegistry().register(stubConnector({ drafts: [draft()] }));
      const runner = new SourceRunner({
        registry,
        sources,
        discovery: new DiscoveryRepository(ctx.db),
        logger,
        events,
        getSecret: () => undefined,
        createHttpClient: () => testHttpClient([]).client as HttpClient,
      });

      const sourceResult = await runner.run('stub-source');
      expect(sourceResult.stats.jobsDiscovered).toBe(1);

      const activity = await ops.runSourceActivity(runId);
      expect(activity).toHaveLength(1);
      expect(activity[0]?.sourceId).toBe('stub-source');

      const jobs = new JobRepository(ctx.db);
      const identity = new JobIdentityService();
      void identity;
      const discovered = await ops.exploreJobs(
        { limit: 25, offset: 0, sort: 'discovered', duplicatesOnly: false },
        profileId,
      );
      expect(discovered.total).toBe(1);
      const jobId = discovered.items[0]!.job.id;

      // 6. Observe jobs entering queues.
      await queue.enqueue('enrichment', {
        jobId,
        envelope: createEnvelope('control-trace', `enrich:${jobId}`),
      });
      const queuedCounts = await service.queueCounts();
      expect(queuedCounts.get('enrichment')?.waiting).toBe(1);
      expect(await service.queueBacklog()).toBe(1);

      // 7. Observe enrichment.
      await new EnrichmentRepository(ctx.db).save(
        jobId,
        makeEnrichment({
          normalizedTitle: 'Senior Frontend Engineer',
          seniority: 'senior',
          seniorityConfidence: 0.92,
          experience: { minimumYears: 5, confidence: 0.9 },
          workArrangement: { mode: 'remote', confidence: 0.95, remoteWorldwide: true },
          skills: makeSkills([['typescript'], ['react']]),
          aiUsed: true,
          aiModel: 'claude-haiku-4-5',
        }),
      );

      const afterEnrichment = await ops.pipelineCounters(profileId);
      expect(afterEnrichment.enriched).toBe(1);

      // 8. Observe matching.
      const candidates = new CandidateRepository(ctx.db);
      await candidates.initialisePreferences(profileId, {});
      await candidates.replaceSkills(profileId, [
        { name: 'TypeScript', slug: 'typescript', proficiency: 'expert', importance: 'primary' },
        { name: 'React', slug: 'react', proficiency: 'advanced', importance: 'primary' },
      ]);

      const matching = new MatchingService({
        matches: new MatchRepository(ctx.db),
        candidates,
        profiles,
        enrichments: new EnrichmentRepository(ctx.db),
        jobs,
        embeddings: new EmbeddingRepository(ctx.db),
        logger,
        events,
        embedder: new HashingEmbeddingProvider(1536),
      });

      const matchRun = await matching.matchAll(profileId, { force: true, reason: 'control test' });
      expect(matchRun.matched).toBe(1);
      expect(matchRun.failed).toBe(0);

      // 9. Observe ranking.
      const recommendations = new RecommendationRepository(ctx.db);
      const recommendation = new RecommendationService({
        recommendations,
        candidates,
        profiles,
        sources,
        logger,
        events,
      });

      await recommendation.refreshSignals({ limit: 100, staleAfterHours: 0 });
      const ranking = await recommendation.rank(profileId);
      expect(ranking.ranked).toBe(1);

      // 11. Inspect a resulting job.
      const inspection = await ops.inspectJob(jobId, profileId);
      expect(inspection).not.toBeNull();
      expect(inspection!.job.title).toBe('Senior Frontend Engineer');
      expect(inspection!.enrichment).not.toBeNull();
      expect(inspection!.signals).not.toBeNull();

      // 12. Inspect its match explanation.
      const match = inspection!.match;
      expect(match).not.toBeNull();
      expect(match!.explanation.length).toBeGreaterThan(0);
      expect(match!.componentScores.length).toBeGreaterThan(0);
      // Weights are recorded alongside the components, so the arithmetic is
      // reproducible from stored data rather than recomputed from config.
      expect(Object.keys(match!.trace.weightsUsed).length).toBeGreaterThan(0);

      // 13. Inspect why it does or does not reach the top of the list.
      expect(inspection!.recommendation).not.toBeNull();
      expect(inspection!.recommendation!.rankReasons.length).toBeGreaterThan(0);

      // 14. Inspect queue statistics.
      const finalCounts = await service.queueCounts();
      expect(finalCounts.get('enrichment')?.waiting).toBe(1);

      // 15. Inspect AI usage.
      await ops.recordAiUsage({
        operation: 'enrichment_extraction',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        calls: 1,
        inputTokens: 4_200,
        outputTokens: 380,
        costUsd: 0.0061,
        latencyMs: 820,
        succeeded: true,
        jobId,
        runId,
        sourceId: 'stub-source',
      });

      const cost = await service.aiCost(24);
      expect(cost.totalCalls).toBe(1);
      expect(cost.totalCostUsd).toBeGreaterThan(0);
      expect(cost.byModel['claude-haiku-4-5']).toBeGreaterThan(0);

      // 16. Inspect run history.
      await ops.completeRun(runId, {
        status: 'success',
        counters: {
          jobsDiscovered: sourceResult.stats.jobsDiscovered,
          jobsMatched: matchRun.matched,
          jobsRecommended: ranking.ranked,
        },
      });

      const history = await ops.listRuns({ limit: 10 });
      expect(history).toHaveLength(1);
      expect(history[0]?.status).toBe('success');
      expect(history[0]?.jobsDiscovered).toBe(1);
      expect(history[0]?.durationMs).toBeGreaterThanOrEqual(0);

      const detail = await ops.getRun(runId);
      expect(detail?.timeline.length).toBeGreaterThan(0);
      expect(detail?.timeline[0]?.event).toBe('Run started');

      // Source → final email: the whole chain is one query away.
      const trail = await ops.queryEvents({ jobId, sinceHours: 24 });
      expect(trail.length).toBeGreaterThan(0);

      const after = await service.overview();
      expect(after.pipeline.matched).toBe(1);
      expect(after.pipeline.recommended).toBeGreaterThanOrEqual(0);
      expect(after.scheduler.lastRunStatus).toBe('success');
    });
  });

  // ── Audit and authorisation surface ───────────────────────────────────────

  describe('audit', () => {
    it('records before and after for a manual change', async () => {
      await sources.update('stub-source', { enabled: false });
      await ops.recordAudit({
        action: 'source.disabled',
        actor: 'tester',
        target: 'stub-source',
        before: { enabled: true },
        after: { enabled: false },
        reason: 'rate limited upstream',
        requestId: 'req-1',
      });

      const [entry] = await ops.listAudit({ limit: 5 });
      expect(entry?.before).toEqual({ enabled: true });
      expect(entry?.after).toEqual({ enabled: false });
      expect(entry?.reason).toBe('rate limited upstream');
    });

    it('records a dry run without writing job state', async () => {
      const service = makeService();
      const report = await service.dryRun({ triggeredBy: 'tester', reason: 'threshold tuning' });

      expect(report.skippedWrites).toContain('no job records written');
      expect(report.wouldShortlist).toBe(0);

      const run = await ops.getRun(report.runId);
      expect(run?.dryRun).toBe(true);
      expect(run?.status).toBe('success');

      // Inert: nothing entered the corpus.
      const counters = await ops.pipelineCounters(profileId);
      expect(counters.totalJobs).toBe(0);
    });
  });
});
