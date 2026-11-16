import type {
  Exposure,
  FreshnessScore,
  LifecycleStatus,
  MaterialChangeResult,
  NotificationBlocker,
  NotificationEligibility,
  NotificationPolicy,
  RecommendationTier,
  ScamAssessment,
} from '@job-intel/contracts';
import { NOTIFIABLE_TIERS } from '../ranking/categories';

/**
 * Notification eligibility.
 *
 * The gate between "we ranked this" and "we will interrupt someone about it".
 * It is deliberately separate from ranking, and deliberately strict: the user's
 * stated requirement for this whole layer was *not* receiving hundreds of
 * emails, and every rule here exists to make an unwanted email impossible
 * rather than unlikely.
 *
 * Every blocker is collected rather than short-circuiting on the first. "Why
 * wasn't I told about this job?" needs the complete answer — a list that stops
 * at the first reason sends the operator round the loop once per rule.
 *
 * Per-digest caps (company, source, total) are **not** decided here: they
 * depend on what else is in the same digest, so they belong to the selection
 * pass in the engine. This function judges one job on its own merits.
 */

export interface NotificationEligibilityInput {
  tier: RecommendationTier;
  score: number;
  confidence: number;
  /** From the matching engine. A hard-constraint failure is absolute. */
  matchEligible: boolean;
  lifecycle: LifecycleStatus;
  freshness: FreshnessScore;
  scam: ScamAssessment;
  exposure: Exposure;
  /** Set when this record is a merged duplicate of another. */
  duplicateOf: string | null;
  applicationUrlPresent: boolean;
  applicationUrlReachable: boolean | null;
  /** Computed against the snapshot taken when the job was last notified. */
  materialChange: MaterialChangeResult | null;
  now?: Date;
}

export function evaluateNotificationEligibility(
  input: NotificationEligibilityInput,
  policy: NotificationPolicy,
): NotificationEligibility {
  const now = input.now ?? new Date();
  const blockers: NotificationBlocker[] = [];
  const reasons: string[] = [];
  let renotifyReason: string | null = null;

  const block = (blocker: NotificationBlocker, reason: string) => {
    blockers.push(blocker);
    reasons.push(reason);
  };

  // ── Hard constraints from the matching engine ───────────────────────────
  if (!input.matchEligible) {
    block('ineligible_match', 'The job fails one of your non-negotiable requirements');
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────
  if (!policy.allowedLifecycleStatuses.includes(input.lifecycle)) {
    block('not_active', `Job status is ${input.lifecycle}`);
  }

  // ── Duplicate ───────────────────────────────────────────────────────────
  if (input.duplicateOf !== null) {
    block('duplicate', 'This record duplicates another job already under consideration');
  }

  // ── Candidate's own verdicts ────────────────────────────────────────────
  if (input.exposure.state === 'rejected') {
    block('previously_rejected', 'You marked this job as not interesting');
  }
  if (input.exposure.state === 'dismissed') {
    block('previously_dismissed', 'You dismissed this job');
  }

  // ── Score and confidence ────────────────────────────────────────────────
  if (input.score < policy.minimumScore) {
    // One decimal, not rounded: a live run produced "score 55 is below your
    // threshold of 55", which reads as a contradiction and makes the whole
    // explanation look broken.
    block(
      'below_score_threshold',
      `Recommendation score ${input.score.toFixed(1)} is below your threshold of ${policy.minimumScore}`,
    );
  }
  if (input.confidence < policy.minimumConfidence) {
    block(
      'below_confidence_threshold',
      `Confidence ${Math.round(input.confidence * 100)}% is below your threshold of ${Math.round(policy.minimumConfidence * 100)}%`,
    );
  }
  if (!NOTIFIABLE_TIERS.has(input.tier)) {
    block('below_score_threshold', `Tier ${input.tier} is not notifiable`);
  }

  // ── Freshness window ────────────────────────────────────────────────────
  if (
    policy.freshnessWindowHours !== null &&
    input.freshness.ageHours > policy.freshnessWindowHours
  ) {
    block(
      'outside_freshness_window',
      `Posted ${Math.round(input.freshness.ageHours)}h ago, outside your ${policy.freshnessWindowHours}h window`,
    );
  }

  // ── Application path ────────────────────────────────────────────────────
  if (policy.requireApplicationPath) {
    if (!input.applicationUrlPresent) {
      block('no_application_path', 'No application URL — there is nowhere to send you');
    } else if (input.applicationUrlReachable === false) {
      block('no_application_path', 'The application URL did not resolve when checked');
    }
  }

  // ── Scam risk ───────────────────────────────────────────────────────────
  if (input.scam.risk > policy.maxScamRisk) {
    block('scam_risk', `Scam risk ${input.scam.risk.toFixed(2)}: ${input.scam.explanation}`);
  }

  // ── Already notified ────────────────────────────────────────────────────
  if (input.exposure.notifiedAt) {
    const hoursSince = (now.getTime() - input.exposure.notifiedAt.getTime()) / 3_600_000;
    const change = input.materialChange;

    if (hoursSince < policy.renotifyCooldownHours) {
      block(
        'already_notified',
        `Notified ${Math.round(hoursSince)}h ago; inside the ${policy.renotifyCooldownHours}h cooldown`,
      );
    } else if (!change?.changed) {
      block('already_notified', 'Already notified and nothing material has changed since');
    } else if (change.maxSignificance < policy.renotifyMinSignificance) {
      block(
        'already_notified',
        `Already notified; the changes since are too minor to justify another email (${change.explanation})`,
      );
    } else {
      // Survives as a re-notification, and the reason travels with it so the
      // eventual email can say why the job is appearing again.
      renotifyReason = change.explanation;
      reasons.push(`Re-notifying because: ${change.explanation}`);
    }
  }

  return {
    eligible: blockers.length === 0,
    blockers: [...new Set(blockers)],
    reasons,
    renotifyReason,
  };
}

/**
 * Per-digest caps.
 *
 * Applied over an already-ranked, already-eligible list. Separate from the
 * per-job rules above because these are decisions about the *set*: whether a
 * job makes the cut depends entirely on what else is in it.
 */
export interface DigestSelectionItem {
  jobId: string;
  companyKey: string;
  sourceId: string;
  score: number;
}

export interface DigestSelection<T extends DigestSelectionItem> {
  selected: T[];
  held: Array<{ item: T; blocker: NotificationBlocker; reason: string }>;
}

export function applyDigestCaps<T extends DigestSelectionItem>(
  ranked: readonly T[],
  policy: NotificationPolicy,
): DigestSelection<T> {
  const selected: T[] = [];
  const held: DigestSelection<T>['held'] = [];
  const perCompany = new Map<string, number>();
  const perSource = new Map<string, number>();

  for (const item of ranked) {
    if (selected.length >= policy.maxPerDigest) {
      held.push({
        item,
        blocker: 'digest_cap_reached',
        reason: `digest is full at ${policy.maxPerDigest}`,
      });
      continue;
    }

    const companyCount = perCompany.get(item.companyKey) ?? 0;
    if (companyCount >= policy.maxPerCompanyPerDigest) {
      held.push({
        item,
        blocker: 'company_cap_reached',
        reason: `already ${companyCount} job(s) from this company in the digest`,
      });
      continue;
    }

    const sourceCount = perSource.get(item.sourceId) ?? 0;
    if (sourceCount >= policy.maxPerSourcePerDigest) {
      held.push({
        item,
        blocker: 'source_cap_reached',
        reason: `already ${sourceCount} job(s) from this source in the digest`,
      });
      continue;
    }

    selected.push(item);
    perCompany.set(item.companyKey, companyCount + 1);
    perSource.set(item.sourceId, sourceCount + 1);
  }

  return { selected, held };
}
