import {
  candidateProfilePayloadSchema,
  type BehavioralSignalInput,
  type CandidateEvaluation,
  type CandidatePreferences,
  type JobEnrichment,
  type LearnedSignal,
  type ProposalBundle,
} from '@job-intel/contracts';
import type { CandidateRepository, ProfileRepository } from '@job-intel/db';
import type { EventRecorder, Logger } from '@job-intel/observability';
import {
  ConstraintEvaluator,
  PreferenceService,
  SkillGraph,
  aggregateSignals,
  buildCanonicalProfile,
  isEmbeddingStale,
  parsePreferenceInstruction,
  suggestFromSignals,
  type MutationResult,
  type ObservedEvent,
  type PreferenceListDimension,
} from '@job-intel/candidate';

/**
 * Candidate intelligence orchestration.
 *
 * Binds the pure domain services to persistence and enforces the sequence every
 * preference change must follow:
 *
 *   1. validate      (schema, in the pure service)
 *   2. persist       (new version + field-level change log, one transaction)
 *   3. record        (system event)
 *   4. invalidate    (embedding marked stale when semantics changed)
 *   5. queue         (regeneration, picked up by the worker)
 *
 * Nothing caches the preference payload. Every evaluation loads the active
 * version, which is what makes a change take effect on the *next* matching run
 * with no restart and no deploy.
 */

export interface CandidateIntelligenceDependencies {
  candidates: CandidateRepository;
  profiles: ProfileRepository;
  logger: Logger;
  events: EventRecorder;
  /** Embedding model id, from runtime config rather than a constant. */
  embeddingModel: string;
  embeddingDimensions: number;
}

export interface PreferenceUpdateResult {
  version: number;
  versionId: string;
  changes: MutationResult['changes'];
  embeddingStale: boolean;
  preferences: CandidatePreferences;
}

export class CandidateIntelligenceService {
  constructor(private readonly deps: CandidateIntelligenceDependencies) {}

  /**
   * The active preferences, created on first access.
   *
   * Auto-initialisation matters: a profile with no preference row must behave
   * as "no opinions expressed", not fail. Every dimension then defaults to
   * neutral and nothing is filtered out.
   */
  async getPreferences(profileId: string): Promise<{
    version: number;
    versionId: string;
    preferences: CandidatePreferences;
  }> {
    const existing = await this.deps.candidates.getActivePreferences(profileId);
    if (existing) return existing;
    const created = await this.deps.candidates.initialisePreferences(profileId, {});
    return created;
  }

  /**
   * Applies a mutation produced by `PreferenceService`.
   *
   * The single write path. UI edits, API calls and accepted natural-language
   * proposals all funnel through here, so none of them can bypass validation,
   * versioning or embedding invalidation.
   */
  async applyMutation(
    profileId: string,
    mutation: MutationResult,
    options: { changedBy?: string; summary?: string } = {},
  ): Promise<PreferenceUpdateResult> {
    if (mutation.changes.length === 0) {
      const current = await this.getPreferences(profileId);
      return { ...current, changes: [], embeddingStale: false };
    }

    const saved = await this.deps.candidates.savePreferenceVersion({
      profileId,
      preferences: mutation.preferences,
      changes: mutation.changes,
      embeddingStale: mutation.embeddingStale,
      ...(options.changedBy ? { changedBy: options.changedBy } : {}),
      ...(options.summary ? { summary: options.summary } : {}),
    });

    await this.deps.events.emit('PROFILE_VERSION_ACTIVATED', {
      message: options.summary ?? `Preferences updated to v${saved.version}`,
      data: {
        version: saved.version,
        changes: mutation.changes.map((c) => c.path),
        embeddingStale: mutation.embeddingStale,
      },
    });

    // Invalidate synchronously so a stale vector can never be read between the
    // change landing and the worker picking it up.
    if (mutation.embeddingStale) {
      await this.invalidateEmbedding(profileId, 'preferences changed');
    }

    this.deps.logger.info('Candidate preferences updated', {
      profileId,
      version: saved.version,
      changes: mutation.changes.length,
      embeddingStale: mutation.embeddingStale,
    });

    return {
      version: saved.version,
      versionId: saved.versionId,
      changes: mutation.changes,
      embeddingStale: mutation.embeddingStale,
      preferences: mutation.preferences,
    };
  }

  // ── Named operations ──────────────────────────────────────────────────────

  async updateWorkArrangement(
    profileId: string,
    value: unknown,
    maxOfficeDaysPerWeek?: number | null,
  ): Promise<PreferenceUpdateResult> {
    const { preferences } = await this.getPreferences(profileId);
    return this.applyMutation(
      profileId,
      PreferenceService.updateWorkArrangement(preferences, value, maxOfficeDaysPerWeek),
    );
  }

  async updateList(
    profileId: string,
    dimension: PreferenceListDimension,
    values: unknown,
  ): Promise<PreferenceUpdateResult> {
    const { preferences } = await this.getPreferences(profileId);
    return this.applyMutation(profileId, PreferenceService.updateList(preferences, dimension, values));
  }

  async upsertListEntry(
    profileId: string,
    dimension: PreferenceListDimension,
    entry: unknown,
  ): Promise<PreferenceUpdateResult> {
    const { preferences } = await this.getPreferences(profileId);
    return this.applyMutation(
      profileId,
      PreferenceService.upsertListEntry(preferences, dimension, entry),
    );
  }

  async removeListEntry(
    profileId: string,
    dimension: PreferenceListDimension,
    value: string,
  ): Promise<PreferenceUpdateResult> {
    const { preferences } = await this.getPreferences(profileId);
    return this.applyMutation(
      profileId,
      PreferenceService.removeListEntry(preferences, dimension, value),
    );
  }

  async updateSalary(profileId: string, patch: unknown): Promise<PreferenceUpdateResult> {
    const { preferences } = await this.getPreferences(profileId);
    return this.applyMutation(profileId, PreferenceService.updateSalary(preferences, patch));
  }

  async updateWorkAuthorization(profileId: string, patch: unknown): Promise<PreferenceUpdateResult> {
    const { preferences } = await this.getPreferences(profileId);
    return this.applyMutation(
      profileId,
      PreferenceService.updateWorkAuthorization(preferences, patch),
    );
  }

  async updateWeights(profileId: string, patch: unknown): Promise<PreferenceUpdateResult> {
    const { preferences } = await this.getPreferences(profileId);
    return this.applyMutation(profileId, PreferenceService.updateWeights(preferences, patch));
  }

  async updateExcludedKeywords(profileId: string, values: unknown): Promise<PreferenceUpdateResult> {
    const { preferences } = await this.getPreferences(profileId);
    return this.applyMutation(
      profileId,
      PreferenceService.updateExcludedKeywords(preferences, values),
    );
  }

  // ── Evaluation ────────────────────────────────────────────────────────────

  /**
   * Evaluates a job against the *current* preferences.
   *
   * Loads them on every call. That is deliberate: any cache here would be the
   * exact mechanism by which a preference change failed to take effect.
   */
  async evaluate(
    profileId: string,
    input: { enrichment: JobEnrichment; job: { title: string; companyName: string; description: string | null } },
  ): Promise<CandidateEvaluation> {
    const { preferences, version } = await this.getPreferences(profileId);
    return new ConstraintEvaluator(preferences).evaluate({
      preferences,
      profileVersion: version,
      enrichment: input.enrichment,
      job: input.job,
    });
  }

  // ── Embedding ─────────────────────────────────────────────────────────────

  /** Rebuilds the canonical text and records whether the vector is stale. */
  async refreshCanonicalProfile(profileId: string): Promise<{
    hash: string;
    text: string;
    stale: boolean;
    reason: string;
  }> {
    const [profile, preferences, skills] = await Promise.all([
      this.deps.profiles.getActiveProfile(),
      this.getPreferences(profileId),
      this.deps.candidates.listSkills(profileId),
    ]);

    const payload = candidateProfilePayloadSchema.parse(
      profile?.payload ?? { identity: { fullName: 'Candidate', email: 'candidate@example.com' } },
    );

    const canonical = buildCanonicalProfile({
      profile: payload,
      preferences: preferences.preferences,
      skills,
    });

    const state = await this.deps.candidates.getEmbeddingState(profileId, this.deps.embeddingModel);
    const staleness = isEmbeddingStale(canonical, {
      storedHash: state?.canonicalHash ?? null,
      storedModel: state?.model ?? null,
      currentModel: this.deps.embeddingModel,
    });

    if (staleness.stale) {
      await this.deps.candidates.markEmbeddingStale({
        profileId,
        model: this.deps.embeddingModel,
        dimensions: this.deps.embeddingDimensions,
        canonicalHash: canonical.hash,
        canonicalText: canonical.text,
        reason: staleness.reason,
      });
    }

    return { hash: canonical.hash, text: canonical.text, ...staleness };
  }

  private async invalidateEmbedding(profileId: string, reason: string): Promise<void> {
    try {
      await this.refreshCanonicalProfile(profileId);
      this.deps.logger.debug('Candidate embedding invalidated', { profileId, reason });
    } catch (error) {
      // Invalidation failing must not fail the preference change itself — the
      // preference is the user's intent; the embedding is derived data.
      this.deps.logger.error('Failed to invalidate candidate embedding', { profileId, err: error });
    }
  }

  // ── Behaviour ─────────────────────────────────────────────────────────────

  /** Records an interaction. Never modifies preferences. */
  async recordSignal(profileId: string, input: BehavioralSignalInput): Promise<void> {
    await this.deps.candidates.recordSignal(profileId, input);
  }

  /**
   * What behaviour suggests, computed on read.
   *
   * Returned as a separate structure from preferences so a caller cannot
   * accidentally treat a learned affinity as something the candidate said.
   */
  async getLearnedSignals(profileId: string): Promise<{
    signals: LearnedSignal[];
    suggestions: ReturnType<typeof suggestFromSignals>;
  }> {
    const { preferences } = await this.getPreferences(profileId);
    const rows = await this.deps.candidates.listSignalsWithAttributes(profileId);

    const events: ObservedEvent[] = rows.map((row) => ({
      event: row.event,
      occurredAt: row.occurredAt,
      attributes: {
        countryCode: row.countryCode,
        workMode: row.workMode,
        companyName: row.companyName,
        jobFunction: row.jobFunction,
        seniority: row.seniority,
        technologies: row.techStack ?? [],
        industries:
          (row.classification as { industries?: string[] } | null)?.industries ?? [],
      },
    }));

    const signals = aggregateSignals(events, preferences);
    return { signals, suggestions: suggestFromSignals(signals, preferences) };
  }

  // ── Natural language ──────────────────────────────────────────────────────

  /**
   * Turns an instruction into proposals. Applies nothing.
   *
   * Confirmation is a separate call, so the model-facing path and the
   * database-writing path are never the same request.
   */
  async proposeFromInstruction(profileId: string, instruction: string): Promise<ProposalBundle> {
    const { preferences } = await this.getPreferences(profileId);
    return parsePreferenceInstruction(instruction, preferences);
  }

  /** Applies proposals the candidate confirmed, through the normal write path. */
  async applyProposals(
    profileId: string,
    proposals: ReadonlyArray<{ path: string; operation: string; value?: unknown; summary?: string }>,
  ): Promise<PreferenceUpdateResult> {
    let { preferences } = await this.getPreferences(profileId);
    const allChanges: MutationResult['changes'] = [];
    let embeddingStale = false;

    for (const proposal of proposals) {
      const result = PreferenceService.applyProposal(preferences, proposal);
      preferences = result.preferences;
      allChanges.push(...result.changes);
      embeddingStale = embeddingStale || result.embeddingStale;
    }

    return this.applyMutation(
      profileId,
      { preferences, changes: allChanges, embeddingStale },
      { summary: `Applied ${proposals.length} confirmed preference change(s)` },
    );
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  async getSkillGraph(): Promise<SkillGraph> {
    const stored = await this.deps.candidates.listSkillRelations();
    // Fall back to the seed set when the table is empty, so the graph is useful
    // before anyone has curated it.
    return stored.length > 0 ? new SkillGraph(stored) : new SkillGraph();
  }
}
