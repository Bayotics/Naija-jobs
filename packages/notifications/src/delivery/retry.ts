import type { NotificationEngineConfig } from '@job-intel/contracts';

/**
 * Retry policy.
 *
 * Exponential backoff with full jitter, matching the discovery layer's policy
 * so the system has one answer to "how do we retry" rather than three.
 *
 * Jitter is not decoration. Without it, a provider outage that fails a hundred
 * deliveries at once retries all hundred at the same instant, repeatedly — a
 * self-inflicted thundering herd against a service that is already struggling.
 */

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  reason: string;
}

export function nextRetry(
  attempt: number,
  retryable: boolean,
  config: Pick<NotificationEngineConfig, 'maxAttempts' | 'baseRetryDelayMs' | 'maxRetryDelayMs'>,
  random: () => number = Math.random,
): RetryDecision {
  if (!retryable) {
    return { retry: false, delayMs: 0, reason: 'the failure is not retryable' };
  }
  if (attempt >= config.maxAttempts) {
    return {
      retry: false,
      delayMs: 0,
      reason: `exhausted ${config.maxAttempts} attempts`,
    };
  }

  const exponential = Math.min(
    config.maxRetryDelayMs,
    config.baseRetryDelayMs * Math.pow(2, attempt - 1),
  );
  const delayMs = Math.round(random() * exponential);

  return {
    retry: true,
    delayMs,
    reason: `attempt ${attempt + 1} of ${config.maxAttempts} in ${Math.round(delayMs / 1000)}s`,
  };
}

/**
 * Whether a delivery may be attempted at all.
 *
 * The last line of defence against a double send. The unique constraint on
 * `idempotency_key` is the real guarantee — this is the cheap check that avoids
 * reaching the provider in the first place.
 */
export function canAttempt(delivery: {
  status: string;
  attempts: number;
  maxAttempts: number;
}): { allowed: boolean; reason: string } {
  if (delivery.status === 'sent' || delivery.status === 'delivered') {
    return { allowed: false, reason: 'already sent' };
  }
  if (delivery.status === 'cancelled') {
    return { allowed: false, reason: 'cancelled' };
  }
  if (delivery.attempts >= delivery.maxAttempts) {
    return { allowed: false, reason: `exhausted ${delivery.maxAttempts} attempts` };
  }
  return { allowed: true, reason: 'ready' };
}
