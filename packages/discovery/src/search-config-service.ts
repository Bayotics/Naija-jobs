import { randomUUID } from 'node:crypto';
import {
  searchOverrideSchema,
  searchProfileSchema,
  type ConfigChange,
  type ConfigIntent,
  type EffectiveSearchConfig,
  type SearchOverride,
  type SearchProfile,
  type ValidationResult,
} from '@job-intel/contracts';
import type { CandidateRepository, SearchConfigRepository, SourceRepository } from '@job-intel/db';
import type { EventRecorder, Logger } from '@job-intel/observability';
import {
  applyChanges,
  expiredOverrides,
  generateQueries,
  parseConfigInstruction,
  parseTemporaryInstruction,
  proposeWithProvider,
  resolveEffectiveConfig,
  restoreSnapshot,
  validateProfile,
  type IntentProvider,
} from '@job-intel/search-config';

/**
 * The search configuration service.
 *
 * Owns the write path for everything a candidate can change about what they are
 * looking for, and the read path every downstream stage consumes. Two things
 * about its shape are deliberate.
 *
 * **The resolver is cached, and the cache is versioned.** Resolving a
 * configuration touches four tables, and discovery asks for it on every pass.
 * The cache is keyed on `configVersion`, which the repository bumps inside the
 * same write that changes anything — so a stale entry is impossible rather than
 * merely unlikely, and there is no invalidation message anyone can forget to
 * send.
 *
 * **Nothing is written without validation and, where the policy says so,
 * confirmation.** A natural-language instruction produces a *preview*; applying
 * it is a second call with the intent the user actually saw. That is the whole
 * point of Part 34's pipeline, and short-circuiting it would mean a misheard
 * sentence silently changing what someone's job search looks for.
 */

export interface SearchConfigDependencies {
  repository: SearchConfigRepository;
  candidates: CandidateRepository;
  sources: SourceRepository;
  logger: Logger;
  events: EventRecorder;
  /** Optional model for instructions the deterministic rules could not parse. */
  intentProvider?: IntentProvider | null;
}

/** A resolved configuration plus the version it was resolved at. */
interface CacheEntry {
  version: number;
  resolvedAt: number;
  configs: Map<string, EffectiveSearchConfig>;
}

/**
 * How long a resolved configuration may be reused when the version has not
 * moved.
 *
 * Short on purpose. The version check makes staleness impossible for anything
 * *this service* wrote, but a source being disabled elsewhere in the system
 * would not bump it, and a minute of lag on that is acceptable where an hour
 * would not be.
 */
const CACHE_TTL_MS = 60_000;

export class SearchConfigService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: SearchConfigDependencies) {}

  // ── Reading (Parts 41, 42, 43) ────────────────────────────────────────────

  /**
   * The configuration every downstream stage reads.
   *
   * Discovery, filtering, matching, ranking and notification all call this
   * rather than querying preference tables themselves, which is what makes a
   * change reach all of them without any of them knowing where it came from.
   */
  async getEffectiveSearchConfiguration(
    candidateId: string,
    profileId: string,
    options: { now?: Date; bypassCache?: boolean } = {},
  ): Promise<EffectiveSearchConfig | null> {
    const now = options.now ?? new Date();
    const state = await this.deps.repository.getState(candidateId);

    const cached = this.cache.get(candidateId);

    if (
      !options.bypassCache &&
      cached &&
      cached.version === state.configVersion &&
      now.getTime() - cached.resolvedAt < CACHE_TTL_MS
    ) {
      const hit = cached.configs.get(profileId);
      if (hit) return hit;
    }

    const profile = await this.deps.repository.getProfile(profileId);
    if (!profile || profile.candidateId !== candidateId) return null;

    const [preferences, overrides, sources] = await Promise.all([
      this.deps.candidates
        .getActivePreferences(candidateId)
        .then((row) => row?.preferences ?? null)
        .catch(() => null),
      this.deps.repository.listOverrides(candidateId, true),
      this.deps.sources.list({ enabledOnly: true }).catch(() => []),
    ]);

    const config = resolveEffectiveConfig({
      profile,
      preferences,
      overrides,
      state,
      availableSourceIds: sources.map((source) => source.id),
      now,
    });

    const entry: CacheEntry =
      cached && cached.version === state.configVersion
        ? cached
        : { version: state.configVersion, resolvedAt: now.getTime(), configs: new Map() };

    entry.configs.set(profileId, config);
    entry.resolvedAt = now.getTime();
    entry.version = state.configVersion;
    this.cache.set(candidateId, entry);

    return config;
  }

  /** Every active profile's resolved configuration. */
  async allEffectiveConfigurations(
    candidateId: string,
    options: { now?: Date } = {},
  ): Promise<EffectiveSearchConfig[]> {
    const profiles = await this.deps.repository.listProfiles(candidateId);

    const resolved = await Promise.all(
      profiles.map((profile) =>
        this.getEffectiveSearchConfiguration(candidateId, profile.id, options),
      ),
    );

    return resolved.filter((config): config is EffectiveSearchConfig => config !== null);
  }

  /** Drops the cache for one candidate. Called after any external change. */
  invalidate(candidateId: string): void {
    this.cache.delete(candidateId);
  }

  // ── Profiles (Parts 1, 27, 28) ────────────────────────────────────────────

  async listProfiles(candidateId: string, includeArchived = false): Promise<SearchProfile[]> {
    return this.deps.repository.listProfiles(candidateId, { includeArchived });
  }

  async createProfile(input: {
    candidateId: string;
    profileName: string;
    seed?: Partial<SearchProfile>;
  }): Promise<{ ok: boolean; profile: SearchProfile | null; validation: ValidationResult }> {
    const profile = searchProfileSchema.parse({
      id: randomUUID(),
      candidateId: input.candidateId,
      profileName: input.profileName,
      ...input.seed,
    });

    const validation = validateProfile(profile);
    if (!validation.valid) return { ok: false, profile: null, validation };

    const created = await this.deps.repository.createProfile(profile);
    this.invalidate(input.candidateId);

    await this.deps.repository.recordHistory({
      candidateId: input.candidateId,
      profileId: created.id,
      operation: 'CREATE_SEARCH_PROFILE',
      changes: [],
      snapshotBefore: null,
      source: 'ui',
    });

    return { ok: true, profile: created, validation };
  }

  /**
   * Applies a set of changes to a profile.
   *
   * History is written *before* the profile, with the pre-change snapshot, so
   * an undo has something to restore even if the write that follows fails.
   */
  async applyToProfile(input: {
    candidateId: string;
    profileId: string;
    changes: readonly ConfigChange[];
    source: 'ui' | 'api' | 'natural_language' | 'system_suggestion';
    instruction?: string | null;
    reason?: string | null;
  }): Promise<{
    ok: boolean;
    profile: SearchProfile | null;
    validation: ValidationResult;
    rejected: Array<{ change: ConfigChange; reason: string }>;
  }> {
    const profile = await this.deps.repository.getProfile(input.profileId);

    if (!profile || profile.candidateId !== input.candidateId) {
      return {
        ok: false,
        profile: null,
        validation: { valid: false, issues: [{ severity: 'error', field: 'profileId', message: 'No such profile.', suggestion: null }] },
        rejected: [],
      };
    }

    const result = applyChanges(profile, input.changes);

    if (!result.ok) {
      return { ok: false, profile: null, validation: result.validation, rejected: result.rejected };
    }

    await this.deps.repository.recordHistory({
      candidateId: input.candidateId,
      profileId: input.profileId,
      operation: 'UPDATE_SEARCH_PROFILE',
      changes: result.applied,
      snapshotBefore: result.previous,
      source: input.source,
      instruction: input.instruction ?? null,
      reason: input.reason ?? null,
    });

    const saved = await this.deps.repository.updateProfile(result.profile);
    this.invalidate(input.candidateId);

    await this.deps.events.emit('SEARCH_CONFIG_CHANGED', {
      message: `${result.applied.length} configuration change(s) applied`,
      data: {
        candidateId: input.candidateId,
        profileId: input.profileId,
        source: input.source,
        fields: result.applied.map((entry) => entry.field).join(','),
      },
    });

    return { ok: true, profile: saved, validation: result.validation, rejected: result.rejected };
  }

  async setProfileState(
    candidateId: string,
    profileId: string,
    state: 'active' | 'paused' | 'archived',
  ): Promise<void> {
    const profile = await this.deps.repository.getProfile(profileId);
    if (!profile || profile.candidateId !== candidateId) return;

    await this.deps.repository.recordHistory({
      candidateId,
      profileId,
      operation:
        state === 'archived' ? 'ARCHIVE_PROFILE' : state === 'active' ? 'ENABLE_PROFILE' : 'DISABLE_PROFILE',
      changes: [
        {
          field: 'state',
          action: 'set',
          from: profile.state,
          to: state,
          summary: `Profile ${state}.`,
          confidence: 1,
          sourceText: null,
        },
      ],
      snapshotBefore: profile,
      source: 'ui',
    });

    await this.deps.repository.setProfileState(profileId, candidateId, state);
    this.invalidate(candidateId);
  }

  // ── Pause and resume (Part 26) ────────────────────────────────────────────

  /**
   * Stops discovery without changing anything else.
   *
   * Everything already found stays exactly where it is — pausing a search is
   * not deleting one, and a resume should restore the previous behaviour rather
   * than start from nothing.
   */
  async setPaused(candidateId: string, paused: boolean, reason?: string | null) {
    const state = await this.deps.repository.setPaused(candidateId, paused, reason ?? null);
    this.invalidate(candidateId);

    await this.deps.repository.recordHistory({
      candidateId,
      profileId: null,
      operation: paused ? 'PAUSE_SEARCH' : 'RESUME_SEARCH',
      changes: [],
      snapshotBefore: null,
      source: 'ui',
      reason: reason ?? null,
    });

    return state;
  }

  // ── Natural language (Parts 34–36) ────────────────────────────────────────

  /**
   * Turns an instruction into a preview.
   *
   * Nothing is written. The caller shows the changes, the user confirms, and
   * `applyIntent` runs with the intent they actually saw — which is what stops
   * a misheard sentence from quietly changing a search.
   */
  async previewInstruction(input: {
    candidateId: string;
    profileId: string;
    instruction: string;
    now?: Date;
  }): Promise<{
    intent: ConfigIntent;
    validation: ValidationResult;
    preview: SearchProfile | null;
    providerError: string | null;
  } | null> {
    const profile = await this.deps.repository.getProfile(input.profileId);
    if (!profile || profile.candidateId !== input.candidateId) return null;

    /*
     * A time-boxed instruction is a different operation.
     *
     * "For the next 48 hours, also include remote jobs over €100k" must become
     * an override rather than an edit, so nothing has to be remembered and
     * undone when the window closes.
     */
    const knownSources = await this.sourceCatalogue();

    const temporary = parseTemporaryInstruction({
      instruction: input.instruction,
      profile,
      knownSources,
      ...(input.now ? { now: input.now } : {}),
    });

    if (temporary) {
      const applied = applyChanges(profile, temporary.changes);

      return {
        intent: temporary,
        validation: applied.validation,
        preview: applied.ok ? applied.profile : null,
        providerError: null,
      };
    }

    const intent = await proposeWithProvider({
      instruction: input.instruction,
      profile,
      knownSources,
      provider: this.deps.intentProvider ?? null,
    });

    const applied = applyChanges(profile, intent.changes);

    return {
      intent,
      validation: applied.validation,
      preview: applied.ok ? applied.profile : null,
      providerError: intent.providerError,
    };
  }

  /** Applies an intent the user has confirmed. */
  async applyIntent(input: {
    candidateId: string;
    intent: ConfigIntent;
    instruction?: string | null;
    now?: Date;
  }) {
    const now = input.now ?? new Date();

    if (input.intent.operation === 'CREATE_OVERRIDE') {
      if (!input.intent.overrideWindow || !input.intent.profileId) {
        return { ok: false as const, error: 'The override is missing its time window.' };
      }

      const created: SearchOverride[] = [];

      for (const change of input.intent.changes) {
        const override = searchOverrideSchema.parse({
          id: randomUUID(),
          candidateId: input.candidateId,
          profileId: input.intent.profileId,
          field: change.field,
          oldValue: change.from,
          newValue: change.to,
          startTime: input.intent.overrideWindow.startTime,
          endTime: input.intent.overrideWindow.endTime,
          reason: change.summary,
          active: true,
        });

        created.push(await this.deps.repository.createOverride(override));
      }

      this.invalidate(input.candidateId);

      await this.deps.repository.recordHistory({
        candidateId: input.candidateId,
        profileId: input.intent.profileId,
        operation: 'CREATE_OVERRIDE',
        changes: input.intent.changes,
        snapshotBefore: null,
        source: 'natural_language',
        instruction: input.instruction ?? null,
      });

      return { ok: true as const, overrides: created };
    }

    if (input.intent.operation === 'PAUSE_SEARCH' || input.intent.operation === 'RESUME_SEARCH') {
      await this.setPaused(input.candidateId, input.intent.operation === 'PAUSE_SEARCH');
      return { ok: true as const };
    }

    if (!input.intent.profileId) {
      return { ok: false as const, error: 'No profile was named.' };
    }

    const result = await this.applyToProfile({
      candidateId: input.candidateId,
      profileId: input.intent.profileId,
      changes: input.intent.changes,
      source: 'natural_language',
      instruction: input.instruction ?? null,
    });

    void now;
    return result.ok
      ? { ok: true as const, profile: result.profile }
      : { ok: false as const, error: result.validation.issues[0]?.message ?? 'Validation failed.' };
  }

  // ── Undo (Part 38) ────────────────────────────────────────────────────────

  /**
   * Restores the profile as it was before the last change.
   *
   * A restore rather than an inverse. Undoing a change set by computing its
   * opposite is fragile — a `remove` whose target was already absent has no
   * inverse — and putting back a stored snapshot has none of those problems.
   */
  async undoLast(candidateId: string, profileId?: string) {
    const entry = await this.deps.repository.lastUndoableChange(candidateId, profileId);

    if (!entry) return { ok: false as const, error: 'There is nothing to undo.' };

    const restored = restoreSnapshot(entry.snapshotBefore);

    if (!restored) {
      return {
        ok: false as const,
        error: 'That change has no restorable snapshot — it created or deleted a profile.',
      };
    }

    const current = await this.deps.repository.getProfile(restored.id);

    // The undo is itself a change, and gets its own history entry.
    await this.deps.repository.recordHistory({
      candidateId,
      profileId: restored.id,
      operation: 'UPDATE_SEARCH_PROFILE',
      changes: [],
      snapshotBefore: current,
      source: 'ui',
      reason: `Undo of ${entry.operation} from ${entry.occurredAt.toISOString().slice(0, 16)}.`,
    });

    const saved = await this.deps.repository.updateProfile(restored);
    await this.deps.repository.markUndone(entry.id);
    this.invalidate(candidateId);

    return { ok: true as const, profile: saved, undone: entry };
  }

  async history(candidateId: string, limit = 50) {
    return this.deps.repository.listHistory(candidateId, limit);
  }

  // ── Overrides (Parts 32, 33) ──────────────────────────────────────────────

  async listOverrides(candidateId: string, activeOnly = false) {
    return this.deps.repository.listOverrides(candidateId, activeOnly);
  }

  async cancelOverride(candidateId: string, overrideId: string) {
    await this.deps.repository.cancelOverride(overrideId, candidateId);
    this.invalidate(candidateId);
  }

  /**
   * Retires overrides whose window has closed.
   *
   * Run by the scheduler. Each expiry writes a history entry, because an
   * override that silently stops applying leaves someone wondering why their
   * search changed for no reason they can see.
   */
  async expireOverrides(now = new Date()): Promise<number> {
    const expired = await this.deps.repository.expireOverrides(now);

    for (const override of expired) {
      this.invalidate(override.candidateId);

      await this.deps.repository.recordHistory({
        candidateId: override.candidateId,
        profileId: override.profileId,
        operation: 'UPDATE_SEARCH_PROFILE',
        changes: [
          {
            field: override.field,
            action: 'set',
            from: override.newValue,
            to: override.oldValue,
            summary: `Temporary override on ${override.field} expired.`,
            confidence: 1,
            sourceText: null,
          },
        ],
        snapshotBefore: null,
        source: 'override_expiry',
        reason: override.reason,
      });
    }

    if (expired.length > 0) {
      this.deps.logger.info('Search overrides expired', { count: expired.length });
    }

    return expired.length;
  }

  // ── Scheduling (Part 44) ──────────────────────────────────────────────────

  /**
   * Profiles due to run.
   *
   * One scheduler reading one resolved configuration per profile, rather than
   * separate schedulers for frequency, pause state and source enablement. Every
   * one of those is already folded into the resolved config, so the scheduler
   * only has to compare two timestamps.
   */
  async dueProfiles(now = new Date()): Promise<
    Array<{ config: EffectiveSearchConfig; lastRunAt: Date | null }>
  > {
    const schedulable = await this.deps.repository.schedulableProfiles();
    const due: Array<{ config: EffectiveSearchConfig; lastRunAt: Date | null }> = [];

    for (const entry of schedulable) {
      const config = await this.getEffectiveSearchConfiguration(
        entry.profile.candidateId,
        entry.profile.id,
        { now },
      );

      if (!config || !config.searchEnabled || config.intervalMinutes === null) continue;

      const nextDue =
        entry.lastRunAt === null
          ? now
          : new Date(entry.lastRunAt.getTime() + config.intervalMinutes * 60_000);

      if (nextDue <= now) due.push({ config, lastRunAt: entry.lastRunAt });
    }

    return due;
  }

  async markRun(profileId: string, at = new Date()): Promise<void> {
    await this.deps.repository.markRun(profileId, at);
  }

  // ── Query generation (Parts 45, 46) ───────────────────────────────────────

  /** The queries one profile would run right now. */
  async queriesFor(candidateId: string, profileId: string) {
    const config = await this.getEffectiveSearchConfiguration(candidateId, profileId);
    if (!config) return [];

    return generateQueries(config);
  }

  // ── Validation and preview ────────────────────────────────────────────────

  async validate(profileId: string): Promise<ValidationResult | null> {
    const profile = await this.deps.repository.getProfile(profileId);
    return profile ? validateProfile(profile) : null;
  }

  /** Parses without a model, for callers that want the deterministic result. */
  parseInstruction(
    instruction: string,
    profile: SearchProfile,
    knownSources: readonly string[] = [],
  ): ConfigIntent {
    return parseConfigInstruction({ instruction, profile, knownSources });
  }

  /** Source identifiers this deployment has, for rules that name one. */
  private async sourceCatalogue(): Promise<string[]> {
    const sources = await this.deps.sources.list({}).catch(() => []);
    return sources.map((source) => source.id);
  }

  /** Overrides that have run out but not yet been swept. */
  async pendingExpiries(candidateId: string, now = new Date()) {
    const overrides = await this.deps.repository.listOverrides(candidateId, true);
    return expiredOverrides(overrides, now);
  }
}
