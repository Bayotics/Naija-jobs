import {
  OVERRIDE_PRECEDENCE,
  URGENCY_RANK,
  suppressionRecordSchema,
  type ApplicationRecommendation,
  type NotificationIntelligenceConfig,
  type NotificationOverride,
  type NotificationScore,
  type NotificationType,
  type OverrideAction,
  type SuppressionReason,
  type SuppressionRecord,
} from '@job-intel/contracts';

/**
 * The suppression engine.
 *
 * Most jobs produce no notification, and that is the system working. What makes
 * it trustworthy rather than merely quiet is that every silence has a recorded
 * reason the candidate can read — and, where possible, the specific setting to
 * change if they disagree.
 *
 * The order of the checks is the design. Facts about the job come first
 * (expired, applied, blocked), then the candidate's explicit instructions, then
 * thresholds, then rate limits, then time-of-day. That order means the reason
 * the candidate is shown is the *first* thing that would have stopped the
 * notification, which is almost always the one they care about. Checking quiet
 * hours first would tell someone their 3am alert was deferred when the real
 * answer is that they had already applied to that job.
 */

export interface SuppressionInput {
  jobId: string;
  candidateId: string;
  companyName: string | null;
  jobTitle: string;
  technologies: readonly string[];
  countryCode: string | null;
  sourceId: string;

  score: NotificationScore;
  recommendation: ApplicationRecommendation | null;

  /** Job facts that can stop a notification outright. */
  expired: boolean;
  isDuplicate: boolean;
  alreadyApplied: boolean;
  previouslyRejected: boolean;
  hardBlocked: boolean;
  suspicious: boolean;
  applicationUrlUsable: boolean;

  /** Notification history for this job and its neighbours. */
  lastNotifiedAt: Date | null;
  lastNotifiedScore: number | null;
  lastCompanyAlertAt: Date | null;
  lastRoleAlertAt: Date | null;
  alertsInRollingDay: number;
  alertsInRollingHour: number;

  /** Set when something about the job changed since the last notification. */
  materialChange: string | null;

  overrides: readonly NotificationOverride[];
  config: NotificationIntelligenceConfig;
  type: NotificationType;
  /** Whether the candidate is currently inside their quiet hours. */
  inQuietHours: boolean;
  quietHoursAllowUrgent: boolean;
  excludedSourceIds: readonly string[];
  now: Date;
}

export type SuppressionOutcome =
  | { suppressed: false; note: string | null }
  | { suppressed: true; record: SuppressionRecord };

const HOUR_MS = 3_600_000;

const hoursSince = (from: Date | null, now: Date): number | null =>
  from === null ? null : (now.getTime() - from.getTime()) / HOUR_MS;

/**
 * Which override applies, resolved deterministically.
 *
 * The conflict the brief names — "never alert me about Company X" against
 * "always alert me about senior React jobs", when Company X posts one — is
 * settled by `OVERRIDE_PRECEDENCE`, and a block wins. Someone who muted a
 * company made a decision about that company; someone who starred a role type
 * expressed an interest. An interest does not override a decision, and a mute
 * that silently stops working is how people learn to distrust every switch in a
 * product.
 */
export function resolveOverride(
  input: Pick<
    SuppressionInput,
    'overrides' | 'companyName' | 'jobTitle' | 'technologies' | 'countryCode' | 'sourceId'
  >,
): { action: OverrideAction; rule: NotificationOverride } | null {
  const matches: NotificationOverride[] = [];

  const matchesValue = (value: string, target: string | null): boolean =>
    target !== null && target.toLowerCase().includes(value.toLowerCase());

  for (const override of input.overrides) {
    const value = override.value;

    const hit =
      (override.subject === 'company' && matchesValue(value, input.companyName)) ||
      (override.subject === 'title' && matchesValue(value, input.jobTitle)) ||
      (override.subject === 'location' && matchesValue(value, input.countryCode)) ||
      (override.subject === 'source' && matchesValue(value, input.sourceId)) ||
      (override.subject === 'technology' &&
        input.technologies.some((slug) => slug.toLowerCase() === value.toLowerCase()));

    if (hit) matches.push(override);
  }

  if (matches.length === 0) return null;

  // Precedence, not recency: a rule written first still wins if it is a block.
  for (const action of OVERRIDE_PRECEDENCE) {
    const rule = matches.find((entry) => entry.action === action);
    if (rule) return { action, rule };
  }

  return null;
}

/**
 * Whether a job that has already been notified may notify again.
 *
 * The rule the brief is firm about: rediscovering the same URL on the next
 * hourly scan is not new information. Something must genuinely have changed —
 * a salary appeared, a deadline moved, the score improved materially — and the
 * change is named in the returned note so the email can say what is new.
 */
export function reNotificationReason(
  input: Pick<
    SuppressionInput,
    'lastNotifiedAt' | 'lastNotifiedScore' | 'materialChange' | 'score' | 'config' | 'now'
  >,
): string | null {
  if (input.lastNotifiedAt === null) return null;
  if (!input.config.reNotifyOnMaterialChange) return null;

  if (input.materialChange) return input.materialChange;

  if (input.lastNotifiedScore !== null) {
    const improvement = input.score.score - input.lastNotifiedScore;
    if (improvement >= input.config.reNotifyMinScoreIncrease) {
      return `Its score rose from ${Math.round(input.lastNotifiedScore)} to ${Math.round(input.score.score)}.`;
    }
  }

  /*
   * A deadline that has come into view is new information even when nothing
   * about the posting changed — the job did not move, but the decision did.
   */
  if (input.score.deadline.bucket === 'under_24h' || input.score.deadline.bucket === 'one_to_three_days') {
    return input.score.deadline.explanation;
  }

  return null;
}

/**
 * Decides whether this job produces a notification.
 *
 * Returns the suppression record when it does not, complete with the setting
 * responsible and what to change. Part 32's requirement is that a candidate can
 * ask "why didn't I hear about this?" and get a straight answer, and a reason
 * without a remedy is only half of one.
 */
export function evaluateSuppression(input: SuppressionInput): SuppressionOutcome {
  const suppress = (
    reason: SuppressionReason,
    detail: string,
    setting: string | null = null,
    remedy: string | null = null,
    thresholdApplied: number | null = null,
  ): SuppressionOutcome => ({
    suppressed: true,
    record: suppressionRecordSchema.parse({
      jobId: input.jobId,
      candidateId: input.candidateId,
      reason,
      detail: detail.slice(0, 400),
      setting,
      remedy: remedy === null ? null : remedy.slice(0, 300),
      notificationScore: input.score.score,
      thresholdApplied,
      occurredAt: input.now,
    }),
  });

  // ── 1. Facts about the job ──────────────────────────────────────────────
  if (input.expired) {
    return suppress(
      'expired',
      'This posting has closed, so there is nothing to apply to.',
      null,
      null,
    );
  }

  if (input.alreadyApplied) {
    return suppress('already_applied', 'You have already applied to this role.', null, null);
  }

  if (input.hardBlocked) {
    return suppress(
      'hard_blocked',
      'The application analysis found a requirement this posting states that your profile says you do not meet.',
      null,
      'Open the job to review the blocker — if it is wrong you can clear it there.',
    );
  }

  if (input.isDuplicate) {
    return suppress(
      'duplicate',
      'This is the same role as another posting you have already been shown.',
      null,
      null,
    );
  }

  if (input.suspicious) {
    return suppress(
      'suspicious',
      'This posting matches patterns associated with fraudulent listings, so it was not emailed.',
      null,
      'It is still on your dashboard if you want to judge for yourself.',
    );
  }

  if (input.previouslyRejected && input.materialChange === null) {
    return suppress(
      'previously_rejected',
      'You dismissed this role, and nothing about it has changed since.',
      null,
      null,
    );
  }

  /*
   * No usable application link.
   *
   * Emailing a job the candidate cannot act on wastes the interruption. It
   * still appears on the dashboard, where the cost of being wrong is lower.
   */
  if (!input.applicationUrlUsable) {
    return suppress(
      'no_application_url',
      'No working application link could be resolved for this posting.',
      null,
      'It is on your dashboard, where you can follow the source link yourself.',
    );
  }

  // ── 2. The candidate's explicit instructions ────────────────────────────
  const override = resolveOverride(input);

  if (override?.action === 'never_alert') {
    return suppress(
      'override_never_alert',
      `You asked never to be alerted about ${override.rule.subject} "${override.rule.value}".`,
      'notification overrides',
      'Remove the rule if you have changed your mind.',
    );
  }

  if (input.excludedSourceIds.includes(input.sourceId)) {
    return suppress(
      'source_excluded',
      `You excluded ${input.sourceId} from notifications.`,
      'excluded sources',
      'Re-enable the source in your notification settings.',
    );
  }

  const typeSetting = input.config.typeSettings[input.type];
  if (typeSetting && !typeSetting.enabled) {
    return suppress(
      'type_disabled',
      `${input.type.replace(/_/g, ' ').toLowerCase()} notifications are switched off.`,
      `type: ${input.type}`,
      'Enable this notification type in your settings.',
    );
  }

  // ── 3. Recommendation floor ─────────────────────────────────────────────
  const recommendationRank: Record<string, number> = {
    BLOCKED: 0,
    UNKNOWN: 1,
    SKIP: 2,
    CONSIDER: 3,
    APPLY: 4,
    APPLY_NOW: 5,
  };

  if (input.recommendation !== null) {
    const actual = recommendationRank[input.recommendation] ?? 0;
    const required = recommendationRank[input.config.minimumRecommendation] ?? 3;

    if (actual < required) {
      return suppress(
        'recommendation_too_low',
        `The application analysis says ${input.recommendation}, and you asked to hear about ${input.config.minimumRecommendation} or better.`,
        'minimum recommendation',
        `Lower the minimum recommendation if you want to see ${input.recommendation} jobs too.`,
      );
    }
  }

  // ── 4. Thresholds ───────────────────────────────────────────────────────
  const thresholds = input.config.thresholds;

  /*
   * An `always_alert` override skips the threshold, not the facts.
   *
   * The candidate asked to hear about this kind of job, so a score below their
   * general bar is not a reason to stay quiet. Everything above — expired,
   * applied, blocked, fraudulent — still applies, because those are not matters
   * of taste.
   */
  const forced = override?.action === 'always_alert';

  if (!forced && input.score.score < thresholds.dashboard) {
    return suppress(
      'below_threshold',
      `This scored ${Math.round(input.score.score)} and your dashboard threshold is ${thresholds.dashboard}.`,
      'dashboard threshold',
      `Lower the dashboard threshold below ${Math.round(input.score.score)} to see jobs like this.`,
      thresholds.dashboard,
    );
  }

  // ── 5. Cooldowns and rate limits ────────────────────────────────────────
  const cooldowns = input.config.cooldowns;

  const sinceJob = hoursSince(input.lastNotifiedAt, input.now);
  if (sinceJob !== null && sinceJob < cooldowns.sameJobHours) {
    const reason = reNotificationReason(input);

    if (!reason) {
      return suppress(
        'cooldown_job',
        `You were told about this ${Math.round(sinceJob)} hours ago and nothing has changed since.`,
        'same-job cooldown',
        null,
      );
    }

    // Something genuinely changed. Falls through, and the note reaches the email.
    return { suppressed: false, note: reason };
  }

  const sinceCompany = hoursSince(input.lastCompanyAlertAt, input.now);
  if (
    !forced &&
    sinceCompany !== null &&
    sinceCompany < cooldowns.sameCompanyHours &&
    input.score.urgency !== 'CRITICAL'
  ) {
    return suppress(
      'cooldown_company',
      `You had an alert about ${input.companyName ?? 'this company'} ${Math.round(sinceCompany)} hours ago.`,
      'same-company cooldown',
      'Shorten the company cooldown if you want several alerts from one employer.',
    );
  }

  const sinceRole = hoursSince(input.lastRoleAlertAt, input.now);
  if (
    !forced &&
    sinceRole !== null &&
    sinceRole < cooldowns.sameRoleHours &&
    input.score.urgency !== 'CRITICAL'
  ) {
    return suppress(
      'cooldown_role',
      `You had an alert about a similar role ${Math.round(sinceRole)} hours ago.`,
      'same-role cooldown',
      null,
    );
  }

  if (!forced && input.alertsInRollingHour >= cooldowns.maxAlertsPerRollingHour) {
    return suppress(
      'hourly_limit',
      `You have had ${input.alertsInRollingHour} alerts in the last hour, which is your limit.`,
      'alerts per hour',
      'Raise the hourly limit, or let this arrive in your next digest.',
    );
  }

  if (!forced && input.alertsInRollingDay >= cooldowns.maxAlertsPerRollingDay) {
    return suppress(
      'daily_limit',
      `You have had ${input.alertsInRollingDay} alerts today, which is your limit.`,
      'alerts per day',
      'Raise the daily limit, or let this arrive in your next digest.',
    );
  }

  // ── 6. Time of day ──────────────────────────────────────────────────────
  /*
   * Quiet hours are checked last among the blocking conditions.
   *
   * A job that would not have alerted anyway must not be recorded as
   * quiet-hours-deferred — otherwise the trace blames the wrong setting and the
   * candidate loosens the wrong one. By this point the job would genuinely have
   * been sent.
   */
  if (input.inQuietHours) {
    const mayInterrupt =
      input.quietHoursAllowUrgent && input.score.urgency === 'CRITICAL';

    if (!mayInterrupt) {
      return suppress(
        'quiet_hours',
        'This arrived during your quiet hours, so it is held for your next digest.',
        'quiet hours',
        'Allow urgent alerts to interrupt quiet hours if you want deadline alerts overnight.',
      );
    }
  }

  return { suppressed: false, note: null };
}

/** Whether a score and urgency clear the instant-alert bar. */
export function qualifiesForInstant(
  score: NotificationScore,
  config: NotificationIntelligenceConfig,
): boolean {
  return (
    score.score >= config.thresholds.instant &&
    URGENCY_RANK[score.urgency] >= URGENCY_RANK[config.thresholds.minimumUrgencyForInstant] &&
    // A high score from thin evidence is a guess, and guesses do not interrupt.
    score.confidence >= config.thresholds.minimumConfidenceForInstant
  );
}

/** Whether a score clears the digest bar. */
export function qualifiesForDigest(
  score: NotificationScore,
  config: NotificationIntelligenceConfig,
): boolean {
  return score.score >= config.thresholds.digest;
}

/**
 * Human-readable answer to "why didn't I hear about this?".
 *
 * Assembled from the stored record rather than recomputed, so the answer the
 * candidate reads is the one that was actually applied at the time.
 */
export function explainSuppression(record: SuppressionRecord): string {
  const parts = [record.detail];

  if (record.thresholdApplied !== null && record.notificationScore !== null) {
    parts.push(
      `It scored ${Math.round(record.notificationScore)} against a threshold of ${record.thresholdApplied}.`,
    );
  }

  if (record.remedy) parts.push(record.remedy);

  return parts.join(' ');
}
