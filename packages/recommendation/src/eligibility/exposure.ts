import {
  EVENT_POLARITY,
  type BehavioralEvent,
  type Exposure,
  type ExposureState,
} from '@job-intel/contracts';

/**
 * What the candidate has already seen of a job.
 *
 * "New to me" is not the same as "new to the system": a job discovered three
 * weeks ago that has never reached this candidate is new *to them*, and one
 * discovered an hour ago that they already dismissed is not. Ranking and
 * notification both need the second reading, and nothing else in the system
 * tracks it.
 *
 * States are ordered by how strongly they express intent, and the strongest
 * seen so far wins. A candidate who applied and later merely viewed the job
 * again has still applied — letting the later, weaker event overwrite the
 * stronger one would be how a system starts re-recommending jobs someone is
 * already in process on.
 */

/** Higher wins when several events have occurred. */
const STATE_RANK: Readonly<Record<ExposureState, number>> = {
  never_shown: 0,
  shown: 1,
  clicked: 2,
  notified: 3,
  saved: 4,
  dismissed: 5,
  rejected: 6,
  applied: 7,
};

const EVENT_STATES: Readonly<Partial<Record<BehavioralEvent, ExposureState>>> = {
  job_viewed: 'shown',
  job_source_clicked: 'clicked',
  job_saved: 'saved',
  job_marked_interesting: 'saved',
  job_applied: 'applied',
  job_dismissed: 'dismissed',
  job_hidden: 'dismissed',
  job_ignored: 'shown',
  job_marked_irrelevant: 'rejected',
  job_rejected: 'rejected',
};

export function stateForEvent(event: BehavioralEvent): ExposureState | null {
  return EVENT_STATES[event] ?? null;
}

/** Folds a new observation into an existing exposure record. */
export function advanceExposure(
  current: Exposure,
  next: ExposureState,
  at: Date,
): Exposure {
  const strongest =
    STATE_RANK[next] >= STATE_RANK[current.state] ? next : current.state;

  return {
    ...current,
    state: strongest,
    timesShown: current.timesShown + (next === 'shown' || next === 'notified' ? 1 : 0),
    firstShownAt: current.firstShownAt ?? at,
    lastShownAt: at,
    notifiedAt: next === 'notified' ? at : current.notifiedAt,
  };
}

export function emptyExposure(): Exposure {
  return {
    state: 'never_shown',
    timesShown: 0,
    firstShownAt: null,
    lastShownAt: null,
    notifiedAt: null,
    notifiedContentHash: null,
    notifiedScore: null,
  };
}

/**
 * How much a candidate's history with this *kind* of job should nudge ranking.
 *
 * Returns -1..1 and is applied as a ±5% multiplier by the scorer. Kept
 * deliberately small: explicit preferences already shaped the match score, and
 * behaviour that could move a ranking more than a few percent would be quietly
 * overriding what the candidate actually told us.
 */
export function behavioralAffinity(
  events: ReadonlyArray<{ event: BehavioralEvent; occurredAt: Date }>,
  options: { halfLifeDays?: number; now?: Date } = {},
): number {
  if (events.length === 0) return 0;

  const halfLife = options.halfLifeDays ?? 45;
  const now = options.now ?? new Date();

  let weighted = 0;
  let weight = 0;
  for (const event of events) {
    const polarity = EVENT_POLARITY[event.event] ?? 0;
    if (polarity === 0) continue;
    const ageDays = Math.max(0, (now.getTime() - event.occurredAt.getTime()) / 86_400_000);
    const decay = Math.pow(0.5, ageDays / halfLife);
    weighted += polarity * decay;
    weight += decay;
  }

  if (weight === 0) return 0;
  return Math.max(-1, Math.min(1, weighted / weight));
}

/** True when the candidate has never been shown this job in any form. */
export function isNewToCandidate(exposure: Exposure): boolean {
  return exposure.state === 'never_shown' && exposure.timesShown === 0;
}
