import { describe, expect, it } from 'vitest';
import { candidatePreferencesSchema, type CandidatePreferences } from '@job-intel/contracts';
import { canAttempt, cooldownFor, recordOutcome, type BreakerState } from '@job-intel/core';
import { planQueries, prioritiseByHistory } from './strategy/query-planner';
import { DiscoveryBudgetTracker } from './framework/budget';
import { decideSchedule, orderByValue, scoreSourceValue } from './framework/adaptive-scheduler';
import { buildCoverage, detectGaps } from './framework/coverage';

/**
 * Discovery framework behaviour.
 *
 * The properties under test are the ones the brief is most specific about:
 * queries come from structured preferences rather than hardcoded strings,
 * generation is bounded, budgets refuse before they overspend, a failing source
 * is backed off, and coverage is measured rather than claimed.
 */

const preferences = (overrides: Partial<CandidatePreferences> = {}): CandidatePreferences =>
  candidatePreferencesSchema.parse({
    titles: [
      { value: 'Frontend Engineer', strength: 'required' },
      { value: 'React Developer', strength: 'preferred' },
    ],
    countries: [
      { value: 'DE', strength: 'strongly_preferred' },
      { value: 'NL', strength: 'preferred' },
    ],
    technologies: [
      { value: 'React', strength: 'strongly_preferred' },
      { value: 'TypeScript', strength: 'preferred' },
    ],
    seniorityLevels: ['senior'],
    workArrangement: 'REMOTE_PREFERRED',
    ...overrides,
  });

describe('query planning', () => {
  it('generates queries from structured preferences, not hardcoded strings', () => {
    const plan = planQueries({ profileId: 'p1', preferences: preferences() });

    expect(plan.queries.length).toBeGreaterThan(0);

    // The candidate's own words appear; nothing else was invented.
    const text = plan.queries.map((query) => query.text).join(' ');
    expect(text).toContain('Frontend Engineer');
    expect(text).toMatch(/Germany|Berlin|Munich/);
    expect(text).toContain('React');

    // Every query carries the structured terms it was built from, so a
    // provider with real filters need not re-parse the string.
    for (const query of plan.queries) {
      expect(query.terms).toBeDefined();
      expect(query.rationale.length).toBeGreaterThan(0);
    }
  });

  it('changes when preferences change', () => {
    const before = planQueries({ profileId: 'p1', preferences: preferences() });
    const after = planQueries({
      profileId: 'p1',
      preferences: preferences({
        titles: [{ value: 'Data Engineer', strength: 'required', hard: false, note: null, source: 'explicit' }],
        countries: [{ value: 'PT', strength: 'required', hard: false, note: null, source: 'explicit' }],
      }),
    });

    const beforeText = before.queries.map((query) => query.text).join(' ');
    const afterText = after.queries.map((query) => query.text).join(' ');

    expect(afterText).toContain('Data Engineer');
    expect(afterText).toMatch(/Portugal|Lisbon/);
    expect(afterText).not.toContain('Frontend Engineer');
    expect(beforeText).not.toContain('Data Engineer');
  });

  it('expands location codes into the wordings boards actually use', () => {
    const plan = planQueries({ profileId: 'p1', preferences: preferences() });
    const locations = new Set(
      plan.queries.map((query) => query.terms.location).filter((value): value is string => Boolean(value)),
    );

    // "DE" alone finds almost nothing on a job board.
    expect([...locations].some((value) => /Germany|Berlin|Munich/.test(value))).toBe(true);
  });

  it('assigns priority by kind, and scores within a tier by preference strength', () => {
    const plan = planQueries({ profileId: 'p1', preferences: preferences() });

    const high = plan.queries.filter((query) => query.priority === 'HIGH');
    const low = plan.queries.filter((query) => query.priority === 'LOW');

    expect(high.length).toBeGreaterThan(0);
    expect(high.every((query) => query.terms.title !== null)).toBe(true);
    expect(low.every((query) => query.score <= Math.max(...high.map((q) => q.score)))).toBe(true);

    // `required` title outranks `preferred` within HIGH.
    const required = high.filter((query) => query.terms.title === 'Frontend Engineer');
    const preferred = high.filter((query) => query.terms.title === 'React Developer');
    if (required.length > 0 && preferred.length > 0) {
      expect(Math.max(...required.map((q) => q.score))).toBeGreaterThan(
        Math.max(...preferred.map((q) => q.score)),
      );
    }
  });

  it('never exceeds the query budget, and reports what it dropped', () => {
    const plan = planQueries({
      profileId: 'p1',
      preferences: preferences({
        titles: Array.from({ length: 10 }, (_, i) => ({
          value: `Engineer ${i}`,
          strength: 'preferred' as const,
          hard: false,
          note: null,
          source: 'explicit' as const,
        })),
        technologies: Array.from({ length: 10 }, (_, i) => ({
          value: `Tech${i}`,
          strength: 'preferred' as const,
          hard: false,
          note: null,
          source: 'explicit' as const,
        })),
      }),
      config: { maxQueries: 12 },
    });

    expect(plan.queries.length).toBeLessThanOrEqual(12);
    expect(plan.droppedCount).toBeGreaterThan(0);
    expect(plan.dropReasons.length).toBeGreaterThan(0);
  });

  it('deduplicates semantically identical queries', () => {
    const plan = planQueries({ profileId: 'p1', preferences: preferences() });
    const ids = plan.queries.map((query) => query.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('supports domain-restricted discovery', () => {
    const plan = planQueries({
      profileId: 'p1',
      preferences: preferences(),
      targetDomains: ['boards.greenhouse.io'],
    });

    const restricted = plan.queries.filter((query) => query.terms.site !== null);
    expect(restricted.length).toBeGreaterThan(0);
    expect(restricted[0]?.text).toContain('site:boards.greenhouse.io');
    expect(restricted[0]?.kind).toBe('domain_restricted');
  });

  it('emits no remote queries when the candidate will not work remotely', () => {
    const plan = planQueries({
      profileId: 'p1',
      preferences: preferences({ workArrangement: 'ONSITE_PREFERRED' }),
    });
    expect(plan.queries.every((query) => query.terms.remoteOnly === false)).toBe(true);
  });

  it('tilts toward historically productive queries without overriding preferences', () => {
    const plan = planQueries({ profileId: 'p1', preferences: preferences() });
    const target = plan.queries.find((query) => query.priority === 'MEDIUM') ?? plan.queries[0]!;

    const boosted = prioritiseByHistory(
      plan,
      new Map([[target.id, { matchedJobs: 8, discoveredJobs: 10 }]]),
    );

    const after = boosted.queries.find((query) => query.id === target.id)!;
    expect(after.score).toBeGreaterThanOrEqual(target.score);
    expect(after.rationale).toContain('previously produced');
    // History tilts within a tier; it never promotes a LOW query above HIGH.
    expect(after.priority).toBe(target.priority);
  });

  it('produces an empty plan for an empty profile rather than inventing one', () => {
    const plan = planQueries({ profileId: 'p1', preferences: candidatePreferencesSchema.parse({}) });
    expect(plan.queries).toHaveLength(0);
  });
});

describe('discovery budget', () => {
  it('refuses a spend that would exceed the cycle limit', () => {
    const tracker = new DiscoveryBudgetTracker({ maxSearchApiCalls: 2 });

    expect(tracker.spend('searchApiCalls').allowed).toBe(true);
    expect(tracker.spend('searchApiCalls').allowed).toBe(true);

    const third = tracker.spend('searchApiCalls');
    expect(third.allowed).toBe(false);
    expect(third.reason).toContain('exhausted');
  });

  it('enforces a per-source request cap independently of the cycle cap', () => {
    const tracker = new DiscoveryBudgetTracker({
      maxRequestsPerSource: 2,
      maxRequestsPerCycle: 100,
    });

    tracker.spend('requests', 1, 'source-a');
    tracker.spend('requests', 1, 'source-a');
    expect(tracker.spend('requests', 1, 'source-a').allowed).toBe(false);

    // A different source still has its own allowance.
    expect(tracker.spend('requests', 1, 'source-b').allowed).toBe(true);
  });

  it('records every refusal so a thin run can be explained', () => {
    const tracker = new DiscoveryBudgetTracker({ maxClassificationCalls: 0 });
    tracker.spend('classificationCalls');

    const snapshot = tracker.snapshot();
    expect(snapshot.refusals).toHaveLength(1);
    expect(snapshot.refusals[0]?.key).toBe('classificationCalls');
    expect(snapshot.exhausted).toContain('classificationCalls');
  });

  it('checks without spending', () => {
    const tracker = new DiscoveryBudgetTracker({ maxPageFetches: 1 });
    expect(tracker.check('pageFetches').allowed).toBe(true);
    expect(tracker.check('pageFetches').allowed).toBe(true);
    expect(tracker.snapshot().usage.pageFetches).toBe(0);
  });
});

describe('circuit breaker', () => {
  const policy = { threshold: 3, cooldownSeconds: 60 };
  const closed: BreakerState = {
    circuitState: 'closed',
    consecutiveFailures: 0,
    circuitOpenedAt: null,
  };

  it('opens only after the threshold is reached', () => {
    let state = closed;
    for (let i = 0; i < 2; i += 1) {
      state = recordOutcome(state, 'failed', policy).next;
      expect(state.circuitState).toBe('closed');
    }

    const decision = recordOutcome(state, 'failed', policy);
    expect(decision.next.circuitState).toBe('open');
    expect(decision.changed).toBe(true);
    expect(decision.reason).toContain('threshold');
  });

  it('blocks attempts while open, then permits one probe after the cooldown', () => {
    const openedAt = new Date('2026-08-19T10:00:00Z');
    const state = { circuitState: 'open' as const, consecutiveFailures: 3, circuitOpenedAt: openedAt };

    const during = canAttempt(state, policy, new Date('2026-08-19T10:00:30Z'));
    expect(during.allowed).toBe(false);
    expect(during.reason).toContain('retrying in');

    const after = canAttempt(state, policy, new Date('2026-08-19T10:02:00Z'));
    expect(after.allowed).toBe(true);
    expect(after.state).toBe('half_open');
  });

  it('closes on a successful probe and re-opens on a failed one', () => {
    const halfOpen = {
      circuitState: 'half_open' as const,
      consecutiveFailures: 3,
      circuitOpenedAt: new Date(),
    };

    const recovered = recordOutcome(halfOpen, 'success', policy);
    expect(recovered.next.circuitState).toBe('closed');
    expect(recovered.next.consecutiveFailures).toBe(0);

    const relapsed = recordOutcome(halfOpen, 'failed', policy);
    expect(relapsed.next.circuitState).toBe('open');
    expect(relapsed.next.consecutiveFailures).toBe(4);
  });

  it('treats a partial run as healthy — the source answered', () => {
    const state = { circuitState: 'open' as const, consecutiveFailures: 5, circuitOpenedAt: new Date() };
    expect(recordOutcome(state, 'partial', policy).next.circuitState).toBe('closed');
  });

  it('leaves the breaker untouched for a skipped run', () => {
    const state = { circuitState: 'closed' as const, consecutiveFailures: 2, circuitOpenedAt: null };
    const decision = recordOutcome(state, 'skipped', policy);
    expect(decision.next).toBe(state);
    expect(decision.changed).toBe(false);
  });

  it('lengthens the cooldown as failures accumulate, up to a cap', () => {
    const short = cooldownFor({ ...closed, consecutiveFailures: 3 }, policy);
    const long = cooldownFor({ ...closed, consecutiveFailures: 6 }, policy);
    const capped = cooldownFor({ ...closed, consecutiveFailures: 50 }, policy);

    expect(long).toBeGreaterThan(short);
    expect(capped).toBeLessThanOrEqual(6 * 3_600);
  });
});

describe('source value and adaptive scheduling', () => {
  const baseInputs = {
    sourceId: 's1',
    windowDays: 30,
    runs: 20,
    jobsDiscovered: 400,
    duplicates: 40,
    validJobs: 360,
    enrichmentSucceeded: 350,
    matchedJobs: 60,
    staleJobs: 10,
    failedRuns: 0,
    totalLatencyMs: 40_000,
  };

  it('ranks a redundant high-volume source below a productive low-volume one', () => {
    const redundant = scoreSourceValue({
      ...baseInputs,
      jobsDiscovered: 2_000,
      duplicates: 1_950,
      matchedJobs: 2,
      validJobs: 1_990,
    });
    const productive = scoreSourceValue({
      ...baseInputs,
      jobsDiscovered: 40,
      duplicates: 2,
      matchedJobs: 18,
      validJobs: 38,
    });

    // Volume alone would rank these the other way round.
    expect(productive.valueScore).toBeGreaterThan(redundant.valueScore);
  });

  it('reports zero runs as unknown rather than as worthless', () => {
    const unknown = scoreSourceValue({ ...baseInputs, runs: 0, jobsDiscovered: 0 });
    expect(unknown.explanation).toContain('unknown');
  });

  it('polls a high-value source more often than a low-value one', () => {
    const common = {
      enabled: true,
      breaker: { circuitState: 'closed' as const, consecutiveFailures: 0, circuitOpenedAt: null },
      circuitThreshold: 5,
      circuitCooldownSeconds: 900,
      lastRunAt: null,
      unchangedStreak: 0,
      priority: 2,
    };

    const high = decideSchedule({
      ...common,
      sourceId: 'high',
      performance: scoreSourceValue({ ...baseInputs, matchedJobs: 200, duplicates: 5 }),
    });
    const low = decideSchedule({
      ...common,
      sourceId: 'low',
      performance: scoreSourceValue({
        ...baseInputs,
        jobsDiscovered: 20,
        duplicates: 19,
        matchedJobs: 0,
        validJobs: 5,
        staleJobs: 15,
      }),
    });

    expect(high.intervalMinutes).toBeLessThan(low.intervalMinutes);
    expect(high.reason).toContain('high value');
  });

  it('stretches the interval for a feed that never changes', () => {
    const common = {
      sourceId: 's1',
      enabled: true,
      breaker: { circuitState: 'closed' as const, consecutiveFailures: 0, circuitOpenedAt: null },
      circuitThreshold: 5,
      circuitCooldownSeconds: 900,
      lastRunAt: null,
      performance: null,
      priority: 2,
    };

    const fresh = decideSchedule({ ...common, unchangedStreak: 0 }, { jitterPercent: 0 });
    const stale = decideSchedule({ ...common, unchangedStreak: 8 }, { jitterPercent: 0 });

    expect(stale.intervalMinutes).toBeGreaterThan(fresh.intervalMinutes);
    expect(stale.reason).toContain('unchanged');
  });

  it('suppresses a source whose circuit is open', () => {
    const decision = decideSchedule({
      sourceId: 's1',
      enabled: true,
      breaker: {
        circuitState: 'open',
        consecutiveFailures: 5,
        circuitOpenedAt: new Date(),
      },
      circuitThreshold: 5,
      circuitCooldownSeconds: 900,
      lastRunAt: null,
      unchangedStreak: 0,
      performance: null,
      priority: 0,
    });

    expect(decision.suppressed).toBe(true);
    expect(decision.reason).toContain('circuit open');
  });

  it('backs off after failures that have not yet tripped the breaker', () => {
    const common = {
      sourceId: 's1',
      enabled: true,
      circuitThreshold: 10,
      circuitCooldownSeconds: 900,
      lastRunAt: null,
      unchangedStreak: 0,
      performance: null,
      priority: 1,
    };

    const healthy = decideSchedule(
      { ...common, breaker: { circuitState: 'closed', consecutiveFailures: 0, circuitOpenedAt: null } },
      { jitterPercent: 0 },
    );
    const struggling = decideSchedule(
      { ...common, breaker: { circuitState: 'closed', consecutiveFailures: 3, circuitOpenedAt: null } },
      { jitterPercent: 0 },
    );

    expect(struggling.intervalMinutes).toBeGreaterThan(healthy.intervalMinutes);
  });

  it('orders execution by value, breaking ties on staleness', () => {
    const now = new Date('2026-08-19T12:00:00Z');
    const order = orderByValue(
      [
        { sourceId: 'low', performance: { valueScore: 10 } as never, lastRunAt: now },
        { sourceId: 'high', performance: { valueScore: 90 } as never, lastRunAt: now },
        {
          sourceId: 'stale-mid',
          performance: { valueScore: 50 } as never,
          lastRunAt: new Date('2026-08-01T00:00:00Z'),
        },
      ],
      now,
    );

    expect(order).toEqual(['high', 'stale-mid', 'low']);
  });
});

describe('coverage', () => {
  const plan = planQueries({ profileId: 'p1', preferences: preferences() });

  it('reports what was searched rather than claiming the internet', () => {
    const executed = new Map(
      plan.queries.slice(0, 3).map((query) => [
        query.id,
        { discovered: 5, matched: 2, sourcesSearched: 2, at: new Date() },
      ]),
    );

    const report = buildCoverage({
      profileId: 'p1',
      preferences: preferences(),
      plan,
      windowHours: 24,
      observation: { executedQueries: executed, sourcesAvailable: 9, sourcesProductive: 4 },
    });

    expect(report.queriesExecuted).toBe(3);
    expect(report.sourcesSearched).toBe(4);
    expect(report.sourcesAvailable).toBe(9);
    expect(report.searchedShare).toBeGreaterThan(0);
    expect(report.searchedShare).toBeLessThanOrEqual(1);
    expect(report.items.length).toBeGreaterThan(0);
  });

  it('separates "never looked" from "looked and found nothing"', () => {
    const executed = new Map(
      plan.queries.map((query) => [
        query.id,
        { discovered: 0, matched: 0, sourcesSearched: 3, at: new Date() },
      ]),
    );

    const report = buildCoverage({
      profileId: 'p1',
      preferences: preferences(),
      plan,
      windowHours: 24,
      observation: { executedQueries: executed, sourcesAvailable: 5, sourcesProductive: 0 },
    });

    // Everything was searched, so nothing is NEVER_SEARCHED — the gaps are
    // about what the market returned, which is a different problem.
    expect(report.gaps.some((gap) => gap.kind === 'LOW_DISCOVERY_COVERAGE')).toBe(true);
    expect(report.gaps.every((gap) => gap.kind !== 'NEVER_SEARCHED')).toBe(true);
  });

  it('flags a preference no query covered', () => {
    const report = buildCoverage({
      profileId: 'p1',
      preferences: preferences({
        cities: [{ value: 'Reykjavik', strength: 'required', hard: false, note: null, source: 'explicit' }],
      }),
      // A plan that predates the new preference.
      plan,
      windowHours: 24,
      observation: { executedQueries: new Map(), sourcesAvailable: 5, sourcesProductive: 0 },
    });

    const gap = report.gaps.find((entry) => entry.value === 'Reykjavik');
    expect(gap?.kind).toBe('NEVER_SEARCHED');
    expect(gap?.severity).toBe('high');
  });

  it('ranks gaps by the candidate’s own preference strength', () => {
    const gaps = detectGaps(
      [
        {
          dimension: 'title',
          value: 'Weakly wanted',
          weight: 0.25,
          queriesPlanned: 0,
          queriesExecuted: 0,
          sourcesSearched: 0,
          jobsDiscovered: 0,
          jobsMatched: 0,
          lastSearchedAt: null,
        },
        {
          dimension: 'title',
          value: 'Required role',
          weight: 1,
          queriesPlanned: 0,
          queriesExecuted: 0,
          sourcesSearched: 0,
          jobsDiscovered: 0,
          jobsMatched: 0,
          lastSearchedAt: null,
        },
      ],
      { executedQueries: new Map(), sourcesAvailable: 1, sourcesProductive: 0 },
      24,
    );

    expect(gaps[0]?.value).toBe('Required role');
    expect(gaps[0]?.severity).toBe('high');
  });

  it('reports a capability gap as its own kind', () => {
    const report = buildCoverage({
      profileId: 'p1',
      preferences: preferences(),
      plan,
      windowHours: 24,
      observation: {
        executedQueries: new Map(),
        sourcesAvailable: 3,
        sourcesProductive: 0,
        uncoveredByCapability: [
          { dimension: 'location', value: 'NG', detail: 'No enabled source covers Nigeria' },
        ],
      },
    });

    const gap = report.gaps.find((entry) => entry.kind === 'NO_CAPABLE_SOURCE');
    expect(gap?.severity).toBe('high');
    expect(gap?.suggestion).toContain('Add a source');
  });
});
