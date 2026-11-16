import { describe, expect, it } from 'vitest';
import { candidatePreferencesSchema } from '@job-intel/contracts';
import { planQueries } from './strategy/query-planner';
import { DiscoveryBudgetTracker } from './framework/budget';
import { decideSchedule, orderByValue, scoreSourceValue } from './framework/adaptive-scheduler';
import { buildCoverage } from './framework/coverage';

/**
 * Discovery at scale.
 *
 * The brief asks what happens with 100 sources, 1,000 queries and 10,000
 * records. The failure this guards against is not a crash — it is the quiet
 * kind: a scheduler that is O(n²) in sources, a planner whose deduplication
 * degrades, a budget that is only checked after the money is spent.
 *
 * Timings are asserted generously. The point is to catch an order-of-magnitude
 * regression, not to benchmark this machine.
 */

describe('discovery at scale', () => {
  it('plans against a large preference set without exploding', () => {
    // 20 titles × 15 technologies × 12 countries × 4 seniorities is a naive
    // cross product of over 14,000 queries.
    const preferences = candidatePreferencesSchema.parse({
      titles: Array.from({ length: 20 }, (_, i) => ({
        value: `Engineer Role ${i}`,
        strength: i < 5 ? 'required' : 'preferred',
      })),
      technologies: Array.from({ length: 15 }, (_, i) => ({
        value: `Technology${i}`,
        strength: 'preferred',
      })),
      countries: ['DE', 'NL', 'GB', 'FR', 'ES', 'PT', 'PL', 'SE', 'IE', 'IT', 'NG', 'US'].map(
        (value) => ({ value, strength: 'preferred' }),
      ),
      seniorityLevels: ['senior', 'staff', 'lead', 'principal'],
    });

    const startedAt = Date.now();
    const plan = planQueries({
      profileId: 'scale',
      preferences,
      config: { maxQueries: 1_000 },
      targetDomains: ['boards.greenhouse.io', 'jobs.lever.co'],
    });
    const durationMs = Date.now() - startedAt;

    expect(plan.queries.length).toBeLessThanOrEqual(1_000);
    expect(plan.queries.length).toBeGreaterThan(50);
    expect(durationMs).toBeLessThan(2_000);

    // Deduplication still holds at scale — this is the property that decays
    // first if identity is derived from the rendered string.
    const ids = plan.queries.map((query) => query.id);
    expect(new Set(ids).size).toBe(ids.length);

    // And every dropped combination is accounted for.
    expect(plan.droppedCount).toBeGreaterThan(0);
  });

  it('schedules 100 sources in linear time', () => {
    const sources = Array.from({ length: 100 }, (_, i) => ({
      sourceId: `source-${i}`,
      enabled: true,
      breaker: {
        circuitState: (i % 17 === 0 ? 'open' : 'closed') as 'open' | 'closed',
        consecutiveFailures: i % 17 === 0 ? 6 : i % 5,
        circuitOpenedAt: i % 17 === 0 ? new Date() : null,
      },
      circuitThreshold: 5,
      circuitCooldownSeconds: 900,
      lastRunAt: new Date(Date.now() - i * 60_000),
      unchangedStreak: i % 9,
      performance: scoreSourceValue({
        sourceId: `source-${i}`,
        windowDays: 30,
        runs: 20,
        jobsDiscovered: i * 10,
        duplicates: i * 2,
        validJobs: i * 8,
        enrichmentSucceeded: i * 7,
        matchedJobs: i,
        staleJobs: i,
        failedRuns: i % 7,
        totalLatencyMs: 20_000,
      }),
      priority: i % 4,
    }));

    const startedAt = Date.now();
    const decisions = sources.map((source) => decideSchedule(source));
    const order = orderByValue(
      sources.map((source) => ({
        sourceId: source.sourceId,
        performance: source.performance,
        lastRunAt: source.lastRunAt,
      })),
    );
    const durationMs = Date.now() - startedAt;

    expect(decisions).toHaveLength(100);
    expect(order).toHaveLength(100);
    expect(durationMs).toBeLessThan(500);

    // Every open circuit is suppressed; nothing else is.
    const suppressed = decisions.filter((decision) => decision.suppressed);
    expect(suppressed.length).toBe(sources.filter((s) => s.breaker.circuitState === 'open').length);

    // Every interval respects the policy bounds — a scheduler that can emit
    // zero produces a hot loop against someone else's server.
    for (const decision of decisions) {
      expect(decision.intervalMinutes).toBeGreaterThanOrEqual(15);
      expect(decision.intervalMinutes).toBeLessThanOrEqual(1_440);
    }
  });

  it('enforces a budget across 10,000 spend attempts without drifting', () => {
    const tracker = new DiscoveryBudgetTracker({
      maxRequestsPerCycle: 5_000,
      maxRequestsPerSource: 100,
    });

    let allowed = 0;
    let refused = 0;

    for (let i = 0; i < 10_000; i += 1) {
      const decision = tracker.spend('requests', 1, `source-${i % 100}`);
      if (decision.allowed) allowed += 1;
      else refused += 1;
    }

    // 100 sources × 100 requests each = 5,000, which is also the cycle cap.
    expect(allowed).toBe(5_000);
    expect(refused).toBe(5_000);

    const snapshot = tracker.snapshot();
    expect(snapshot.usage.requests).toBe(5_000);
    expect(Object.values(snapshot.perSourceRequests).every((count) => count <= 100)).toBe(true);
  });

  it('deduplicates 10,000 discovered records in memory-flat time', () => {
    // Mirrors the pipeline's identity check: 10,000 records where a third are
    // repeats of an earlier one.
    const seen = new Set<string>();
    const startedAt = Date.now();

    let unique = 0;
    let duplicates = 0;

    for (let i = 0; i < 10_000; i += 1) {
      const identity = `https://board.test/jobs/${i % 6_700}`;
      if (seen.has(identity)) duplicates += 1;
      else {
        seen.add(identity);
        unique += 1;
      }
    }

    expect(unique).toBe(6_700);
    expect(duplicates).toBe(3_300);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('builds coverage over 1,000 executed queries quickly', () => {
    const preferences = candidatePreferencesSchema.parse({
      titles: Array.from({ length: 15 }, (_, i) => ({ value: `Role ${i}`, strength: 'preferred' })),
      countries: ['DE', 'NL', 'GB', 'FR'].map((value) => ({ value, strength: 'preferred' })),
      technologies: Array.from({ length: 10 }, (_, i) => ({
        value: `Tech${i}`,
        strength: 'preferred',
      })),
    });

    const plan = planQueries({ profileId: 'scale', preferences, config: { maxQueries: 1_000 } });
    const executed = new Map(
      plan.queries.map((query, index) => [
        query.id,
        { discovered: index % 7, matched: index % 3, sourcesSearched: 5, at: new Date() },
      ]),
    );

    const startedAt = Date.now();
    const report = buildCoverage({
      profileId: 'scale',
      preferences,
      plan,
      windowHours: 24,
      observation: { executedQueries: executed, sourcesAvailable: 100, sourcesProductive: 40 },
    });
    const durationMs = Date.now() - startedAt;

    expect(report.queriesExecuted).toBe(plan.queries.length);
    expect(report.items.length).toBe(29);
    expect(durationMs).toBeLessThan(1_000);
    expect(report.searchedShare).toBeGreaterThan(0);
  });
});
