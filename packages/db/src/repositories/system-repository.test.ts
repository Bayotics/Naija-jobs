import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '../testing';
import { ConfigRepository, EventRepository } from './system-repository';

describe('ConfigRepository', () => {
  let ctx: TestDatabase;
  let repo: ConfigRepository;

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);
    repo = new ConfigRepository(ctx.db);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('expands dotted keys into a nested object', async () => {
    await repo.set('matching.minimumScore', 72);
    await repo.set('notifications.enabled', true);

    expect(await repo.getAll()).toEqual({
      matching: { minimumScore: 72 },
      notifications: { enabled: true },
    });
  });

  it('stores leaves so unrelated settings do not clobber each other', async () => {
    // Two operators editing different keys under the same section must both win.
    await repo.set('matching.minimumScore', 60);
    await repo.set('matching.instantNotifyScore', 95);

    const all = (await repo.getAll()) as { matching: Record<string, unknown> };
    expect(all.matching).toEqual({ minimumScore: 60, instantNotifyScore: 95 });
  });

  it('upserts on repeated writes to the same key', async () => {
    await repo.set('matching.minimumScore', 50);
    await repo.set('matching.minimumScore', 80);

    const all = (await repo.getAll()) as { matching: { minimumScore: number } };
    expect(all.matching.minimumScore).toBe(80);
    expect(await repo.listRaw()).toHaveLength(1);
  });

  it('removes an override so the code default takes over again', async () => {
    await repo.set('matching.minimumScore', 80);
    await repo.delete('matching.minimumScore');
    expect(await repo.getAll()).toEqual({});
  });
});

describe('EventRepository', () => {
  let ctx: TestDatabase;
  let repo: EventRepository;

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);
    repo = new EventRepository(ctx.db);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const event = (
    name: Parameters<EventRepository['record']>[0]['name'],
    traceId: string | null,
  ) =>
    repo.record({
      name,
      severity: 'info',
      message: `${name}/${traceId}`,
      traceId,
      sourceId: null,
      jobId: null,
      runId: null,
      data: {},
    });

  it('filters by event name', async () => {
    await event('JOB_DISCOVERED', 'trace-a');
    await event('JOB_MATCHED', 'trace-a');

    const rows = await repo.list({ name: 'JOB_DISCOVERED' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('JOB_DISCOVERED');
  });

  it('applies name AND traceId together', async () => {
    // Regression: only the first condition used to be applied, which silently
    // widened a trace-scoped query back to the whole event stream.
    await event('JOB_DISCOVERED', 'trace-a');
    await event('JOB_DISCOVERED', 'trace-b');
    await event('JOB_MATCHED', 'trace-a');

    const rows = await repo.list({ name: 'JOB_DISCOVERED', traceId: 'trace-b' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe('JOB_DISCOVERED/trace-b');
  });

  it('returns the whole stream when no filter is given', async () => {
    await event('JOB_DISCOVERED', 'trace-a');
    await event('JOB_MATCHED', 'trace-b');
    expect(await repo.list()).toHaveLength(2);
  });

  it('counts by severity for the health endpoint', async () => {
    await event('JOB_DISCOVERED', null);
    await repo.record({
      name: 'SOURCE_RUN_FAILED',
      severity: 'error',
      message: 'boom',
      traceId: null,
      sourceId: null,
      jobId: null,
      runId: null,
      data: {},
    });

    expect(await repo.countsBySeverity(24)).toEqual({ info: 1, error: 1 });
  });
});
