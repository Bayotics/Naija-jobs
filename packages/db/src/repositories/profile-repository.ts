import { and, desc, eq } from 'drizzle-orm';
import {
  candidateProfilePayloadSchema,
  type CandidateProfilePatch,
  type CandidateProfilePayload,
} from '@job-intel/contracts';
import type { Database } from '../client';
import { candidateProfiles, profileVersions, users } from '../schema/identity';

export interface ActiveProfile {
  profileId: string;
  versionId: string;
  version: number;
  payload: CandidateProfilePayload;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep merge with array *replacement* rather than concatenation.
 *
 * This is the semantics a preference patch needs: sending
 * `{ preferences: { location: { countries: ['NL'] } } }` must mean "the list is
 * now exactly NL", not "add NL to whatever was there". Concatenating would make
 * removing a country impossible through the patch API.
 */
export function mergeProfilePatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] =
      isPlainObject(value) && isPlainObject(current)
        ? mergeProfilePatch(current, value)
        : value;
  }
  return out;
}

/**
 * Reads and evolves the candidate profile.
 *
 * The central guarantee: a preference change is a new immutable version plus an
 * activation flip — never an in-place edit. That is what lets a stored match
 * score stay interpretable, and what makes "change a preference" a data
 * operation rather than a deploy.
 */
export class ProfileRepository {
  constructor(private readonly db: Database) {}

  async getActiveProfile(): Promise<ActiveProfile | null> {
    const rows = await this.db
      .select({
        profileId: candidateProfiles.id,
        versionId: profileVersions.id,
        version: profileVersions.version,
        payload: profileVersions.payload,
      })
      .from(candidateProfiles)
      .innerJoin(
        profileVersions,
        and(
          eq(profileVersions.profileId, candidateProfiles.id),
          eq(profileVersions.isActive, true),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      profileId: row.profileId,
      versionId: row.versionId,
      version: row.version,
      // Re-validate on read: a payload written by an older schema version must
      // either upgrade cleanly or fail loudly, never silently half-apply.
      payload: candidateProfilePayloadSchema.parse(row.payload),
    };
  }

  async listVersions(profileId: string, limit = 50) {
    return this.db
      .select()
      .from(profileVersions)
      .where(eq(profileVersions.profileId, profileId))
      .orderBy(desc(profileVersions.version))
      .limit(limit);
  }

  /** Creates the user + profile + version 1. Used by seeding and first-run setup. */
  async createProfile(input: {
    payload: CandidateProfilePayload;
    displayName?: string;
  }): Promise<ActiveProfile> {
    const payload = candidateProfilePayloadSchema.parse(input.payload);

    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: payload.identity.email,
          name: payload.identity.fullName,
          timezone: payload.identity.timezone,
          isAdmin: true,
        })
        .returning();
      if (!user) throw new Error('Failed to create user');

      const [profile] = await tx
        .insert(candidateProfiles)
        .values({
          userId: user.id,
          displayName: input.displayName ?? payload.identity.fullName,
        })
        .returning();
      if (!profile) throw new Error('Failed to create candidate profile');

      const [version] = await tx
        .insert(profileVersions)
        .values({
          profileId: profile.id,
          version: 1,
          payload,
          changeSummary: 'Initial profile',
          isActive: true,
        })
        .returning();
      if (!version) throw new Error('Failed to create profile version');

      await tx
        .update(candidateProfiles)
        .set({ activeVersionId: version.id, updatedAt: new Date() })
        .where(eq(candidateProfiles.id, profile.id));

      return {
        profileId: profile.id,
        versionId: version.id,
        version: version.version,
        payload,
      };
    });
  }

  /**
   * Applies a patch as a new active version.
   *
   * Runs in one transaction: deactivate the old version, insert the new one,
   * repoint the profile. A crash midway leaves the previous version active
   * rather than a profile with no active version at all.
   */
  async applyPatch(patch: CandidateProfilePatch): Promise<ActiveProfile> {
    const active = await this.getActiveProfile();
    if (!active) {
      throw new Error('No active candidate profile exists. Run the seed or create one first.');
    }

    const { changeSummary, ...sections } = patch;
    const merged = mergeProfilePatch(
      active.payload as unknown as Record<string, unknown>,
      sections as Record<string, unknown>,
    );
    // Validate the *result*, not the patch: an individually-valid patch can
    // still produce an invalid profile.
    const nextPayload = candidateProfilePayloadSchema.parse(merged);

    return this.db.transaction(async (tx) => {
      await tx
        .update(profileVersions)
        .set({ isActive: false })
        .where(
          and(
            eq(profileVersions.profileId, active.profileId),
            eq(profileVersions.isActive, true),
          ),
        );

      const [version] = await tx
        .insert(profileVersions)
        .values({
          profileId: active.profileId,
          version: active.version + 1,
          payload: nextPayload,
          changeSummary: changeSummary ?? describeChangedSections(sections),
          isActive: true,
        })
        .returning();
      if (!version) throw new Error('Failed to create profile version');

      await tx
        .update(candidateProfiles)
        .set({ activeVersionId: version.id, updatedAt: new Date() })
        .where(eq(candidateProfiles.id, active.profileId));

      return {
        profileId: active.profileId,
        versionId: version.id,
        version: version.version,
        payload: nextPayload,
      };
    });
  }

  /** Rolls back by re-activating a historical version as a new version. */
  async activateVersion(profileId: string, versionId: string): Promise<ActiveProfile> {
    const rows = await this.db
      .select()
      .from(profileVersions)
      .where(and(eq(profileVersions.id, versionId), eq(profileVersions.profileId, profileId)))
      .limit(1);
    const target = rows[0];
    if (!target) throw new Error(`Profile version ${versionId} not found`);

    return this.applyPatch({
      ...(target.payload as unknown as CandidateProfilePatch),
      changeSummary: `Restored from version ${target.version}`,
    });
  }
}

function describeChangedSections(sections: Record<string, unknown>): string {
  const names = Object.keys(sections).filter((k) => sections[k] !== undefined);
  return names.length > 0 ? `Updated: ${names.join(', ')}` : 'Updated profile';
}
