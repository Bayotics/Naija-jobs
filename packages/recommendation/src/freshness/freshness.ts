import {
  freshnessConfigSchema,
  type FreshnessBasis,
  type FreshnessConfig,
  type FreshnessScore,
} from '@job-intel/contracts';

/**
 * Freshness.
 *
 * A job posted ten minutes ago is worth more than one posted twenty-five days
 * ago — but not infinitely more, and never enough to outrank a genuinely better
 * opening. Freshness is one weighted factor in the recommendation formula, and
 * its weight is configuration.
 *
 * Two decisions worth stating:
 *
 *  - **Exponential decay with a plateau**, not a linear ramp. The difference
 *    between one hour and six hours old is negligible; the difference between
 *    two days and two weeks is not. Linear decay gets both wrong.
 *  - **The basis is recorded.** An age measured from a stated posting date is
 *    trustworthy; one measured from when *we* first saw it is a lower bound on
 *    the real age, and the confidence reflects that. Reporting both as "3 days
 *    old" would be a quiet lie.
 */

export interface FreshnessInput {
  postedAt: Date | null;
  updatedAt: Date | null;
  lastVerifiedAt: Date | null;
  firstSeenAt: Date;
  /** 0-1. A source that restamps dates on every crawl is less believable. */
  sourceReliability?: number;
  now?: Date;
}

/** How much each basis is trusted, before source reliability is applied. */
const BASIS_CONFIDENCE: Readonly<Record<FreshnessBasis, number>> = {
  posted: 0.95,
  updated: 0.8,
  verified: 0.85,
  // We know when we first saw it, which bounds the age from above but not
  // below: the posting may have been weeks old when discovered.
  first_seen: 0.5,
};

export function scoreFreshness(
  input: FreshnessInput,
  config: Partial<FreshnessConfig> = {},
): FreshnessScore {
  const cfg = freshnessConfigSchema.parse(config);
  const now = input.now ?? new Date();

  // Posted date is the truth when stated. Verification is the next best thing:
  // it says the job existed at that moment, which is what freshness is a proxy
  // for in the first place.
  const [basis, reference]: [FreshnessBasis, Date] =
    input.postedAt !== null
      ? ['posted', input.postedAt]
      : input.lastVerifiedAt !== null
        ? ['verified', input.lastVerifiedAt]
        : input.updatedAt !== null
          ? ['updated', input.updatedAt]
          : ['first_seen', input.firstSeenAt];

  const ageMs = Math.max(0, now.getTime() - reference.getTime());
  const ageHours = ageMs / 3_600_000;
  const ageDays = ageHours / 24;

  // Plateau, then half-life decay from the end of it.
  const score =
    ageHours <= cfg.peakHours
      ? 100
      : 100 * Math.pow(0.5, (ageHours - cfg.peakHours) / 24 / cfg.halfLifeDays);

  const reliability = Math.max(0, Math.min(1, input.sourceReliability ?? 1));
  const confidence = BASIS_CONFIDENCE[basis] * (0.6 + 0.4 * reliability);

  const explanation =
    basis === 'first_seen'
      ? `First seen ${formatAge(ageHours)} ago; the posting states no date, so this is a lower bound on its real age`
      : `${basis === 'posted' ? 'Posted' : basis === 'verified' ? 'Verified' : 'Updated'} ${formatAge(ageHours)} ago`;

  return {
    score: Math.round(Math.max(0, Math.min(100, score)) * 100) / 100,
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 1000) / 1000,
    basis,
    ageDays: Math.round(ageDays * 100) / 100,
    ageHours: Math.round(ageHours * 100) / 100,
    explanation,
  };
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} days`;
  return `${Math.round(days / 30)} months`;
}

/** Whether a posting falls inside a candidate's stated recency window. */
export function withinFreshnessWindow(
  freshness: FreshnessScore,
  windowHours: number | null,
): boolean {
  if (windowHours === null) return true;
  return freshness.ageHours <= windowHours;
}
