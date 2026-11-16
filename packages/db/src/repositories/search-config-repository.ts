import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import {
  configHistoryEntrySchema,
  profileJobMatchSchema,
  searchOverrideSchema,
  searchProfileSchema,
  searchStateSchema,
  type ConfigChange,
  type ConfigHistoryEntry,
  type ConfigOperation,
  type ProfileJobMatch,
  type SearchOverride,
  type SearchProfile,
  type SearchState,
} from '@job-intel/contracts';
import type { Database } from '../client';
import {
  profileJobMatches,
  searchConfigHistory,
  searchOverrides,
  searchProfiles,
  searchStates,
} from '../schema/search-configuration';
import { jobs } from '../schema/jobs';

/**
 * Search configuration persistence.
 *
 * Two invariants live here rather than in callers.
 *
 * **Every write bumps `configVersion`.** That single integer is how the rest of
 * the system knows its cached configuration is stale — cheaper and far easier
 * to debug than a message bus, and it cannot be forgotten because it happens
 * inside the same transaction as the write.
 *
 * **Every write records history first.** The snapshot is taken before the
 * change lands, so undo is a restore rather than a reconstruction. A change
 * that fails validation never reaches here, so history never contains an entry
 * for something that did not happen.
 */
export class SearchConfigRepository {
  constructor(private readonly db: Database) {}

  // ── Profiles ──────────────────────────────────────────────────────────────

  private toProfile(row: typeof searchProfiles.$inferSelect): SearchProfile | null {
    const parsed = searchProfileSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }

  async listProfiles(
    candidateId: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<SearchProfile[]> {
    const conditions = [eq(searchProfiles.candidateId, candidateId)];

    if (!options.includeArchived) {
      conditions.push(inArray(searchProfiles.state, ['active', 'paused']));
    }

    const rows = await this.db
      .select()
      .from(searchProfiles)
      .where(and(...conditions))
      .orderBy(desc(searchProfiles.updatedAt))
      .limit(50);

    return rows
      .map((row) => this.toProfile(row))
      .filter((profile): profile is SearchProfile => profile !== null);
  }

  async getProfile(profileId: string): Promise<SearchProfile | null> {
    const [row] = await this.db
      .select()
      .from(searchProfiles)
      .where(eq(searchProfiles.id, profileId))
      .limit(1);

    return row ? this.toProfile(row) : null;
  }

  /** Profiles the scheduler should consider. */
  async schedulableProfiles(candidateId?: string) {
    const conditions = [eq(searchProfiles.enabled, true), eq(searchProfiles.state, 'active')];
    if (candidateId) conditions.push(eq(searchProfiles.candidateId, candidateId));

    const rows = await this.db
      .select()
      .from(searchProfiles)
      .where(and(...conditions))
      .limit(200);

    return rows
      .map((row) => ({ profile: this.toProfile(row), lastRunAt: row.lastRunAt }))
      .filter((entry): entry is { profile: SearchProfile; lastRunAt: Date | null } =>
        entry.profile !== null,
      );
  }

  async createProfile(profile: SearchProfile): Promise<SearchProfile> {
    const [row] = await this.db.insert(searchProfiles).values(this.toRow(profile)).returning();

    await this.bumpVersion(profile.candidateId);
    return this.toProfile(row!) ?? profile;
  }

  /**
   * Replaces a profile wholesale.
   *
   * The whole object rather than a patch: partial updates to a nested
   * configuration are where "I changed one thing and something else moved" come
   * from, and the caller always has the resolved object anyway.
   */
  async updateProfile(profile: SearchProfile): Promise<SearchProfile> {
    const [row] = await this.db
      .update(searchProfiles)
      .set({ ...this.toRow(profile), updatedAt: new Date() })
      .where(eq(searchProfiles.id, profile.id))
      .returning();

    await this.bumpVersion(profile.candidateId);
    return row ? (this.toProfile(row) ?? profile) : profile;
  }

  async setProfileState(
    profileId: string,
    candidateId: string,
    state: 'active' | 'paused' | 'archived',
  ): Promise<void> {
    await this.db
      .update(searchProfiles)
      .set({ state, enabled: state === 'active', updatedAt: new Date() })
      .where(eq(searchProfiles.id, profileId));

    await this.bumpVersion(candidateId);
  }

  async deleteProfile(profileId: string, candidateId: string): Promise<void> {
    await this.db.delete(searchProfiles).where(eq(searchProfiles.id, profileId));
    await this.bumpVersion(candidateId);
  }

  async markRun(profileId: string, at = new Date()): Promise<void> {
    await this.db
      .update(searchProfiles)
      .set({ lastRunAt: at })
      .where(eq(searchProfiles.id, profileId));
  }

  private toRow(profile: SearchProfile) {
    return {
      id: profile.id,
      candidateId: profile.candidateId,
      profileName: profile.profileName,
      description: profile.description,
      state: profile.state,
      enabled: profile.enabled,
      roles: profile.roles,
      locations: profile.locations,
      excludedLocations: profile.excludedLocations,
      locationStrictness: profile.locationStrictness,
      remotePreference: profile.remotePreference,
      remoteScope: profile.remoteScope as unknown as Record<string, unknown>,
      employmentTypes: [...profile.employmentTypes],
      seniorityLevels: [...profile.seniorityLevels],
      minimumExperienceYears: profile.minimumExperienceYears,
      maximumExperienceYears: profile.maximumExperienceYears,
      salary: profile.salary,
      skills: profile.skills,
      excludedSkills: profile.excludedSkills,
      skillStrictness: profile.skillStrictness,
      keywords: profile.keywords,
      companies: profile.companies,
      industries: profile.industries,
      visa: profile.visa,
      languages: profile.languages,
      sources: profile.sources,
      excludedSources: profile.excludedSources,
      searchFrequency: profile.searchFrequency,
      notificationPolicy: profile.notificationPolicy as unknown as Record<string, unknown>,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  // ── Global state ──────────────────────────────────────────────────────────

  async getState(candidateId: string): Promise<SearchState> {
    const [row] = await this.db
      .select()
      .from(searchStates)
      .where(eq(searchStates.candidateId, candidateId))
      .limit(1);

    return searchStateSchema.parse(row ?? { candidateId });
  }

  /**
   * Bumps the version every consumer watches.
   *
   * Upserted rather than updated so a candidate who has never touched the
   * settings still gets a row on their first configuration change — otherwise
   * the first write would silently do nothing and every cache would stay stale.
   */
  async bumpVersion(candidateId: string): Promise<number> {
    const [row] = await this.db
      .insert(searchStates)
      .values({ candidateId, configVersion: 1, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: searchStates.candidateId,
        set: {
          configVersion: sql`${searchStates.configVersion} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ version: searchStates.configVersion });

    return row?.version ?? 0;
  }

  async setPaused(
    candidateId: string,
    paused: boolean,
    reason: string | null = null,
  ): Promise<SearchState> {
    const now = new Date();

    const [row] = await this.db
      .insert(searchStates)
      .values({
        candidateId,
        paused,
        pausedAt: paused ? now : null,
        pauseReason: paused ? reason : null,
        configVersion: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: searchStates.candidateId,
        set: {
          paused,
          pausedAt: paused ? now : null,
          pauseReason: paused ? reason : null,
          configVersion: sql`${searchStates.configVersion} + 1`,
          updatedAt: now,
        },
      })
      .returning();

    return searchStateSchema.parse(row);
  }

  // ── Overrides ─────────────────────────────────────────────────────────────

  async listOverrides(candidateId: string, activeOnly = false): Promise<SearchOverride[]> {
    const conditions = [eq(searchOverrides.candidateId, candidateId)];
    if (activeOnly) conditions.push(eq(searchOverrides.active, true));

    const rows = await this.db
      .select()
      .from(searchOverrides)
      .where(and(...conditions))
      .orderBy(desc(searchOverrides.createdAt))
      .limit(100);

    return rows
      .map((row) => searchOverrideSchema.safeParse(row))
      .filter((parsed): parsed is { success: true; data: SearchOverride } => parsed.success)
      .map((parsed) => parsed.data);
  }

  async createOverride(override: SearchOverride): Promise<SearchOverride> {
    const [row] = await this.db
      .insert(searchOverrides)
      .values({
        id: override.id,
        candidateId: override.candidateId,
        profileId: override.profileId,
        field: override.field,
        oldValue: override.oldValue,
        newValue: override.newValue,
        startTime: override.startTime,
        endTime: override.endTime,
        reason: override.reason,
        active: override.active,
      })
      .returning();

    await this.bumpVersion(override.candidateId);
    return searchOverrideSchema.parse(row);
  }

  async cancelOverride(overrideId: string, candidateId: string): Promise<void> {
    await this.db
      .update(searchOverrides)
      .set({ active: false, expiredAt: new Date() })
      .where(eq(searchOverrides.id, overrideId));

    await this.bumpVersion(candidateId);
  }

  /**
   * Retires overrides whose window has closed.
   *
   * Run by the scheduler. Returns what it retired so the caller can write a
   * history entry — an override that silently stops applying leaves someone
   * wondering why their search changed for no reason.
   */
  async expireOverrides(now = new Date()): Promise<SearchOverride[]> {
    const due = await this.db
      .select()
      .from(searchOverrides)
      .where(and(eq(searchOverrides.active, true), lte(searchOverrides.endTime, now)))
      .limit(200);

    if (due.length === 0) return [];

    await this.db
      .update(searchOverrides)
      .set({ active: false, expiredAt: now })
      .where(
        inArray(
          searchOverrides.id,
          due.map((row) => row.id),
        ),
      );

    // One bump per affected candidate, so every cache refreshes.
    for (const candidateId of new Set(due.map((row) => row.candidateId))) {
      await this.bumpVersion(candidateId);
    }

    return due
      .map((row) => searchOverrideSchema.safeParse(row))
      .filter((parsed): parsed is { success: true; data: SearchOverride } => parsed.success)
      .map((parsed) => parsed.data);
  }

  // ── History and undo ──────────────────────────────────────────────────────

  async recordHistory(input: {
    candidateId: string;
    profileId: string | null;
    operation: ConfigOperation;
    changes: readonly ConfigChange[];
    snapshotBefore: unknown;
    source: string;
    actor?: string;
    reason?: string | null;
    instruction?: string | null;
  }): Promise<ConfigHistoryEntry | null> {
    const [row] = await this.db
      .insert(searchConfigHistory)
      .values({
        candidateId: input.candidateId,
        profileId: input.profileId,
        operation: input.operation,
        changes: [...input.changes],
        snapshotBefore: input.snapshotBefore,
        source: input.source,
        actor: input.actor ?? 'user',
        reason: input.reason ?? null,
        instruction: input.instruction ?? null,
      })
      .returning();

    const parsed = configHistoryEntrySchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }

  async listHistory(candidateId: string, limit = 50) {
    return this.db
      .select()
      .from(searchConfigHistory)
      .where(eq(searchConfigHistory.candidateId, candidateId))
      .orderBy(desc(searchConfigHistory.occurredAt))
      .limit(limit);
  }

  /**
   * The most recent change that has not already been undone.
   *
   * Excluding undone entries is what stops "undo" twice in a row from oscillating
   * between two states — the second press reaches the change *before* the one
   * just reverted, which is what people expect.
   */
  async lastUndoableChange(candidateId: string, profileId?: string) {
    const conditions = [
      eq(searchConfigHistory.candidateId, candidateId),
      isNull(searchConfigHistory.undoneAt),
      /*
       * Undoable means restorable.
       *
       * Entries without a snapshot — a profile creation, an override expiring —
       * are still history, but they cannot be put back. Without this the most
       * recent snapshot-less entry blocked undo entirely: the user pressed undo,
       * was told there was nothing to restore, and the change they actually
       * wanted reversed sat one row further down.
       */
      isNotNull(searchConfigHistory.snapshotBefore),
    ];

    if (profileId) conditions.push(eq(searchConfigHistory.profileId, profileId));

    const [row] = await this.db
      .select()
      .from(searchConfigHistory)
      .where(and(...conditions))
      .orderBy(desc(searchConfigHistory.occurredAt))
      .limit(1);

    return row ?? null;
  }

  async markUndone(historyId: string): Promise<void> {
    await this.db
      .update(searchConfigHistory)
      .set({ undoneAt: new Date() })
      .where(eq(searchConfigHistory.id, historyId));
  }

  // ── Profile-specific matching ─────────────────────────────────────────────

  async saveProfileMatch(match: ProfileJobMatch): Promise<void> {
    const row = {
      profileId: match.profileId,
      candidateId: match.candidateId,
      jobId: match.jobId,
      score: match.score,
      eligible: match.eligible,
      reason: match.reason,
      matchedCriteria: [...match.matchedCriteria],
      failedCriteria: [...match.failedCriteria],
      computedAt: match.computedAt,
    };

    await this.db
      .insert(profileJobMatches)
      .values(row)
      .onConflictDoUpdate({
        target: [profileJobMatches.profileId, profileJobMatches.jobId],
        set: row,
      });
  }

  /**
   * Every profile that matched one job.
   *
   * Part 31's data: a notification can say "matched your 'Remote Frontend'
   * profile" because this answers which one, rather than the system guessing.
   */
  async profilesMatching(candidateId: string, jobId: string): Promise<ProfileJobMatch[]> {
    const rows = await this.db
      .select()
      .from(profileJobMatches)
      .where(
        and(eq(profileJobMatches.candidateId, candidateId), eq(profileJobMatches.jobId, jobId)),
      )
      .orderBy(desc(profileJobMatches.score))
      .limit(20);

    return rows
      .map((row) => profileJobMatchSchema.safeParse(row))
      .filter((parsed): parsed is { success: true; data: ProfileJobMatch } => parsed.success)
      .map((parsed) => parsed.data);
  }

  async topForProfile(profileId: string, limit = 25) {
    return this.db
      .select({
        jobId: profileJobMatches.jobId,
        score: profileJobMatches.score,
        eligible: profileJobMatches.eligible,
        reason: profileJobMatches.reason,
        matchedCriteria: profileJobMatches.matchedCriteria,
        title: jobs.title,
        companyName: jobs.companyNameRaw,
        computedAt: profileJobMatches.computedAt,
      })
      .from(profileJobMatches)
      .innerJoin(jobs, eq(jobs.id, profileJobMatches.jobId))
      .where(eq(profileJobMatches.profileId, profileId))
      .orderBy(desc(profileJobMatches.score))
      .limit(limit);
  }

  /**
   * How many jobs each profile has found, and how many are shared.
   *
   * The cross-profile deduplication evidence: a job counted under two profiles
   * is one row in `jobs` and two here, which is exactly the intended shape.
   */
  async profileCoverage(candidateId: string) {
    const rows = await this.db
      .select({
        profileId: profileJobMatches.profileId,
        profileName: searchProfiles.profileName,
        total: sql<number>`count(*)::int`,
        eligible: sql<number>`count(*) FILTER (WHERE ${profileJobMatches.eligible})::int`,
      })
      .from(profileJobMatches)
      .innerJoin(searchProfiles, eq(searchProfiles.id, profileJobMatches.profileId))
      .where(eq(profileJobMatches.candidateId, candidateId))
      .groupBy(profileJobMatches.profileId, searchProfiles.profileName);

    const [shared] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(
        this.db
          .select({ jobId: profileJobMatches.jobId })
          .from(profileJobMatches)
          .where(eq(profileJobMatches.candidateId, candidateId))
          .groupBy(profileJobMatches.jobId)
          .having(sql`count(*) > 1`)
          .as('shared_jobs'),
      );

    return { perProfile: rows, sharedJobs: shared?.total ?? 0 };
  }
}
