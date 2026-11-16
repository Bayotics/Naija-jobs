/**
 * Global concurrency control.
 *
 * Per-source rate limiters answer "am I being polite to this host". They cannot
 * answer "is this machine about to fall over", because each one only sees its
 * own source. Twenty sources each politely holding two concurrent requests is
 * forty in flight, forty response bodies in memory, and forty database writes
 * queued behind them — every limiter individually correct and the process dead.
 *
 * So there are two ceilings, and a request needs both: a global one and a
 * per-host one. The per-host ceiling matters independently because several
 * configured sources routinely share a host — a dozen Greenhouse boards are a
 * dozen sources and one server.
 *
 * Implemented with an explicit FIFO queue rather than a semaphore library so
 * that waiters are served in order. Without that, a busy host can starve one
 * source indefinitely while others cycle through.
 */

export interface ConcurrencyOptions {
  /** Ceiling across the whole process. */
  maxGlobal?: number;
  /** Ceiling per hostname, whatever the source. */
  maxPerHost?: number;
  /** Longest a request may wait for a slot before giving up. */
  acquireTimeoutMs?: number;
}

interface Waiter {
  host: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

export class ConcurrencyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyLimitError';
  }
}

export class ConcurrencyController {
  private readonly maxGlobal: number;
  private readonly maxPerHost: number;
  private readonly acquireTimeoutMs: number;

  private active = 0;
  private readonly perHost = new Map<string, number>();
  private readonly queue: Waiter[] = [];

  constructor(options: ConcurrencyOptions = {}) {
    this.maxGlobal = Math.max(1, options.maxGlobal ?? 8);
    this.maxPerHost = Math.max(1, options.maxPerHost ?? 2);
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 60_000;
  }

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  hostInFlight(host: string): number {
    return this.perHost.get(host) ?? 0;
  }

  private hasCapacity(host: string): boolean {
    return this.active < this.maxGlobal && this.hostInFlight(host) < this.maxPerHost;
  }

  private take(host: string): void {
    this.active += 1;
    this.perHost.set(host, this.hostInFlight(host) + 1);
  }

  /**
   * Hands a freed slot to the first waiter that can use it.
   *
   * Scans past waiters blocked on a *different* host rather than stopping at
   * the head of the queue. Strict head-of-line ordering would leave the whole
   * system idle behind one waiter queued for a saturated host while slots for
   * every other host sat free.
   */
  private drain(): void {
    for (let index = 0; index < this.queue.length; index += 1) {
      const waiter = this.queue[index]!;

      if (waiter.settled) {
        this.queue.splice(index, 1);
        index -= 1;
        continue;
      }

      if (!this.hasCapacity(waiter.host)) continue;

      this.queue.splice(index, 1);
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      this.take(waiter.host);
      waiter.resolve();

      if (this.active >= this.maxGlobal) return;
      index -= 1;
    }
  }

  /** Waits for a slot. Rejects rather than waiting forever. */
  acquire(host: string): Promise<void> {
    if (this.hasCapacity(host)) {
      this.take(host);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { host, resolve, reject, timer: null, settled: false };

      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        reject(
          new ConcurrencyLimitError(
            `Timed out after ${this.acquireTimeoutMs}ms waiting for a slot on ${host}.`,
          ),
        );
      }, this.acquireTimeoutMs);

      /*
       * `unref` so a pending timer cannot hold the process open. A worker
       * finishing its shift should exit, not linger for sixty seconds because
       * something is queued behind a slow host.
       */
      waiter.timer.unref?.();
      this.queue.push(waiter);
    });
  }

  release(host: string): void {
    /*
     * Guarded against releasing more than was taken.
     *
     * A double release would inflate the effective ceiling silently and the
     * symptom — occasional overload under specific error paths — is close to
     * undiagnosable. Clamping makes the bug harmless.
     */
    this.active = Math.max(0, this.active - 1);

    const current = this.hostInFlight(host);
    if (current <= 1) this.perHost.delete(host);
    else this.perHost.set(host, current - 1);

    this.drain();
  }

  /** Runs `fn` holding a slot, releasing it however `fn` ends. */
  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(host);
    try {
      return await fn();
    } finally {
      this.release(host);
    }
  }

  /** Fails every waiter. For shutdown, so nothing hangs on a dying process. */
  drainAll(reason = 'The concurrency controller is shutting down.'): void {
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new ConcurrencyLimitError(reason));
    }
  }
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'invalid';
  }
}
