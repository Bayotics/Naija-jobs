import {
  matchCacheFingerprint,
  matchCacheKeySchema,
  type JobMatchResult,
  type MatchCacheKey,
} from '@job-intel/contracts';

/**
 * Cached match results.
 *
 * Matching a thousand jobs against a candidate who has not changed is work the
 * system has already done. The interesting part is not the caching — it is the
 * invalidation, and specifically the decision to make invalidation *impossible
 * to forget*.
 *
 * A cache keyed on `jobId + candidateId` needs a rule for every input that
 * could change the answer: the profile, the preferences, the job, the
 * enrichment, the taxonomy, the scoring version, the model. Someone will
 * eventually add an eighth input and not add the eighth rule, and the symptom —
 * stale scores that look plausible — is close to undiagnosable.
 *
 * So the key *is* the inputs. A changed input produces a different fingerprint
 * and therefore a miss, with no rule to remember. The cost is that a scoring
 * version bump invalidates everything at once, which is correct: every score
 * really did change.
 */

export interface CacheEntry {
  fingerprint: string;
  result: JobMatchResult;
  storedAt: Date;
  hits: number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
  staleRejections: number;
  hitRate: number;
}

export interface MatchCacheOptions {
  maxEntries?: number;
  /** Oldest an entry may be regardless of fingerprint agreement. */
  maxAgeMs?: number;
  now?: () => Date;
}

export class MatchCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly now: () => Date;

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private staleRejections = 0;

  constructor(options: MatchCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 5_000;
    /*
     * A ceiling on age even when every input agrees.
     *
     * Freshness is not an input to the fingerprint — a job's posted date does
     * not change — but a match computed a week ago describes a job that may
     * have since expired. The age bound is the safety net for the inputs the
     * fingerprint cannot see.
     */
    this.maxAgeMs = options.maxAgeMs ?? 24 * 3_600_000;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The cached result for these exact inputs, or null.
   *
   * The lookup key includes the fingerprint, so a stale entry is a miss rather
   * than something to check and discard. The separate `staleRejections`
   * counter exists for the *age* rejections, which are the ones worth watching:
   * a high rate means the TTL is fighting the workload.
   */
  get(key: MatchCacheKey): JobMatchResult | null {
    const parsed = matchCacheKeySchema.parse(key);
    const fingerprint = matchCacheFingerprint(parsed);
    const entry = this.entries.get(fingerprint);

    if (!entry) {
      this.misses += 1;
      return null;
    }

    const age = this.now().getTime() - entry.storedAt.getTime();

    if (age > this.maxAgeMs) {
      this.entries.delete(fingerprint);
      this.staleRejections += 1;
      this.misses += 1;
      return null;
    }

    entry.hits += 1;
    this.hits += 1;

    /*
     * Re-inserted so the Map's insertion order tracks recency, which is what
     * makes the eviction below least-recently-*used* rather than
     * least-recently-written.
     */
    this.entries.delete(fingerprint);
    this.entries.set(fingerprint, entry);

    return entry.result;
  }

  set(key: MatchCacheKey, result: JobMatchResult): void {
    const parsed = matchCacheKeySchema.parse(key);
    const fingerprint = matchCacheFingerprint(parsed);

    this.entries.set(fingerprint, {
      fingerprint,
      result,
      storedAt: this.now(),
      hits: 0,
    });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
  }

  /**
   * Drops every entry for one job or one candidate.
   *
   * The fingerprint handles *input* changes on its own; this handles deletion,
   * which the fingerprint cannot see. A job that has been withdrawn should stop
   * appearing in recommendations immediately rather than at the TTL.
   */
  invalidate(filter: { jobId?: string; candidateProfileId?: string }): number {
    let removed = 0;

    for (const [fingerprint] of this.entries) {
      const matchesJob = filter.jobId ? fingerprint.startsWith(`${filter.jobId}|`) : true;
      const matchesCandidate = filter.candidateProfileId
        ? fingerprint.includes(`|${filter.candidateProfileId}|`)
        : true;

      if (matchesJob && matchesCandidate && (filter.jobId || filter.candidateProfileId)) {
        this.entries.delete(fingerprint);
        removed += 1;
      }
    }

    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  get stats(): CacheStats {
    const total = this.hits + this.misses;

    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      staleRejections: this.staleRejections,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(3)),
    };
  }
}
