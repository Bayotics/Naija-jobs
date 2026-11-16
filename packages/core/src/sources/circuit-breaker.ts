import type { CircuitState } from '@job-intel/contracts';

/**
 * Per-source circuit breaker.
 *
 * A source that is failing does not benefit from being retried every fifteen
 * minutes, and neither does the source's operator. The breaker converts
 * repeated failure into a bounded pause, then one careful probe:
 *
 *   CLOSED ──(threshold consecutive failures)──▶ OPEN
 *   OPEN ──(cooldown elapsed)──▶ HALF_OPEN
 *   HALF_OPEN ──(probe succeeds)──▶ CLOSED
 *   HALF_OPEN ──(probe fails)──▶ OPEN, with a longer cooldown
 *
 * Two properties worth stating, because both are easy to get wrong:
 *
 *  - **HALF_OPEN allows exactly one run.** The point of the half-open state is
 *    to spend a single request finding out whether the source recovered. Letting
 *    the whole schedule through re-hammers a site that is already struggling.
 *  - **A `partial` run closes the breaker.** Partial means the source answered
 *    and some items failed. The source is up; the breaker is not the mechanism
 *    for item-level problems.
 *
 * The cooldown grows with consecutive failures so a permanently dead source
 * settles into occasional probes rather than a fixed drumbeat forever.
 */

export interface BreakerState {
  circuitState: CircuitState;
  consecutiveFailures: number;
  circuitOpenedAt: Date | null;
}

export interface BreakerPolicy {
  /** Consecutive failures that trip the breaker. */
  threshold: number;
  /** Base pause once open, in seconds. */
  cooldownSeconds: number;
  /** Multiplier applied per failure beyond the threshold. */
  backoffFactor?: number;
  maxCooldownSeconds?: number;
}

export interface BreakerDecision {
  next: BreakerState;
  /** Whether the state changed, so a caller can log only real transitions. */
  changed: boolean;
  reason: string;
}

/**
 * The pause before a half-open probe.
 *
 * Compounds past the threshold and is capped, so a source that has failed
 * fifty times is probed roughly hourly rather than never or constantly.
 */
export function cooldownFor(state: BreakerState, policy: BreakerPolicy): number {
  const factor = policy.backoffFactor ?? 2;
  const max = policy.maxCooldownSeconds ?? 6 * 3_600;
  const excess = Math.max(0, state.consecutiveFailures - policy.threshold);
  return Math.min(max, Math.round(policy.cooldownSeconds * factor ** Math.min(excess, 8)));
}

/** Whether a run may proceed right now, and why not when it may not. */
export function canAttempt(
  state: BreakerState,
  policy: BreakerPolicy,
  now = new Date(),
): { allowed: boolean; state: CircuitState; reason: string } {
  if (state.circuitState === 'closed') {
    return { allowed: true, state: 'closed', reason: 'circuit closed' };
  }

  if (state.circuitState === 'half_open') {
    // Already probing. A second concurrent probe would defeat the purpose.
    return { allowed: true, state: 'half_open', reason: 'half-open probe' };
  }

  const openedAt = state.circuitOpenedAt?.getTime() ?? 0;
  const cooldownMs = cooldownFor(state, policy) * 1_000;
  const elapsed = now.getTime() - openedAt;

  if (elapsed >= cooldownMs) {
    return {
      allowed: true,
      state: 'half_open',
      reason: `cooldown of ${Math.round(cooldownMs / 1000)}s elapsed; probing once`,
    };
  }

  const waitSeconds = Math.ceil((cooldownMs - elapsed) / 1_000);
  return {
    allowed: false,
    state: 'open',
    reason: `circuit open after ${state.consecutiveFailures} consecutive failure(s); retrying in ${waitSeconds}s`,
  };
}

/** Folds a completed run's outcome into the breaker state. */
export function recordOutcome(
  state: BreakerState,
  outcome: 'success' | 'partial' | 'failed' | 'skipped',
  policy: BreakerPolicy,
  now = new Date(),
): BreakerDecision {
  // `skipped` means the run never happened — availability, schedule, budget.
  // It is neither evidence of health nor of failure.
  if (outcome === 'skipped') {
    return { next: state, changed: false, reason: 'run skipped; breaker unchanged' };
  }

  if (outcome === 'success' || outcome === 'partial') {
    const changed = state.circuitState !== 'closed' || state.consecutiveFailures > 0;
    return {
      next: { circuitState: 'closed', consecutiveFailures: 0, circuitOpenedAt: null },
      changed,
      reason:
        state.circuitState === 'half_open'
          ? 'half-open probe succeeded; circuit closed'
          : 'run succeeded',
    };
  }

  const failures = state.consecutiveFailures + 1;

  // A failed probe re-opens immediately, with the cooldown recomputed from the
  // now-higher failure count.
  if (state.circuitState === 'half_open') {
    return {
      next: { circuitState: 'open', consecutiveFailures: failures, circuitOpenedAt: now },
      changed: true,
      reason: `half-open probe failed; circuit re-opened (${failures} consecutive failures)`,
    };
  }

  if (failures >= policy.threshold) {
    const alreadyOpen = state.circuitState === 'open';
    return {
      next: {
        circuitState: 'open',
        consecutiveFailures: failures,
        // Keeping the original open time means the cooldown does not restart
        // on every failed attempt while open.
        circuitOpenedAt: alreadyOpen ? (state.circuitOpenedAt ?? now) : now,
      },
      changed: !alreadyOpen,
      reason: alreadyOpen
        ? `still failing (${failures} consecutive)`
        : `threshold of ${policy.threshold} reached; circuit opened`,
    };
  }

  return {
    next: { circuitState: 'closed', consecutiveFailures: failures, circuitOpenedAt: null },
    changed: false,
    reason: `failure ${failures}/${policy.threshold} before the circuit opens`,
  };
}
