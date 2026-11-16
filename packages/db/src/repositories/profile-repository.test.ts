import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeCandidateProfile } from '@job-intel/contracts/factories';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '../testing';
import { ProfileRepository, mergeProfilePatch } from './profile-repository';

/**
 * Profile versioning against a real database.
 *
 * This is the persistence half of the "change preferences without changing
 * code" requirement: a patch must produce a new immutable version and flip
 * exactly one active row, atomically.
 */
describe('ProfileRepository', () => {
  let ctx: TestDatabase;
  let repo: ProfileRepository;

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);
    repo = new ProfileRepository(ctx.db);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('creates a profile at version 1 and marks it active', async () => {
    const created = await repo.createProfile({ payload: makeCandidateProfile() });
    expect(created.version).toBe(1);

    const active = await repo.getActiveProfile();
    expect(active?.versionId).toBe(created.versionId);
  });

  it('applies a preference change as a new active version', async () => {
    await repo.createProfile({
      payload: makeCandidateProfile({ preferences: { salary: { minimum: 70_000 } } }),
    });

    const updated = await repo.applyPatch({
      preferences: { salary: { minimum: 90_000 } },
      changeSummary: 'Raised salary floor',
    });

    expect(updated.version).toBe(2);
    expect(updated.payload.preferences.salary.minimum).toBe(90_000);

    const active = await repo.getActiveProfile();
    expect(active?.version).toBe(2);
    expect(active?.payload.preferences.salary.minimum).toBe(90_000);
  });

  it('keeps exactly one active version after repeated changes', async () => {
    await repo.createProfile({ payload: makeCandidateProfile() });
    await repo.applyPatch({ preferences: { location: { countries: ['DE'] } } });
    await repo.applyPatch({ preferences: { location: { countries: ['DE', 'NL'] } } });

    const active = await repo.getActiveProfile();
    expect(active?.version).toBe(3);
    expect(active?.payload.preferences.location.countries).toEqual(['DE', 'NL']);

    const versions = await repo.listVersions(active!.profileId);
    expect(versions).toHaveLength(3);
    expect(versions.filter((v) => v.isActive)).toHaveLength(1);
  });

  it('preserves history so an old version remains readable', async () => {
    const created = await repo.createProfile({
      payload: makeCandidateProfile({ preferences: { salary: { minimum: 60_000 } } }),
    });
    await repo.applyPatch({ preferences: { salary: { minimum: 95_000 } } });

    const versions = await repo.listVersions(created.profileId);
    const first = versions.find((v) => v.version === 1);
    // The score a v1 match produced must stay interpretable after the change.
    expect(first?.payload.preferences.salary.minimum).toBe(60_000);
  });

  it('replaces arrays rather than concatenating them', async () => {
    // Concatenation would make removing a country impossible via the patch API.
    await repo.createProfile({
      payload: makeCandidateProfile({ preferences: { location: { countries: ['DE', 'NL'] } } }),
    });
    const updated = await repo.applyPatch({
      preferences: { location: { countries: ['IE'] } },
    });
    expect(updated.payload.preferences.location.countries).toEqual(['IE']);
  });

  it('rejects a patch that would produce an invalid profile', async () => {
    await repo.createProfile({ payload: makeCandidateProfile() });
    await expect(
      repo.applyPatch({ identity: { email: 'not-an-email' } }),
    ).rejects.toThrow();

    // The rejected patch must not have advanced the version.
    expect((await repo.getActiveProfile())?.version).toBe(1);
  });

  it('fails clearly when no profile exists yet', async () => {
    await expect(repo.applyPatch({ preferences: { desiredTitles: ['X'] } })).rejects.toThrow(
      /No active candidate profile/,
    );
  });
});

describe('mergeProfilePatch', () => {
  it('merges nested objects and replaces arrays', () => {
    const merged = mergeProfilePatch(
      { a: { b: 1, c: 2 }, list: [1, 2, 3] },
      { a: { c: 9 }, list: [7] },
    );
    expect(merged).toEqual({ a: { b: 1, c: 9 }, list: [7] });
  });

  it('ignores undefined values so an absent field means "unchanged"', () => {
    expect(mergeProfilePatch({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });
});
