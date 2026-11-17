import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeCandidateProfile, makeJobSource } from '@job-intel/contracts/factories';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '../testing';
import { JobRepository } from './job-repository';
import { ProfileRepository } from './profile-repository';
import { SourceRepository } from './source-repository';
import { jobs } from '../schema/jobs';
import { applications } from '../schema/matching';

/**
 * The weekly purge.
 *
 * Written against the two ways this can go wrong, both of which destroy
 * something the user cannot get back.
 *
 * Every table referencing a job cascades on delete — twenty-five of them,
 * `applications` included. So a purge that only looks at dates also deletes
 * the record that you applied to a role and are waiting to hear back on.
 * Everything else in the corpus can be re-fetched from the source; that
 * cannot.
 *
 * And most Nigerian postings state no date at all. Treating an absent
 * `posted_at` as infinitely old would delete most of the corpus on the first
 * pass.
 */
describe('job retention', () => {
  let ctx: TestDatabase;
  let repo: JobRepository;
  let profileId: string;

  const NOW = new Date('2026-11-18T12:00:00Z');
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);

    repo = new JobRepository(ctx.db);
    await new SourceRepository(ctx.db).upsert(makeJobSource({ id: 'greenhouse' }));

    const created = await new ProfileRepository(ctx.db).createProfile({
      payload: makeCandidateProfile(),
    });
    profileId = created.profileId;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function seedJob(input: {
    identity: string;
    postedAt: Date | null;
    firstSeenAt: Date;
  }): Promise<string> {
    const [row] = await ctx.db
      .insert(jobs)
      .values({
        title: `Admin Officer ${input.identity}`,
        titleNormalized: `admin officer ${input.identity}`,
        companyNameRaw: 'Lagos Holdings',
        description: 'A role with responsibilities and requirements.',
        sourceUrl: `https://example.test/jobs/${input.identity}`,
        sourceId: 'greenhouse',
        sourceIdentity: input.identity,
        contentHash: `content-${input.identity}`,
        fingerprint: `fingerprint-${input.identity}`,
        postedAt: input.postedAt,
        firstSeenAt: input.firstSeenAt,
      })
      .returning({ id: jobs.id });

    return row!.id;
  }

  const remaining = async () =>
    (await ctx.db.select({ id: jobs.id }).from(jobs)).map((r) => r.id);

  it('deletes what aged out and keeps what is inside the window', async () => {
    const fresh = await seedJob({ identity: 'fresh', postedAt: daysAgo(2), firstSeenAt: daysAgo(2) });
    const edge = await seedJob({ identity: 'edge', postedAt: daysAgo(6), firstSeenAt: daysAgo(6) });
    await seedJob({ identity: 'stale', postedAt: daysAgo(9), firstSeenAt: daysAgo(9) });

    const result = await repo.purgeExpired({ days: 7, now: NOW });

    expect(result.deleted).toBe(1);
    expect((await remaining()).sort()).toEqual([fresh, edge].sort());
  });

  it('never deletes a job that was saved or applied to, however old', async () => {
    const applied = await seedJob({
      identity: 'applied',
      postedAt: daysAgo(40),
      firstSeenAt: daysAgo(40),
    });
    await seedJob({ identity: 'ignored', postedAt: daysAgo(40), firstSeenAt: daysAgo(40) });

    // The Saved page and the Applications page read the same table, so one
    // row covers both senses of "I acted on this".
    await ctx.db.insert(applications).values({ jobId: applied, profileId, state: 'saved' });

    const result = await repo.purgeExpired({ days: 7, now: NOW });

    expect(result.deleted).toBe(1);
    expect(result.keptBecauseActedOn).toBe(1);
    expect(await remaining()).toEqual([applied]);

    // And the application record itself survived, which is the whole point:
    // a cascade would have taken it with the job.
    const rows = await ctx.db.select({ id: applications.id }).from(applications);
    expect(rows).toHaveLength(1);
  });

  it('falls back to first seen when the posting states no date', async () => {
    const seenRecently = await seedJob({
      identity: 'undated-new',
      postedAt: null,
      firstSeenAt: daysAgo(1),
    });
    await seedJob({ identity: 'undated-old', postedAt: null, firstSeenAt: daysAgo(30) });

    const result = await repo.purgeExpired({ days: 7, now: NOW });

    // Most Nigerian listings state no date. Treating that as infinitely old
    // would have deleted both.
    expect(result.deleted).toBe(1);
    expect(await remaining()).toEqual([seenRecently]);
  });

  it('deletes nothing when the corpus is all inside the window', async () => {
    await seedJob({ identity: 'a', postedAt: daysAgo(1), firstSeenAt: daysAgo(1) });
    await seedJob({ identity: 'b', postedAt: daysAgo(3), firstSeenAt: daysAgo(3) });

    const result = await repo.purgeExpired({ days: 7, now: NOW });

    expect(result).toEqual({ deleted: 0, keptBecauseActedOn: 0 });
    expect(await remaining()).toHaveLength(2);
  });
});
