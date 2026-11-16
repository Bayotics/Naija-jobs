import {
  schedulingPolicySchema,
  scheduleDecisionSchema,
  sourcePerformanceSchema,
  type ScheduleDecision,
  type SchedulingPolicy,
  type SourcePerformance,
} from '@job-intel/contracts';
import { canAttempt, type BreakerState } from '@job-intel/core';

/**
 * Adaptive scheduling.
 *
 * A fixed cron per source is wrong in both directions at once: the ATS board
 * that posts three roles a week is polled hourly for nothing, while the
 * high-yield aggregator that turns over every twenty minutes is polled at the
 * same rate and misses postings. Cadence should follow evidence.
 *
 * Four inputs, in descending authority:
 *
 *   1. **The circuit breaker.** An open circuit suppresses the source outright.
 *      Nothing else can override that — the whole point of the breaker is that
 *      a failing source stops being called.
 *   2. **Consecutive failures.** Compounding backoff, before the breaker trips.
 *   3. **Unchanged streak.** A feed that has returned 304 six times running is
 *      telling us plainly that polling it is wasted.
 *   4. **Value score.** Jobs per run, uniqueness and match rate.
 *
 * Jitter is applied last so a hundred sources on a six-hour cadence do not all
 * fire at the same instant.
 */

export interface SchedulingInput {
  sourceId: string;
  enabled: boolean;
  /** From the source row. */
  breaker: BreakerState;
  circuitThreshold: number;
  circuitCooldownSeconds: number;
  lastRunAt: Date | null;
  /** Consecutive fetches that returned 304 or an identical hash. */
  unchangedStreak: number;
  performance: SourcePerformance | null;
  /** Source priority, 0 = highest. Sets the baseline cadence. */
  priority: number;
}

/** Baseline cadence by declared priority, before any adjustment. */
const PRIORITY_BASE_MINUTES: Readonly<Record<number, number>> = {
  0: 30,
  1: 60,
  2: 180,
  3: 360,
};

/**
 * Scores how much a source is worth polling.
 *
 * Deliberately not just volume. A source producing 200 jobs of which 199 are
 * duplicates of what another source already gave us is *worse* than one
 * producing 5 unique matches, and a volume-only score would rank it first.
 */
export function scoreSourceValue(input: {
  sourceId: string;
  windowDays: number;
  runs: number;
  jobsDiscovered: number;
  duplicates: number;
  validJobs: number;
  enrichmentSucceeded: number;
  matchedJobs: number;
  staleJobs: number;
  failedRuns: number;
  totalLatencyMs: number;
}): SourcePerformance {
  const runs = Math.max(0, input.runs);
  const discovered = Math.max(0, input.jobsDiscovered);

  const rate = (numerator: number, denominator: number): number =>
    denominator > 0 ? Math.min(1, Math.max(0, numerator / denominator)) : 0;

  const duplicateRate = rate(input.duplicates, discovered);
  const validJobRate = rate(input.validJobs, discovered);
  const enrichmentSuccessRate = rate(input.enrichmentSucceeded, input.validJobs);
  const matchRate = rate(input.matchedJobs, discovered);
  const staleRate = rate(input.staleJobs, discovered);
  const errorRate = rate(input.failedRuns, runs);
  const averageLatencyMs = runs > 0 ? Math.round(input.totalLatencyMs / runs) : 0;
  const averageJobsPerRun = runs > 0 ? discovered / runs : 0;

  // Volume matters, but with sharply diminishing returns: the difference
  // between 5 and 50 jobs per run is large, between 500 and 5,000 is not.
  const volumeComponent = Math.min(25, Math.log10(1 + averageJobsPerRun) * 18);
  const uniquenessComponent = (1 - duplicateRate) * 20;
  const matchComponent = matchRate * 30;
  const validityComponent = validJobRate * 15;
  const reliabilityComponent = (1 - errorRate) * 10;
  const stalenessPenalty = staleRate * 15;

  const valueScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        volumeComponent +
          uniquenessComponent +
          matchComponent +
          validityComponent +
          reliabilityComponent -
          stalenessPenalty,
      ),
    ),
  );

  const explanation =
    runs === 0
      ? 'No runs in the window; value is unknown rather than zero'
      : `${averageJobsPerRun.toFixed(1)} jobs/run, ${Math.round(duplicateRate * 100)}% duplicate, ` +
        `${Math.round(matchRate * 100)}% matched, ${Math.round(errorRate * 100)}% of runs failed`;

  return sourcePerformanceSchema.parse({
    sourceId: input.sourceId,
    windowDays: input.windowDays,
    runs,
    averageJobsPerRun: Math.round(averageJobsPerRun * 100) / 100,
    duplicateRate,
    validJobRate,
    enrichmentSuccessRate,
    matchRate,
    staleRate,
    errorRate,
    averageLatencyMs,
    valueScore,
    explanation,
  });
}

/** Decides when a source should next run, and says why. */
export function decideSchedule(
  input: SchedulingInput,
  policyInput?: Partial<SchedulingPolicy>,
  now = new Date(),
): ScheduleDecision {
  const policy = schedulingPolicySchema.parse(policyInput ?? {});

  if (!input.enabled) {
    return scheduleDecisionSchema.parse({
      sourceId: input.sourceId,
      intervalMinutes: policy.maxIntervalMinutes,
      nextRunAt: new Date(now.getTime() + policy.maxIntervalMinutes * 60_000),
      reason: 'Source is disabled',
      suppressed: true,
    });
  }

  // The breaker outranks everything: a source that is failing is not scheduled
  // more cleverly, it is not scheduled at all until the cooldown elapses.
  const breaker = canAttempt(
    input.breaker,
    { threshold: input.circuitThreshold, cooldownSeconds: input.circuitCooldownSeconds },
    now,
  );

  if (!breaker.allowed) {
    const cooldownMinutes = Math.max(
      policy.minIntervalMinutes,
      Math.ceil(input.circuitCooldownSeconds / 60),
    );
    return scheduleDecisionSchema.parse({
      sourceId: input.sourceId,
      intervalMinutes: cooldownMinutes,
      nextRunAt: new Date(now.getTime() + cooldownMinutes * 60_000),
      reason: breaker.reason,
      suppressed: true,
    });
  }

  const reasons: string[] = [];
  let minutes = PRIORITY_BASE_MINUTES[input.priority] ?? policy.lowValueIntervalMinutes;
  reasons.push(`priority ${input.priority} baseline ${minutes}m`);

  // ── Value ────────────────────────────────────────────────────────────────
  const value = input.performance?.valueScore ?? null;
  if (value !== null && (input.performance?.runs ?? 0) >= 3) {
    if (value >= 70) {
      minutes = Math.min(minutes, policy.highValueIntervalMinutes);
      reasons.push(`high value (${value}/100) → ${policy.highValueIntervalMinutes}m`);
    } else if (value <= 25) {
      minutes = Math.max(minutes, policy.lowValueIntervalMinutes);
      reasons.push(`low value (${value}/100) → ${policy.lowValueIntervalMinutes}m`);
    } else {
      reasons.push(`value ${value}/100, baseline kept`);
    }
  } else {
    reasons.push('not enough run history to judge value');
  }

  // ── Unchanged streak ─────────────────────────────────────────────────────
  if (input.unchangedStreak >= policy.unchangedStreakBeforeSlowdown) {
    const factor = Math.min(4, 1 + (input.unchangedStreak - policy.unchangedStreakBeforeSlowdown + 1) * 0.5);
    minutes = Math.round(minutes * factor);
    reasons.push(`${input.unchangedStreak} unchanged fetches → ×${factor.toFixed(1)}`);
  }

  // ── Failures below the breaker threshold ─────────────────────────────────
  if (input.breaker.consecutiveFailures > 0) {
    const backoff = policy.failureBackoffFactor ** Math.min(input.breaker.consecutiveFailures, 6);
    minutes = Math.min(policy.maxBackoffMinutes, Math.round(minutes * backoff));
    reasons.push(`${input.breaker.consecutiveFailures} recent failure(s) → ×${backoff.toFixed(1)}`);
  }

  minutes = Math.max(policy.minIntervalMinutes, Math.min(policy.maxIntervalMinutes, minutes));

  // Jitter spreads the fleet. Deterministic per source would be better for
  // testing but would also make every source's offset stable forever, which
  // reintroduces the thundering herd after the first restart.
  //
  // Clamped *again* afterwards, at both ends: `maxIntervalMinutes` is a promise
  // that a source will be visited at least that often, and applying jitter
  // after the first clamp silently broke it by up to the jitter percentage.
  const jitter = 1 + (Math.random() * 2 - 1) * policy.jitterPercent;
  const jittered = Math.min(
    policy.maxIntervalMinutes,
    Math.max(policy.minIntervalMinutes, Math.round(minutes * jitter)),
  );

  const base = input.lastRunAt ?? now;
  const nextRunAt = new Date(Math.max(now.getTime(), base.getTime() + jittered * 60_000));

  return scheduleDecisionSchema.parse({
    sourceId: input.sourceId,
    intervalMinutes: jittered,
    nextRunAt,
    reason: reasons.join('; '),
    suppressed: false,
  });
}

/**
 * Orders due sources for execution.
 *
 * Value-first, so a constrained cycle spends its budget where it has
 * historically paid off. Ties break on staleness — the source not read for
 * longest goes first, which stops a high-value source from starving the rest.
 */
export function orderByValue(
  sources: ReadonlyArray<{ sourceId: string; performance: SourcePerformance | null; lastRunAt: Date | null }>,
  now = new Date(),
): string[] {
  return [...sources]
    .sort((a, b) => {
      const valueDiff = (b.performance?.valueScore ?? 50) - (a.performance?.valueScore ?? 50);
      if (valueDiff !== 0) return valueDiff;
      const aAge = now.getTime() - (a.lastRunAt?.getTime() ?? 0);
      const bAge = now.getTime() - (b.lastRunAt?.getTime() ?? 0);
      return bAge - aAge;
    })
    .map((entry) => entry.sourceId);
}
