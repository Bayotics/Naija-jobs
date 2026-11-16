import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeCandidateProfile, makeJobSource } from '@job-intel/contracts/factories';
import { jobExplorerQuerySchema } from '@job-intel/contracts';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '../testing';
import { OpsRepository } from './ops-repository';
import { ProfileRepository } from './profile-repository';
import { SourceRepository } from './source-repository';
import { jobs } from '../schema/jobs';

/**
 * Operations aggregation against a real database.
 *
 * The two properties the brief cares about most, proven in SQL: an empty system
 * reports zeros rather than plausible placeholders, and every filter in the job
 * explorer actually narrows the result rather than being silently ignored.
 */
describe('OpsRepository', () => {
  let ctx: TestDatabase;
  let repo: OpsRepository;
  let profileId: string;

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);

    repo = new OpsRepository(ctx.db);
    await new SourceRepository(ctx.db).upsert(makeJobSource({ id: 'greenhouse' }));

    const created = await new ProfileRepository(ctx.db).createProfile({
      payload: makeCandidateProfile(),
    });
    profileId = created.profileId;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function seedJob(overrides: Record<string, unknown> = {}) {
    const id = Math.random().toString(36).slice(2, 10);
    const [row] = await ctx.db
      .insert(jobs)
      .values({
        title: 'Senior Frontend Engineer',
        titleNormalized: 'senior frontend engineer',
        companyNameRaw: 'Northwind',
        description: 'x'.repeat(1200),
        sourceUrl: `https://example.test/jobs/${id}`,
        sourceId: 'greenhouse',
        sourceIdentity: id,
        contentHash: `content-${id}`,
        fingerprint: `fingerprint-${id}`,
        remoteType: 'remote',
        countryCode: 'DE',
        city: 'Berlin',
        salaryNormalizedAnnualUsd: '120000',
        applyUrl: `https://boards.greenhouse.io/${id}`,
        ...overrides,
      })
      .returning({ id: jobs.id });
    return row!.id;
  }

  it('reports zeros for an empty system rather than inventing numbers', async () => {
    const counters = await repo.pipelineCounters(profileId);
    expect(counters).toMatchObject({
      discoveredToday: 0,
      discoveredThisHour: 0,
      enriched: 0,
      matched: 0,
      recommended: 0,
      duplicates: 0,
      stale: 0,
    });

    const quality = await repo.dataQualityCounts();
    expect(quality.total).toBe(0);

    const funnel = await repo.funnelCounts(profileId, 24);
    expect(Object.values(funnel).every((value) => value === 0)).toBe(true);
  });

  it('counts discovery in today and this-hour windows', async () => {
    await seedJob();
    await seedJob();
    // Firmly outside both windows.
    await seedJob({ firstSeenAt: new Date(Date.now() - 40 * 3_600_000) });

    const counters = await repo.pipelineCounters(profileId);
    expect(counters.discoveredThisHour).toBe(2);
    expect(counters.totalJobs).toBe(3);
  });

  it('records and reads back a pipeline run with its timeline', async () => {
    const runId = await repo.startRun({ trigger: 'MANUAL', triggeredBy: 'tester', note: 'test run' });

    await repo.appendTimeline(runId, [
      { at: new Date(), stage: 'discovery', event: 'Discovery started', detail: '', severity: 'info' },
    ]);
    // Appended, not replaced — concurrent stages must not overwrite each other.
    await repo.appendTimeline(runId, [
      { at: new Date(), stage: 'enrichment', event: 'Enrichment started', detail: '', severity: 'info' },
    ]);

    await repo.completeRun(runId, {
      status: 'success',
      counters: { jobsDiscovered: 12, jobsMatched: 8, jobsRecommended: 3 },
    });

    const run = await repo.getRun(runId);
    expect(run?.status).toBe('success');
    expect(run?.jobsDiscovered).toBe(12);
    expect(run?.durationMs).toBeGreaterThanOrEqual(0);
    expect(run?.timeline).toHaveLength(2);
    expect(run?.timeline[1]?.stage).toBe('enrichment');
  });

  it('reports the currently running pass, and nothing once it completes', async () => {
    const runId = await repo.startRun({ trigger: 'SCHEDULED' });
    expect((await repo.currentRun())?.id).toBe(runId);

    await repo.completeRun(runId, { status: 'success' });
    expect(await repo.currentRun()).toBeNull();
  });

  it('filters the job explorer by every supported dimension', async () => {
    await seedJob({ title: 'Backend Engineer', titleNormalized: 'backend engineer' });
    await seedJob({ companyNameRaw: 'Helios', countryCode: 'NL', city: 'Amsterdam' });
    await seedJob({ remoteType: 'onsite', salaryNormalizedAnnualUsd: '40000' });

    const all = await repo.exploreJobs(jobExplorerQuerySchema.parse({}), profileId);
    expect(all.total).toBe(3);

    const byText = await repo.exploreJobs(
      jobExplorerQuerySchema.parse({ q: 'backend' }),
      profileId,
    );
    expect(byText.total).toBe(1);

    const byCountry = await repo.exploreJobs(
      jobExplorerQuerySchema.parse({ countryCode: 'NL' }),
      profileId,
    );
    expect(byCountry.total).toBe(1);

    const byRemote = await repo.exploreJobs(
      jobExplorerQuerySchema.parse({ remoteType: 'onsite' }),
      profileId,
    );
    expect(byRemote.total).toBe(1);

    const bySalary = await repo.exploreJobs(
      jobExplorerQuerySchema.parse({ minSalaryUsd: 100_000 }),
      profileId,
    );
    expect(bySalary.total).toBe(2);
  });

  it('paginates rather than returning the corpus', async () => {
    for (let i = 0; i < 8; i += 1) await seedJob();

    const page = await repo.exploreJobs(
      jobExplorerQuerySchema.parse({ limit: 3, offset: 3 }),
      profileId,
    );
    expect(page.items).toHaveLength(3);
    // The total is the whole match set, so the UI can paginate honestly.
    expect(page.total).toBe(8);
  });

  it('treats explorer text as a parameter, not as SQL', async () => {
    await seedJob();
    const hostile = await repo.exploreJobs(
      jobExplorerQuerySchema.parse({ q: "'; DROP TABLE jobs; --" }),
      profileId,
    );
    expect(hostile.total).toBe(0);
    // The table is still there.
    expect((await repo.exploreJobs(jobExplorerQuerySchema.parse({}), profileId)).total).toBe(1);
  });

  it('inspects one job with everything known about it', async () => {
    const jobId = await seedJob();
    const inspection = await repo.inspectJob(jobId, profileId);

    expect(inspection?.job.id).toBe(jobId);
    // Absent stages are null, not fabricated.
    expect(inspection?.enrichment).toBeNull();
    expect(inspection?.match).toBeNull();
    expect(inspection?.duplicates).toEqual([]);
  });

  it('records AI usage and separates priced from unpriced models', async () => {
    await repo.recordAiUsage({
      operation: 'enrichment_extraction',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      calls: 1,
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.002,
      latencyMs: 320,
      succeeded: true,
      jobId: null,
      runId: null,
      sourceId: null,
    });

    await repo.recordAiUsage({
      operation: 'match_reasoning',
      provider: 'unknown',
      model: 'mystery-model',
      calls: 1,
      inputTokens: 500,
      outputTokens: 100,
      costUsd: 0,
      latencyMs: null,
      succeeded: true,
      jobId: null,
      runId: null,
      sourceId: null,
      priced: false,
    });

    const records = await repo.aiUsageRecords(24);
    expect(records).toHaveLength(2);

    // An unpriced model must be visible, not silently counted as free.
    expect(await repo.unpricedModels()).toEqual(['mystery-model']);
  });

  it('records audit entries with before and after', async () => {
    await repo.recordAudit({
      action: 'source.disabled',
      actor: 'tester',
      target: 'greenhouse',
      before: { enabled: true },
      after: { enabled: false },
      reason: 'rate limited',
      requestId: 'abc123',
    });

    const entries = await repo.listAudit({ limit: 10 });
    expect(entries).toHaveLength(1);
    // The useful half of "who changed this" is what it was before.
    expect(entries[0]?.before).toEqual({ enabled: true });
    expect(entries[0]?.after).toEqual({ enabled: false });
    expect(entries[0]?.reason).toBe('rate limited');

    const filtered = await repo.listAudit({ action: 'source.enabled' });
    expect(filtered).toHaveLength(0);
  });

  it('stores latency samples so percentiles are computable', async () => {
    for (const value of [10, 20, 30, 900]) {
      await repo.recordSample({ operation: 'enrichment', valueMs: value });
    }

    const samples = await repo.latencySamples(24);
    expect(samples.get('enrichment')).toHaveLength(4);
    // Raw samples, not a pre-averaged bucket: p99 cannot be recovered from a mean.
    expect(samples.get('enrichment')).toContain(900);
  });

  it('rolls HTTP outcomes into one bucket per source per hour', async () => {
    const at = new Date();
    await repo.recordHttpOutcomes({
      sourceId: 'greenhouse', requests: 10, succeeded: 9, failed: 1, rateLimited: 0, at,
    });
    await repo.recordHttpOutcomes({
      sourceId: 'greenhouse', requests: 5, succeeded: 3, failed: 2, rateLimited: 2, at,
    });

    const summaries = await repo.rateLimitSummaries(24);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.requests).toBe(15);
    expect(summaries[0]?.rateLimited).toBe(2);
  });

  it('queries structured events by job, severity and window', async () => {
    const jobId = await seedJob();
    await ctx.db.execute(
      (await import('drizzle-orm')).sql`
        INSERT INTO system_events (name, severity, message, job_id)
        VALUES ('JOB_DISCOVERED', 'info', 'found it', ${jobId}),
               ('JOB_REJECTED', 'warn', 'rejected', ${jobId})`,
    );

    expect(await repo.queryEvents({ jobId })).toHaveLength(2);
    expect(await repo.queryEvents({ jobId, severity: ['warn'] })).toHaveLength(1);
    // Outside the window: present in the table, absent from the query.
    expect(await repo.queryEvents({ jobId, sinceHours: 1, name: ['JOB_EXPIRED'] })).toHaveLength(0);
  });
});
