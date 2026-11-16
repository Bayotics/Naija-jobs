import {
  FREQUENCY_INTERVAL_MINUTES,
  PRECEDENCE_RANK,
  REMOTE_PREFERENCE_ACCEPTS,
  effectiveSearchConfigSchema,
  searchProfileSchema,
  type CandidatePreferences,
  type EffectiveSearchConfig,
  type PrecedenceLayer,
  type RemotePreference,
  type SearchOverride,
  type SearchProfile,
  type SearchState,
  type SourcePriority,
} from '@job-intel/contracts';

/**
 * The effective configuration resolver.
 *
 * Part 41's requirement, and the load-bearing piece of this whole layer: **the
 * discovery engine reads one resolved object rather than querying preference
 * tables itself.** Every stage downstream — query generation, filtering,
 * matching, ranking, notification — consumes what this returns, which means a
 * change to any input reaches all of them on their next pass without any of
 * them knowing where it came from.
 *
 * Precedence is Part 40's, encoded rather than remembered:
 *
 *   1. temporary override        — explicitly time-boxed, so it wins outright
 *   2. candidate hard constraint — things the person cannot accept at all
 *   3. profile setting           — the strategy's own criteria
 *   4. candidate preference      — general wants, narrowed by the profile
 *   5. behavioural signal        — never resolved here; ranking input only
 *   6. AI inference              — never resolved here at all
 *
 * The one worth explaining is why a hard constraint outranks a profile. A
 * profile is a *search strategy*, and no strategy should be able to search for
 * something the person has stated they cannot take — someone who needs visa
 * sponsorship should not have a profile quietly looking at roles that refuse
 * it. Their softer preferences sit *below* the profile, because narrowing them
 * is exactly what a profile is for.
 *
 * Layers 5 and 6 appear in the vocabulary and never in this function. That is
 * deliberate: behaviour and inference inform *ranking*, and letting either
 * reach configuration is the failure every layer of this system is built to
 * prevent.
 */

export interface ResolveInput {
  profile: SearchProfile;
  /** Global preferences. Hard entries outrank the profile; soft ones do not. */
  preferences: CandidatePreferences | null;
  /** Every override for this candidate. Filtered to the active ones here. */
  overrides: readonly SearchOverride[];
  state: SearchState | null;
  /** Sources the system knows about, so a profile cannot enable a phantom. */
  availableSourceIds: readonly string[];
  now?: Date;
}

/** Reads a dotted path out of an object. */
function readPath(target: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cursor, segment) => {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    return (cursor as Record<string, unknown>)[segment];
  }, target);
}

/** Writes a dotted path, creating intermediate objects as needed. */
function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor: Record<string, unknown> = target;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const next = cursor[segment];

    if (next === null || typeof next !== 'object') {
      cursor[segment] = {};
    }

    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1]!] = value;
}

/** Overrides in force right now. */
export function activeOverrides(
  overrides: readonly SearchOverride[],
  profileId: string,
  now: Date,
): SearchOverride[] {
  return overrides.filter(
    (override) =>
      override.active &&
      override.startTime <= now &&
      override.endTime > now &&
      // A null profileId means the override applies to every profile.
      (override.profileId === null || override.profileId === profileId),
  );
}

/**
 * Overrides that have run out.
 *
 * Returned rather than deleted so the caller can record the expiry in
 * configuration history — an override silently ceasing to apply is confusing;
 * one that leaves a line saying "the Germany-only window ended" is not.
 */
export function expiredOverrides(
  overrides: readonly SearchOverride[],
  now: Date,
): SearchOverride[] {
  return overrides.filter((override) => override.active && override.endTime <= now);
}

/**
 * Hard constraints, projected from the candidate's general preferences.
 *
 * Only entries the candidate marked `hard` are read. Everything else is a
 * preference, and a profile is allowed to narrow or contradict a preference —
 * that is what a profile is.
 */
function hardConstraints(
  preferences: CandidatePreferences | null,
): Array<{ field: string; value: unknown; detail: string; currency?: string }> {
  if (!preferences) return [];

  const constraints: Array<{ field: string; value: unknown; detail: string; currency?: string }> =
    [];

  /*
   * A hard salary minimum.
   *
   * Raises the profile's floor but never lowers it: a profile asking for more
   * than the global minimum is being more selective, which is allowed. This is
   * a floor, not an assignment.
   */
  if (preferences.salary.minimumIsHard && preferences.salary.minimum !== null) {
    constraints.push({
      field: 'salary.minimum',
      value: preferences.salary.minimum,
      currency: preferences.salary.currency,
      detail: 'You marked this salary minimum as non-negotiable.',
    });
  }

  /*
   * Hard technology exclusions.
   *
   * Merged into the profile's exclusions rather than replacing them, because
   * both lists are exclusions and the union is what the candidate means.
   */
  const hardExclusions = preferences.technologies
    .filter((entry) => entry.hard && entry.strength === 'excluded')
    .map((entry) => entry.value.toLowerCase());

  if (hardExclusions.length > 0) {
    constraints.push({
      field: 'excludedSkills',
      value: hardExclusions,
      detail: 'Technologies you excluded as non-negotiable.',
    });
  }

  // Banned words are always hard — the schema says so, and so does the intent.
  if (preferences.excludedKeywords.length > 0) {
    constraints.push({
      field: 'keywords.mustNotContain',
      value: preferences.excludedKeywords,
      detail: 'Keywords you banned outright.',
    });
  }

  return constraints;
}

/**
 * Whether a work arrangement is acceptable under a preference.
 *
 * Exported because filtering, ranking and query generation all need the same
 * answer, and three implementations of it would drift.
 */
export function acceptsArrangement(
  preference: RemotePreference,
  arrangement: string | null,
): boolean {
  const accepted = REMOTE_PREFERENCE_ACCEPTS[preference];
  if (!accepted) return true;
  return accepted.includes(arrangement ?? 'unknown');
}

/**
 * Resolves everything into the object the engine consumes.
 *
 * Pure: no database, no clock beyond the injected `now`. That is what makes the
 * precedence rules testable as arithmetic rather than as integration.
 */
export function resolveEffectiveConfig(input: ResolveInput): EffectiveSearchConfig {
  const now = input.now ?? new Date();
  const provenance: EffectiveSearchConfig['provenance'] = [];

  // Start from the profile: layer 3.
  const resolved = structuredClone(input.profile) as unknown as Record<string, unknown>;

  const record = (field: string, layer: PrecedenceLayer, detail: string): void => {
    const existing = provenance.find((entry) => entry.field === field);

    // Keep the strongest claim on each field, so provenance mirrors precedence.
    if (existing && PRECEDENCE_RANK[existing.layer] <= PRECEDENCE_RANK[layer]) return;

    if (existing) {
      existing.layer = layer;
      existing.detail = detail.slice(0, 300);
      return;
    }

    provenance.push({ field, layer, detail: detail.slice(0, 300) });
  };

  // ── Layer 2: hard constraints ───────────────────────────────────────────
  for (const constraint of hardConstraints(input.preferences)) {
    if (constraint.field === 'salary.minimum') {
      const profileMinimum = input.profile.salary.minimum;
      const hardMinimum = constraint.value as number;

      /*
       * Only when the two are in the same currency.
       *
       * A $100,000 hard floor compared numerically against a €70,000 profile
       * produced €100,000 — a threshold the candidate never stated, filtering
       * out real jobs on the strength of a unit mismatch. There is no rates
       * table here and inventing one would be worse, so an unconvertible floor
       * is reported rather than guessed at.
       */
      if (constraint.currency && constraint.currency !== input.profile.salary.currency) {
        record(
          'salary.minimum',
          'candidate_hard_constraint',
          `Your non-negotiable minimum is set in ${constraint.currency} but this profile ` +
            `searches in ${input.profile.salary.currency}, so it was not applied. ` +
            'Set them in the same currency to enforce it.',
        );
        continue;
      }

      /*
       * The floor, not an assignment.
       *
       * A profile asking €90k when the global hard minimum is €70k is being
       * more selective, and overwriting it with €70k would widen a search the
       * candidate deliberately narrowed.
       */
      if (profileMinimum === null || profileMinimum < hardMinimum) {
        writePath(resolved, 'salary.minimum', hardMinimum);
        record('salary.minimum', 'candidate_hard_constraint', constraint.detail);
      }
      continue;
    }

    if (constraint.field === 'excludedSkills') {
      const merged = [
        ...new Set([...input.profile.excludedSkills, ...(constraint.value as string[])]),
      ];
      writePath(resolved, 'excludedSkills', merged);
      record('excludedSkills', 'candidate_hard_constraint', constraint.detail);
      continue;
    }

    if (constraint.field === 'keywords.mustNotContain') {
      const merged = [
        ...new Set([
          ...input.profile.keywords.mustNotContain,
          ...(constraint.value as string[]),
        ]),
      ];
      writePath(resolved, 'keywords.mustNotContain', merged);
      record('keywords.mustNotContain', 'candidate_hard_constraint', constraint.detail);
    }
  }

  // ── Layer 4: general preferences fill gaps the profile left empty ───────
  /*
   * Fill, never overwrite.
   *
   * A profile that states nothing about seniority should inherit what the
   * candidate generally wants; one that states something has narrowed it
   * deliberately and must be left alone.
   */
  if (input.preferences) {
    if (input.profile.seniorityLevels.length === 0 && input.preferences.seniorityLevels.length > 0) {
      writePath(resolved, 'seniorityLevels', [...input.preferences.seniorityLevels]);
      record('seniorityLevels', 'candidate_preference', 'Inherited from your general preferences.');
    }

    if (input.profile.roles.length === 0 && input.preferences.titles.length > 0) {
      const roles = input.preferences.titles
        .filter((entry) => entry.strength !== 'excluded')
        .slice(0, 10)
        .map((entry, index) => ({
          title: entry.value,
          priority: (entry.strength === 'required' ? 'primary' : 'secondary') as
            | 'primary'
            | 'secondary',
          rank: index,
          alternatives: [],
        }));

      writePath(resolved, 'roles', roles);
      record('roles', 'candidate_preference', 'Inherited from your general preferences.');
    }
  }

  // ── Layer 1: temporary overrides win outright ───────────────────────────
  const active = activeOverrides(input.overrides, input.profile.id, now);

  for (const override of active) {
    writePath(resolved, override.field, override.newValue);
    record(
      override.field,
      'temporary_override',
      override.reason ?? `Temporary override until ${override.endTime.toISOString().slice(0, 16)}.`,
    );
  }

  /*
   * Re-parsed rather than cast.
   *
   * Overrides carry `unknown` values that came from a database column, and a
   * cast would let a malformed one through into every downstream consumer. If
   * an override produces something the schema rejects, the profile as written
   * stands — a bad override loses, and the search keeps working.
   */
  const parsed = searchProfileSchema.safeParse(resolved);
  const profile = parsed.success ? parsed.data : input.profile;

  if (!parsed.success) {
    provenance.push({
      field: '(profile)',
      layer: 'profile_setting',
      detail: 'An override produced an invalid profile and was ignored.',
    });
  }

  // ── Sources ─────────────────────────────────────────────────────────────
  /*
   * Exclusion beats selection, and both are bounded by what exists.
   *
   * A profile carrying a source the deployment does not have is not an error —
   * sources get removed — but it must not produce a query against a phantom.
   */
  const excluded = new Set(profile.excludedSources.map((id) => id.toLowerCase()));
  const available = new Set(input.availableSourceIds.map((id) => id.toLowerCase()));

  const selections = new Map<string, SourcePriority>();

  for (const selection of profile.sources) {
    const id = selection.sourceId.toLowerCase();
    if (!selection.enabled) continue;
    if (excluded.has(id)) continue;
    if (!available.has(id)) continue;
    selections.set(selection.sourceId, selection.priority);
  }

  /*
   * An empty selection means "everything available".
   *
   * A new profile has not chosen sources yet, and reading that as "search
   * nothing" would make a freshly created profile silently do nothing at all.
   */
  if (profile.sources.length === 0) {
    for (const sourceId of input.availableSourceIds) {
      if (excluded.has(sourceId.toLowerCase())) continue;
      selections.set(sourceId, 'medium');
    }
  }

  const resolvedSources = [...selections.entries()].map(([sourceId, priority]) => ({
    sourceId,
    priority,
  }));

  // ── Cadence and pause ───────────────────────────────────────────────────
  const interval = FREQUENCY_INTERVAL_MINUTES[profile.searchFrequency];
  const intervalMinutes = Number.isFinite(interval) ? interval : null;

  const paused = input.state?.paused ?? false;
  const searchEnabled = profile.enabled && profile.state === 'active' && !paused;

  const pauseReason = paused
    ? (input.state?.pauseReason ?? 'Search is paused.')
    : !profile.enabled
      ? 'This profile is switched off.'
      : profile.state !== 'active'
        ? `This profile is ${profile.state}.`
        : null;

  return effectiveSearchConfigSchema.parse({
    candidateId: input.profile.candidateId,
    profileId: input.profile.id,
    profileName: profile.profileName,
    profile,
    provenance: provenance.slice(0, 80),
    activeOverrides: active,
    searchEnabled,
    pauseReason,
    resolvedSources,
    intervalMinutes,
    configVersion: input.state?.configVersion ?? 0,
    resolvedAt: now,
  });
}

/**
 * When this profile should next run.
 *
 * Returns null when it never self-schedules — `manual` frequency, a paused
 * search, a disabled profile. The scheduler treats null as "not my problem",
 * which is how Part 44 gets one scheduler rather than one per setting.
 */
export function nextRunAt(
  config: EffectiveSearchConfig,
  lastRunAt: Date | null,
  now = new Date(),
): Date | null {
  if (!config.searchEnabled) return null;
  if (config.intervalMinutes === null) return null;

  if (lastRunAt === null) return now;

  const next = new Date(lastRunAt.getTime() + config.intervalMinutes * 60_000);
  return next <= now ? now : next;
}

/** Reads a resolved field, for consumers that want one value rather than all. */
export function effectiveValue(config: EffectiveSearchConfig, field: string): unknown {
  return readPath(config.profile, field);
}

/** Which precedence layer decided a field. */
export function layerFor(config: EffectiveSearchConfig, field: string): PrecedenceLayer {
  return config.provenance.find((entry) => entry.field === field)?.layer ?? 'profile_setting';
}
