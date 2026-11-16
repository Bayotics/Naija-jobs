import { z } from 'zod';
import { timezoneSchema } from './common';

/**
 * Notification engine contracts.
 *
 * The system exists to solve one stated problem: **tell me about the best jobs
 * without spamming me.** Every decision here is downstream of that.
 *
 * Two modes, deliberately different:
 *
 *   DIGEST    — a periodic summary. Ordinary 75-85 matches wait for it.
 *   IMMEDIATE — an interrupt. Reserved for opportunities that genuinely should
 *               not wait an hour, and rate-limited so "exceptional" stays rare.
 *
 * The pipeline is a chain of *decisions*, not a chain of sends:
 *
 *   recommendation → eligibility → decision → event → queue → render →
 *   provider → delivery tracking
 *
 * The recommendation engine never touches an email provider. It cannot: it has
 * no reference to one, and this file is where that separation is expressed.
 */

/** Bumped when notification behaviour changes, so old decisions stay readable. */
export const NOTIFICATION_ENGINE_VERSION = '1.0.0';

// ── Notification types ──────────────────────────────────────────────────────

/**
 * Extensible by construction: a new type is a member here, a template in the
 * renderer and a row in the settings table. No pipeline change.
 */
export const NOTIFICATION_TYPES = [
  'JOB_ALERT',
  'JOB_DIGEST',
  'SYSTEM_ALERT',
  'SOURCE_FAILURE',
  'CRAWLER_HEALTH_ALERT',
  'WEEKLY_SUMMARY',
  /*
   * Added by the notification intelligence layer.
   *
   * `JOB_DIGEST` stays as the generic digest type and the two below are its
   * cadence-specific forms, because a daily and a weekly digest are different
   * products — one is "here is today", the other is "here is the shape of the
   * week" — and a candidate who wants one frequently does not want the other.
   */
  'DAILY_DIGEST',
  'WEEKLY_DIGEST',
  'PREFERENCE_SUGGESTION',
  'APPLICATION_REMINDER',
  'APPLICATION_DEADLINE',
  'JOB_EXPIRING',
  'LEARNING_INSIGHT',
  'SEARCH_COVERAGE_ALERT',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Job-bearing types. The rest are operational and bypass job dedup entirely. */
export const JOB_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  'JOB_ALERT',
  'JOB_DIGEST',
]);

// ── Priority ────────────────────────────────────────────────────────────────

export const ALERT_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type AlertPriority = (typeof ALERT_PRIORITIES)[number];

export const PRIORITY_RANK: Readonly<Record<AlertPriority, number>> = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3,
};

// ── Digest cadence ──────────────────────────────────────────────────────────

export const DIGEST_FREQUENCIES = [
  'every_15_minutes',
  'every_30_minutes',
  'hourly',
  'every_2_hours',
  'every_6_hours',
  'twice_daily',
  'daily',
  'weekly',
  /*
   * Nothing is ever sent on a schedule.
   *
   * The dashboard still fills up; the candidate reads it when they choose.
   * Worth supporting explicitly rather than expecting someone to disable every
   * type individually to get the same effect.
   */
  'manual',
] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

/** Interval in minutes. `daily` and `weekly` also honour a configured hour. */
export const FREQUENCY_MINUTES: Readonly<Record<DigestFrequency, number>> = {
  every_15_minutes: 15,
  every_30_minutes: 30,
  hourly: 60,
  every_2_hours: 120,
  every_6_hours: 360,
  twice_daily: 720,
  daily: 1440,
  weekly: 10_080,
  // Never fires on its own. The scheduler treats this as "no next run".
  manual: Number.POSITIVE_INFINITY,
};

export const WEEKEND_BEHAVIORS = ['normal', 'digest_only', 'urgent_only', 'silent'] as const;
export type WeekendBehavior = (typeof WEEKEND_BEHAVIORS)[number];

// ── Decision trace ──────────────────────────────────────────────────────────

/**
 * What happened to one notification candidate, and why.
 *
 * Recorded for **every** candidate including the suppressed ones. "Why didn't I
 * hear about this job?" is the question that makes or breaks trust in a system
 * that deliberately stays quiet, and it cannot be answered from a log line that
 * was never written.
 */
export const NOTIFICATION_DECISIONS = [
  'SENT_IMMEDIATE_ALERT',
  'INCLUDED_IN_DIGEST',
  'QUEUED_FOR_DIGEST',
  'SUPPRESSED_ALREADY_NOTIFIED',
  'SUPPRESSED_BELOW_THRESHOLD',
  'SUPPRESSED_QUIET_HOURS',
  'SUPPRESSED_USER_REJECTED',
  'SUPPRESSED_DAILY_LIMIT',
  'SUPPRESSED_DIGEST_CAP',
  'SUPPRESSED_COMPANY_CAP',
  'SUPPRESSED_SOURCE_EXCLUDED',
  'SUPPRESSED_NOT_ELIGIBLE',
  'SUPPRESSED_DUPLICATE',
  'SUPPRESSED_STALE',
  'SUPPRESSED_WEEKEND_POLICY',
  'SUPPRESSED_ALERTS_DISABLED',
  'SUPPRESSED_NO_APPLICATION_URL',
  'DEFERRED_QUIET_HOURS',
] as const;
export type NotificationDecisionOutcome = (typeof NOTIFICATION_DECISIONS)[number];

export const notificationDecisionSchema = z.object({
  jobId: z.string().uuid().nullable().default(null),
  /** Canonical id when the job was merged — see the dedup note below. */
  canonicalJobId: z.string().uuid().nullable().default(null),
  outcome: z.enum(NOTIFICATION_DECISIONS),
  priority: z.enum(ALERT_PRIORITIES).nullable().default(null),
  reason: z.string().max(400),
  recommendationScore: z.number().min(0).max(100).nullable().default(null),
  matchScore: z.number().min(0).max(100).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  /** Set when the decision releases the job at a later time. */
  deferredUntil: z.coerce.date().nullable().default(null),
  decidedAt: z.coerce.date(),
});
export type NotificationDecision = z.infer<typeof notificationDecisionSchema>;

// ── Alert rules ─────────────────────────────────────────────────────────────

/**
 * A configurable rule.
 *
 * Conditions are a fixed vocabulary of comparisons against structured fields —
 * not an expression language. That is a deliberate limit: an eval-style DSL
 * reachable from stored configuration is an injection surface, and every rule
 * anyone has actually wanted is expressible as a conjunction of these.
 */
export const RULE_FIELDS = [
  'recommendationScore',
  'matchScore',
  'confidence',
  'qualityScore',
  'freshnessHours',
  'salaryAnnualUsd',
  'scamRisk',
] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export const RULE_FLAGS = [
  'applicationUrlVerified',
  'applicationUrlPresent',
  'visaSponsorshipOffered',
  'salaryMeetsTarget',
  'remote',
  'lifecycleActive',
  'fromAuthoritativeSource',
] as const;
export type RuleFlag = (typeof RULE_FLAGS)[number];

export const alertRuleConditionSchema = z.object({
  field: z.enum(RULE_FIELDS),
  operator: z.enum(['gte', 'lte', 'gt', 'lt', 'eq']),
  value: z.number(),
});
export type AlertRuleCondition = z.infer<typeof alertRuleConditionSchema>;

export const alertRuleSchema = z.object({
  id: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  priority: z.enum(ALERT_PRIORITIES).default('HIGH'),
  /** All must hold. Conjunction only — see the note above. */
  conditions: z.array(alertRuleConditionSchema).default([]),
  /** Boolean facts that must all be true. */
  requireFlags: z.array(z.enum(RULE_FLAGS)).default([]),
  /** Boolean facts that must all be false. */
  forbidFlags: z.array(z.enum(RULE_FLAGS)).default([]),
  /** Restricts the rule to specific sources, e.g. company careers pages only. */
  sourceIds: z.array(z.string().trim().max(120)).default([]),
  /** May an alert from this rule interrupt quiet hours? */
  overridesQuietHours: z.boolean().default(false),
});
export type AlertRule = z.infer<typeof alertRuleSchema>;

/**
 * Defaults.
 *
 * Two rules, both narrow. The point of an immediate alert is that it is rare —
 * a threshold loose enough to fire often turns the interrupt channel into a
 * second digest that arrives at 3am.
 */
export const DEFAULT_ALERT_RULES: AlertRule[] = [
  {
    id: 'exceptional-verified',
    name: 'Exceptional match with a verified application URL',
    enabled: true,
    priority: 'URGENT',
    conditions: [
      { field: 'recommendationScore', operator: 'gte', value: 92 },
      { field: 'confidence', operator: 'gte', value: 0.8 },
    ],
    requireFlags: ['applicationUrlVerified', 'lifecycleActive'],
    forbidFlags: [],
    sourceIds: [],
    overridesQuietHours: true,
  },
  {
    id: 'strong-match',
    name: 'Very strong match from a trustworthy source',
    enabled: true,
    priority: 'HIGH',
    conditions: [
      { field: 'recommendationScore', operator: 'gte', value: 85 },
      { field: 'confidence', operator: 'gte', value: 0.7 },
    ],
    requireFlags: ['applicationUrlPresent', 'lifecycleActive'],
    forbidFlags: [],
    sourceIds: [],
    overridesQuietHours: false,
  },
];

export const alertRuleMatchSchema = z.object({
  ruleId: z.string().max(60),
  ruleName: z.string().max(120),
  priority: z.enum(ALERT_PRIORITIES),
  overridesQuietHours: z.boolean(),
  /** Each satisfied condition, in the form it was evaluated. */
  matched: z.array(z.string().max(200)).default([]),
});
export type AlertRuleMatch = z.infer<typeof alertRuleMatchSchema>;

// ── Preferences ─────────────────────────────────────────────────────────────

/** `HH:MM`, 24-hour, in the candidate's timezone. */
export const clockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM in 24-hour form');

export const quietHoursSchema = z.object({
  enabled: z.boolean().default(false),
  start: clockTimeSchema.default('23:00'),
  end: clockTimeSchema.default('07:00'),
  /**
   * Whether a rule marked `overridesQuietHours` may still interrupt.
   *
   * Two switches rather than one: the rule says "this is the kind of thing
   * worth waking someone for", the candidate says "and I agree". Either alone
   * would be someone else deciding when your phone lights up at 3am.
   */
  allowUrgentOverride: z.boolean().default(true),
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

export const sourceNotificationRuleSchema = z.object({
  sourceId: z.string().trim().min(1).max(120),
  /** Immediate alerts allowed from this source. */
  immediate: z.boolean().default(true),
  /** Included in digests. */
  digest: z.boolean().default(true),
});
export type SourceNotificationRule = z.infer<typeof sourceNotificationRuleSchema>;

/**
 * Everything the candidate controls.
 *
 * Data, not constants. Changing any of it is a database write — the same
 * property the preference and matching layers were built around, and for the
 * same reason: the person being emailed at 7am should not need a deploy to
 * make it 9am.
 */
export const notificationPreferencesSchema = z.object({
  schemaVersion: z.literal(1).default(1),

  email: z.string().trim().email().nullable().default(null),
  timezone: timezoneSchema.default('UTC'),

  digestEnabled: z.boolean().default(true),
  digestFrequency: z.enum(DIGEST_FREQUENCIES).default('daily'),
  /** For `daily`/`weekly`: the local hour and minute to send at. */
  digestTime: clockTimeSchema.default('08:00'),
  /** 0 = Sunday. Only meaningful for `weekly`. */
  digestDayOfWeek: z.number().int().min(0).max(6).default(1),
  maxJobsPerDigest: z.number().int().min(1).max(100).default(10),
  maxPerCompanyPerDigest: z.number().int().min(1).max(20).default(2),

  immediateAlertsEnabled: z.boolean().default(true),
  maxAlertsPerDay: z.number().int().min(0).max(100).default(5),

  minimumMatchScore: z.number().min(0).max(100).default(70),
  minimumConfidence: z.number().min(0).max(1).default(0.5),
  minimumRecommendationScore: z.number().min(0).max(100).default(64),

  quietHours: quietHoursSchema.default({}),
  weekendBehavior: z.enum(WEEKEND_BEHAVIORS).default('normal'),

  /** Per-source overrides, checked before the global switches. */
  sourceRules: z.array(sourceNotificationRuleSchema).default([]),
  /** Sources excluded from every notification, whatever they contain. */
  excludedSourceIds: z.array(z.string().trim().max(120)).default([]),

  alertRules: z.array(alertRuleSchema).default(DEFAULT_ALERT_RULES),

  weeklySummaryEnabled: z.boolean().default(false),
  systemAlertsEnabled: z.boolean().default(true),
  /** Consecutive source failures before an operational alert is raised. */
  sourceFailureAlertThreshold: z.number().int().min(1).max(50).default(5),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

// ── Rendered payloads ───────────────────────────────────────────────────────

/**
 * One job as an email shows it.
 *
 * Every field is a value read from structured data. Nothing here is generated
 * prose, which is the guard against an email confidently claiming a salary the
 * posting never stated.
 */
export const jobCardDataSchema = z.object({
  jobId: z.string().uuid(),
  title: z.string().max(300),
  company: z.string().max(300),
  location: z.string().max(200).nullable().default(null),
  workArrangement: z.string().max(40).nullable().default(null),
  salary: z.string().max(120).nullable().default(null),

  matchScore: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  recommendationScore: z.number().min(0).max(100),
  tier: z.string().max(40),

  whyItMatches: z.array(z.string().max(200)).default([]),
  concerns: z.array(z.string().max(200)).default([]),
  matchedSkills: z.array(z.string().max(80)).default([]),
  missingRequirements: z.array(z.string().max(120)).default([]),

  sourceId: z.string().max(120),
  sourceLabel: z.string().max(120),
  postedAgo: z.string().max(60),
  /** The best available application path, and how sure we are of it. */
  applyUrl: z.string().max(2000),
  applyUrlKind: z.enum(['ats', 'company', 'source', 'aggregator', 'unverified']),
  applyUrlVerified: z.boolean().default(false),
  viewUrl: z.string().max(2000),

  /** Set when this is an update to a job already sent. */
  updateNote: z.string().max(300).nullable().default(null),
});
export type JobCardData = z.infer<typeof jobCardDataSchema>;

export const digestSectionSchema = z.object({
  key: z.string().max(40),
  icon: z.string().max(8),
  title: z.string().max(80),
  jobs: z.array(jobCardDataSchema).default([]),
});
export type DigestSection = z.infer<typeof digestSectionSchema>;

export const digestDataSchema = z.object({
  subject: z.string().max(300),
  periodLabel: z.string().max(120),
  jobsDiscovered: z.number().int().min(0),
  highQualityMatches: z.number().int().min(0),
  sections: z.array(digestSectionSchema).default([]),
  preferencesUrl: z.string().max(2000),
  generatedAt: z.coerce.date(),
});
export type DigestData = z.infer<typeof digestDataSchema>;

export const alertDataSchema = z.object({
  subject: z.string().max(300),
  priority: z.enum(ALERT_PRIORITIES),
  headline: z.string().max(120),
  job: jobCardDataSchema,
  ruleName: z.string().max(120),
  preferencesUrl: z.string().max(2000),
  generatedAt: z.coerce.date(),
});
export type AlertData = z.infer<typeof alertDataSchema>;

export const SYSTEM_ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type SystemAlertSeverity = (typeof SYSTEM_ALERT_SEVERITIES)[number];

export const systemAlertDataSchema = z.object({
  subject: z.string().max(300),
  severity: z.enum(SYSTEM_ALERT_SEVERITIES),
  title: z.string().max(200),
  summary: z.string().max(1000),
  facts: z.array(z.object({ label: z.string().max(80), value: z.string().max(300) })).default([]),
  suggestedAction: z.string().max(400).nullable().default(null),
  preferencesUrl: z.string().max(2000),
  generatedAt: z.coerce.date(),
});
export type SystemAlertData = z.infer<typeof systemAlertDataSchema>;

export const weeklySummaryDataSchema = z.object({
  subject: z.string().max(300),
  periodLabel: z.string().max(120),
  stats: z.object({
    jobsDiscovered: z.number().int().min(0),
    jobsRecommended: z.number().int().min(0),
    jobsNotified: z.number().int().min(0),
    jobsSaved: z.number().int().min(0),
    jobsClicked: z.number().int().min(0),
    jobsApplied: z.number().int().min(0),
    duplicatesMerged: z.number().int().min(0),
    staleJobs: z.number().int().min(0),
    averageMatchScore: z.number().min(0).max(100),
  }),
  topCompanies: z.array(z.object({ label: z.string().max(200), count: z.number().int() })).default([]),
  topLocations: z.array(z.object({ label: z.string().max(200), count: z.number().int() })).default([]),
  topTechnologies: z.array(z.object({ label: z.string().max(200), count: z.number().int() })).default([]),
  bestSources: z
    .array(z.object({ label: z.string().max(200), count: z.number().int(), averageScore: z.number() }))
    .default([]),
  preferencesUrl: z.string().max(2000),
  generatedAt: z.coerce.date(),
});
export type WeeklySummaryData = z.infer<typeof weeklySummaryDataSchema>;

// ── Rendered email ──────────────────────────────────────────────────────────

export const renderedEmailSchema = z.object({
  subject: z.string().max(300),
  html: z.string(),
  /** Always present. A text part is not optional for deliverability. */
  text: z.string(),
  /** Stable across re-renders of the same content; the send key. */
  idempotencyKey: z.string().max(120),
});
export type RenderedEmail = z.infer<typeof renderedEmailSchema>;

// ── Provider ────────────────────────────────────────────────────────────────

export const emailSendResultSchema = z.object({
  accepted: z.boolean(),
  providerMessageId: z.string().max(255).nullable().default(null),
  /** True when the failure is worth retrying. A 4xx address error is not. */
  retryable: z.boolean().default(false),
  error: z.string().max(500).nullable().default(null),
});
export type EmailSendResult = z.infer<typeof emailSendResultSchema>;

export const DELIVERY_EVENTS = [
  'created',
  'queued',
  'sending',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'failed',
  'bounced',
  'complained',
] as const;
export type DeliveryEvent = (typeof DELIVERY_EVENTS)[number];

// ── Runtime config ──────────────────────────────────────────────────────────

export const notificationEngineConfigSchema = z.object({
  /** Attempts before a delivery is abandoned. */
  maxAttempts: z.number().int().min(1).max(10).default(5),
  baseRetryDelayMs: z.number().int().min(100).max(600_000).default(2000),
  maxRetryDelayMs: z.number().int().min(1000).max(3_600_000).default(300_000),
  /** Emails per provider batch call. */
  batchSize: z.number().int().min(1).max(100).default(20),
  /** Base URL for links in emails. */
  appUrl: z.string().max(500).default('http://localhost:3000'),
  /** Sender identity; the address itself comes from the environment. */
  fromName: z.string().max(120).default('Job Intelligence'),
  /** Global kill switch, independent of any candidate's preferences. */
  enabled: z.boolean().default(false),
});
export type NotificationEngineConfig = z.infer<typeof notificationEngineConfigSchema>;
