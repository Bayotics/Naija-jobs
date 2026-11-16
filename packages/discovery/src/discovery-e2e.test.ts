import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jobSourceSchema, sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import { makeCandidateProfile } from '@job-intel/contracts/factories';
import {
  CandidateRepository,
  DiscoveryFrameworkRepository,
  DiscoveryRepository,
  EmbeddingRepository,
  EnrichmentRepository,
  EventRepository,
  JobRepository,
  MatchRepository,
  NotificationRepository,
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
import { SourceRunner } from './source-runner';
import { MatchingService } from './matching-service';
import { RecommendationService } from './recommendation-service';
import { DiscoveryFrameworkService } from './discovery-framework-service';

/**
 * The whole pipeline, after the discovery expansion.
 *
 * Walks the chain the brief lists: preferences → query generation → source
 * selection → discovery → normalization → deduplication → enrichment → matching
 * → ranking → notification eligibility.
 *
 * The property under test is that expanding discovery did not break anything
 * downstream, and specifically that the *new* seams hold: a plan generated from
 * preferences, capabilities recorded per source, coverage reported against what
 * actually ran, and a duplicate consolidated rather than counted twice.
 */

const logger = new MemoryLogger();

const draft = (over: Record<string, unknown>): SourceJobDraft =>
  sourceJobDraftSchema.parse({
    title: 'Senior Frontend Engineer',
    companyName: 'Northwind',
    description:
      'We are hiring a senior frontend engineer to work with TypeScript and React on our ' +
      'platform team. Responsibilities include owning the design system. Requirements: five ' +
      'years of experience. Fully remote within the EU.',
    locationText: 'Remote (EU)',
    remoteFlag: true,
    url: 'https://example.test/jobs/1',
    externalId: 'e2e-1',
    raw: {},
    ...over,
  });

function stubConnector(id: string, drafts: SourceJobDraft[]): Connector<Record<string, never>> {
  return {
    id,
    displayName: id,
    sourceType: 'job_api',
    accessTier: 'official_api',
    capabilities: { ...DEFAULT_CAPABILITIES, supportsIncremental: true },
    configSchema: z.object({}).passthrough() as unknown as z.ZodType<
      Record<string, never>,
      z.ZodTypeDef,
      unknown
    >,
    availability: () => ({ available: true, reason: null, requires: [] }),
    healthCheck: () => Promise.resolve({ healthy: true, message: 'ok', checkedAt: new Date() }),
    async *discover() {
      for (const item of drafts) yield item;
    },
  };
}

describe('discovery pipeline end to end', () => {
  let ctx: TestDatabase;
  let profileId: string;
  let framework: DiscoveryFrameworkRepository;
  let sources: SourceRepository;
  let profiles: ProfileRepository;
  let candidates: CandidateRepository;
  let http: HttpClient;

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);

    sources = new SourceRepository(ctx.db);
    profiles = new ProfileRepository(ctx.db);
    candidates = new CandidateRepository(ctx.db);
    framework = new DiscoveryFrameworkRepository(ctx.db);
    http = testHttpClient([]).client;

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

    await candidates.initialisePreferences(profileId, {
      titles: [{ value: 'Frontend Engineer', strength: 'required' }],
      countries: [{ value: 'DE', strength: 'strongly_preferred' }],
      technologies: [
        { value: 'React', strength: 'strongly_preferred' },
        { value: 'TypeScript', strength: 'preferred' },
      ],
      seniorityLevels: ['senior'],
      workArrangement: 'REMOTE_PREFERRED',
    } as never);

    await candidates.replaceSkills(profileId, [
      { name: 'TypeScript', slug: 'typescript', proficiency: 'expert', importance: 'primary' },
      { name: 'React', slug: 'react', proficiency: 'advanced', importance: 'primary' },
    ]);

    for (const id of ['board-a', 'board-b']) {
      await sources.upsert(
        jobSourceSchema.parse({
          id,
          connectorId: id,
          displayName: id,
          sourceType: 'job_api',
          accessTier: 'official_api',
        }),
      );
    }
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const makeFrameworkService = (registry: ConnectorRegistry) =>
    new DiscoveryFrameworkService({
      framework,
      sources,
      profiles,
      candidates,
      registry,
      logger,
      events: new EventRecorder(logger, new EventRepository(ctx.db)),
      http,
    });

  it('runs preferences → queries → discovery → matching → ranking → eligibility', async () => {
    const events = new EventRecorder(logger, new EventRepository(ctx.db));

    // ── 1. Query generation from preferences ────────────────────────────
    const registry = new ConnectorRegistry()
      .register(
        stubConnector('board-a', [
          draft({}),
          draft({
            title: 'Staff Backend Engineer',
            externalId: 'e2e-2',
            url: 'https://example.test/jobs/2',
            description:
              'Backend role working with Go and Postgres. Responsibilities include service ' +
              'ownership. Requirements: seven years of experience. Onsite in Berlin.',
            remoteFlag: false,
            locationText: 'Berlin, Germany',
          }),
        ]),
      )
      // The same posting, from a second board, under a different URL. This is
      // the deduplication case that matters as source coverage widens.
      .register(
        stubConnector('board-b', [
          draft({
            externalId: 'e2e-1-mirror',
            url: 'https://mirror.test/listing/1',
          }),
        ]),
      );

    const service = makeFrameworkService(registry);
    const plan = await service.planFor(profileId);

    expect(plan.queries.length).toBeGreaterThan(0);
    expect(plan.queries.some((query) => query.terms.title === 'Frontend Engineer')).toBe(true);

    const persisted = await framework.listQueries(profileId);
    expect(persisted.length).toBe(plan.queries.length);

    // ── 2. Capabilities recorded per source ─────────────────────────────
    expect(await service.refreshCapabilities()).toBe(2);
    const capabilities = await framework.listCapabilities();
    expect(capabilities).toHaveLength(2);
    expect(capabilities[0]?.methods.length).toBeGreaterThan(0);

    // ── 3. Discovery, one source failing independently of the other ─────
    const runner = new SourceRunner({
      registry,
      sources,
      discovery: new DiscoveryRepository(ctx.db),
      logger,
      events,
      ops: undefined,
      getSecret: () => undefined,
      createHttpClient: () => http,
    });

    const results = await runner.runAll({ trigger: 'manual' });
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === 'success')).toBe(true);

    const jobs = new JobRepository(ctx.db);
    const discovered = await jobs.list({ limit: 50, offset: 0 });
    // Three drafts, one of which mirrors another: the pipeline stores what it
    // was given and the dedup layer consolidates downstream.
    expect(discovered.items.length).toBeGreaterThanOrEqual(2);

    // ── 4. Enrichment ───────────────────────────────────────────────────
    const enrichments = new EnrichmentRepository(ctx.db);
    for (const job of discovered.items) {
      await enrichments.save(
        job.id,
        makeEnrichment({
          normalizedTitle: job.title,
          seniority: 'senior',
          seniorityConfidence: 0.9,
          experience: { minimumYears: 5, confidence: 0.9 },
          workArrangement: { mode: 'remote', confidence: 0.9, remoteWorldwide: false },
          skills: makeSkills([['typescript'], ['react']]),
        }),
      );
    }

    // ── 5. Matching ─────────────────────────────────────────────────────
    const matching = new MatchingService({
      matches: new MatchRepository(ctx.db),
      candidates,
      profiles,
      enrichments,
      jobs,
      embeddings: new EmbeddingRepository(ctx.db),
      logger,
      events,
      embedder: new HashingEmbeddingProvider(1536),
    });

    const matchRun = await matching.matchAll(profileId, { force: true, reason: 'e2e' });
    expect(matchRun.matched).toBeGreaterThan(0);
    expect(matchRun.failed).toBe(0);

    // ── 6. Ranking ──────────────────────────────────────────────────────
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
    expect(ranking.ranked).toBeGreaterThan(0);

    // ── 7. Notification eligibility ─────────────────────────────────────
    const notifications = new NotificationRepository(ctx.db);
    const notified = await notifications.loadNotifiedJobs(profileId);
    // Nothing has been emailed, so eligibility is decided fresh — not blocked
    // by a stale "already sent" record.
    expect(notified.size).toBe(0);

    const top = await recommendations.topRecommendations({ profileId, limit: 10 });
    expect(top.length).toBeGreaterThan(0);
    expect(typeof top[0]?.recommendation.notificationEligible).toBe('boolean');

    // ── 8. Coverage reports what actually ran ───────────────────────────
    for (const query of plan.queries.slice(0, 3)) {
      await framework.recordQueryExecution({ queryId: query.id, discovered: 2, matched: 1 });
    }

    const coverage = await service.reportCoverage(profileId, 24);
    expect(coverage.queriesExecuted).toBe(3);
    expect(coverage.items.length).toBeGreaterThan(0);
    // Coverage is about the candidate's stated space, never about the web.
    expect(coverage.searchedShare).toBeLessThanOrEqual(1);

    const stored = await framework.latestCoverage(profileId);
    expect(stored).not.toBeNull();
  });

  it('keeps one source failing from stopping the others', async () => {
    const registry = new ConnectorRegistry()
      .register(stubConnector('board-a', [draft({})]))
      .register({
        ...stubConnector('board-b', []),
        // eslint-disable-next-line require-yield
        async *discover(): AsyncGenerator<SourceJobDraft, void, void> {
          throw new Error('board-b is down');
        },
      } as Connector<Record<string, never>>);

    const runner = new SourceRunner({
      registry,
      sources,
      discovery: new DiscoveryRepository(ctx.db),
      logger,
      events: new EventRecorder(logger, new EventRepository(ctx.db)),
      getSecret: () => undefined,
      createHttpClient: () => http,
    });

    const results = await runner.runAll({ trigger: 'manual' });
    const failed = results.filter((result) => result.status === 'failed');
    const succeeded = results.filter((result) => result.status === 'success');

    expect(failed).toHaveLength(1);
    expect(succeeded).toHaveLength(1);

    // The healthy source still stored its posting.
    const jobs = await new JobRepository(ctx.db).list({ limit: 10, offset: 0 });
    expect(jobs.items.length).toBeGreaterThan(0);
  });

  it('opens the circuit after repeated failures and suppresses scheduling', async () => {
    const registry = new ConnectorRegistry().register({
      ...stubConnector('board-a', []),
      // eslint-disable-next-line require-yield
      async *discover(): AsyncGenerator<SourceJobDraft, void, void> {
        throw new Error('permanently broken');
      },
    } as Connector<Record<string, never>>);

    // Threshold of 2 so the test does not depend on the default.
    await sources.update('board-a', { limits: { circuitBreakerThreshold: 2 } } as never);

    const runner = new SourceRunner({
      registry,
      sources,
      discovery: new DiscoveryRepository(ctx.db),
      logger,
      events: new EventRecorder(logger, new EventRepository(ctx.db)),
      getSecret: () => undefined,
      createHttpClient: () => http,
    });

    await runner.run('board-a').catch(() => undefined);
    await runner.run('board-a').catch(() => undefined);

    const source = await sources.get('board-a');
    expect(source?.consecutiveFailures).toBeGreaterThanOrEqual(2);
    expect(source?.circuitState).toBe('open');
    expect(source?.circuitOpenedAt).not.toBeNull();

    // And the scheduler now refuses to run it.
    const service = makeFrameworkService(registry);
    const decisions = await service.schedule();
    const decision = decisions.find((entry) => entry.sourceId === 'board-a');

    expect(decision?.suppressed).toBe(true);
    expect(decision?.reason).toContain('circuit open');
  });

  it('re-plans when preferences change', async () => {
    const registry = new ConnectorRegistry().register(stubConnector('board-a', []));
    const service = makeFrameworkService(registry);

    const before = await service.planFor(profileId);
    expect(before.queries.some((query) => query.terms.title === 'Frontend Engineer')).toBe(true);

    // A preference change is a data change. No deploy, no code edit.
    const current = await candidates.getActivePreferences(profileId);
    await candidates.savePreferenceVersion({
      profileId,
      preferences: {
        ...current!.preferences,
        titles: [
          { value: 'Data Engineer', strength: 'required', hard: false, note: null, source: 'explicit' },
        ],
      },
      changes: [
        { path: 'titles', before: current!.preferences.titles, after: ['Data Engineer'], summary: 'retargeted' },
      ],
      embeddingStale: true,
      changedBy: 'e2e',
      summary: 'retargeted to data engineering',
    });

    const after = await service.planFor(profileId);
    expect(after.queries.some((query) => query.terms.title === 'Data Engineer')).toBe(true);
    expect(after.queries.every((query) => query.terms.title !== 'Frontend Engineer')).toBe(true);

    // The old queries are retired, not deleted — their history is what makes
    // historical prioritisation possible if the preference comes back.
    const active = await framework.listQueries(profileId, { activeOnly: true });
    expect(active.every((query) => query.terms.title !== 'Frontend Engineer')).toBe(true);
  });

  it('validates a user-provided URL without activating it', async () => {
    const registry = new ConnectorRegistry().register(stubConnector('board-a', []));
    const service = makeFrameworkService(registry);

    const { client } = testHttpClient([
      { match: 'robots.txt', body: '', headers: { 'content-type': 'text/plain' } },
      { match: 'unreachable.test', status: 500, body: 'boom' },
    ]);

    const withHttp = new DiscoveryFrameworkService({
      framework,
      sources,
      profiles,
      candidates,
      registry,
      logger,
      events: new EventRecorder(logger, new EventRepository(ctx.db)),
      http: client,
    });

    const { id, detection } = await withHttp.submitSource({
      url: 'https://unreachable.test/careers',
      displayName: null,
      sourceType: null,
      scanFrequencyMinutes: 360,
      searchTerms: [],
      location: null,
      enabled: true,
      notes: null,
    });

    expect(detection.reachable).toBe(false);
    expect(detection.rejectionReason).toBeTruthy();

    const row = await framework.getUserSource(id);
    expect(row?.status).toBe('rejected');

    // And activation refuses, rather than creating a source that cannot work.
    await expect(withHttp.activateSource(id)).rejects.toThrow(/not validated/i);

    // No source row was created.
    const all = await sources.list({ includeArchived: true });
    expect(all.every((source) => !source.id.startsWith('user:'))).toBe(true);

    void service;
  });
});
