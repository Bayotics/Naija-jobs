import { describe, expect, it } from 'vitest';
import {
  behaviorEventSchema,
  candidatePreferencesSchema,
  type BehaviorEventInput,
  type BehaviorEventType,
  type EventContext,
} from '@job-intel/contracts';
import {
  buildBehavioralProfile,
  computeAffinities,
  computeBehavioralAdjustment,
  extractFeatures,
  generateSuggestions,
  mergeAffinities,
  selectExploration,
  type AffinityEventInput,
  type JobAttributes,
} from './index';

/**
 * Simulated candidate history, and the end-to-end scenario.
 *
 * A hundred and forty interactions over four months, with deliberate structure:
 * a strong pattern, a weak one, a stale one, and a contradiction with an
 * explicit preference. Every assertion below is about whether the learning
 * engine can tell those four apart — which is the actual job, and which a
 * simpler "count the clicks" implementation would fail.
 */

const CANDIDATE = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-19T12:00:00Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

let counter = 0;
const nextJobId = (): string =>
  `44444444-4444-4444-8444-${String(++counter).padStart(12, '0')}`;

function makeJob(over: Partial<JobAttributes> = {}): JobAttributes {
  return {
    jobId: nextJobId(),
    title: 'Senior Frontend Engineer',
    companyName: 'Northwind',
    countryCode: 'DE',
    city: 'Berlin',
    remoteType: 'remote',
    employmentTypes: ['full_time'],
    seniority: 'senior',
    technologies: ['React', 'TypeScript'],
    industries: ['fintech'],
    salaryAnnualUsd: 95_000,
    sourceId: 'greenhouse',
    companySize: null,
    ...over,
  };
}

function makeInteraction(
  eventType: BehaviorEventType,
  attributes: JobAttributes,
  occurredAt: Date,
  over: Partial<BehaviorEventInput> = {},
): AffinityEventInput {
  return {
    event: behaviorEventSchema.parse({
      eventId: crypto.randomUUID(),
      candidateId: CANDIDATE,
      jobId: attributes.jobId,
      eventType,
      occurredAt,
      context: 'RECOMMENDATIONS' as EventContext,
      ...over,
    }),
    features: extractFeatures(attributes),
  };
}

/**
 * The history.
 *
 * Four deliberate patterns:
 *  - **Strong and current:** React saves and applications, throughout.
 *  - **Weak:** a couple of Rust clicks. Should stay uncertain.
 *  - **Stale:** heavy healthcare engagement four months ago, none since.
 *  - **Contradictory:** consistent remote engagement against an explicit
 *    onsite preference.
 */
function buildHistory(): AffinityEventInput[] {
  const history: AffinityEventInput[] = [];

  // ── Strong, current: React / TypeScript / Berlin ───────────────────────
  for (let i = 0; i < 30; i += 1) {
    history.push(
      makeInteraction('JOB_VIEWED', makeJob(), daysAgo(i % 30)),
    );
  }
  for (let i = 0; i < 18; i += 1) {
    history.push(makeInteraction('JOB_SAVED', makeJob(), daysAgo(i % 25)));
  }
  for (let i = 0; i < 5; i += 1) {
    history.push(makeInteraction('JOB_APPLIED', makeJob(), daysAgo(i * 3)));
  }

  // ── Consistently passed over: backend / Go ─────────────────────────────
  for (let i = 0; i < 22; i += 1) {
    history.push(
      makeInteraction(
        'JOB_DISMISSED',
        makeJob({
          title: 'Senior Backend Engineer',
          technologies: ['Go', 'Postgres'],
          companyName: 'Helios',
          industries: ['logistics'],
        }),
        daysAgo(i % 28),
      ),
    );
  }

  // ── Weak: two Rust clicks. Must remain uncertain. ─────────────────────
  for (let i = 0; i < 2; i += 1) {
    history.push(
      makeInteraction('JOB_CLICKED', makeJob({ technologies: ['Rust'] }), daysAgo(i * 5)),
    );
  }

  // ── Stale: healthcare, four months ago, nothing since ─────────────────
  for (let i = 0; i < 20; i += 1) {
    history.push(
      makeInteraction(
        'JOB_SAVED',
        makeJob({ industries: ['healthcare'], companyName: 'Medica' }),
        daysAgo(115 + (i % 15)),
      ),
    );
  }

  // ── Contradictory: remote engagement against an onsite preference ─────
  for (let i = 0; i < 24; i += 1) {
    history.push(
      makeInteraction(
        'JOB_SAVED',
        makeJob({ remoteType: 'remote', companyName: `Remote Co ${i % 6}` }),
        daysAgo(i % 20),
      ),
    );
  }
  for (let i = 0; i < 16; i += 1) {
    history.push(
      makeInteraction(
        'JOB_DISMISSED',
        makeJob({ remoteType: 'onsite', city: 'Frankfurt', companyName: `Onsite Co ${i % 5}` }),
        daysAgo(i % 20),
      ),
    );
  }

  return history;
}

const explicit = candidatePreferencesSchema.parse({
  titles: [{ value: 'Frontend Engineer', strength: 'required' }],
  technologies: [
    { value: 'React', strength: 'strongly_preferred' },
    { value: 'PHP', strength: 'excluded' },
  ],
  countries: [{ value: 'DE', strength: 'strongly_preferred' }],
  // Deliberately contradicts the behaviour: they said onsite, they act remote.
  workArrangement: 'ONSITE_PREFERRED',
});

describe('simulated candidate history', () => {
  const history = buildHistory();
  const affinities = computeAffinities(history, { preferences: explicit, now: NOW });
  const profile = buildBehavioralProfile(CANDIDATE, history, {
    preferences: explicit,
    now: NOW,
  });

  it('processes a realistic history', () => {
    expect(history.length).toBeGreaterThanOrEqual(100);
    expect(profile.totalEvents).toBe(history.length);
    expect(profile.hasSufficientData).toBe(true);
    expect(affinities.length).toBeGreaterThan(10);
  });

  it('turns a strong repeated pattern into a strong, confident signal', () => {
    const react = affinities.find((a) => a.dimension === 'technology' && a.value === 'react')!;

    expect(react.affinity).toBeGreaterThan(0.3);
    expect(react.confidence).toBeGreaterThan(0.7);
    expect(react.sampleSize).toBeGreaterThan(50);
  });

  it('leaves a weak pattern uncertain rather than promoting it', () => {
    const rust = affinities.find((a) => a.dimension === 'technology' && a.value === 'rust');
    const react = affinities.find((a) => a.dimension === 'technology' && a.value === 'react')!;

    // Two clicks may register, but must not look like knowledge.
    if (rust) {
      expect(rust.confidence).toBeLessThan(0.35);
      expect(rust.confidence).toBeLessThan(react.confidence / 2);
    }
  });

  it('decays a stale pattern below a current one of similar size', () => {
    const healthcare = affinities.find((a) => a.dimension === 'industry' && a.value === 'healthcare');
    const fintech = affinities.find((a) => a.dimension === 'industry' && a.value === 'fintech')!;

    // Twenty stale saves must not outweigh current engagement.
    expect(fintech.confidence).toBeGreaterThan(healthcare?.confidence ?? 0);
    if (healthcare) expect(healthcare.evidence).toBeLessThan(fintech.evidence);
  });

  it('learns a clear negative from consistent dismissals', () => {
    const go = affinities.find((a) => a.dimension === 'technology' && a.value === 'go')!;
    expect(go.affinity).toBeLessThan(-0.3);
    expect(go.confidence).toBeGreaterThan(0.6);
  });

  it('flags the contradiction with the explicit preference, and never applies it', () => {
    const remote = affinities.find(
      (a) => a.dimension === 'work_arrangement' && a.value === 'remote',
    )!;

    expect(remote.affinity).toBeGreaterThan(0.3);
    expect(remote.conflictsWithExplicit).toBe(true);

    // And the explicit preference object is untouched.
    expect(explicit.workArrangement).toBe('ONSITE_PREFERRED');
  });

  it('offers the contradiction as a suggestion the candidate can decline', () => {
    const suggestions = generateSuggestions({
      candidateId: CANDIDATE,
      preferences: explicit,
      affinities,
      now: NOW,
    });

    const workArrangement = suggestions.find((s) => s.path === 'workArrangement');
    expect(workArrangement).toBeDefined();
    expect(workArrangement!.status).toBe('pending');
    expect(workArrangement!.message).toContain('Would you like');
    expect(workArrangement!.evidence.supporting).toBeGreaterThan(5);
  });

  it('keeps exploration active even with a well-formed profile', () => {
    const candidates = Array.from({ length: 30 }, (_, index) => ({
      jobId: nextJobId(),
      rank: index + 1,
      score: 100 - index,
      features: extractFeatures(
        makeJob({
          companyName: `Novel Co ${index}`,
          technologies: [`Novel${index}`],
          city: `Novel City ${index}`,
          industries: [`novel-industry-${index}`],
          title: `Novel Role ${index}`,
        }),
      ),
      eligible: true,
    }));

    const exploration = selectExploration(candidates, affinities, { resultSize: 20 });
    expect(exploration.slots).toBeGreaterThan(0);
    expect(exploration.selected.length).toBeGreaterThan(0);
  });

  it('produces the same result when replayed — the algorithm is deterministic', () => {
    const again = computeAffinities(history, { preferences: explicit, now: NOW });
    expect(again).toEqual(affinities);
  });
});

// ── The Part 45 scenario, step by step ──────────────────────────────────────

describe('end-to-end learning scenario', () => {
  it('walks the twelve steps the brief specifies', () => {
    // 1. The candidate explicitly wants frontend roles.
    const preferences = candidatePreferencesSchema.parse({
      titles: [{ value: 'Frontend Engineer', strength: 'required' }],
      technologies: [{ value: 'React', strength: 'preferred' }],
      workArrangement: 'HYBRID_ACCEPTED',
    });
    const preferencesBefore = JSON.stringify(preferences);

    // 2–5. They save React roles, ignore backend roles, apply to two remote
    //      React jobs.
    const history: AffinityEventInput[] = [
      ...Array.from({ length: 12 }, (_, i) =>
        makeInteraction('JOB_SAVED', makeJob(), daysAgo(i)),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        makeInteraction(
          'JOB_IGNORED',
          makeJob({
            title: 'Backend Engineer',
            technologies: ['Go'],
            companyName: 'Helios',
            industries: ['logistics'],
          }),
          daysAgo(i),
        ),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeInteraction('JOB_APPLIED', makeJob({ remoteType: 'remote' }), daysAgo(i)),
      ),
    ];

    // 6. The behavioural profile updates.
    const affinities = computeAffinities(history, { preferences, now: NOW });
    const profile = buildBehavioralProfile(CANDIDATE, history, { preferences, now: NOW });

    expect(profile.hasSufficientData).toBe(true);
    expect(affinities.length).toBeGreaterThan(0);

    // 7–8. New recommendations: React jobs receive a behavioural boost.
    const reactJob = makeJob();
    const reactAdjustment = computeBehavioralAdjustment({
      jobId: reactJob.jobId,
      features: extractFeatures(reactJob),
      affinities,
      preferences,
      hasSufficientData: true,
    });

    expect(reactAdjustment.adjustment).toBeGreaterThan(0);
    expect(reactAdjustment.explanation).toContain('higher');

    // 9. Backend jobs receive a behavioural reduction.
    const backendJob = makeJob({
      title: 'Backend Engineer',
      technologies: ['Go'],
      companyName: 'Helios',
      industries: ['logistics'],
    });
    const backendAdjustment = computeBehavioralAdjustment({
      jobId: backendJob.jobId,
      features: extractFeatures(backendJob),
      affinities,
      preferences,
      hasSufficientData: true,
    });

    expect(backendAdjustment.adjustment).toBeLessThan(reactAdjustment.adjustment);

    // 10. Explicit constraints remain unchanged — the whole point.
    expect(JSON.stringify(preferences)).toBe(preferencesBefore);

    // 11. Exploration still occurs.
    const pool = Array.from({ length: 30 }, (_, index) => ({
      jobId: nextJobId(),
      rank: index + 1,
      score: 100 - index,
      features: extractFeatures(
        makeJob({
          companyName: `Unfamiliar ${index}`,
          technologies: [`Unseen${index}`],
          city: `Elsewhere ${index}`,
          title: `Different Role ${index}`,
          industries: [`unseen-${index}`],
        }),
      ),
      eligible: true,
    }));

    const exploration = selectExploration(pool, affinities, { resultSize: 20 });
    expect(exploration.selected.length).toBeGreaterThan(0);

    // 12. And the system offers a preference suggestion rather than acting.
    const suggestions = generateSuggestions({
      candidateId: CANDIDATE,
      preferences,
      affinities,
      now: NOW,
    });

    expect(suggestions.every((suggestion) => suggestion.status === 'pending')).toBe(true);
    expect(JSON.stringify(preferences)).toBe(preferencesBefore);
  });
});

// ── Performance (Part 47) ───────────────────────────────────────────────────

describe('learning performance', () => {
  const historyOf = (count: number): AffinityEventInput[] =>
    Array.from({ length: count }, (_, index) =>
      makeInteraction(
        index % 3 === 0 ? 'JOB_SAVED' : index % 3 === 1 ? 'JOB_VIEWED' : 'JOB_DISMISSED',
        makeJob({
          companyName: `Company ${index % 60}`,
          technologies: [`Tech${index % 25}`, `Tech${(index + 7) % 25}`],
          city: `City ${index % 15}`,
          industries: [`Industry ${index % 10}`],
        }),
        daysAgo(index % 90),
      ),
    );

  it('handles 10 events instantly', () => {
    const startedAt = Date.now();
    const affinities = computeAffinities(historyOf(10), { now: NOW });
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(affinities.length).toBeGreaterThan(0);
  });

  it('handles 1,000 events well under a second', () => {
    const history = historyOf(1_000);
    const startedAt = Date.now();
    const affinities = computeAffinities(history, { now: NOW });
    const durationMs = Date.now() - startedAt;

    expect(durationMs).toBeLessThan(1_000);
    expect(affinities.length).toBeGreaterThan(50);
  });

  it('handles 100,000 events without collapsing', () => {
    const history = historyOf(100_000);

    const startedAt = Date.now();
    const affinities = computeAffinities(history, { now: NOW });
    const durationMs = Date.now() - startedAt;

    // Linear in events, bounded in memory by the distinct feature count rather
    // than by the event count — which is the property that makes this scale.
    expect(durationMs).toBeLessThan(20_000);
    expect(affinities.length).toBeLessThan(500);
  });

  it('merges incrementally without re-reading history', () => {
    // The shape that actually runs in production: one big historical profile,
    // then a small batch per queue message.
    let affinities = computeAffinities(historyOf(5_000), { now: NOW });
    const before = affinities.length;

    const startedAt = Date.now();
    for (let batch = 0; batch < 50; batch += 1) {
      affinities = mergeAffinities(affinities, historyOf(2), { now: NOW });
    }
    const durationMs = Date.now() - startedAt;

    // Fifty incremental merges must cost far less than one full recomputation.
    expect(durationMs).toBeLessThan(2_000);
    expect(affinities.length).toBeGreaterThanOrEqual(before - 10);
  });
});
