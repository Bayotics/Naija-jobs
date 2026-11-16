import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeCandidateProfile, makeJobSource } from '@job-intel/contracts/factories';
import {
  CandidateRepository,
  EventRepository,
  LearningRepository,
  ProfileRepository,
  SourceRepository,
  schema,
} from '@job-intel/db';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '@job-intel/db/testing';
import { EventRecorder, MemoryLogger } from '@job-intel/observability';
import { makeEnrichment } from '@job-intel/matching/testing';
import { EnrichmentRepository } from '@job-intel/db';
import { LearningService } from './learning-service';

/**
 * The feedback loop against a real database.
 *
 * The properties that can only be shown here: ingestion is genuinely
 * idempotent under a unique constraint, resets are genuinely scoped, and
 * accepting a suggestion genuinely does not write a preference by itself.
 */
describe('LearningService', () => {
  let ctx: TestDatabase;
  let service: LearningService;
  let learning: LearningRepository;
  let candidates: CandidateRepository;
  let profileId: string;
  let jobIds: string[] = [];

  const logger = new MemoryLogger();
  const now = new Date('2026-08-19T12:00:00Z');

  /** Synthetic ids for jobs that are scored but never stored. */
  const REACT_LIKE = '55555555-5555-4555-8555-555555555551';
  const BACKEND_LIKE = '55555555-5555-4555-8555-555555555552';
  const ANY_JOB = '55555555-5555-4555-8555-555555555553';
  const COLD_JOB = '55555555-5555-4555-8555-555555555554';

  async function seedJob(input: {
    identity: string;
    title: string;
    company: string;
    technologies: string[];
    remote: boolean;
    salaryUsd: number;
    seniority?: string;
  }): Promise<string> {
    const [job] = await ctx.db
      .insert(schema.jobs)
      .values({
        title: input.title,
        titleNormalized: input.title.toLowerCase(),
        companyNameRaw: input.company,
        description: 'A role with responsibilities and requirements.',
        sourceUrl: `https://example.test/jobs/${input.identity}`,
        sourceId: 'greenhouse',
        sourceIdentity: input.identity,
        contentHash: `content-${input.identity}`,
        fingerprint: `fingerprint-${input.identity}`,
        remoteType: input.remote ? 'remote' : 'onsite',
        countryCode: 'DE',
        city: 'Berlin',
        techStack: input.technologies,
        salaryNormalizedAnnualUsd: String(input.salaryUsd),
      })
      .returning({ id: schema.jobs.id });

    await new EnrichmentRepository(ctx.db).save(
      job!.id,
      makeEnrichment({ seniority: (input.seniority ?? 'senior') as never }),
    );

    return job!.id;
  }

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);

    await new SourceRepository(ctx.db).upsert(makeJobSource({ id: 'greenhouse' }));

    const profiles = new ProfileRepository(ctx.db);
    const created = await profiles.createProfile({ payload: makeCandidateProfile() });
    profileId = created.profileId;

    candidates = new CandidateRepository(ctx.db);
    await candidates.initialisePreferences(profileId, {
      titles: [{ value: 'Frontend Engineer', strength: 'required' }],
      technologies: [{ value: 'React', strength: 'preferred' }],
      workArrangement: 'ONSITE_PREFERRED',
    } as never);

    learning = new LearningRepository(ctx.db);
    service = new LearningService({
      learning,
      candidates,
      logger,
      events: new EventRecorder(logger, new EventRepository(ctx.db)),
      now: () => now,
    });

    jobIds = [];
    for (let i = 0; i < 14; i += 1) {
      jobIds.push(
        await seedJob({
          identity: `react-${i}`,
          title: 'Senior Frontend Engineer',
          company: 'Northwind',
          technologies: ['React', 'TypeScript'],
          remote: true,
          salaryUsd: 95_000,
        }),
      );
    }
    for (let i = 0; i < 12; i += 1) {
      jobIds.push(
        await seedJob({
          identity: `backend-${i}`,
          title: 'Senior Backend Engineer',
          company: 'Helios',
          technologies: ['Go', 'Postgres'],
          remote: false,
          salaryUsd: 45_000,
        }),
      );
    }
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const save = (jobId: string) =>
    service.recordEvent({
      candidateId: profileId,
      jobId,
      eventType: 'JOB_SAVED',
      context: 'RECOMMENDATIONS',
      occurredAt: now,
    });

  const dismiss = (jobId: string) =>
    service.recordEvent({
      candidateId: profileId,
      jobId,
      eventType: 'JOB_DISMISSED',
      context: 'RECOMMENDATIONS',
      occurredAt: now,
    });

  it('ingests events idempotently', async () => {
    const first = await save(jobIds[0]!);
    expect(first.duplicate).toBe(false);

    // The same interaction redelivered by an at-least-once queue.
    const second = await service.recordEvent({
      candidateId: profileId,
      jobId: jobIds[0]!,
      eventType: 'JOB_SAVED',
      context: 'RECOMMENDATIONS',
      occurredAt: now,
      eventId: first.eventId!,
    });

    expect(second.duplicate).toBe(true);

    const counts = await learning.eventCounts(profileId);
    expect(counts.find((row) => row.eventType === 'JOB_SAVED')?.count).toBe(1);
  });

  it('builds a behavioural profile from real jobs and their enrichment', async () => {
    for (const jobId of jobIds.slice(0, 14)) await save(jobId);
    for (const jobId of jobIds.slice(14)) await dismiss(jobId);

    const result = await service.updateBehavioralProfile(profileId);

    expect(result.eventsProcessed).toBe(26);
    expect(result.profile.hasSufficientData).toBe(true);
    expect(result.affinities).toBeGreaterThan(0);

    const affinities = await learning.listAffinities(profileId);
    const react = affinities.find((a) => a.dimension === 'technology' && a.value === 'react');
    const go = affinities.find((a) => a.dimension === 'technology' && a.value === 'go');

    expect(react?.affinity).toBeGreaterThan(0);
    expect(go?.affinity).toBeLessThan(0);
  });

  it('does not reprocess events on a second pass', async () => {
    for (const jobId of jobIds.slice(0, 10)) await save(jobId);

    const first = await service.updateBehavioralProfile(profileId);
    const second = await service.updateBehavioralProfile(profileId);

    expect(first.eventsProcessed).toBe(10);
    expect(second.eventsProcessed).toBe(0);
  });

  it('boosts a job like the ones saved and lowers one like those dismissed', async () => {
    for (const jobId of jobIds.slice(0, 14)) await save(jobId);
    for (const jobId of jobIds.slice(14)) await dismiss(jobId);
    await service.updateBehavioralProfile(profileId);

    const scores = await service.scoreJobs(profileId, [
      {
        jobId: REACT_LIKE,
        attributes: {
          jobId: REACT_LIKE,
          title: 'Senior Frontend Engineer',
          companyName: 'Northwind',
          countryCode: 'DE',
          city: 'Berlin',
          remoteType: 'remote',
          employmentTypes: [],
          seniority: 'senior',
          technologies: ['React', 'TypeScript'],
          industries: [],
          salaryAnnualUsd: 95_000,
          sourceId: 'greenhouse',
          companySize: null,
        },
      },
      {
        jobId: BACKEND_LIKE,
        attributes: {
          jobId: BACKEND_LIKE,
          title: 'Senior Backend Engineer',
          companyName: 'Helios',
          countryCode: 'DE',
          city: 'Berlin',
          remoteType: 'onsite',
          employmentTypes: [],
          seniority: 'senior',
          technologies: ['Go', 'Postgres'],
          industries: [],
          salaryAnnualUsd: 45_000,
          sourceId: 'greenhouse',
          companySize: null,
        },
      },
    ]);

    const boosted = scores.get(REACT_LIKE)!;
    const lowered = scores.get(BACKEND_LIKE)!;

    expect(boosted.adjustment).toBeGreaterThan(lowered.adjustment);
    expect(boosted.explanation.length).toBeGreaterThan(0);
    expect(boosted.authorityTrace[0]?.layer).toBe('explicit_hard_constraint');
  });

  it('generates a suggestion without touching preferences', async () => {
    for (const jobId of jobIds.slice(0, 14)) await save(jobId);
    for (const jobId of jobIds.slice(14)) await dismiss(jobId);
    await service.updateBehavioralProfile(profileId);

    const before = await candidates.getActivePreferences(profileId);
    const suggestions = await service.generatePreferenceSuggestions(profileId);
    const after = await candidates.getActivePreferences(profileId);

    expect(suggestions.length).toBeGreaterThan(0);
    // The preference version did not change: nothing was written.
    expect(after!.version).toBe(before!.version);
    expect(after!.preferences.workArrangement).toBe('ONSITE_PREFERRED');

    const stored = await learning.listSuggestions(profileId);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((row) => row.status === 'pending')).toBe(true);
  });

  it('records a declined suggestion and never re-offers it', async () => {
    for (const jobId of jobIds.slice(0, 14)) await save(jobId);
    for (const jobId of jobIds.slice(14)) await dismiss(jobId);
    await service.updateBehavioralProfile(profileId);

    const [suggestion] = await service.generatePreferenceSuggestions(profileId);
    expect(suggestion).toBeDefined();

    await service.recordSuggestionResponse(suggestion!.id, 'declined');

    const declined = await learning.declinedPaths(profileId);
    expect(declined).toContain(suggestion!.path);

    const again = await service.generatePreferenceSuggestions(profileId);
    expect(again.some((s) => s.path === suggestion!.path)).toBe(false);
  });

  it('freezes learning without discarding what was learned', async () => {
    for (const jobId of jobIds.slice(0, 14)) await save(jobId);
    await service.updateBehavioralProfile(profileId);

    const before = await learning.listAffinities(profileId);
    expect(before.length).toBeGreaterThan(0);

    await service.updateConfig(profileId, { frozen: true });

    for (const jobId of jobIds.slice(14)) await dismiss(jobId);
    const result = await service.updateBehavioralProfile(profileId);

    expect(result.eventsProcessed).toBe(0);

    const after = await learning.listAffinities(profileId);
    // Same affinities: frozen means "stop changing", not "forget".
    expect(after.length).toBe(before.length);
    expect(after.find((a) => a.value === 'go')).toBeUndefined();
  });

  it('stops applying adjustments when personalization is disabled', async () => {
    for (const jobId of jobIds.slice(0, 14)) await save(jobId);
    await service.updateBehavioralProfile(profileId);
    await service.updateConfig(profileId, { enabled: false });

    const scores = await service.scoreJobs(profileId, [
      {
        jobId: ANY_JOB,
        attributes: {
          jobId: ANY_JOB,
          title: 'Senior Frontend Engineer',
          companyName: 'Northwind',
          countryCode: 'DE',
          city: 'Berlin',
          remoteType: 'remote',
          employmentTypes: [],
          seniority: 'senior',
          technologies: ['React'],
          industries: [],
          salaryAnnualUsd: 95_000,
          sourceId: 'greenhouse',
          companySize: null,
        },
      },
    ]);

    const adjustment = scores.get(ANY_JOB)!;
    expect(adjustment.adjustment).toBe(0);
    expect(adjustment.explanation).toContain('switched off');
  });

  it('resets learning by scope, leaving explicit preferences untouched', async () => {
    for (const jobId of jobIds.slice(0, 14)) await save(jobId);
    for (const jobId of jobIds.slice(14)) await dismiss(jobId);
    await service.updateBehavioralProfile(profileId);

    const beforePreferences = await candidates.getActivePreferences(profileId);
    const beforeAffinities = await learning.listAffinities(profileId);
    expect(beforeAffinities.some((a) => a.dimension === 'company')).toBe(true);
    expect(beforeAffinities.some((a) => a.dimension === 'technology')).toBe(true);

    await service.resetLearning(profileId, 'company');

    const afterAffinities = await learning.listAffinities(profileId);
    expect(afterAffinities.some((a) => a.dimension === 'company')).toBe(false);
    // Only companies went; technologies are untouched.
    expect(afterAffinities.some((a) => a.dimension === 'technology')).toBe(true);

    const afterPreferences = await candidates.getActivePreferences(profileId);
    expect(afterPreferences!.version).toBe(beforePreferences!.version);
  });

  it('deletes behavioural history while keeping explicit preferences', async () => {
    for (const jobId of jobIds.slice(0, 14)) await save(jobId);
    await service.updateBehavioralProfile(profileId);

    const removed = await service.deleteHistory(profileId);
    expect(removed.events).toBeGreaterThan(0);
    expect(removed.affinities).toBeGreaterThan(0);

    expect(await learning.listAffinities(profileId)).toHaveLength(0);
    expect(await learning.getProfile(profileId)).toBeNull();

    const preferences = await candidates.getActivePreferences(profileId);
    expect(preferences?.preferences.workArrangement).toBe('ONSITE_PREFERRED');
  });

  it('computes engagement analytics from stored events', async () => {
    for (const [index, jobId] of jobIds.slice(0, 10).entries()) {
      await service.recordEvent({
        candidateId: profileId,
        jobId,
        eventType: 'JOB_VIEWED',
        context: 'RECOMMENDATIONS',
        shownAtRank: index + 1,
        occurredAt: now,
      });
    }
    for (const [index, jobId] of jobIds.slice(0, 3).entries()) {
      await service.recordEvent({
        candidateId: profileId,
        jobId,
        eventType: 'JOB_SAVED',
        context: 'RECOMMENDATIONS',
        shownAtRank: index + 1,
        occurredAt: now,
      });
    }

    const { metrics, quality } = await service.computeAnalytics(profileId);

    expect(metrics.jobsViewed).toBe(10);
    expect(metrics.jobsSaved).toBe(3);
    expect(quality).toHaveLength(3);
    expect(quality.some((entry) => entry.saveAtK > 0)).toBe(true);

    const stored = await learning.latestEngagement(profileId);
    expect(stored).not.toBeNull();
  });

  it('learns which sources the candidate actually values', async () => {
    for (const jobId of jobIds.slice(0, 14)) await save(jobId);
    const result = await service.updatePerformance(profileId);

    expect(result.sources).toBeGreaterThan(0);

    const values = await learning.listSourceUserValue(profileId);
    expect(values[0]?.sourceId).toBe('greenhouse');
    expect(values[0]?.userValueScore).toBeGreaterThan(0);
  });

  it('starts cold and says so', async () => {
    await save(jobIds[0]!);
    const result = await service.updateBehavioralProfile(profileId);

    expect(result.profile.hasSufficientData).toBe(false);
    expect(result.profile.coldStartReason).toContain('explicit preferences');

    const scores = await service.scoreJobs(profileId, [
      {
        jobId: COLD_JOB,
        attributes: {
          jobId: COLD_JOB,
          title: 'Senior Frontend Engineer',
          companyName: 'Northwind',
          countryCode: 'DE',
          city: 'Berlin',
          remoteType: 'remote',
          employmentTypes: [],
          seniority: 'senior',
          technologies: ['React'],
          industries: [],
          salaryAnnualUsd: 95_000,
          sourceId: 'greenhouse',
          companySize: null,
        },
      },
    ]);

    expect(scores.get(COLD_JOB)!.adjustment).toBe(0);
  });
});
