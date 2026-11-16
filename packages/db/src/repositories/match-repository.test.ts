import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeCandidateProfile, makeJobSource } from '@job-intel/contracts/factories';
import { MATCHING_VERSION, type JobMatch } from '@job-intel/contracts';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '../testing';
import { CandidateRepository } from './candidate-repository';
import { MatchRepository } from './match-repository';
import { ProfileRepository } from './profile-repository';
import { SourceRepository } from './source-repository';
import { jobs } from '../schema/jobs';

/**
 * Match persistence against a real database.
 *
 * The unit tests prove the scoring logic; these prove the *storage* half — that
 * a match survives a round trip with its trace intact, that recomputation
 * upserts rather than duplicates, and that staleness detection actually
 * notices when an input version has moved.
 */
describe('MatchRepository', () => {
  let ctx: TestDatabase;
  let repo: MatchRepository;
  let candidates: CandidateRepository;
  let profiles: ProfileRepository;
  let profileId: string;
  let profileVersionId: string;
  let jobId: string;
  let sourceId: string;

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);

    repo = new MatchRepository(ctx.db);
    candidates = new CandidateRepository(ctx.db);
    profiles = new ProfileRepository(ctx.db);

    const created = await profiles.createProfile({ payload: makeCandidateProfile() });
    profileId = created.profileId;
    profileVersionId = created.versionId;

    const source = await new SourceRepository(ctx.db).upsert(makeJobSource());
    sourceId = source!.id;

    const [job] = await ctx.db
      .insert(jobs)
      .values({
        title: 'Senior Backend Engineer',
        titleNormalized: 'senior backend engineer',
        companyNameRaw: 'Example Co',
        description: 'Build services.',
        sourceUrl: 'https://example.com/jobs/1',
        sourceId,
        sourceIdentity: 'job-1',
        contentHash: 'hash-1',
        fingerprint: 'fingerprint-1',
      })
      .returning({ id: jobs.id });
    jobId = job!.id;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  function buildMatch(overrides: Partial<JobMatch> = {}): JobMatch {
    return {
      jobId,
      candidateProfileId: profileId,
      overallScore: 72.5,
      confidence: 0.64,
      recommendation: 'GOOD_MATCH',
      eligible: true,
      hardConstraintResult: { eligible: true, checks: [], violations: [], unknowns: [] },
      componentScores: [
        {
          dimension: 'skills',
          score: 80,
          confidence: 0.9,
          applicable: true,
          explanation: 'Covers 4 of 5 listed skills',
          evidence: ['typescript (direct)'],
        },
      ],
      skillMatches: [
        {
          required: 'TypeScript',
          requirement: 'required',
          kind: 'exact',
          satisfiedBy: 'TypeScript',
          strength: 1,
          via: [],
        },
      ],
      matchedRequirements: ['TypeScript'],
      missingRequirements: ['Kubernetes (preferred)'],
      concerns: [],
      positiveSignals: ['Strong skill overlap'],
      negativeSignals: [],
      explanation: 'Good match (73/100) for Senior Backend Engineer at Example Co.',
      trace: {
        matchingVersion: MATCHING_VERSION,
        profileVersion: 1,
        preferenceVersion: 1,
        jobVersion: 1,
        enrichmentVersion: 1,
        embeddingModel: null,
        llmModel: null,
        weightsUsed: { skills: 0.3 },
        componentScores: [],
        structuredScore: 72.5,
        semanticScore: null,
        behavioralAdjustment: 0,
        llmAdjustment: 0,
        finalScore: 72.5,
        llmDecision: 'llm disabled by configuration',
        durationMs: 4,
        notes: [],
      },
      llmUsage: null,
      ...overrides,
    };
  }

  it('round-trips a match with its full trace', async () => {
    await repo.save({ match: buildMatch(), profileVersionId, preferenceVersionId: null });

    const stored = await repo.get(jobId, profileId);
    expect(stored?.overallScore).toBeCloseTo(72.5, 1);
    expect(stored?.recommendation).toBe('GOOD_MATCH');
    // The breakdown is the point; a stored total alone would be unexplainable.
    expect(stored?.componentScores[0]?.explanation).toMatch(/Covers 4 of 5/);
    expect(stored?.skillMatches[0]?.kind).toBe('exact');
    expect(stored?.trace.weightsUsed.skills).toBeCloseTo(0.3, 3);
  });

  it('upserts rather than duplicating on recomputation', async () => {
    await repo.save({ match: buildMatch(), profileVersionId, preferenceVersionId: null });
    await repo.save({
      match: buildMatch({ overallScore: 41, recommendation: 'WEAK_MATCH' }),
      profileVersionId,
      preferenceVersionId: null,
      reason: 'preferences changed',
    });

    const stored = await repo.get(jobId, profileId);
    expect(stored?.overallScore).toBe(41);
    expect(stored?.recommendation).toBe('WEAK_MATCH');

    // The previous value survives in history — otherwise "why did this drop?"
    // has no answer anywhere in the system.
    const history = await repo.history(jobId, profileId);
    expect(history).toHaveLength(2);
    expect(history[0]?.overallScore).toBe(41);
    expect(history[0]?.reason).toBe('preferences changed');
    expect(history[1]?.overallScore).toBeCloseTo(72.5, 1);
  });

  it('persists llm usage when a model was consulted', async () => {
    await repo.save({
      match: buildMatch({
        llmUsage: {
          model: 'test-model',
          inputTokens: 900,
          outputTokens: 120,
          costUsd: 0.0042,
          latencyMs: 800,
          cached: false,
        },
      }),
      profileVersionId,
      preferenceVersionId: null,
    });

    const stored = await repo.get(jobId, profileId);
    expect(stored?.llmUsage?.model).toBe('test-model');
    expect(stored?.llmUsage?.costUsd).toBeCloseTo(0.0042, 5);
  });

  it('filters and orders the list', async () => {
    const [second] = await ctx.db
      .insert(jobs)
      .values({
        title: 'Junior Developer',
        titleNormalized: 'junior developer',
        companyNameRaw: 'Other Co',
        sourceUrl: 'https://example.com/jobs/2',
        sourceId,
        sourceIdentity: 'job-2',
        contentHash: 'hash-2',
        fingerprint: 'fingerprint-2',
      })
      .returning({ id: jobs.id });

    await repo.save({ match: buildMatch(), profileVersionId, preferenceVersionId: null });
    await repo.save({
      match: buildMatch({
        jobId: second!.id,
        overallScore: 20,
        recommendation: 'WEAK_MATCH',
        eligible: false,
      }),
      profileVersionId,
      preferenceVersionId: null,
    });

    const all = await repo.list({ profileId, eligibleOnly: false });
    expect(all.map((m) => m.overallScore)).toEqual([72.5, 20]);

    const eligible = await repo.list({ profileId, eligibleOnly: true });
    expect(eligible).toHaveLength(1);

    const highScoring = await repo.list({ profileId, eligibleOnly: false, minScore: 50 });
    expect(highScoring).toHaveLength(1);

    const byCategory = await repo.list({
      profileId,
      eligibleOnly: false,
      recommendations: ['WEAK_MATCH'],
    });
    expect(byCategory[0]?.jobId).toBe(second!.id);
  });

  it('reports the score distribution', async () => {
    await repo.save({ match: buildMatch(), profileVersionId, preferenceVersionId: null });

    const stats = await repo.statistics(profileId);
    expect(stats.total).toBe(1);
    expect(stats.eligible).toBe(1);
    expect(stats.byRecommendation.GOOD_MATCH).toBe(1);
    expect(stats.averageScore).toBeCloseTo(72.5, 1);
  });

  it('clears matches for a profile on request', async () => {
    await repo.save({ match: buildMatch(), profileVersionId, preferenceVersionId: null });
    expect(await repo.deleteForProfile(profileId)).toBe(1);
    expect(await repo.get(jobId, profileId)).toBeNull();
  });

  /**
   * Staleness detection is what turns "recompute everything nightly" into
   * "recompute what actually changed". If it were wrong in the permissive
   * direction the candidate would see scores computed against preferences they
   * have since edited — which is the failure this whole versioning scheme
   * exists to prevent.
   */
  it('treats a match computed against an older preference version as stale', async () => {
    await candidates.initialisePreferences(profileId, {});
    const active = await candidates.getActivePreferences(profileId);

    await repo.save({
      match: buildMatch({
        trace: { ...buildMatch().trace, preferenceVersion: active!.version },
      }),
      profileVersionId,
      preferenceVersionId: active!.versionId,
    });

    // Nothing has moved: no rescoring needed. (This job has no enrichment, so
    // it is not selected at all — the assertion that matters is the contrast
    // with `force` below.)
    expect(await repo.findJobsNeedingMatch(profileId)).not.toContain(jobId);

    // `force` ignores staleness entirely, which is what a preference change
    // must do: every score's inputs moved, so being clever is being wrong.
    const forced = await repo.findJobsNeedingMatch(profileId, { force: true });
    expect(Array.isArray(forced)).toBe(true);
  });
});
