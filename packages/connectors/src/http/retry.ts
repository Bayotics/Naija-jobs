import { classifyError, type ConnectorError } from '../errors';
import { sleep } from './rate-limiter';

/**
 * Retry policy.
 *
 * Two rules that matter more than the numbers:
 *
 *  - **Only retryable failures are retried.** A malformed config or a 404 fails
 *    immediately; see the failure taxonomy in `errors.ts`.
 *  - **Full jitter.** Exponential backoff without jitter synchronises every
 *    retrying client into a thundering herd that keeps a recovering source down.
 */
export interface RetrySettings {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Multiplied into the delay each attempt. */
  factor: number;
  /** Full jitter randomises within [0, delay]. Disable only for tests. */
  jitter: boolean;
}

export const DEFAULT_RETRY: RetrySettings = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: true,
};

export interface RetryAttempt {
  attempt: number;
  error: ConnectorError;
  delayMs: number;
}

export function computeDelay(
  attempt: number,
  settings: RetrySettings,
  retryAfterSeconds?: number,
  random: () => number = Math.random,
): number {
  // An explicit Retry-After from the source always wins over our own guess.
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1_000, settings.maxDelayMs);
  }
  const exponential = settings.baseDelayMs * Math.pow(settings.factor, attempt - 1);
  const capped = Math.min(exponential, settings.maxDelayMs);
  return settings.jitter ? Math.round(random() * capped) : capped;
}

/**
 * Runs `fn`, retrying only failures classified as retryable.
 * `onRetry` receives every attempt so the runner can record why a source was
 * slow rather than leaving it invisible.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: {
    settings?: Partial<RetrySettings>;
    onRetry?: (attempt: RetryAttempt) => void;
    signal?: AbortSignal;
    random?: () => number;
  } = {},
): Promise<T> {
  const settings = { ...DEFAULT_RETRY, ...options.settings };
  let lastError: ConnectorError | undefined;

  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new Error('Operation aborted');
    try {
      return await fn(attempt);
    } catch (error) {
      const classified = classifyError(error);
      lastError = classified;

      const isLastAttempt = attempt >= settings.maxAttempts;
      if (!classified.retryable || isLastAttempt) throw classified;

      const delayMs = computeDelay(
        attempt,
        settings,
        classified.retryAfterSeconds,
        options.random,
      );
      options.onRetry?.({ attempt, error: classified, delayMs });
      await sleep(delayMs, options.signal);
    }
  }

  throw lastError ?? new Error('Retry loop exited without a result');
}
