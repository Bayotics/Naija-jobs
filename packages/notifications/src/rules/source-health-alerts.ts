import type { SystemAlertData, SystemAlertSeverity } from '@job-intel/contracts';

/**
 * Source-health alerting.
 *
 * The rule the brief names, and the reason it exists: **do not send an alert
 * for every failed request.** Sources fail transiently all the time; a system
 * that emails on each one trains its reader to ignore the channel, and then the
 * one that mattered goes unread too.
 *
 * So failures escalate: log, then warn, then notify — and only when a source
 * crosses the notify threshold *for the first time*. A source that has been
 * down for a week is not news every hour.
 */

export const HEALTH_ESCALATIONS = ['none', 'log', 'warn', 'notify'] as const;
export type HealthEscalation = (typeof HEALTH_ESCALATIONS)[number];

export interface SourceHealthInput {
  sourceId: string;
  displayName: string;
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: Date | null;
  enabled: boolean;
  /** Failures at the last alert, so re-crossing is distinguishable from staying down. */
  lastAlertedAtFailures: number | null;
}

export interface HealthThresholds {
  logAt: number;
  warnAt: number;
  notifyAt: number;
  /** Re-alert only after this many further consecutive failures. */
  reAlertEvery: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  logAt: 1,
  warnAt: 3,
  notifyAt: 5,
  reAlertEvery: 20,
};

export interface HealthVerdict {
  escalation: HealthEscalation;
  shouldNotify: boolean;
  severity: SystemAlertSeverity;
  reason: string;
}

export function evaluateSourceHealth(
  input: SourceHealthInput,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): HealthVerdict {
  const failures = input.consecutiveFailures;

  if (!input.enabled) {
    return {
      escalation: 'none',
      shouldNotify: false,
      severity: 'info',
      reason: 'source is disabled',
    };
  }
  if (failures < thresholds.logAt) {
    return { escalation: 'none', shouldNotify: false, severity: 'info', reason: 'healthy' };
  }
  if (failures < thresholds.warnAt) {
    return {
      escalation: 'log',
      shouldNotify: false,
      severity: 'info',
      reason: `${failures} consecutive failure(s) — logged only`,
    };
  }
  if (failures < thresholds.notifyAt) {
    return {
      escalation: 'warn',
      shouldNotify: false,
      severity: 'warning',
      reason: `${failures} consecutive failures — warning, not yet notifying`,
    };
  }

  // At or past the notify threshold. Whether to actually send depends on
  // whether we have already said so.
  const alreadyAlerted = input.lastAlertedAtFailures !== null;
  const sinceLastAlert = alreadyAlerted ? failures - (input.lastAlertedAtFailures as number) : failures;
  const shouldNotify = !alreadyAlerted || sinceLastAlert >= thresholds.reAlertEvery;

  return {
    escalation: 'notify',
    shouldNotify,
    severity: failures >= thresholds.notifyAt * 3 ? 'critical' : 'warning',
    reason: shouldNotify
      ? `${failures} consecutive failures`
      : `${failures} consecutive failures, but already alerted at ${input.lastAlertedAtFailures}`,
  };
}

export function buildSourceHealthAlert(
  input: SourceHealthInput,
  verdict: HealthVerdict,
  preferencesUrl: string,
  now = new Date(),
): SystemAlertData {
  const lastSuccess = input.lastSuccessAt
    ? `${Math.round((now.getTime() - input.lastSuccessAt.getTime()) / 3_600_000)} hours ago`
    : 'never';

  return {
    subject: `[${verdict.severity}] ${input.displayName} has failed ${input.consecutiveFailures} times`,
    severity: verdict.severity,
    title: `${input.displayName} is failing`,
    summary:
      `The ${input.displayName} connector has failed ${input.consecutiveFailures} consecutive times. ` +
      `Jobs from this source are not being discovered, so your recommendations may be missing openings.`,
    facts: [
      { label: 'Source', value: input.sourceId },
      { label: 'Consecutive failures', value: String(input.consecutiveFailures) },
      { label: 'Last success', value: lastSuccess },
      { label: 'Last error', value: input.lastError ?? 'not recorded' },
    ],
    suggestedAction:
      'Check the source health page. If the connector needs credentials or the site has changed, ' +
      'disable the source until it is fixed so it stops consuming run budget.',
    preferencesUrl,
    generatedAt: now,
  };
}

/**
 * A generic operational alert.
 *
 * Shares the template and the channel with source-health alerts, but is kept a
 * separate function so a queue-depth warning never has to pretend to be a
 * source failure to get sent.
 */
export function buildSystemAlert(input: {
  title: string;
  summary: string;
  severity: SystemAlertSeverity;
  facts?: Array<{ label: string; value: string }>;
  suggestedAction?: string;
  preferencesUrl: string;
  now?: Date;
}): SystemAlertData {
  return {
    subject: `[${input.severity}] ${input.title}`,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    facts: input.facts ?? [],
    suggestedAction: input.suggestedAction ?? null,
    preferencesUrl: input.preferencesUrl,
    generatedAt: input.now ?? new Date(),
  };
}
