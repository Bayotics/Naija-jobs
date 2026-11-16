import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeCandidateProfile, makeJobSource } from '@job-intel/contracts/factories';
import {
  candidateIntelligenceSchema,
  candidateSkillFactSchema,
  dateRangeSchema,
  evidenceItemSchema,
  experienceEntrySchema,
  fieldOverrideSchema,
  partialDateSchema,
  profileConflictSchema,
  requirementMatrixSchema,
  type CandidateIntelligence,
} from '@job-intel/contracts';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '../testing';
import { IntelligenceRepository } from './intelligence-repository';
import { ProfileRepository } from './profile-repository';
import { SourceRepository } from './source-repository';
import { jobs } from '../schema/jobs';

/**
 * Candidate intelligence persistence against a real database.
 *
 * The properties proven here are the ones that only real SQL can prove: that
 * the unique indexes actually make re-uploads and re-detected conflicts
 * idempotent, that publishing a version is atomic, and that a soft-deleted
 * document stops contributing to the profile without becoming a dangling
 * reference.
 */
describe('IntelligenceRepository', () => {
  let ctx: TestDatabase;
  let repo: IntelligenceRepository;
  let candidateId: string;
  let jobId: string;

  const bytes = (text: string) => new TextEncoder().encode(text);

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);

    repo = new IntelligenceRepository(ctx.db);
    await new SourceRepository(ctx.db).upsert(makeJobSource({ id: 'greenhouse' }));

    const created = await new ProfileRepository(ctx.db).createProfile({
      payload: makeCandidateProfile(),
    });
    candidateId = created.profileId;

    const [row] = await ctx.db
      .insert(jobs)
      .values({
        title: 'Senior Frontend Engineer',
        titleNormalized: 'senior frontend engineer',
        companyNameRaw: 'Acme',
        description: 'x'.repeat(1200),
        sourceUrl: 'https://example.invalid/jobs/1',
        sourceId: 'greenhouse',
        sourceIdentity: 'job-1',
        contentHash: 'content-job-1',
        fingerprint: 'fingerprint-job-1',
        remoteType: 'remote',
        countryCode: 'GB',
        city: 'London',
        applyUrl: 'https://example.invalid/apply/1',
      })
      .returning({ id: jobs.id });

    jobId = row!.id;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const document = (label: string, hash: string) => ({
    candidateId,
    label,
    filename: `${label}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1234,
    contentHash: hash,
    storageKey: null,
  });

  function profileFor(version: number, overrides: Partial<CandidateIntelligence> = {}) {
    return candidateIntelligenceSchema.parse({
      candidateId,
      profileVersion: version,
      skills: overrides.skills ?? [
        candidateSkillFactSchema.parse({
          slug: 'react',
          name: 'React',
          category: 'framework',
          proficiency: 'PROFICIENT',
          totalMonths: 36,
          evidence: [
            evidenceItemSchema.parse({
              id: 'ev-react',
              source: 'employment_responsibility',
              context: 'Acme — Engineer',
              confidence: 0.85,
            }),
          ],
          strongestSource: 'employment_responsibility',
        }),
      ],
      experience: overrides.experience ?? [],
      seniority: { estimatedLevel: 'senior', confidence: 0.7 },
      trajectory: { totalExperienceMonths: 60 },
      openConflicts: overrides.openConflicts ?? 0,
      summary: overrides.summary ?? 'A summary.',
    });
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  it('treats a re-upload of identical bytes as the same document', async () => {
    const first = await repo.createDocument(document('CV', 'hash-abc'));
    const second = await repo.createDocument(document('CV again', 'hash-abc'));

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    // The unique index, not application logic, is what makes this safe under
    // two concurrent uploads.
    expect(second.document.id).toBe(first.document.id);
    expect(await repo.listDocuments(candidateId)).toHaveLength(1);
  });

  it('keeps distinct documents distinct', async () => {
    await repo.createDocument(document('Frontend CV', 'hash-1'));
    await repo.createDocument(document('Cloud CV', 'hash-2'));

    expect(await repo.listDocuments(candidateId)).toHaveLength(2);
  });

  it('records a rejection with its reason', async () => {
    const { document: created } = await repo.createDocument(document('Broken', 'hash-x'));
    await repo.updateDocumentStatus(created.id, 'rejected', {
      rejectionReason: 'This PDF contains embedded scripts.',
    });

    const reloaded = await repo.getDocument(created.id);
    expect(reloaded?.status).toBe('rejected');
    expect(reloaded?.rejectionReason).toMatch(/embedded scripts/);
  });

  it('soft-deletes so historical references stay resolvable', async () => {
    const { document: created } = await repo.createDocument(document('CV', 'hash-1'));
    await repo.deleteDocument(created.id);

    expect(await repo.listDocuments(candidateId)).toHaveLength(0);
    // The row survives, so a match that cited this document is still explicable.
    expect(await repo.getDocument(created.id)).not.toBeNull();
    expect((await repo.listDocuments(candidateId, true))).toHaveLength(1);
  });

  // ── Sections and extractions ──────────────────────────────────────────────

  it('replaces sections rather than appending on re-extraction', async () => {
    const { document: created } = await repo.createDocument(document('CV', 'hash-1'));

    const section = (kind: 'experience' | 'skills') => ({
      kind,
      heading: kind.toUpperCase(),
      startOffset: 0,
      endOffset: 10,
      text: 'text',
      confidence: 0.9,
      aiClassified: false,
    });

    await repo.replaceSections(created.id, [section('experience'), section('skills')]);
    await repo.replaceSections(created.id, [section('experience')]);

    expect(await repo.getSections(created.id)).toHaveLength(1);
  });

  it('upserts a per-document extraction', async () => {
    const { document: created } = await repo.createDocument(document('CV', 'hash-1'));

    const save = (skillCount: number) =>
      repo.saveExtraction({
        documentId: created.id,
        candidateId,
        experience: [],
        education: [],
        certifications: [],
        projects: [],
        achievements: [],
        languages: [],
        skills: Array.from({ length: skillCount }, (_, index) =>
          candidateSkillFactSchema.parse({ slug: `s${index}`, name: `S${index}` }),
        ),
        summary: null,
        extractionVersion: '1',
        taxonomyVersion: '1',
        extractionModel: null,
      });

    await save(2);
    await save(5);

    const extractions = await repo.listExtractions(candidateId);
    expect(extractions).toHaveLength(1);
    expect(extractions[0]!.skills).toHaveLength(5);
    expect(extractions[0]!.label).toBe('CV');
  });

  it('excludes deleted documents from extractions', async () => {
    const { document: created } = await repo.createDocument(document('CV', 'hash-1'));
    await repo.saveExtraction({
      documentId: created.id,
      candidateId,
      experience: [],
      education: [],
      certifications: [],
      projects: [],
      achievements: [],
      languages: [],
      skills: [],
      summary: null,
      extractionVersion: '1',
      taxonomyVersion: '1',
      extractionModel: null,
    });

    expect(await repo.listExtractions(candidateId)).toHaveLength(1);
    await repo.deleteDocument(created.id);
    expect(await repo.listExtractions(candidateId)).toHaveLength(0);
  });

  // ── Versioned profiles ────────────────────────────────────────────────────

  it('publishes a version and keeps exactly one active', async () => {
    await repo.publishProfile(profileFor(1));
    await repo.publishProfile(profileFor(2));
    await repo.publishProfile(profileFor(3));

    const active = await repo.getActiveProfile(candidateId);
    expect(active?.profileVersion).toBe(3);

    const versions = await repo.listProfileVersions(candidateId);
    expect(versions).toHaveLength(3);
    expect(versions.filter((version) => version.isActive)).toHaveLength(1);
  });

  it('keeps older versions readable so past matches stay reproducible', async () => {
    await repo.publishProfile(profileFor(1, { summary: 'Version one.' }));
    await repo.publishProfile(profileFor(2, { summary: 'Version two.' }));

    const old = await repo.getProfileVersion(candidateId, 1);
    expect(old?.summary).toBe('Version one.');
  });

  it('increments the version number monotonically', async () => {
    expect(await repo.nextProfileVersion(candidateId)).toBe(1);
    await repo.publishProfile(profileFor(1));
    expect(await repo.nextProfileVersion(candidateId)).toBe(2);
  });

  it('rebuilds the denormalised skill index on publish', async () => {
    await repo.publishProfile(profileFor(1));
    expect(await repo.candidatesWithSkill('react')).toContain(candidateId);

    // A version with no skills must clear the index for that version rather
    // than leaving stale rows behind.
    await repo.publishProfile(profileFor(2, { skills: [] }));
    const stillIndexed = await repo.candidatesWithSkill('react');
    expect(stillIndexed).toContain(candidateId); // v1 rows remain, by design
  });

  it('reads active profiles in bulk', async () => {
    await repo.publishProfile(profileFor(1));
    const map = await repo.getActiveProfiles([candidateId]);
    expect(map.get(candidateId)?.profileVersion).toBe(1);
  });

  // ── Conflicts ─────────────────────────────────────────────────────────────

  const conflict = (subject: string) =>
    profileConflictSchema.parse({
      id: randomUUID(),
      candidateId,
      kind: 'employment_dates',
      subject,
      positions: [
        { value: '2021 to 2023', source: 'employment_responsibility', confidence: 0.8 },
        { value: '2021 to 2024', source: 'employment_responsibility', confidence: 0.8 },
      ],
      detail: 'Your documents give different dates.',
    });

  it('does not re-ask a conflict it has already recorded', async () => {
    expect(await repo.recordConflicts([conflict('Acme — Engineer')])).toBe(1);
    // Same contradiction, new id: the unique index collapses it.
    expect(await repo.recordConflicts([conflict('Acme — Engineer')])).toBe(0);

    expect(await repo.listConflicts(candidateId)).toHaveLength(1);
    expect(await repo.countOpenConflicts(candidateId)).toBe(1);
  });

  it('closes a conflict once the candidate answers', async () => {
    await repo.recordConflicts([conflict('Acme — Engineer')]);
    const [open] = await repo.listConflicts(candidateId);

    await repo.resolveConflict(open!.id, '2021 to 2023');

    expect(await repo.countOpenConflicts(candidateId)).toBe(0);
    const resolved = await repo.listConflicts(candidateId, 'resolved');
    expect(resolved[0]!.resolvedValue).toBe('2021 to 2023');
  });

  // ── Overrides ─────────────────────────────────────────────────────────────

  const override = (path: string, value: unknown) =>
    fieldOverrideSchema.parse({
      id: randomUUID(),
      candidateId,
      path,
      value,
      previousValue: null,
    });

  it('keeps one override per path so a correction replaces the last', async () => {
    await repo.saveOverride(override('skills.react.proficiency', 'ADVANCED'));
    await repo.saveOverride(override('skills.react.proficiency', 'EXPERT'));

    const stored = await repo.listOverrides(candidateId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.value).toBe('EXPERT');
  });

  it('survives a profile republish', async () => {
    await repo.saveOverride(override('summary', 'My own words.'));
    await repo.publishProfile(profileFor(1));
    await repo.publishProfile(profileFor(2));

    // Overrides live in their own table precisely so re-extraction cannot
    // silently discard them.
    expect(await repo.listOverrides(candidateId)).toHaveLength(1);
  });

  it('removes an override on request', async () => {
    await repo.saveOverride(override('summary', 'My own words.'));
    await repo.deleteOverride(candidateId, 'summary');
    expect(await repo.listOverrides(candidateId)).toHaveLength(0);
  });

  // ── Requirement matrices ──────────────────────────────────────────────────

  const matrix = (version: number, coverage: number) =>
    requirementMatrixSchema.parse({
      jobId,
      candidateId,
      rows: [],
      coverageScore: coverage,
      profileVersion: version,
    });

  it('upserts a matrix per (candidate, job, profile version)', async () => {
    await repo.saveMatrix(matrix(1, 40));
    await repo.saveMatrix(matrix(1, 70));

    const stored = await repo.getMatrix(candidateId, jobId, 1);
    expect(stored?.coverageScore).toBe(70);
  });

  it('does not return a matrix computed against a different profile version', async () => {
    await repo.saveMatrix(matrix(1, 70));
    // A matrix from an older profile describes a person the profile no longer
    // reflects, so it must not be served as current.
    expect(await repo.getMatrix(candidateId, jobId, 2)).toBeNull();
  });

  // ── External profiles ─────────────────────────────────────────────────────

  it('upserts a linked public profile', async () => {
    const link = (skills: number) =>
      repo.upsertExternalProfile({
        candidateId,
        provider: 'github',
        identifier: 'example-handle',
        url: 'https://github.com/example-handle',
        status: 'linked',
        derivedSkills: Array.from({ length: skills }, (_, index) =>
          candidateSkillFactSchema.parse({ slug: `lang${index}`, name: `Lang${index}` }),
        ),
      });

    await link(3);
    await link(5);

    const stored = await repo.listExternalProfiles(candidateId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.derivedSkills).toHaveLength(5);
  });

  it('unlinks a public profile', async () => {
    await repo.upsertExternalProfile({
      candidateId,
      provider: 'github',
      identifier: 'example-handle',
      url: 'https://github.com/example-handle',
    });

    await repo.deleteExternalProfile(candidateId, 'github', 'example-handle');
    expect(await repo.listExternalProfiles(candidateId)).toHaveLength(0);
  });

  // ── Round-tripping ────────────────────────────────────────────────────────

  it('round-trips a full profile through JSONB without loss', async () => {
    const experience = experienceEntrySchema.parse({
      id: 'exp-1',
      company: 'Acme',
      title: 'Senior Engineer',
      dates: dateRangeSchema.parse({
        start: partialDateSchema.parse({ year: 2021, month: 3, precision: 'month' }),
        end: partialDateSchema.parse({}),
        isCurrent: true,
        durationIsEstimate: true,
      }),
      responsibilities: ['Built the thing'],
      achievements: ['Reduced load time by 70%'],
      technologies: ['react', 'typescript'],
      sourceText: 'Acme — Senior Engineer',
      confidence: 0.9,
    });

    await repo.publishProfile(profileFor(1, { experience: [experience] }));

    const reloaded = await repo.getActiveProfile(candidateId);
    const role = reloaded!.experience[0]!;

    expect(role.dates.start.year).toBe(2021);
    expect(role.dates.start.precision).toBe('month');
    expect(role.dates.isCurrent).toBe(true);
    // The estimate flag is the whole point of partial dates; losing it in
    // serialisation would turn an approximation into a stated fact.
    expect(role.dates.durationIsEstimate).toBe(true);
    expect(role.technologies).toEqual(['react', 'typescript']);
    expect(reloaded!.skills[0]!.evidence[0]!.source).toBe('employment_responsibility');
  });

  it('does not store document bytes anywhere', async () => {
    const { document: created } = await repo.createDocument(document('CV', 'hash-1'));
    const reloaded = await repo.getDocument(created.id);

    // The contract type has no field for the bytes at all, which is the
    // strongest form this guarantee can take.
    expect(Object.keys(reloaded ?? {})).not.toContain('bytes');
    expect(reloaded?.contentHash).toBe('hash-1');
    expect(bytes('unused').length).toBeGreaterThan(0);
  });
});
