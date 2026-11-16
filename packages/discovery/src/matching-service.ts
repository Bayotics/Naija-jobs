import { createHash } from 'node:crypto';
import {
  candidateProfilePayloadSchema,
  type CandidateIntelligence,
  type JobMatch,
  type MatchingConfig,
} from '@job-intel/contracts';
import type {
  CandidateRepository,
  EmbeddingRepository,
  EnrichmentRepository,
  IntelligenceRepository,
  JobRepository,
  MatchRepository,
  ProfileRepository,
  StoredMatch,
} from '@job-intel/db';
import type { EventRecorder, Logger } from '@job-intel/observability';
import {
  SkillGraph,
  aggregateSignals,
  evidenceForExplanation,
  type ObservedEvent,
} from '@job-intel/candidate';
import {
  MatchingEngine,
  type MatchingEngineDependencies,
  NullEmbeddingProvider,
  type EmbeddingProvider,
  type MatchCandidateContext,
  type MatchJobContext,
  type MatchReasoningProvider,
  type MatchRunState,
} from '@job-intel/matching';

/**
 * Matching orchestration.
 *
 * Binds the pure engine to persistence and enforces the sequence a match must
 * follow: load current state → score → persist with provenance → record.
 *
 * The candidate context is loaded **fresh on every run**, never cached. That is
 * the mechanism by which changing a preference in the database changes the next
 * run's results with no restart and no deploy — the property the whole
 * preference system exists to provide. A cache here would be the exact bug that
 * makes a preference edit appear to do nothing.
 */

export interface MatchingServiceDependencies {
  matches: MatchRepository;
  candidates: CandidateRepository;
  profiles: ProfileRepository;
  enrichments: EnrichmentRepository;
  jobs: JobRepository;
  embeddings: EmbeddingRepository;
  logger: Logger;
  events: EventRecorder;
  config?: MatchingEngineDependencies['config'];
  reasoning?: MatchReasoningProvider;
  embedder?: EmbeddingProvider;
  /**
   * Candidate intelligence, when the candidate has uploaded documents.
   *
   * Optional because matching predates this layer and must keep working for a
   * candidate who has uploaded nothing. When present it does not change any
   * score — it supplies the evidence that makes the explanation traceable to a
   * document rather than only to a number.
   */
  intelligence?: IntelligenceRepository;
}

export interface MatchRunResult {
  profileId: string;
  considered: number;
  matched: number;
  failed: number;
  eligible: number;
  ineligible: number;
  llmCalls: number;
  durationMs: number;
  byRecommendation: Record<string, number>;
  errors: Array<{ jobId: string; error: string }>;
}

export class MatchingService {
  private readonly engine: MatchingEngine;
  private readonly embedder: EmbeddingProvider;

  constructor(private readonly deps: MatchingServiceDependencies) {
    this.engine = new MatchingEngine({
      logger: deps.logger,
      ...(deps.config ? { config: deps.config } : {}),
      ...(deps.reasoning ? { reasoning: deps.reasoning } : {}),
    });
    this.embedder = deps.embedder ?? new NullEmbeddingProvider();
  }

  get config(): MatchingConfig {
    return this.engine.config;
  }

  /**
   * Assembles everything the engine needs about the candidate.
   *
   * One read per run, not per job — but always a read. The distinction matters:
   * reusing it across the jobs of a single run is correct (they were all scored
   * against the same stated preferences, which is what the trace records);
   * reusing it across runs would not be.
   */
  async loadCandidate(profileId: string): Promise<{
    context: MatchCandidateContext;
    profileVersionId: string;
    preferenceVersionId: string | null;
  }> {
    const [activeProfile, preferences, skills, relations] = await Promise.all([
      this.deps.profiles.getActiveProfile(),
      this.deps.candidates.getActivePreferences(profileId),
      this.deps.candidates.listSkills(profileId),
      this.deps.candidates.listSkillRelations(),
    ]);

    if (!activeProfile) throw new Error('No active candidate profile');
    if (!preferences) throw new Error(`No active preferences for profile ${profileId}`);

    const profile = candidateProfilePayloadSchema.parse(activeProfile.payload);

    // Behavioural signals are computed on read and kept in their own field.
    // They are never merged into `preferences`, so no code path can mistake an
    // inferred affinity for something the candidate actually said.
    const signalRows = await this.deps.candidates.listSignalsWithAttributes(profileId);
    const events: ObservedEvent[] = signalRows.map((row) => ({
      event: row.event,
      occurredAt: row.occurredAt,
      attributes: {
        countryCode: row.countryCode,
        workMode: row.workMode,
        companyName: row.companyName,
        jobFunction: row.jobFunction,
        seniority: row.seniority,
        technologies: row.techStack ?? [],
        industries: (row.classification as { industries?: string[] } | null)?.industries ?? [],
      },
    }));

    const embedding = this.embedder.isAvailable()
      ? await this.deps.embeddings.getCandidateEmbedding(profileId, this.embedder.model)
      : null;

    return {
      context: {
        profileId,
        profileVersion: activeProfile.version,
        preferenceVersion: preferences.version,
        profile,
        preferences: preferences.preferences,
        skills,
        skillGraph: relations.length > 0 ? new SkillGraph(relations) : new SkillGraph(),
        embedding: embedding ? { model: embedding.model, vector: embedding.vector } : null,
        learnedSignals: aggregateSignals(events, preferences.preferences),
      },
      profileVersionId: activeProfile.versionId,
      preferenceVersionId: preferences.versionId,
    };
  }

  /**
   * Evidence for one job, when an intelligence profile and a matrix exist.
   *
   * Read-only and best-effort: a missing profile, a missing matrix or a stale
   * one all return null, and matching proceeds exactly as it did before this
   * layer existed. Nothing here can block a match.
   */
  private async evidenceFor(
    profileId: string,
    jobId: string,
    profile: CandidateIntelligence | null,
  ): Promise<ReturnType<typeof evidenceForExplanation> | null> {
    if (!this.deps.intelligence || !profile) return null;

    try {
      const matrix = await this.deps.intelligence.getMatrix(
        profileId,
        jobId,
        profile.profileVersion,
      );
      return matrix ? evidenceForExplanation(matrix) : null;
    } catch {
      // Observability, not correctness. A failure here must not cost the match.
      return null;
    }
  }

  private async activeIntelligence(profileId: string): Promise<CandidateIntelligence | null> {
    if (!this.deps.intelligence) return null;
    try {
      return await this.deps.intelligence.getActiveProfile(profileId);
    } catch {
      return null;
    }
  }

  /** Scores one job. Loads the candidate itself, so it is safe to call alone. */
  async matchJob(profileId: string, jobId: string, reason?: string): Promise<JobMatch> {
    const candidate = await this.loadCandidate(profileId);
    const job = await this.loadJob(jobId);

    const intelligence = await this.activeIntelligence(profileId);
    const evidence = await this.evidenceFor(profileId, jobId, intelligence);

    const match = await this.engine.match(candidate.context, job, { llmCallsMade: 0 }, evidence);

    await this.deps.matches.save({
      match,
      profileVersionId: candidate.profileVersionId,
      preferenceVersionId: candidate.preferenceVersionId,
      ...(reason ? { reason } : {}),
    });

    return match;
  }

  /**
   * Scores every job that needs it.
   *
   * A failure on one job is recorded and the run continues. One malformed
   * enrichment must not cost the candidate the other four hundred results.
   */
  async matchAll(
    profileId: string,
    options: { limit?: number; force?: boolean; reason?: string } = {},
  ): Promise<MatchRunResult> {
    const startedAt = Date.now();
    const candidate = await this.loadCandidate(profileId);

    const jobIds = await this.deps.matches.findJobsNeedingMatch(profileId, {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.force !== undefined ? { force: options.force } : {}),
    });

    const state: MatchRunState = { llmCallsMade: 0 };
    const result: MatchRunResult = {
      profileId,
      considered: jobIds.length,
      matched: 0,
      failed: 0,
      eligible: 0,
      ineligible: 0,
      llmCalls: 0,
      durationMs: 0,
      byRecommendation: {},
      errors: [],
    };

    const intelligence = await this.activeIntelligence(profileId);

    for (const jobId of jobIds) {
      try {
        const job = await this.loadJob(jobId);
        const evidence = await this.evidenceFor(profileId, jobId, intelligence);
        const match = await this.engine.match(candidate.context, job, state, evidence);

        await this.deps.matches.save({
          match,
          profileVersionId: candidate.profileVersionId,
          preferenceVersionId: candidate.preferenceVersionId,
          reason: options.reason ?? 'scheduled match run',
        });

        result.matched += 1;
        if (match.eligible) result.eligible += 1;
        else result.ineligible += 1;
        result.byRecommendation[match.recommendation] =
          (result.byRecommendation[match.recommendation] ?? 0) + 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push({
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.deps.logger.error('Match failed', { jobId, err: error });
      }
    }

    result.llmCalls = state.llmCallsMade;
    result.durationMs = Date.now() - startedAt;

    await this.deps.events.emit('MATCH_RUN_COMPLETED', {
      message: `Matched ${result.matched}/${result.considered} jobs`,
      data: {
        profileId,
        matched: result.matched,
        eligible: result.eligible,
        failed: result.failed,
        llmCalls: result.llmCalls,
        durationMs: result.durationMs,
      },
    });

    this.deps.logger.info('Match run complete', { ...result, errors: result.errors.length });
    return result;
  }

  /**
   * Recomputes everything for a candidate after a preference change.
   *
   * `force` is deliberate rather than relying on staleness detection: a
   * preference change alters the *inputs* to every score, and being clever
   * about which ones "probably" moved is how a stale recommendation survives an
   * explicit edit.
   */
  async recalculateForCandidate(
    profileId: string,
    reason = 'preferences changed',
  ): Promise<MatchRunResult> {
    return this.matchAll(profileId, { force: true, reason });
  }

  async getMatch(jobId: string, profileId: string): Promise<StoredMatch | null> {
    return this.deps.matches.get(jobId, profileId);
  }

  // ── Embeddings ────────────────────────────────────────────────────────────

  /**
   * Generates missing job vectors.
   *
   * Content-hashed, so re-running is cheap and a job whose description has not
   * changed is never re-embedded.
   */
  async backfillJobEmbeddings(limit = 200): Promise<{ embedded: number; skipped: number }> {
    if (!this.embedder.isAvailable()) return { embedded: 0, skipped: 0 };

    const pending = await this.deps.embeddings.findJobsNeedingEmbedding(this.embedder.model, limit);
    if (pending.length === 0) return { embedded: 0, skipped: 0 };

    const texts = pending.map((job) => `${job.title}\n\n${job.description ?? ''}`.slice(0, 20_000));
    const result = await this.embedder.embed(texts);

    let embedded = 0;
    for (const [index, job] of pending.entries()) {
      const vector = result.vectors[index];
      if (!vector) continue;
      await this.deps.embeddings.saveJobEmbedding({
        jobId: job.jobId,
        model: result.model,
        dimensions: result.dimensions,
        embedding: vector,
        contentHash: createHash('sha256').update(texts[index] ?? '').digest('hex'),
      });
      embedded += 1;
    }

    return { embedded, skipped: pending.length - embedded };
  }

  /** Generates the candidate vector from the canonical text already stored. */
  async rebuildCandidateEmbedding(profileId: string): Promise<{ generated: boolean; reason: string }> {
    if (!this.embedder.isAvailable()) {
      return { generated: false, reason: 'no embedding provider configured' };
    }

    const state = await this.deps.candidates.getEmbeddingState(profileId, this.embedder.model);
    if (!state) return { generated: false, reason: 'no canonical profile recorded yet' };
    if (!state.isStale && state.embedding) return { generated: false, reason: 'already current' };
    if (!state.canonicalText) return { generated: false, reason: 'canonical text missing' };

    const result = await this.embedder.embed([state.canonicalText]);
    const vector = result.vectors[0];
    if (!vector) return { generated: false, reason: 'provider returned no vector' };

    await this.deps.candidates.saveEmbedding({
      profileId,
      model: result.model,
      embedding: vector,
      canonicalHash: state.canonicalHash,
    });

    return { generated: true, reason: 'regenerated' };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async loadJob(jobId: string): Promise<MatchJobContext> {
    // `getEnrichment` reassembles and re-validates the decomposed row, so a
    // record written by an older extractor upgrades cleanly or fails loudly.
    const [job, enrichment] = await Promise.all([
      this.deps.jobs.getById(jobId),
      this.deps.enrichments.getEnrichment(jobId),
    ]);

    if (!job) throw new Error(`Job ${jobId} not found`);
    if (!enrichment) throw new Error(`Job ${jobId} has no enrichment`);

    const embedding = this.embedder.isAvailable()
      ? await this.deps.embeddings.getJobEmbedding(jobId, this.embedder.model)
      : null;

    return {
      jobId,
      jobVersion: job.version ?? 1,
      title: job.title,
      companyName: job.company?.canonicalName ?? job.companyNameRaw ?? '',
      description: job.description ?? null,
      enrichment,
      embedding: embedding ? { model: embedding.model, vector: embedding.vector } : null,
    };
  }
}
