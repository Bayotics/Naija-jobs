/**
 * Politeness controls.
 *
 * These exist to *respect* external services, not to work around them. Every
 * knob is a limit we impose on ourselves; none of it evades a limit a source
 * imposes on us. When a source says 429, we slow down — see `RateLimitError`
 * and the retry policy.
 *
 * Limits are keyed by **domain** rather than by source, because several sources
 * can share a host and a per-source limit would let them collectively exceed
 * what the host expects.
 */

export interface RateLimitSettings {
  requestsPerMinute: number;
  /** Simultaneous in-flight requests to one domain. */
  maxConcurrent: number;
  /** Enforced pause between consecutive requests, on top of the bucket. */
  minDelayMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitSettings = {
  requestsPerMinute: 30,
  maxConcurrent: 2,
  minDelayMs: 250,
};

/**
 * Token bucket with a concurrency gate and a minimum spacing.
 *
 * Also the mechanism that honours robots.txt `Crawl-delay`: politeness and
 * rate limiting are one implementation rather than two that can disagree.
 */
export class DomainRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly defaults: RateLimitSettings = DEFAULT_RATE_LIMIT) {}

  /** Raises (never lowers) the delay for a domain, e.g. from `Crawl-delay`. */
  applyCrawlDelay(domain: string, seconds: number): void {
    const bucket = this.bucketFor(domain, this.defaults);
    bucket.minDelayMs = Math.max(bucket.minDelayMs, seconds * 1_000);
  }

  /**
   * Blocks until a request to `domain` is permitted, then runs `fn`.
   * The permit is released even if `fn` throws, so one failure cannot
   * permanently consume a concurrency slot.
   */
  async schedule<T>(
    domain: string,
    fn: () => Promise<T>,
    settings?: Partial<RateLimitSettings>,
    signal?: AbortSignal,
  ): Promise<T> {
    const bucket = this.bucketFor(domain, { ...this.defaults, ...settings });
    await bucket.acquire(signal);
    try {
      return await fn();
    } finally {
      bucket.release();
    }
  }

  /** Backs off a domain for a while, in response to a 429. */
  penalize(domain: string, seconds: number): void {
    const bucket = this.bucketFor(domain, this.defaults);
    bucket.blockUntil = Math.max(bucket.blockUntil, Date.now() + seconds * 1_000);
  }

  stats(domain: string): { available: number; inFlight: number; blockedForMs: number } {
    const bucket = this.buckets.get(domain);
    if (!bucket) return { available: this.defaults.requestsPerMinute, inFlight: 0, blockedForMs: 0 };
    bucket.refill();
    return {
      available: Math.floor(bucket.tokens),
      inFlight: bucket.inFlight,
      blockedForMs: Math.max(0, bucket.blockUntil - Date.now()),
    };
  }

  private bucketFor(domain: string, settings: RateLimitSettings): Bucket {
    let bucket = this.buckets.get(domain);
    if (!bucket) {
      bucket = new Bucket(settings);
      this.buckets.set(domain, bucket);
    }
    return bucket;
  }
}

class Bucket {
  tokens: number;
  inFlight = 0;
  blockUntil = 0;
  minDelayMs: number;
  private lastRefill = Date.now();
  private lastStart = 0;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxConcurrent: number;

  constructor(settings: RateLimitSettings) {
    this.capacity = Math.max(1, settings.requestsPerMinute);
    this.tokens = this.capacity;
    this.refillPerMs = this.capacity / 60_000;
    this.maxConcurrent = Math.max(1, settings.maxConcurrent);
    this.minDelayMs = Math.max(0, settings.minDelayMs);
  }

  refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
    this.lastRefill = now;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error('Rate limit wait aborted');
      this.refill();

      const now = Date.now();
      const waits = [
        this.blockUntil - now,
        this.lastStart + this.minDelayMs - now,
        this.tokens < 1 ? (1 - this.tokens) / this.refillPerMs : 0,
      ];
      const wait = Math.ceil(Math.max(0, ...waits));

      if (wait > 0) {
        await sleep(Math.min(wait, 1_000), signal);
        continue;
      }
      if (this.inFlight >= this.maxConcurrent) {
        await sleep(25, signal);
        continue;
      }

      this.tokens -= 1;
      this.inFlight += 1;
      this.lastStart = Date.now();
      return;
    }
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Sleep aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Sleep aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
