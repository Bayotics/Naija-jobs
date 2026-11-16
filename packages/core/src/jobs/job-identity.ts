import { createHash } from 'node:crypto';
import type { JobIdentity, NormalizedJob } from '@job-intel/contracts';
import {
  isoYearWeek,
  normalizeCompanyName,
  normalizeTitle,
  normalizeUrl,
  shingles,
} from '../normalize/text';

/**
 * Job identity: deciding whether two records describe the same opening.
 *
 * The same job reaches this system from LinkedIn alerts, Google, Reddit, X,
 * Hot Nigerian Jobs and the company's own careers page. This service produces
 * the deterministic signals a resolver blocks on, in increasing order of cost:
 *
 *   L1 `contentHash`   — identical bytes from one source. Pure idempotency.
 *   L2 `urlHash`       — same destination after tracking params are stripped.
 *   L3 `fingerprint`   — company + title + location + posted-week bucket.
 *   L4 `simhash`       — near-duplicate description detection by Hamming distance.
 *
 * Deliberately *not* here: the decision itself. Clustering, verification and
 * embedding similarity are prompt 12. What this layer guarantees is that the
 * expensive comparison only ever runs inside a small candidate set — L3 is the
 * blocking key that makes dedup O(n) instead of O(n²).
 */

export interface JobIdentityOptions {
  trackingParams?: readonly string[];
  shingleSize?: number;
}

export class JobIdentityService {
  constructor(private readonly options: JobIdentityOptions = {}) {}

  /** SHA-256 over a stable serialization. Key ordering is canonicalized so that
   *  two JSON objects differing only in key order hash identically. */
  contentHash(payload: unknown): string {
    return createHash('sha256').update(canonicalJson(payload)).digest('hex');
  }

  normalizedUrl(url: string | null): string | null {
    if (!url) return null;
    const opts = this.options.trackingParams
      ? { trackingParams: this.options.trackingParams }
      : {};
    return normalizeUrl(url, opts);
  }

  urlHash(url: string | null): string | null {
    const normalized = this.normalizedUrl(url);
    return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
  }

  /**
   * Coarse blocking key.
   *
   * Location uses country (falling back to city) rather than the raw string:
   * "Berlin, Germany" and "Berlin (Remote)" must land in the same bucket, while
   * Berlin and Munich must not — two simultaneous openings at one company in
   * different cities are genuinely different jobs.
   */
  fingerprint(job: Pick<NormalizedJob, 'title' | 'company' | 'location' | 'postedAt'>): {
    hash: string;
    parts: JobIdentity['fingerprintParts'];
  } {
    const company = normalizeCompanyName(job.company.name) || 'unknown';
    const title = normalizeTitle(job.title) || 'unknown';
    const location =
      job.location.countryCode?.toLowerCase() ??
      (job.location.city ? normalizeCompanyName(job.location.city) : null) ??
      'unknown';
    const postedWeek = job.postedAt ? isoYearWeek(job.postedAt) : 'unknown';

    const parts = { company, title, location, postedWeek };
    const hash = createHash('sha256')
      .update([company, title, location, postedWeek].join('|'))
      .digest('hex');
    return { hash, parts };
  }

  /**
   * 64-bit SimHash over description shingles.
   *
   * Returned as a decimal string because the value is stored in a Postgres
   * `bigint` (signed) and JavaScript numbers cannot hold 64 bits exactly.
   * Null when there is too little text to be meaningful — a two-word
   * description would otherwise produce confident nonsense.
   */
  simhash(text: string | null): string | null {
    if (!text) return null;
    const features = shingles(text, this.options.shingleSize ?? 3);
    if (features.length < 3) return null;

    const bits = new Array<number>(64).fill(0);
    for (const feature of features) {
      const hash = fnv1a64(feature);
      for (let i = 0; i < 64; i += 1) {
        const bit = (hash >> BigInt(i)) & 1n;
        bits[i] = (bits[i] ?? 0) + (bit === 1n ? 1 : -1);
      }
    }

    let value = 0n;
    for (let i = 0; i < 64; i += 1) {
      if ((bits[i] ?? 0) > 0) value |= 1n << BigInt(i);
    }
    return BigInt.asIntN(64, value).toString();
  }

  /** All identity signals for a normalized job. */
  compute(job: NormalizedJob, rawPayload?: unknown): JobIdentity {
    const { hash: fingerprint, parts } = this.fingerprint(job);
    return {
      contentHash: this.contentHash(rawPayload ?? canonicalJobIdentityInput(job)),
      normalizedUrl: this.normalizedUrl(job.sourceUrl),
      urlHash: this.urlHash(job.sourceUrl),
      fingerprint,
      fingerprintParts: parts,
      simhash: this.simhash(job.description),
    };
  }
}

/**
 * Hamming distance between two SimHash values.
 * Distance ≤ ~3 over 64 bits indicates near-identical text.
 */
export function simhashDistance(a: string, b: string): number {
  let xor = BigInt.asUintN(64, BigInt(a) ^ BigInt(b));
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

/**
 * Fields that define "the same posting content".
 *
 * Used when no raw payload is supplied. Volatile fields (fetch timestamps,
 * view counts, session ids) are excluded, so a source that re-renders the same
 * job with a new timestamp does not look like new content.
 */
function canonicalJobIdentityInput(job: NormalizedJob): Record<string, unknown> {
  return {
    title: job.title,
    company: job.company.name,
    description: job.description,
    location: job.location.raw,
    salaryMin: job.salary.min,
    salaryMax: job.salary.max,
    employmentTypes: [...job.employmentTypes].sort(),
    remoteType: job.remoteType,
    externalId: job.externalId,
    sourceUrl: job.sourceUrl,
  };
}

/** Stable JSON: object keys sorted recursively, arrays left in order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

/** FNV-1a, 64-bit. Fast, dependency-free, well distributed for short strings. */
function fnv1a64(input: string): bigint {
  const PRIME = 1099511628211n;
  const MASK = (1n << 64n) - 1n;
  let hash = 14695981039346656037n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * PRIME) & MASK;
  }
  return hash;
}
