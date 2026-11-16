import type { RepostAssessment, RepostKind } from '@job-intel/contracts';

/**
 * Repost detection.
 *
 * The same opening reappears constantly — sources bump dates to keep listings
 * near the top, employers re-advertise after a failed search, and a genuinely
 * new headcount opens on an old requisition. These are three different things
 * and only the last is a new opportunity.
 *
 * Treating every reappearance as new is how a digest ends up sending the same
 * job every week. Treating none of them as new is how a genuinely reopened role
 * is missed. So the gap and the content decide:
 *
 *   refresh  — reappeared quickly with no content change. Almost never news.
 *   repost   — a real gap, but the same posting. Mildly interesting.
 *   reopened — a long gap *and* material change. A new opportunity.
 */

export interface RepostInput {
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Every date on which this job was observed, oldest first. */
  sightings: Date[];
  /** Content hash at each sighting, aligned with `sightings`. */
  contentHashes: string[];
  /** Distinct posting dates the sources have claimed for this job. */
  claimedPostingDates: Date[];
  now?: Date;
}

export interface RepostThresholds {
  /** Below this gap, a reappearance is a refresh rather than a repost. */
  refreshGapDays: number;
  /** At or above this gap, with a content change, the role counts as reopened. */
  reopenGapDays: number;
}

export const DEFAULT_REPOST_THRESHOLDS: RepostThresholds = {
  refreshGapDays: 7,
  reopenGapDays: 30,
};

/** Multiplier applied to the recommendation score, by kind. */
const NOVELTY: Readonly<Record<RepostKind, number>> = {
  new: 1,
  // A date-bumped listing should not keep winning the freshness factor it did
  // not earn, so novelty claws most of that back.
  refresh: 0.7,
  repost: 0.85,
  reopened: 1,
};

export function detectRepost(
  input: RepostInput,
  thresholds: RepostThresholds = DEFAULT_REPOST_THRESHOLDS,
): RepostAssessment {
  const occurrences = Math.max(1, input.sightings.length);

  if (occurrences <= 1 && input.claimedPostingDates.length <= 1) {
    return {
      kind: 'new',
      occurrences,
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.lastSeenAt,
      gapDays: null,
      noveltyFactor: NOVELTY.new,
      explanation: 'First and only sighting',
    };
  }

  const sorted = [...input.sightings].sort((a, b) => a.getTime() - b.getTime());
  const previous = sorted[sorted.length - 2];
  const latest = sorted[sorted.length - 1] ?? input.lastSeenAt;
  const gapDays =
    previous && latest ? (latest.getTime() - previous.getTime()) / 86_400_000 : null;

  // A changed content hash between the last two sightings means the posting
  // itself moved, not just its date.
  const hashes = input.contentHashes;
  const contentChanged =
    hashes.length >= 2 && hashes[hashes.length - 1] !== hashes[hashes.length - 2];

  // Several distinct claimed posting dates is the signature of a listing being
  // restamped to stay near the top of a board.
  const restamped = new Set(input.claimedPostingDates.map((d) => d.toISOString().slice(0, 10))).size > 1;

  let kind: RepostKind;
  let explanation: string;

  if (gapDays === null) {
    kind = 'refresh';
    explanation = `Seen ${occurrences} times with no measurable gap`;
  } else if (gapDays >= thresholds.reopenGapDays && contentChanged) {
    kind = 'reopened';
    explanation = `Reappeared after ${Math.round(gapDays)} days with changed content — likely genuinely reopened`;
  } else if (gapDays >= thresholds.refreshGapDays) {
    kind = 'repost';
    explanation = `Reposted after ${Math.round(gapDays)} days${contentChanged ? ' with minor changes' : ' unchanged'}`;
  } else {
    kind = 'refresh';
    explanation = restamped
      ? `Listing restamped ${occurrences} times; the posting date has moved without the content changing`
      : `Seen ${occurrences} times within ${Math.round(gapDays)} days — routine re-listing`;
  }

  return {
    kind,
    occurrences,
    firstSeenAt: input.firstSeenAt,
    lastSeenAt: input.lastSeenAt,
    gapDays: gapDays === null ? null : Math.round(gapDays * 10) / 10,
    noveltyFactor: NOVELTY[kind],
    explanation,
  };
}
