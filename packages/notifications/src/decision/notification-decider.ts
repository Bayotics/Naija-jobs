import {
  PRIORITY_RANK,
  type AlertPriority,
  type AlertRuleMatch,
  type MaterialChangeResult,
  type NotificationDecision,
  type NotificationDecisionOutcome,
  type NotificationPreferences,
} from '@job-intel/contracts';
import { evaluateAlertRules, priorityForScore, type AlertFacts } from '../rules/alert-rules';
import { evaluateQuietHours, evaluateWeekend } from '../scheduling/schedule';

/**
 * The notification decision.
 *
 * Between "the ranking layer says this is good" and "an email exists" sits this
 * function, and it says no far more often than yes. Every candidate gets a
 * recorded outcome — including every suppression, with its reason — because a
 * system whose main behaviour is *staying quiet* is only trustworthy if it can
 * explain each silence.
 *
 * Nothing here sends anything. It returns a decision; the queue and the
 * provider are downstream, and keeping them apart is what stops the ranking
 * layer from ever holding a reference to an email client.
 */

export interface NotificationCandidate {
  jobId: string;
  /** The merged group's representative. Dedup is keyed on this, never `jobId`. */
  canonicalJobId: string;
  companyKey: string;
  sourceId: string;

  recommendationScore: number;
  matchScore: number;
  confidence: number;
  qualityScore: number;
  freshnessHours: number;
  scamRisk: number;
  salaryAnnualUsd: number | null;

  notificationEligible: boolean;
  notificationBlockers: string[];
  lifecycleActive: boolean;
  isDuplicate: boolean;

  applicationUrlPresent: boolean;
  applicationUrlVerified: boolean;
  visaSponsorshipOffered: boolean;
  salaryMeetsTarget: boolean;
  remote: boolean;
  fromAuthoritativeSource: boolean;

  /** Candidate's own verdict, from the exposure record. */
  previouslyRejected: boolean;
  /** Null when never notified. */
  notifiedAt: Date | null;
  materialChange: MaterialChangeResult | null;
}

export interface DecisionContext {
  preferences: NotificationPreferences;
  /** Immediate alerts already sent in the candidate's local day. */
  alertsSentToday: number;
  now?: Date;
}

export interface CandidateDecision {
  candidate: NotificationCandidate;
  outcome: NotificationDecisionOutcome;
  priority: AlertPriority;
  reason: string;
  rule: AlertRuleMatch | null;
  deferredUntil: Date | null;
  /** Set when this is a re-notification of a job already sent. */
  updateNote: string | null;
}

export interface DecisionResult {
  immediate: CandidateDecision[];
  digest: CandidateDecision[];
  suppressed: CandidateDecision[];
  /** Every decision, for the trace table. */
  all: CandidateDecision[];
}

function decide(
  candidate: NotificationCandidate,
  outcome: NotificationDecisionOutcome,
  priority: AlertPriority,
  reason: string,
  extra: Partial<CandidateDecision> = {},
): CandidateDecision {
  return {
    candidate,
    outcome,
    priority,
    reason,
    rule: extra.rule ?? null,
    deferredUntil: extra.deferredUntil ?? null,
    updateNote: extra.updateNote ?? null,
  };
}

function factsFor(candidate: NotificationCandidate): AlertFacts {
  return {
    recommendationScore: candidate.recommendationScore,
    matchScore: candidate.matchScore,
    confidence: candidate.confidence,
    qualityScore: candidate.qualityScore,
    freshnessHours: candidate.freshnessHours,
    salaryAnnualUsd: candidate.salaryAnnualUsd,
    scamRisk: candidate.scamRisk,
    applicationUrlVerified: candidate.applicationUrlVerified,
    applicationUrlPresent: candidate.applicationUrlPresent,
    visaSponsorshipOffered: candidate.visaSponsorshipOffered,
    salaryMeetsTarget: candidate.salaryMeetsTarget,
    remote: candidate.remote,
    lifecycleActive: candidate.lifecycleActive,
    fromAuthoritativeSource: candidate.fromAuthoritativeSource,
    sourceId: candidate.sourceId,
  };
}

/**
 * Decides what happens to every candidate.
 *
 * The order of the checks is the design. Hard disqualifiers first (rejected,
 * duplicate, stale, excluded source), then thresholds, then the alert rules,
 * then the time-of-day policies. Quiet hours are checked *last* among the
 * immediate path because a job that would not have alerted anyway should be
 * recorded as below-threshold, not as quiet-hours — otherwise the trace blames
 * the wrong rule and the candidate loosens the wrong setting.
 */
export function decideNotifications(
  candidates: readonly NotificationCandidate[],
  context: DecisionContext,
): DecisionResult {
  const { preferences } = context;
  const now = context.now ?? new Date();

  const quiet = evaluateQuietHours(now, preferences.quietHours, preferences.timezone);
  const weekend = evaluateWeekend(now, preferences.weekendBehavior, preferences.timezone);

  const immediate: CandidateDecision[] = [];
  const digest: CandidateDecision[] = [];
  const suppressed: CandidateDecision[] = [];

  // Sorted so that when the daily alert budget runs out, it runs out on the
  // weakest candidates rather than on whichever happened to arrive last.
  const ordered = [...candidates].sort((a, b) => b.recommendationScore - a.recommendationScore);

  let alertsUsed = context.alertsSentToday;

  for (const candidate of ordered) {
    // ── Hard disqualifiers ────────────────────────────────────────────────
    if (candidate.previouslyRejected) {
      suppressed.push(
        decide(candidate, 'SUPPRESSED_USER_REJECTED', 'LOW', 'You marked this job as not interesting'),
      );
      continue;
    }

    if (candidate.isDuplicate) {
      suppressed.push(
        decide(
          candidate,
          'SUPPRESSED_DUPLICATE',
          'LOW',
          'This record duplicates a job already under consideration',
        ),
      );
      continue;
    }

    if (!candidate.lifecycleActive) {
      suppressed.push(
        decide(candidate, 'SUPPRESSED_STALE', 'LOW', 'The posting is stale, expired or closed'),
      );
      continue;
    }

    if (preferences.excludedSourceIds.includes(candidate.sourceId)) {
      suppressed.push(
        decide(
          candidate,
          'SUPPRESSED_SOURCE_EXCLUDED',
          'LOW',
          `You excluded ${candidate.sourceId} from notifications`,
        ),
      );
      continue;
    }

    if (!candidate.notificationEligible) {
      suppressed.push(
        decide(
          candidate,
          'SUPPRESSED_NOT_ELIGIBLE',
          'LOW',
          candidate.notificationBlockers[0] ?? 'The ranking layer held this job back',
        ),
      );
      continue;
    }

    if (!candidate.applicationUrlPresent) {
      suppressed.push(
        decide(
          candidate,
          'SUPPRESSED_NO_APPLICATION_URL',
          'LOW',
          'No application URL — there is nowhere to send you',
        ),
      );
      continue;
    }

    // ── Already notified ──────────────────────────────────────────────────
    // Keyed on the canonical id, so the same job re-found through a second
    // source does not produce a second email.
    let updateNote: string | null = null;
    if (candidate.notifiedAt) {
      const change = candidate.materialChange;
      if (!change?.changed) {
        suppressed.push(
          decide(
            candidate,
            'SUPPRESSED_ALREADY_NOTIFIED',
            'LOW',
            'Already sent, and nothing material has changed since',
          ),
        );
        continue;
      }
      updateNote = change.explanation;
    }

    // ── Thresholds ────────────────────────────────────────────────────────
    // Only the checks that actually failed are named, at enough precision to
    // see the comparison. Listing all three rounded produced traces reading
    // "below your thresholds … confidence 50%/50%", which looks like a bug in
    // the system rather than a job that missed by half a percent.
    const failures: string[] = [];
    if (candidate.recommendationScore < preferences.minimumRecommendationScore) {
      failures.push(
        `recommendation ${candidate.recommendationScore.toFixed(1)} < ${preferences.minimumRecommendationScore}`,
      );
    }
    if (candidate.matchScore < preferences.minimumMatchScore) {
      failures.push(`match ${candidate.matchScore.toFixed(1)} < ${preferences.minimumMatchScore}`);
    }
    if (candidate.confidence < preferences.minimumConfidence) {
      failures.push(
        `confidence ${candidate.confidence.toFixed(3)} < ${preferences.minimumConfidence}`,
      );
    }

    if (failures.length > 0) {
      suppressed.push(
        decide(
          candidate,
          'SUPPRESSED_BELOW_THRESHOLD',
          'LOW',
          `Below your threshold: ${failures.join('; ')}`,
        ),
      );
      continue;
    }

    // ── Immediate or digest? ──────────────────────────────────────────────
    const sourceRule = preferences.sourceRules.find((r) => r.sourceId === candidate.sourceId);
    const evaluation = evaluateAlertRules(factsFor(candidate), preferences.alertRules);
    const rule = evaluation.match;

    const wantsImmediate =
      rule !== null &&
      preferences.immediateAlertsEnabled &&
      (sourceRule?.immediate ?? true);

    if (wantsImmediate && rule) {
      const priority = rule.priority;

      if (!weekend.allowImmediate) {
        digest.push(
          decide(candidate, 'QUEUED_FOR_DIGEST', priority, weekend.reason, { rule, updateNote }),
        );
        continue;
      }
      if (weekend.urgentOnly && priority !== 'URGENT') {
        digest.push(
          decide(candidate, 'QUEUED_FOR_DIGEST', priority, weekend.reason, { rule, updateNote }),
        );
        continue;
      }

      if (alertsUsed >= preferences.maxAlertsPerDay) {
        // Not dropped: it falls through to the digest, which is where the
        // brief says the overflow belongs.
        digest.push(
          decide(
            candidate,
            'SUPPRESSED_DAILY_LIMIT',
            priority,
            `Daily alert limit of ${preferences.maxAlertsPerDay} reached; held for the next digest`,
            { rule, updateNote },
          ),
        );
        continue;
      }

      // Quiet hours last, so the trace never blames them for a job that would
      // have been suppressed anyway.
      const overrides = rule.overridesQuietHours && preferences.quietHours.allowUrgentOverride;
      if (quiet.active && !overrides) {
        digest.push(
          decide(candidate, 'DEFERRED_QUIET_HOURS', priority, quiet.reason, {
            rule,
            updateNote,
            deferredUntil: quiet.until,
          }),
        );
        continue;
      }

      alertsUsed += 1;
      immediate.push(
        decide(
          candidate,
          'SENT_IMMEDIATE_ALERT',
          priority,
          quiet.active
            ? `${rule.ruleName} (overriding quiet hours)`
            : `${rule.ruleName}: ${rule.matched.join(', ')}`,
          { rule, updateNote },
        ),
      );
      continue;
    }

    // ── Digest ────────────────────────────────────────────────────────────
    if (sourceRule && !sourceRule.digest) {
      suppressed.push(
        decide(
          candidate,
          'SUPPRESSED_SOURCE_EXCLUDED',
          'LOW',
          `You excluded ${candidate.sourceId} from digests`,
        ),
      );
      continue;
    }

    digest.push(
      decide(
        candidate,
        'QUEUED_FOR_DIGEST',
        priorityForScore(candidate.recommendationScore),
        rule === null ? 'No immediate-alert rule matched; queued for the digest' : 'Queued for the digest',
        { rule, updateNote },
      ),
    );
  }

  return { immediate, digest, suppressed, all: [...immediate, ...digest, ...suppressed] };
}

/**
 * Applies the digest caps.
 *
 * Separate from the per-job decisions above because these depend on the
 * *composition* of the digest: whether a job makes the cut is a question about
 * what else is in it.
 */
export function selectDigestJobs(
  queued: readonly CandidateDecision[],
  preferences: NotificationPreferences,
): { selected: CandidateDecision[]; held: CandidateDecision[] } {
  const selected: CandidateDecision[] = [];
  const held: CandidateDecision[] = [];
  const perCompany = new Map<string, number>();

  const ordered = [...queued].sort((a, b) => {
    const byPriority = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (byPriority !== 0) return byPriority;
    return b.candidate.recommendationScore - a.candidate.recommendationScore;
  });

  for (const decision of ordered) {
    if (selected.length >= preferences.maxJobsPerDigest) {
      held.push({
        ...decision,
        outcome: 'SUPPRESSED_DIGEST_CAP',
        reason: `Digest is full at ${preferences.maxJobsPerDigest} jobs`,
      });
      continue;
    }

    const count = perCompany.get(decision.candidate.companyKey) ?? 0;
    if (count >= preferences.maxPerCompanyPerDigest) {
      held.push({
        ...decision,
        outcome: 'SUPPRESSED_COMPANY_CAP',
        reason: `Already ${count} job(s) from this company in the digest`,
      });
      continue;
    }

    selected.push({ ...decision, outcome: 'INCLUDED_IN_DIGEST' });
    perCompany.set(decision.candidate.companyKey, count + 1);
  }

  return { selected, held };
}

/** Flattens decisions into trace rows. */
export function toDecisionRows(
  decisions: readonly CandidateDecision[],
  now = new Date(),
): NotificationDecision[] {
  return decisions.map((decision) => ({
    jobId: decision.candidate.jobId,
    canonicalJobId: decision.candidate.canonicalJobId,
    outcome: decision.outcome,
    priority: decision.priority,
    reason: decision.reason.slice(0, 400),
    recommendationScore: decision.candidate.recommendationScore,
    matchScore: decision.candidate.matchScore,
    confidence: decision.candidate.confidence,
    deferredUntil: decision.deferredUntil,
    decidedAt: now,
  }));
}
