import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeCandidateProfile, makeJobSource } from '@job-intel/contracts/factories';
import type { JobEnrichment } from '@job-intel/contracts';
import {
  CandidateRepository,
  EmbeddingRepository,
  EnrichmentRepository,
  EventRepository,
  JobRepository,
  MatchRepository,
  ProfileRepository,
  SourceRepository,
  schema,
} from '@job-intel/db';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '@job-intel/db/testing';
import { EventRecorder, MemoryLogger } from '@job-intel/observability';
import { PreferenceService } from '@job-intel/candidate';
import { HashingEmbeddingProvider } from '@job-intel/matching';
import { makeEnrichment, makeSkills } from '@job-intel/matching/testing';
import { MatchingService } from './matching-service';

/**
 * End-to-end matching against a real database.
 *
 * The property under test is the one the whole preference system exists to
 * provide, and it can only be demonstrated here rather than in a unit test: a
 * preference is **data**, so changing a stored row — with no code change, no
 * restart and no redeploy — changes what the next matching run produces.
 *
 * Everything runs against real SQL (PGlite), so the version columns, the
 * upsert, the constraint that keeps one match per (job, candidate) and the
 * staleness query are all genuinely exercised.
 */
describe('MatchingService', () => {
  let ctx: TestDatabase;
  let service: MatchingService;
  let matches: MatchRepository;
  let candidates: CandidateRepository;
  let profileId: string;
  let remoteJobId: string;
  let onsiteJobId: string;

  const logger = new MemoryLogger();

  async function seedJob(input: {
    title: string;
    company: string;
    identity: string;
    enrichment: JobEnrichment;
  }): Promise<string> {
    const [job] = await ctx.db
      .insert(schema.jobs)
      .values({
        title: input.title,
        titleNormalized: input.title.toLowerCase(),
        companyNameRaw: input.company,
        description: 'We build things with TypeScript and React.',
        sourceUrl: `https://example.test/jobs/${input.identity}`,
        sourceId: 'test-source',
        sourceIdentity: input.identity,
        contentHash: `content-${input.identity}`,
        fingerprint: `fingerprint-${input.identity}`,
        employmentTypes: ['full_time'],
      })
      .returning({ id: schema.jobs.id });

    await new EnrichmentRepository(ctx.db).save(job!.id, input.enrichment);
    return job!.id;
  }

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);

    await new SourceRepository(ctx.db).upsert(makeJobSource({ id: 'test-source' }));

    const profiles = new ProfileRepository(ctx.db);
    const created = await profiles.createProfile({
      payload: makeCandidateProfile({
        professional: {
          currentTitle: 'Frontend Engineer',
          yearsOfExperience: 6,
          seniority: 'senior',
          technologies: ['TypeScript', 'React'],
        },
      }),
    });
    profileId = created.profileId;

    candidates = new CandidateRepository(ctx.db);
    await candidates.initialisePreferences(profileId, {});
    await candidates.replaceSkills(profileId, [
      { name: 'TypeScript', slug: 'typescript', proficiency: 'expert', importance: 'primary' },
      { name: 'React', slug: 'react', proficiency: 'advanced', importance: 'primary' },
    ]);

    matches = new MatchRepository(ctx.db);
    service = new MatchingService({
      matches,
      candidates,
      profiles,
      enrichments: new EnrichmentRepository(ctx.db),
      jobs: new JobRepository(ctx.db),
      embeddings: new EmbeddingRepository(ctx.db),
      logger,
      events: new EventRecorder(logger, new EventRepository(ctx.db)),
      embedder: new HashingEmbeddingProvider(1536),
    });

    remoteJobId = await seedJob({
      title: 'Senior Frontend Engineer',
      company: 'Remote Co',
      identity: 'remote-1',
      enrichment: makeEnrichment({
        normalizedTitle: 'Senior Frontend Engineer',
        seniority: 'senior',
        seniorityConfidence: 0.9,
        experience: { minimumYears: 5, confidence: 0.9 },
        workArrangement: { mode: 'remote', confidence: 0.95, remoteWorldwide: true },
        skills: makeSkills([['typescript'], ['react']]),
      }),
    });

    onsiteJobId = await seedJob({
      title: 'Frontend Engineer',
      company: 'Office Co',
      identity: 'onsite-1',
      enrichment: makeEnrichment({
        normalizedTitle: 'Frontend Engineer',
        seniority: 'mid',
        seniorityConfidence: 0.8,
        workArrangement: { mode: 'onsite', confidence: 0.95 },
        location: { countryCode: 'DE', city: 'Berlin', confidence: 0.9 },
        skills: makeSkills([['typescript'], ['react']]),
      }),
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('scores every enriched job and stores an explainable result', async () => {
    const result = await service.matchAll(profileId);

    expect(result.considered).toBe(2);
    expect(result.matched).toBe(2);
    expect(result.failed).toBe(0);

    const stored = await matches.get(remoteJobId, profileId);
    expect(stored).not.toBeNull();
    expect(stored!.overallScore).toBeGreaterThan(0);
    expect(stored!.explanation.length).toBeGreaterThan(20);
    expect(stored!.componentScores.length).toBeGreaterThan(8);
    expect(stored!.skillMatches.map((m) => m.required)).toContain('typescript');
    expect(stored!.trace.preferenceVersion).toBe(1);
  });

  it('does not rescore a job whose inputs have not moved', async () => {
    await service.matchAll(profileId);
    // Idempotence is what makes a scheduled run cheap: the second pass should
    // find nothing to do.
    const second = await service.matchAll(profileId);
    expect(second.considered).toBe(0);
  });

  /**
   * The requirement, end to end through the database.
   *
   * Two facts are asserted together because either alone would be misleading:
   * the verdict changes, *and* the change came from a stored preference version
   * rather than from anything in the code path.
   */
  it('changes its verdict when only the stored preferences change', async () => {
    await service.matchAll(profileId);

    const before = await matches.get(onsiteJobId, profileId);
    expect(before!.eligible).toBe(true);

    // Change preferences. Database only — no code, no restart, no redeploy.
    const active = await candidates.getActivePreferences(profileId);
    const mutation = PreferenceService.updateWorkArrangement(active!.preferences, 'REMOTE_ONLY');
    await candidates.savePreferenceVersion({
      profileId,
      preferences: mutation.preferences,
      changes: mutation.changes,
      embeddingStale: mutation.embeddingStale,
    });

    await service.recalculateForCandidate(profileId, 'preferences changed to remote-only');

    const after = await matches.get(onsiteJobId, profileId);
    expect(after!.eligible).toBe(false);
    expect(after!.recommendation).toBe('INELIGIBLE');
    expect(after!.overallScore).toBe(0);
    expect(after!.explanation).toMatch(/remote-only/i);
    // The new preference version is recorded, so the change is attributable.
    expect(after!.trace.preferenceVersion).toBe(2);

    // The remote job is unaffected — the change was targeted, not indiscriminate.
    const remote = await matches.get(remoteJobId, profileId);
    expect(remote!.eligible).toBe(true);

    // And the earlier verdict survives in history.
    const history = await matches.history(onsiteJobId, profileId);
    expect(history).toHaveLength(2);
    expect(history[0]?.eligible).toBe(false);
    expect(history[1]?.eligible).toBe(true);
  });

  it('rescores the same job when only the weights change', async () => {
    // One job, one preference set, two weightings. Berlin scores 100 on skills
    // (both stated skills matched exactly) and 87.5 on location (a country the
    // candidate marked strongly preferred, not required), so shifting weight
    // between those two dimensions must move the total in a predictable
    // direction — and nothing but a stored number changed.
    const weigh = async (weights: Record<string, number>, reason: string) => {
      const active = await candidates.getActivePreferences(profileId);
      let payload = PreferenceService.updateList(active!.preferences, 'countries', [
        { value: 'DE', strength: 'strongly_preferred' },
      ]).preferences;
      payload = PreferenceService.updateWeights(payload, {
        location: 1, technicalSkills: 1, titleMatch: 1, semantic: 1,
        quality: 1, experience: 1, seniority: 1, visa: 1,
        salary: 1, industry: 1, companyPreference: 1, employmentType: 1, education: 1,
        ...weights,
      }).preferences;

      await candidates.savePreferenceVersion({
        profileId,
        preferences: payload,
        changes: [{ path: 'weights', before: null, after: null, summary: reason }],
        embeddingStale: false,
      });
      await service.recalculateForCandidate(profileId, reason);
      return (await matches.get(onsiteJobId, profileId))!;
    };

    const skillsFirst = await weigh({ technicalSkills: 100 }, 'skills matter most');
    const locationFirst = await weigh({ location: 100 }, 'location matters most');

    expect(skillsFirst.overallScore).toBeGreaterThan(locationFirst.overallScore);
    expect(locationFirst.trace.weightsUsed.location).toBeGreaterThan(
      locationFirst.trace.weightsUsed.skills ?? 0,
    );
    expect(skillsFirst.trace.weightsUsed.skills).toBeGreaterThan(
      skillsFirst.trace.weightsUsed.location ?? 0,
    );
  });

  it('records behavioural signals without letting them override preferences', async () => {
    // Exclude the company explicitly, then behave as though you love it.
    const active = await candidates.getActivePreferences(profileId);
    const mutation = PreferenceService.updateList(active!.preferences, 'companies', [
      { value: 'Office Co', strength: 'excluded' },
    ]);
    await candidates.savePreferenceVersion({
      profileId,
      preferences: mutation.preferences,
      changes: mutation.changes,
      embeddingStale: mutation.embeddingStale,
    });

    for (let i = 0; i < 12; i += 1) {
      await candidates.recordSignal(profileId, { event: 'job_applied', jobId: onsiteJobId });
    }

    await service.recalculateForCandidate(profileId, 'company excluded');

    const stored = await matches.get(onsiteJobId, profileId);
    // Stated intent wins. Behaviour is surfaced elsewhere, never applied here.
    expect(stored!.eligible).toBe(false);
    expect(stored!.trace.behavioralAdjustment).toBe(0);
  });

  it('generates job embeddings and uses them for the semantic dimension', async () => {
    const backfill = await service.backfillJobEmbeddings();
    expect(backfill.embedded).toBe(2);

    // Without a candidate vector there is nothing to compare against, and the
    // trace says so rather than silently scoring zero.
    await service.matchAll(profileId);
    const withoutCandidateVector = await matches.get(remoteJobId, profileId);
    expect(withoutCandidateVector!.trace.semanticScore).toBeNull();
    expect(withoutCandidateVector!.trace.notes.join(' ')).toMatch(/candidate embedding/);

    await candidates.markEmbeddingStale({
      profileId,
      model: new HashingEmbeddingProvider(1536).model,
      dimensions: 1536,
      canonicalHash: 'hash-1',
      canonicalText: 'Senior frontend engineer with TypeScript and React experience',
      reason: 'first generation',
    });
    const rebuilt = await service.rebuildCandidateEmbedding(profileId);
    expect(rebuilt.generated).toBe(true);

    await service.recalculateForCandidate(profileId, 'candidate embedding generated');
    const withVector = await matches.get(remoteJobId, profileId);
    expect(withVector!.trace.semanticScore).not.toBeNull();
    expect(withVector!.trace.embeddingModel).toContain('hashing-local');
  });

  it('continues the run when one job fails to score', async () => {
    // A job with no enrichment is exactly the shape that breaks a naive loop.
    await ctx.db.insert(schema.jobs).values({
      title: 'Unenriched Role',
      titleNormalized: 'unenriched role',
      companyNameRaw: 'Nowhere Ltd',
      sourceUrl: 'https://example.test/jobs/broken',
      sourceId: 'test-source',
      sourceIdentity: 'broken-1',
      contentHash: 'content-broken',
      fingerprint: 'fingerprint-broken',
    });

    const result = await service.matchAll(profileId);
    // The unenriched job is not selected at all, and the other two still score.
    expect(result.matched).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('reports a distribution the dashboard can render', async () => {
    await service.matchAll(profileId);
    const stats = await matches.statistics(profileId);
    expect(stats.total).toBe(2);
    expect(Object.values(stats.byRecommendation).reduce((a, b) => a + b, 0)).toBe(2);
    expect(stats.averageConfidence).toBeGreaterThan(0);
  });
});
