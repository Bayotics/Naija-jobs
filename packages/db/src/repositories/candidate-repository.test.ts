import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeCandidateProfile } from '@job-intel/contracts/factories';
import { candidatePreferencesSchema } from '@job-intel/contracts';
import { ConstraintEvaluator, PreferenceService } from '@job-intel/candidate';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '../testing';
import { CandidateRepository } from './candidate-repository';
import { ProfileRepository } from './profile-repository';

/**
 * Candidate intelligence against a real database.
 *
 * The unit tests prove the domain logic; these prove the *persistence* half —
 * that a preference change survives a round trip and that the next read sees
 * it. Together they are the evidence for the change-propagation requirement.
 */
describe('CandidateRepository', () => {
  let ctx: TestDatabase;
  let repo: CandidateRepository;
  let profiles: ProfileRepository;
  let profileId: string;

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);
    repo = new CandidateRepository(ctx.db);
    profiles = new ProfileRepository(ctx.db);
    const created = await profiles.createProfile({ payload: makeCandidateProfile() });
    profileId = created.profileId;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('initialises preferences with every dimension neutral', async () => {
    const created = await repo.initialisePreferences(profileId, {});
    expect(created.version).toBe(1);
    // A brand-new candidate must filter nothing out.
    expect(created.preferences.workArrangement).toBe('ANY');
    expect(created.preferences.countries).toEqual([]);
  });

  it('keeps exactly one active version across repeated changes', async () => {
    await repo.initialisePreferences(profileId, {});

    for (const value of ['REMOTE_ONLY', 'HYBRID_ACCEPTED', 'ONSITE_ACCEPTED']) {
      const active = await repo.getActivePreferences(profileId);
      const mutation = PreferenceService.updateWorkArrangement(active!.preferences, value);
      await repo.savePreferenceVersion({
        profileId,
        preferences: mutation.preferences,
        changes: mutation.changes,
        embeddingStale: mutation.embeddingStale,
      });
    }

    const versions = await repo.listPreferenceVersions(profileId);
    expect(versions).toHaveLength(4);
    expect(versions.filter((v) => v.isActive)).toHaveLength(1);
    expect((await repo.getActivePreferences(profileId))?.preferences.workArrangement).toBe(
      'ONSITE_ACCEPTED',
    );
  });

  it('records a field-level change log', async () => {
    await repo.initialisePreferences(profileId, {});
    const active = await repo.getActivePreferences(profileId);
    const mutation = PreferenceService.updateSalary(active!.preferences, {
      minimum: 90_000,
      currency: 'EUR',
    });

    await repo.savePreferenceVersion({
      profileId,
      preferences: mutation.preferences,
      changes: mutation.changes,
      embeddingStale: mutation.embeddingStale,
    });

    const changes = await repo.listPreferenceChanges(profileId);
    const paths = changes.map((c) => c.path);
    expect(paths).toContain('salary.minimum');
    expect(paths).toContain('salary.currency');
    expect(changes.find((c) => c.path === 'salary.minimum')?.summary).toMatch(/90000/);
  });

  it('preserves history so an old version stays readable', async () => {
    await repo.initialisePreferences(profileId, { salary: { minimum: 60_000 } });
    const active = await repo.getActivePreferences(profileId);
    const mutation = PreferenceService.updateSalary(active!.preferences, { minimum: 95_000 });
    await repo.savePreferenceVersion({
      profileId,
      preferences: mutation.preferences,
      changes: mutation.changes,
      embeddingStale: false,
    });

    const versions = await repo.listPreferenceVersions(profileId);
    const first = versions.find((v) => v.version === 1);
    // The score a v1 match produced must stay explainable.
    expect(
      candidatePreferencesSchema.parse(first?.payload).salary.minimum,
    ).toBe(60_000);
  });

  /**
   * The requirement stated in the brief, end to end through the database:
   * change stored preferences, and the next evaluation uses the new values.
   */
  it('propagates a preference change to the next evaluation with no code change', async () => {
    await repo.initialisePreferences(profileId, {
      workArrangement: 'REMOTE_ONLY',
      countries: [{ value: 'DE', strength: 'required', hard: true }],
      salary: { minimum: 70_000, currency: 'EUR', period: 'year', minimumIsHard: true },
    });

    const hybridDutchJob = {
      enrichment: {
        workArrangement: { mode: 'hybrid' as const, confidence: 0.9, method: 'pattern' as const, remoteRegions: [], remoteWorldwide: false, officeDaysPerWeek: 2, remoteAllowed: null, evidence: null, officeLocation: null, relocationRequired: null, geographicRestriction: null, travelRequirement: null },
        location: { countryCode: 'NL', city: 'Amsterdam', region: null, raw: null, timezoneHint: null, confidence: 0.9, method: 'pattern' as const },
        compensation: {
          stated: true, minimum: 65_000, maximum: 65_000, currency: 'EUR', period: 'year' as const,
          isOpenEnded: false, isEstimated: false, rawText: null, components: [],
          confidence: 0.9, method: 'pattern' as const,
          conversion: { annualUsd: 70_200, rate: 1.08, rateSource: 'test', rateTimestamp: new Date(), periodInferred: false },
        },
        workAuthorization: { sponsorship: 'not_mentioned' as const, sponsorshipConfidence: 0.9, sponsorshipEvidence: null, workAuthorizationRequirement: null, citizenshipRequired: null, securityClearanceRequired: null, securityClearanceLevel: null, relocationSupport: 'not_mentioned' as const, relocationEvidence: null },
        classification: { jobFunction: 'software_engineering' as const, functionConfidence: 0.9, industries: [], industryConfidence: 0, method: 'pattern' as const, evidence: null },
        employmentTypes: [],
        skills: [],
        seniority: 'senior' as const,
        normalizedTitle: 'Backend Engineer',
      },
      job: { title: 'Senior Backend Engineer', companyName: 'Dutch Co', description: 'Build things.' },
    };

    // Read from the database, evaluate.
    const before = await repo.getActivePreferences(profileId);
    const firstVerdict = new ConstraintEvaluator(before!.preferences).evaluate({
      preferences: before!.preferences,
      profileVersion: before!.version,
      enrichment: hybridDutchJob.enrichment as never,
      job: hybridDutchJob.job,
    });
    expect(firstVerdict.eligible).toBe(false);

    // Change preferences — database only.
    const next = PreferenceService.updateWorkArrangement(before!.preferences, 'HYBRID_ACCEPTED', 3);
    let payload = next.preferences;
    payload = PreferenceService.updateList(payload, 'countries', [
      { value: 'DE', strength: 'preferred', hard: false, note: null, source: 'explicit' },
      { value: 'NL', strength: 'preferred', hard: false, note: null, source: 'explicit' },
    ]).preferences;
    payload = PreferenceService.updateSalary(payload, { minimum: 60_000 }).preferences;

    await repo.savePreferenceVersion({
      profileId,
      preferences: payload,
      changes: [...next.changes, { path: 'countries', before: null, after: null, summary: 'added NL' }],
      embeddingStale: false,
    });

    // Re-read from the database. Same job, same code, different verdict.
    const after = await repo.getActivePreferences(profileId);
    expect(after!.version).toBe(2);
    const secondVerdict = new ConstraintEvaluator(after!.preferences).evaluate({
      preferences: after!.preferences,
      profileVersion: after!.version,
      enrichment: hybridDutchJob.enrichment as never,
      job: hybridDutchJob.job,
    });
    expect(secondVerdict.eligible).toBe(true);
  });

  it('stores skills with proficiency and importance', async () => {
    const saved = await repo.replaceSkills(profileId, [
      { name: 'React', slug: 'react', proficiency: 'advanced', yearsOfExperience: 4, importance: 'primary' },
      { name: 'Node.js', slug: 'nodejs', proficiency: 'intermediate', yearsOfExperience: 2, importance: 'secondary' },
    ]);
    expect(saved).toBe(2);

    const skills = await repo.listSkills(profileId);
    expect(skills.find((s) => s.name === 'React')?.proficiency).toBe('advanced');
    expect(skills.find((s) => s.name === 'React')?.importance).toBe('primary');
  });

  it('replaces rather than merges skills, so a deletion sticks', async () => {
    await repo.replaceSkills(profileId, [{ name: 'React', importance: 'primary' }]);
    await repo.replaceSkills(profileId, [{ name: 'Vue', importance: 'primary' }]);
    const skills = await repo.listSkills(profileId);
    expect(skills.map((s) => s.name)).toEqual(['Vue']);
  });

  it('marks the embedding stale and clears it once generated', async () => {
    await repo.markEmbeddingStale({
      profileId,
      model: 'test-model',
      dimensions: 1536,
      canonicalHash: 'hash-1',
      canonicalText: 'Frontend engineer with React experience',
      reason: 'first generation',
    });

    let state = await repo.getEmbeddingState(profileId, 'test-model');
    expect(state?.isStale).toBe(true);
    expect((await repo.listStaleEmbeddings()).length).toBe(1);

    await repo.saveEmbedding({
      profileId,
      model: 'test-model',
      embedding: Array.from({ length: 1536 }, () => 0.01),
      canonicalHash: 'hash-1',
    });

    state = await repo.getEmbeddingState(profileId, 'test-model');
    expect(state?.isStale).toBe(false);
    expect(state?.generatedAt).not.toBeNull();
  });

  it('does not clear staleness when the hash has moved on', async () => {
    // Guards a real race: the worker finishes embedding hash-1 just after the
    // candidate saved a change producing hash-2. The stale flag must survive.
    await repo.markEmbeddingStale({
      profileId, model: 'test-model', dimensions: 1536,
      canonicalHash: 'hash-2', canonicalText: 'newer text', reason: 'profile changed',
    });
    await repo.saveEmbedding({
      profileId, model: 'test-model',
      embedding: Array.from({ length: 1536 }, () => 0.01),
      canonicalHash: 'hash-1',
    });
    expect((await repo.getEmbeddingState(profileId, 'test-model'))?.isStale).toBe(true);
  });

  it('persists skill relations and upserts weights', async () => {
    await repo.upsertSkillRelations([
      { fromSlug: 'nextjs', toSlug: 'react', type: 'implies', weight: 0.9 },
    ]);
    await repo.upsertSkillRelations([
      { fromSlug: 'nextjs', toSlug: 'react', type: 'implies', weight: 0.95 },
    ]);

    const relations = await repo.listSkillRelations();
    expect(relations).toHaveLength(1);
    expect(relations[0]?.weight).toBeCloseTo(0.95);
  });

  it('records CV imports as needing review rather than applying them', async () => {
    const created = await repo.createCvImport({
      profileId, filename: 'cv.pdf', mimeType: 'application/pdf',
      sizeBytes: 1024, rawText: 'Frontend engineer with 5 years of React',
    });
    await repo.saveCvExtraction(created.id, {
      fullName: 'Test Candidate', email: null, currentTitle: 'Frontend Engineer',
      yearsOfExperience: 5, seniority: null, summary: null,
      skills: [], experience: [], education: [], certifications: [], links: [],
      extractionConfidence: 0.7, method: 'pattern',
    });

    const imports = await repo.listCvImports(profileId);
    // Never `applied` automatically — a human has to accept it.
    expect(imports[0]?.status).toBe('needs_review');
    expect(imports[0]?.extraction?.currentTitle).toBe('Frontend Engineer');
  });
});
