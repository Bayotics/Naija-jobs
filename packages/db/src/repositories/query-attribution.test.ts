import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeCandidateProfile, makeJobSource } from '@job-intel/contracts/factories';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '../testing';
import { LearningRepository } from './learning-repository';
import { ProfileRepository } from './profile-repository';
import { SourceRepository } from './source-repository';
import { jobs } from '../schema/jobs';
import { behaviorEvents } from '../schema/feedback-loop';

/**
 * Query attribution, end to end in SQL.
 *
 * This closes a loop that was silently open: query performance was aggregated
 * from a `queryId` the caller had to put in each event's metadata, and no
 * caller ever did — so `query_performance` stayed empty and the learning layer
 * had nothing to learn from. Attribution now lives on the job, stamped at
 * discovery, and the join walks event → job → query.
 *
 * The tests below are written against the failure that actually happened: an
 * event with no metadata must still be attributed.
 */
describe('query attribution', () => {
  let ctx: TestDatabase;
  let repo: LearningRepository;
  let candidateId: string;

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);

    repo = new LearningRepository(ctx.db);
    await new SourceRepository(ctx.db).upsert(makeJobSource({ id: 'greenhouse' }));

    const created = await new ProfileRepository(ctx.db).createProfile({
      payload: makeCandidateProfile(),
    });
    candidateId = created.profileId;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function seedJob(identity: string, discoveryQueryId: string | null): Promise<string> {
    const [row] = await ctx.db
      .insert(jobs)
      .values({
        title: 'Senior Frontend Engineer',
        titleNormalized: 'senior frontend engineer',
        companyNameRaw: 'Acme',
        description: 'x'.repeat(1200),
        sourceUrl: `https://example.invalid/jobs/${identity}`,
        sourceId: 'greenhouse',
        sourceIdentity: identity,
        contentHash: `content-${identity}`,
        fingerprint: `fingerprint-${identity}`,
        remoteType: 'remote',
        countryCode: 'GB',
        city: 'London',
        applyUrl: `https://example.invalid/apply/${identity}`,
        discoveryQueryId,
      })
      .returning({ id: jobs.id });

    return row!.id;
  }

  async function seedEvent(
    jobId: string,
    eventType: string,
    metadata: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    await ctx.db.insert(behaviorEvents).values({
      candidateId,
      jobId,
      eventType,
      context: 'DASHBOARD',
      dedupeKey: `${jobId}:${eventType}:${Math.random()}`,
      metadata,
      occurredAt: new Date(),
    });
  }

  it('attributes an interaction to the query that discovered the job', async () => {
    const jobId = await seedJob('job-1', 'frontend-remote-uk');
    await seedEvent(jobId, 'JOB_VIEWED');
    await seedEvent(jobId, 'JOB_SAVED');

    const counts = await repo.queryInteractionCounts(candidateId);

    expect(counts).toHaveLength(1);
    expect(counts[0]!.queryId).toBe('frontend-remote-uk');
    expect(counts[0]!.views).toBe(1);
    expect(counts[0]!.saves).toBe(1);
  });

  it('needs no queryId in the event metadata', async () => {
    const jobId = await seedJob('job-2', 'react-berlin');
    // The exact case that produced an empty table before: a plain event.
    await seedEvent(jobId, 'JOB_CLICKED', {});

    const counts = await repo.queryInteractionCounts(candidateId);
    expect(counts[0]?.queryId).toBe('react-berlin');
    expect(counts[0]?.clicks).toBe(1);
  });

  it('lets an explicit queryId in the event override the job attribution', async () => {
    const jobId = await seedJob('job-3', 'from-the-job');
    await seedEvent(jobId, 'JOB_VIEWED', { queryId: 'from-the-event' });

    const counts = await repo.queryInteractionCounts(candidateId);
    expect(counts[0]?.queryId).toBe('from-the-event');
  });

  it('ignores jobs no query discovered', async () => {
    // Feed and ATS jobs arrive without a query; counting them under a null key
    // would invent a query that never ran.
    const jobId = await seedJob('job-4', null);
    await seedEvent(jobId, 'JOB_VIEWED');

    expect(await repo.queryInteractionCounts(candidateId)).toHaveLength(0);
  });

  it('groups several jobs under one query', async () => {
    const first = await seedJob('job-5', 'typescript-remote');
    const second = await seedJob('job-6', 'typescript-remote');

    await seedEvent(first, 'JOB_VIEWED');
    await seedEvent(second, 'JOB_VIEWED');
    await seedEvent(second, 'JOB_APPLIED');

    const counts = await repo.queryInteractionCounts(candidateId);
    expect(counts).toHaveLength(1);
    expect(counts[0]!.views).toBe(2);
    expect(counts[0]!.applications).toBe(1);
  });

  it('separates queries that perform differently', async () => {
    const good = await seedJob('job-7', 'good-query');
    const bad = await seedJob('job-8', 'bad-query');

    await seedEvent(good, 'JOB_SAVED');
    await seedEvent(bad, 'JOB_DISMISSED');

    const counts = await repo.queryInteractionCounts(candidateId);
    const byQuery = new Map(counts.map((row) => [row.queryId, row]));

    expect(byQuery.get('good-query')!.saves).toBe(1);
    expect(byQuery.get('bad-query')!.rejections).toBe(1);
  });
});
