import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  jobSourceSchema,
  sourceJobDraftSchema,
  type SourceJobDraft,
  type SourceJobDraftInput,
} from '@job-intel/contracts';
import { JobIdentityService } from '@job-intel/core';
import { DiscoveryRepository, EventRepository, SourceRepository } from '@job-intel/db';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '@job-intel/db/testing';
import { EventRecorder, MemoryLogger } from '@job-intel/observability';
import {
  ConnectorRegistry,
  DEFAULT_CAPABILITIES,
  type HttpClient,
  ServerError,
  type Connector,
} from '@job-intel/connectors';
import { testHttpClient } from '@job-intel/connectors/testing';
import { z } from 'zod';
import { processDraft, resolveSourceIdentity } from './pipeline/discovery-pipeline';
import { SourceRunner } from './source-runner';
import { SourceScheduler, isValidCron, nextRunAt, resolveSchedule } from './scheduler';
import { SourceHealthService } from './source-health';

/**
 * Pipeline and runner integration tests.
 *
 * Run against a real Postgres engine so the constraints that make deduplication
 * work are actually exercised, and against stub connectors so nothing depends
 * on an external website being online.
 */

const draft = (over: Partial<SourceJobDraftInput> = {}): SourceJobDraft =>
  sourceJobDraftSchema.parse({
    title: 'Backend Engineer',
    companyName: 'Acme',
    url: 'https://example.test/jobs/1',
    externalId: 'ext-1',
    raw: { a: 1 },
    ...over,
  });

/** Connector whose behaviour each test dictates. */
function stubConnector(options: {
  id?: string;
  drafts?: SourceJobDraft[];
  throws?: Error;
  available?: boolean;
}): Connector<Record<string, never>> {
  return {
    id: options.id ?? 'stub',
    displayName: 'Stub',
    sourceType: 'job_api',
    accessTier: 'official_api',
    capabilities: DEFAULT_CAPABILITIES,
    configSchema: z.object({}).passthrough() as unknown as z.ZodType<Record<string, never>, unknown>,
    availability: () =>
      options.available === false
        ? { available: false, reason: 'stub unavailable', requires: ['STUB_KEY'] }
        : { available: true, reason: null, requires: [] },
    healthCheck: () => Promise.resolve({ healthy: true, message: 'ok', checkedAt: new Date() }),
     
    async *discover() {
      if (options.throws) throw options.throws;
      for (const d of options.drafts ?? []) yield d;
    },
  };
}

describe('discovery pipeline', () => {
  let ctx: TestDatabase;
  let repo: DiscoveryRepository;
  const identity = new JobIdentityService();

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);
    repo = new DiscoveryRepository(ctx.db);
    await ctx.db.execute(sql`
      INSERT INTO job_sources (id, connector_id, display_name, source_type, access_tier)
      VALUES ('s1', 'stub', 'Stub', 'job_api', 'official_api')
    `);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const deps = () => ({
    repository: repo,
    identity,
    sourceId: 's1',
    sourceRunId: null,
    traceId: 'trace',
  });

  it('creates a job and stores the raw payload for debugging', async () => {
    const result = await processDraft(draft(), deps());
    expect(result.outcome).toBe('created');

    const raw = await ctx.db.execute(sql`SELECT payload FROM raw_postings`);
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]?.payload).toEqual({ a: 1 });
  });

  it('does not duplicate an unchanged posting on re-discovery', async () => {
    await processDraft(draft(), deps());
    const second = await processDraft(draft(), deps());

    expect(second.outcome).toBe('unchanged');
    const count = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM jobs`);
    expect(count.rows[0]?.n).toBe(1);
  });

  it('updates and versions a job when material content changes', async () => {
    const first = await processDraft(draft({ title: 'Backend Engineer' }), deps());
    const second = await processDraft(
      draft({ title: 'Senior Backend Engineer', salaryText: '$150,000 per year' }),
      deps(),
    );

    expect(second.outcome).toBe('updated');
    expect(second.jobId).toBe(first.jobId);
    expect(second.changedFields).toEqual(expect.arrayContaining(['title']));

    // Still one job row, plus a snapshot of the previous state.
    const jobs = await ctx.db.execute(sql`SELECT version FROM jobs`);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.version).toBe(2);

    const versions = await repo.listVersions(second.jobId as string);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
  });

  it('does not version a change that is not material', async () => {
    await processDraft(draft({ description: 'Original body text here.' }), deps());
    // Same material fields; only the raw payload differs.
    const second = await processDraft(
      draft({ description: 'Original body text here.', raw: { a: 2 } }),
      deps(),
    );

    expect(second.outcome).toBe('unchanged');
    expect(await repo.listVersions(second.jobId as string)).toHaveLength(0);
  });

  it('tracks first and last discovery timestamps across runs', async () => {
    const first = await processDraft(draft(), deps());
    await new Promise((r) => setTimeout(r, 20));
    await processDraft(draft({ title: 'Changed Title' }), deps());

    const row = await ctx.db.execute(
      sql`SELECT first_seen_at, last_seen_at FROM jobs WHERE id = ${first.jobId}::uuid`,
    );
    const { first_seen_at: firstSeen, last_seen_at: lastSeen } = row.rows[0] as {
      first_seen_at: string;
      last_seen_at: string;
    };
    // first_seen_at must survive an update.
    expect(new Date(lastSeen).getTime()).toBeGreaterThan(new Date(firstSeen).getTime());
  });

  it('rejects a malformed posting without throwing', async () => {
    const result = await processDraft(
      { ...draft(), title: '', companyName: '' } as SourceJobDraft,
      deps(),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBeTruthy();
  });

  it('rejects a stale posting', async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    const result = await processDraft(draft({ postedAt: old }), deps(), { maxAgeDays: 90 });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain('not_stale');
  });

  it('emits an event per outcome', async () => {
    const events: string[] = [];
    await processDraft(draft(), { ...deps(), onEvent: (e) => events.push(e.type) });
    await processDraft(draft(), { ...deps(), onEvent: (e) => events.push(e.type) });
    expect(events).toEqual(['JOB_DISCOVERED', 'JOB_DUPLICATE']);
  });

  it('prefers the source id, then the URL, for stable identity', () => {
    const withId = resolveSourceIdentity(draft({ externalId: 'abc' }), 'urlhash', 'contenthash');
    expect(withId.startsWith('ext:')).toBe(true);

    const withUrl = resolveSourceIdentity(draft({ externalId: null }), 'urlhash', 'contenthash');
    expect(withUrl.startsWith('url:')).toBe(true);

    const withContent = resolveSourceIdentity(draft({ externalId: null }), null, 'contenthash');
    expect(withContent.startsWith('content:')).toBe(true);
  });

  it('treats two URLs differing only by tracking params as one job', async () => {
    const a = await processDraft(
      draft({ externalId: null, url: 'https://example.test/j/5?utm_source=a' }),
      deps(),
    );
    const b = await processDraft(
      draft({ externalId: null, url: 'https://example.test/j/5?utm_source=b' }),
      deps(),
    );
    expect(b.jobId).toBe(a.jobId);
    expect(b.outcome).toBe('unchanged');
  });
});

describe('SourceRunner', () => {
  let ctx: TestDatabase;
  let sources: SourceRepository;
  let logger: MemoryLogger;

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);
    sources = new SourceRepository(ctx.db);
    logger = new MemoryLogger();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const makeRunner = (registry: ConnectorRegistry, secrets: Record<string, string> = {}) =>
    new SourceRunner({
      registry,
      sources,
      discovery: new DiscoveryRepository(ctx.db),
      logger,
      events: new EventRecorder(logger, new EventRepository(ctx.db)),
      getSecret: (name) => secrets[name],
      createHttpClient: () => testHttpClient([]).client as HttpClient,
    });

  const addSource = async (id: string, connectorId: string, over: Record<string, unknown> = {}) => {
    await sources.upsert(
      jobSourceSchema.parse({
        id,
        connectorId,
        displayName: id,
        sourceType: 'job_api',
        accessTier: 'official_api',
        ...over,
      }),
    );
  };

  it('runs a source and records accurate statistics', async () => {
    const registry = new ConnectorRegistry().register(
      stubConnector({
        drafts: [
          draft({ externalId: 'a', url: 'https://x.test/a' }),
          draft({ externalId: 'b', url: 'https://x.test/b' }),
        ],
      }),
    );
    await addSource('s1', 'stub');

    const result = await makeRunner(registry).run('s1');
    expect(result.status).toBe('success');
    expect(result.stats.jobsDiscovered).toBe(2);
    expect(result.stats.jobsAccepted).toBe(2);

    const runs = await sources.listRuns('s1');
    expect(runs[0]?.status).toBe('success');
    expect(runs[0]?.jobsAccepted).toBe(2);
  });

  it('counts duplicates on a second run without creating rows', async () => {
    const registry = new ConnectorRegistry().register(
      stubConnector({ drafts: [draft({ externalId: 'a', url: 'https://x.test/a' })] }),
    );
    await addSource('s1', 'stub');
    const runner = makeRunner(registry);

    await runner.run('s1');
    const second = await runner.run('s1');

    expect(second.stats.jobsAccepted).toBe(0);
    expect(second.stats.jobsDuplicated).toBe(1);
    const count = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM jobs`);
    expect(count.rows[0]?.n).toBe(1);
  });

  it('contains a connector failure and still finishes the run', async () => {
    const registry = new ConnectorRegistry().register(
      stubConnector({ throws: new ServerError(503, 'source down') }),
    );
    await addSource('s1', 'stub');

    const result = await makeRunner(registry).run('s1');
    expect(result.status).toBe('failed');
    expect(result.errors[0]?.type).toBe('server_error');
    expect(result.errors[0]?.retryable).toBe(true);

    // The run is still closed out rather than left dangling.
    const runs = await sources.listRuns('s1');
    expect(runs[0]?.completedAt).not.toBeNull();
  });

  it('does NOT let one failing source affect another', async () => {
    const registry = new ConnectorRegistry()
      .register(stubConnector({ id: 'good', drafts: [draft({ externalId: 'g' })] }))
      .register(stubConnector({ id: 'bad', throws: new Error('exploded') }));

    await addSource('bad-source', 'bad');
    await addSource('good-source', 'good');

    const results = await makeRunner(registry).runAll();
    const bad = results.find((r) => r.sourceId === 'bad-source');
    const good = results.find((r) => r.sourceId === 'good-source');

    expect(bad?.status).toBe('failed');
    expect(good?.status).toBe('success');
    expect(good?.stats.jobsAccepted).toBe(1);
  });

  it('skips an unknown connector without starting a run', async () => {
    await addSource('s1', 'does-not-exist');
    const result = await makeRunner(new ConnectorRegistry()).run('s1');

    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toContain('Unknown connector');
    expect(await sources.listRuns('s1')).toHaveLength(0);
  });

  it('skips an invalid configuration rather than retrying it', async () => {
    const registry = new ConnectorRegistry().register({
      ...stubConnector({}),
      configSchema: z.object({ required: z.string() }) as unknown as Connector<Record<string, never>>['configSchema'],
    } as Connector<Record<string, never>>);
    await addSource('s1', 'stub', { config: {} });

    const result = await makeRunner(registry).run('s1');
    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toContain('Invalid source configuration');
  });

  it('skips a connector that reports itself unavailable', async () => {
    const registry = new ConnectorRegistry().register(stubConnector({ available: false }));
    await addSource('s1', 'stub');

    const result = await makeRunner(registry).run('s1');
    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toContain('STUB_KEY');
  });

  it('honours a maxItems ceiling', async () => {
    const drafts = Array.from({ length: 10 }, (_, i) =>
      draft({ externalId: `x${i}`, url: `https://x.test/${i}` }),
    );
    const registry = new ConnectorRegistry().register(stubConnector({ drafts }));
    await addSource('s1', 'stub');

    const result = await makeRunner(registry).run('s1', { maxItems: 4 });
    expect(result.stats.jobsDiscovered).toBe(4);
  });

  it('records run lifecycle events', async () => {
    const registry = new ConnectorRegistry().register(stubConnector({ drafts: [draft()] }));
    await addSource('s1', 'stub');
    await makeRunner(registry).run('s1');

    const events = await new EventRepository(ctx.db).list({});
    const names = events.map((e) => e.name);
    expect(names).toContain('SOURCE_RUN_STARTED');
    expect(names).toContain('SOURCE_RUN_COMPLETED');
  });
});

describe('scheduler', () => {
  it('resolves presets and validates cron expressions', () => {
    expect(resolveSchedule('every_15_minutes')).toBe('*/15 * * * *');
    expect(resolveSchedule('0 */6 * * *')).toBe('0 */6 * * *');
    expect(isValidCron('hourly')).toBe(true);
    expect(isValidCron('not a cron')).toBe(false);
  });

  it('computes the next run time from a schedule', () => {
    const from = new Date('2026-08-17T10:05:00Z');
    const next = nextRunAt('0 * * * *', from);
    expect(next?.toISOString()).toBe('2026-08-17T11:00:00.000Z');
  });

  it('gives every source its own cadence', async () => {
    const ctx = await createTestDatabase();
    try {
      const sources = new SourceRepository(ctx.db);
      const now = new Date('2026-08-17T12:00:00Z');

      await sources.upsert(
        jobSourceSchema.parse({
          id: 'fast',
          connectorId: 'stub',
          displayName: 'fast',
          sourceType: 'job_api',
          accessTier: 'official_api',
          scheduleCron: '*/15 * * * *',
        }),
      );
      await sources.upsert(
        jobSourceSchema.parse({
          id: 'slow',
          connectorId: 'stub',
          displayName: 'slow',
          sourceType: 'job_api',
          accessTier: 'official_api',
          scheduleCron: '0 6 * * *',
        }),
      );

      // Both last ran 30 minutes ago: the 15-minute source is due, the daily is not.
      const lastRun = new Date(now.getTime() - 30 * 60_000);
      await ctx.db.execute(sql`UPDATE job_sources SET last_attempted_run_at = ${lastRun.toISOString()}`);

      const scheduler = new SourceScheduler(
        { sources, runner: {} as never, logger: new MemoryLogger() },
        { now: () => now, random: () => 0, jitterSeconds: 0 },
      );
      const plan = await scheduler.plan();

      expect(plan.find((p) => p.sourceId === 'fast')?.shouldRun).toBe(true);
      expect(plan.find((p) => p.sourceId === 'slow')?.shouldRun).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it('never schedules a disabled source or one with an open circuit', async () => {
    const ctx = await createTestDatabase();
    try {
      const sources = new SourceRepository(ctx.db);
      await sources.upsert(
        jobSourceSchema.parse({
          id: 'off',
          connectorId: 'stub',
          displayName: 'off',
          sourceType: 'job_api',
          accessTier: 'official_api',
          enabled: false,
        }),
      );
      await sources.upsert(
        jobSourceSchema.parse({
          id: 'broken',
          connectorId: 'stub',
          displayName: 'broken',
          sourceType: 'job_api',
          accessTier: 'official_api',
        }),
      );
      await ctx.db.execute(sql`UPDATE job_sources SET circuit_state='open' WHERE id='broken'`);

      const scheduler = new SourceScheduler({
        sources,
        runner: {} as never,
        logger: new MemoryLogger(),
      });
      const plan = await scheduler.plan();

      expect(plan.find((p) => p.sourceId === 'off')?.reason).toBe('disabled');
      expect(plan.find((p) => p.sourceId === 'broken')?.reason).toBe('circuit_open');
      expect(plan.every((p) => !p.shouldRun)).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});

describe('source health', () => {
  it('flags a source whose requests succeed but yields nothing', async () => {
    const ctx = await createTestDatabase();
    try {
      const sources = new SourceRepository(ctx.db);
      await sources.upsert(
        jobSourceSchema.parse({
          id: 's1',
          connectorId: 'stub',
          displayName: 'Stub',
          sourceType: 'job_api',
          accessTier: 'official_api',
        }),
      );

      const run = await sources.startRun('s1', 'manual', 't');
      await sources.completeRun(run.id, {
        status: 'success',
        // Requests went out and succeeded; nothing came back.
        stats: { jobsDiscovered: 0, httpRequests: 5 },
      });

      const service = new SourceHealthService({
        sources,
        discovery: new DiscoveryRepository(ctx.db),
      });
      const report = await service.reportForSource('s1');

      expect(report?.yieldWarning).toBe(true);
      expect(report?.notes.join(' ')).toContain('changed its structure');
      expect(report?.runsInWindow).toBe(1);
      expect(report?.successRate).toBe(1);
    } finally {
      await ctx.close();
    }
  });
});
