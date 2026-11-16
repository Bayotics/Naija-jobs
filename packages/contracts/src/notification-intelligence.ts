import { z } from 'zod';
import { timezoneSchema } from './common';
import {
  ALERT_PRIORITIES,
  NOTIFICATION_TYPES,
  clockTimeSchema,
  type NotificationType,
} from './notification-engine';
import { APPLICATION_RECOMMENDATIONS } from './application-intelligence';

/**
 * Notification intelligence.
 *
 * The layer that decides what is worth interrupting someone for. Its success
 * condition is unusual: a notification system is working well when it mostly
 * says nothing, and the thing it must never do is the thing it is structurally
 * easiest to do — email on every discovery.
 *
 * Three separations run through this file, and all three exist because
 * collapsing them produces a system that cannot be tuned.
 *
 * **Score is not urgency.** An excellent job posted this morning with no
 * deadline is high-value and low-urgency; a merely good job closing in six
 * hours is the reverse. One number cannot express both, and a system that
 * multiplies them ends up waking people for mediocre jobs that happen to be
 * expiring.
 *
 * **Notification score is not match score.** Match asks whether the job suits
 * the person. Notification asks whether it is worth an interruption *now*,
 * which additionally depends on rarity, timing, what was sent yesterday, and
 * how much attention the candidate has left.
 *
 * **Suppression is a decision, not an absence.** Every job that does not
 * produce a notification produces a recorded reason, because "why didn't I hear
 * about this?" is the question that decides whether someone trusts a system
 * built to stay quiet.
 */

export const NOTIFICATION_INTELLIGENCE_VERSION = '1.0.0';

// ── Urgency (Part 5) ────────────────────────────────────────────────────────

/**
 * How time-sensitive this is, independent of how good it is.
 *
 * `CRITICAL` is reserved for an excellent opportunity about to become
 * unavailable. It is the only level permitted to interrupt quiet hours, and it
 * is deliberately hard to reach — a level that fires often is a level people
 * learn to ignore, at which point it protects nothing.
 */
export const URGENCY_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export const URGENCY_RANK: Readonly<Record<UrgencyLevel, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

// ── Deadline and closing risk (Parts 8, 9) ──────────────────────────────────

export const DEADLINE_BUCKETS = [
  'expired',
  'under_24h',
  'one_to_three_days',
  'three_to_seven_days',
  'over_seven_days',
  'none_stated',
] as const;
export type DeadlineBucket = (typeof DEADLINE_BUCKETS)[number];

export const CLOSING_RISKS = ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'] as const;
export type ClosingRisk = (typeof CLOSING_RISKS)[number];

export const deadlineAssessmentSchema = z.object({
  bucket: z.enum(DEADLINE_BUCKETS).default('none_stated'),
  deadline: z.coerce.date().nullable().default(null),
  hoursUntilDeadline: z.number().nullable().default(null),
  /**
   * Estimated, never asserted.
   *
   * Without a stated deadline the system is inferring from job age and source
   * behaviour. `UNKNOWN` is the honest default and the common case.
   */
  closingRisk: z.enum(CLOSING_RISKS).default('UNKNOWN'),
  closingRiskConfidence: z.number().min(0).max(1).default(0),
  closingRiskSignals: z.array(z.string().max(200)).max(8).default([]),
  explanation: z.string().max(300).default(''),
});
export type DeadlineAssessment = z.infer<typeof deadlineAssessmentSchema>;

// ── Rarity (Part 10) ────────────────────────────────────────────────────────

/**
 * How unusual this combination is, measured against what has actually been
 * discovered.
 *
 * `sampleSize` is carried so the caller can tell "rare" from "we have barely
 * looked". A system that calls the third job it ever saw a once-in-a-month
 * opportunity is not measuring rarity, it is measuring its own youth.
 */
export const rarityAssessmentSchema = z.object({
  /** 0–1. Higher means fewer comparable jobs have been seen. */
  rarityScore: z.number().min(0).max(1).default(0),
  /** Jobs matching this combination in the observation window. */
  matchingJobs: z.number().int().min(0).default(0),
  /** Total jobs discovered in the same window. */
  sampleSize: z.number().int().min(0).default(0),
  windowDays: z.number().int().min(1).max(365).default(30),
  /** The dimensions that made it rare, named. */
  dimensions: z.array(z.string().max(120)).max(8).default([]),
  /** False when there is too little history to say anything. */
  sufficientHistory: z.boolean().default(false),
  explanation: z.string().max(300).default(''),
});
export type RarityAssessment = z.infer<typeof rarityAssessmentSchema>;

// ── Opportunity value (Part 6) ──────────────────────────────────────────────

/**
 * How valuable this opportunity is to *this* candidate.
 *
 * Distinct from the application layer's value score, which asks whether
 * applying is worth an hour. This asks whether the opportunity is worth
 * knowing about, which is a lower bar and a different mix — a role that is a
 * stretch and a lot of work to apply to can still be very much worth hearing
 * about.
 */
export const opportunityValueSchema = z.object({
  score: z.number().min(0).max(100).default(0),
  components: z
    .array(
      z.object({
        name: z.string().max(60),
        score: z.number().min(0).max(100),
        weight: z.number().min(0).max(100),
        applicable: z.boolean().default(true),
        detail: z.string().max(300).default(''),
      }),
    )
    .max(20)
    .default([]),
  confidence: z.number().min(0).max(1).default(0),
  explanation: z.string().max(400).default(''),
});
export type OpportunityValue = z.infer<typeof opportunityValueSchema>;

// ── Notification score (Part 4) ─────────────────────────────────────────────

export const NOTIFICATION_SCORE_FACTORS = [
  'fit',
  'application_recommendation',
  'job_quality',
  'freshness',
  'salary',
  'career_relevance',
  'behavioral_affinity',
  'company_affinity',
  'deadline',
  'competition',
  'source_quality',
  'application_friction',
  'rarity',
  'notification_history',
] as const;
export type NotificationScoreFactor = (typeof NOTIFICATION_SCORE_FACTORS)[number];

/**
 * Default weights.
 *
 * Data, not constants: every one of these is overridable per candidate, and the
 * dashboard shows what they currently are. The shape matters more than the
 * numbers — fit dominates, rarity and deadline are real but secondary, and
 * notification history is a *penalty* channel rather than a positive one.
 */
export const DEFAULT_SCORE_WEIGHTS: Readonly<Record<NotificationScoreFactor, number>> = {
  fit: 26,
  application_recommendation: 18,
  job_quality: 8,
  freshness: 7,
  salary: 6,
  career_relevance: 8,
  // Secondary by construction — see the authority note on the config below.
  behavioral_affinity: 4,
  company_affinity: 5,
  deadline: 6,
  competition: 2,
  source_quality: 3,
  application_friction: 2,
  rarity: 5,
  notification_history: 0,
};

export const notificationScoreSchema = z.object({
  /** 0–100. Not the match score, not the application score. */
  score: z.number().min(0).max(100),
  urgency: z.enum(URGENCY_LEVELS).default('LOW'),
  opportunityValue: opportunityValueSchema,

  factors: z
    .array(
      z.object({
        factor: z.enum(NOTIFICATION_SCORE_FACTORS),
        /** 0–100 before weighting. */
        raw: z.number().min(0).max(100),
        weight: z.number().min(0).max(100),
        /** Excluded from the aggregate when the data does not exist. */
        applicable: z.boolean().default(true),
        detail: z.string().max(300).default(''),
      }),
    )
    .max(20)
    .default([]),

  /** Points added by explicit boosts — favourite company, favourite title. */
  boost: z.number().min(-100).max(100).default(0),
  boostReasons: z.array(z.string().max(200)).max(8).default([]),

  /** Belief that the score is right, not that the job is good. */
  confidence: z.number().min(0).max(1).default(0),
  deadline: deadlineAssessmentSchema,
  rarity: rarityAssessmentSchema,
  /** One or two sentences, shown in the alert itself. See Part 30. */
  explanation: z.string().max(600).default(''),
  algorithmVersion: z.string().max(20).default(NOTIFICATION_INTELLIGENCE_VERSION),
});
export type NotificationScore = z.infer<typeof notificationScoreSchema>;

// ── Thresholds and cooldowns (Parts 13, 27) ─────────────────────────────────

/**
 * Default thresholds, calibrated against the default weight mix.
 *
 * These are not round numbers chosen for looking sensible. The weighted mean
 * over the default factors puts a genuinely excellent job — a 94 match, an
 * APPLY_NOW recommendation, posted hours ago, paying above target — at about
 * 87, because factors like competition and rarity sit mid-range even for a very
 * good posting. An instant threshold of 88 therefore alerted on nothing at all,
 * which the fifty-job simulation caught immediately.
 *
 * 82 puts the excellent cases through and leaves a solid-but-ordinary job at
 * about 78, which lands in the digest where it belongs. Every value here is
 * overridable per candidate; these are the starting points, not the policy.
 */
export const notificationThresholdsSchema = z.object({
  /** At or above: interrupt now. */
  instant: z.number().min(0).max(100).default(82),
  /** At or above: goes in the next digest. */
  digest: z.number().min(0).max(100).default(65),
  /** At or above: appears on the dashboard but is never emailed. */
  dashboard: z.number().min(0).max(100).default(45),
  /** Below `dashboard`: recorded as suppressed, with the reason. */
  minimumUrgencyForInstant: z.enum(URGENCY_LEVELS).default('LOW'),
  /**
   * Confidence required before an interruption is allowed.
   *
   * A high score computed from two of ten factors is a guess wearing a number.
   * The live run produced exactly that — unmatched jobs scoring in the seventies
   * on posting quality alone — and while the coverage damper lowers the score,
   * this stops a lucky combination from clearing the bar on thin evidence.
   * Digests are not gated: a digest costs a line, not an interruption.
   */
  minimumConfidenceForInstant: z.number().min(0).max(1).default(0.45),
});
export type NotificationThresholds = z.infer<typeof notificationThresholdsSchema>;

export const cooldownConfigSchema = z.object({
  /** Hours before the same job may notify again. */
  sameJobHours: z.number().min(0).max(720).default(24),
  /** Hours between alerts about the same company. */
  sameCompanyHours: z.number().min(0).max(720).default(2),
  /** Hours between alerts from the same role family. */
  sameRoleHours: z.number().min(0).max(720).default(1),
  /** Hard ceiling on interruptions in a rolling day, whatever the scores. */
  maxAlertsPerRollingDay: z.number().int().min(0).max(100).default(5),
  maxAlertsPerRollingHour: z.number().int().min(0).max(50).default(2),
});
export type CooldownConfig = z.infer<typeof cooldownConfigSchema>;

// ── Explicit notification rules (Parts 33, 35) ──────────────────────────────

export const OVERRIDE_SUBJECTS = ['company', 'title', 'technology', 'location', 'source'] as const;
export type OverrideSubject = (typeof OVERRIDE_SUBJECTS)[number];

export const OVERRIDE_ACTIONS = ['always_alert', 'never_alert', 'digest_only'] as const;
export type OverrideAction = (typeof OVERRIDE_ACTIONS)[number];

/**
 * "Never tell me about Company X." "Always tell me about Senior React roles."
 *
 * Both are explicit instructions and neither is a preference — they are about
 * the notification, not about the job. Kept separate from candidate preferences
 * so that muting a company's emails does not quietly exclude it from matching.
 */
export const notificationOverrideSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  subject: z.enum(OVERRIDE_SUBJECTS),
  /** Matched case-insensitively against the job's corresponding field. */
  value: z.string().trim().min(1).max(200),
  action: z.enum(OVERRIDE_ACTIONS),
  note: z.string().max(300).nullable().default(null),
  createdAt: z.coerce.date().default(() => new Date()),
});
export type NotificationOverride = z.infer<typeof notificationOverrideSchema>;

/**
 * Precedence, as data.
 *
 * The brief asks for determinism, and the interesting case is the conflict it
 * names: "never alert me about Company X" against "always alert me about senior
 * React jobs", when Company X posts a senior React job.
 *
 * **A block always wins.** Someone who has muted a company has made a decision
 * about that company; someone who has starred a role type has expressed an
 * interest. An interest does not override a decision, and the alternative — a
 * mute that silently stops working — is the kind of behaviour that makes people
 * stop trusting every other switch in the product.
 */
export const OVERRIDE_PRECEDENCE: readonly OverrideAction[] = [
  'never_alert',
  'always_alert',
  'digest_only',
];

// ── Favourites (Parts 11, 12) ───────────────────────────────────────────────

export const favouriteTargetSchema = z.object({
  value: z.string().trim().min(1).max(200),
  /** Points added to the notification score. Bounded so it cannot alone alert. */
  boost: z.number().min(0).max(30).default(10),
});
export type FavouriteTarget = z.infer<typeof favouriteTargetSchema>;

export const notificationFavouritesSchema = z.object({
  companies: z.array(favouriteTargetSchema).max(100).default([]),
  titles: z.array(favouriteTargetSchema).max(100).default([]),
  technologies: z.array(favouriteTargetSchema).max(100).default([]),
  industries: z.array(favouriteTargetSchema).max(50).default([]),
  locations: z.array(favouriteTargetSchema).max(50).default([]),
});
export type NotificationFavourites = z.infer<typeof notificationFavouritesSchema>;

// ── Per-type configuration (Part 2) ─────────────────────────────────────────

export const typeSettingSchema = z.object({
  enabled: z.boolean().default(false),
  /** Channel override; falls back to the candidate's default when null. */
  channel: z.enum(['email', 'dashboard', 'both']).default('both'),
});
export type TypeSetting = z.infer<typeof typeSettingSchema>;

/**
 * Defaults per type, and note how many are off.
 *
 * The brief is explicit that not everything should be on by default, and the
 * reason is that every type enabled by someone who did not ask for it is a
 * small withdrawal from the same account: their willingness to keep reading.
 */
export const DEFAULT_TYPE_SETTINGS: Readonly<Record<NotificationType, TypeSetting>> = {
  JOB_ALERT: { enabled: true, channel: 'both' },
  JOB_DIGEST: { enabled: true, channel: 'both' },
  DAILY_DIGEST: { enabled: true, channel: 'both' },
  WEEKLY_DIGEST: { enabled: false, channel: 'both' },
  SYSTEM_ALERT: { enabled: true, channel: 'both' },
  SOURCE_FAILURE: { enabled: false, channel: 'dashboard' },
  CRAWLER_HEALTH_ALERT: { enabled: false, channel: 'dashboard' },
  WEEKLY_SUMMARY: { enabled: false, channel: 'email' },
  PREFERENCE_SUGGESTION: { enabled: false, channel: 'dashboard' },
  APPLICATION_REMINDER: { enabled: false, channel: 'both' },
  APPLICATION_DEADLINE: { enabled: true, channel: 'both' },
  JOB_EXPIRING: { enabled: false, channel: 'dashboard' },
  LEARNING_INSIGHT: { enabled: false, channel: 'dashboard' },
  SEARCH_COVERAGE_ALERT: { enabled: false, channel: 'dashboard' },
};

// ── The intelligence configuration ──────────────────────────────────────────

/**
 * Everything the candidate controls in this layer.
 *
 * Sits alongside `notificationPreferences` from prompt 8 rather than replacing
 * it: that schema is already persisted, already versioned, and already drives a
 * working decider. Splitting the new controls into their own record means the
 * existing one keeps its meaning and neither needs a migration to understand
 * the other.
 */
export const notificationIntelligenceConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  timezone: timezoneSchema.default('UTC'),

  thresholds: notificationThresholdsSchema.default({}),
  cooldowns: cooldownConfigSchema.default({}),
  favourites: notificationFavouritesSchema.default({}),
  weights: z
    .record(z.enum(NOTIFICATION_SCORE_FACTORS), z.number().min(0).max(100))
    .default(() => ({ ...DEFAULT_SCORE_WEIGHTS })),

  typeSettings: z
    .record(z.enum(NOTIFICATION_TYPES), typeSettingSchema)
    .default(() => ({ ...DEFAULT_TYPE_SETTINGS })),

  /** Minimum application recommendation before a job may ever be emailed. */
  minimumRecommendation: z.enum(APPLICATION_RECOMMENDATIONS).default('CONSIDER'),

  /**
   * Whether behavioural calibration may adjust scores at all.
   *
   * Bounded even when on: `maxBehavioralAdjustment` is the ceiling, and the
   * adjustment is refused outright on any dimension the candidate has stated
   * explicitly. The same rule as every other layer — behaviour informs, it does
   * not decide.
   */
  calibrationEnabled: z.boolean().default(true),
  maxBehavioralAdjustment: z.number().min(0).max(25).default(8),

  /** Re-notify when something genuinely changed. See Part 26. */
  reNotifyOnMaterialChange: z.boolean().default(true),
  /** Score improvement required before a re-notification is allowed. */
  reNotifyMinScoreIncrease: z.number().min(0).max(100).default(12),

  /** Advisory only. The system never changes settings on its own. */
  fatigueAdviceEnabled: z.boolean().default(true),
  updatedAt: z.coerce.date().default(() => new Date()),
});
export type NotificationIntelligenceConfig = z.infer<typeof notificationIntelligenceConfigSchema>;

// ── Suppression transparency (Parts 31, 32) ─────────────────────────────────

export const SUPPRESSION_REASONS = [
  'expired',
  'duplicate',
  'already_applied',
  'previously_rejected',
  'below_threshold',
  'hard_blocked',
  'suspicious',
  'outside_preferences',
  'recently_notified',
  'cooldown_job',
  'cooldown_company',
  'cooldown_role',
  'daily_limit',
  'hourly_limit',
  'quiet_hours',
  'type_disabled',
  'override_never_alert',
  'no_application_url',
  'recommendation_too_low',
  'urgency_too_low',
  'source_excluded',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * Why a job produced no notification, in the candidate's own terms.
 *
 * `remedy` is what makes this useful rather than merely honest: knowing a job
 * scored 61 against a threshold of 75 is interesting; knowing which setting to
 * move is actionable.
 */
export const suppressionRecordSchema = z.object({
  jobId: z.string().uuid(),
  candidateId: z.string().uuid(),
  reason: z.enum(SUPPRESSION_REASONS),
  detail: z.string().max(400),
  /** The setting responsible, so the UI can link straight to it. */
  setting: z.string().max(80).nullable().default(null),
  remedy: z.string().max(300).nullable().default(null),
  notificationScore: z.number().min(0).max(100).nullable().default(null),
  thresholdApplied: z.number().min(0).max(100).nullable().default(null),
  occurredAt: z.coerce.date().default(() => new Date()),
});
export type SuppressionRecord = z.infer<typeof suppressionRecordSchema>;

// ── The notification entity (Part 1) ────────────────────────────────────────

export const NOTIFICATION_STATES = [
  'PENDING',
  'SCHEDULED',
  'PROCESSING',
  'SENT',
  'FAILED',
  'CANCELLED',
  'SUPPRESSED',
] as const;
export type NotificationState = (typeof NOTIFICATION_STATES)[number];

export const NOTIFICATION_CHANNELS_V2 = ['email', 'dashboard'] as const;
export type NotificationChannelV2 = (typeof NOTIFICATION_CHANNELS_V2)[number];

export const notificationRecordSchema = z.object({
  notificationId: z.string().uuid(),
  candidateId: z.string().uuid(),
  /** Null for operational notifications that are not about a job. */
  jobId: z.string().uuid().nullable().default(null),
  type: z.enum(NOTIFICATION_TYPES),
  priority: z.enum(ALERT_PRIORITIES).default('NORMAL'),
  urgency: z.enum(URGENCY_LEVELS).default('LOW'),
  /** Shown to the candidate verbatim. */
  reason: z.string().max(600).default(''),
  channel: z.enum(NOTIFICATION_CHANNELS_V2).default('email'),
  state: z.enum(NOTIFICATION_STATES).default('PENDING'),

  notificationScore: z.number().min(0).max(100).nullable().default(null),

  /** Digest membership. Several notifications share one group. */
  groupId: z.string().uuid().nullable().default(null),

  scheduledAt: z.coerce.date().nullable().default(null),
  sentAt: z.coerce.date().nullable().default(null),
  /** Unreliable by nature — see the tracking note in the delivery module. */
  openedAt: z.coerce.date().nullable().default(null),
  clickedAt: z.coerce.date().nullable().default(null),
  failedAt: z.coerce.date().nullable().default(null),
  failureReason: z.string().max(400).nullable().default(null),
  attempts: z.number().int().min(0).max(20).default(0),

  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.coerce.date().default(() => new Date()),
});
export type NotificationRecord = z.infer<typeof notificationRecordSchema>;

// ── Delivery outcomes (Parts 43, 44) ────────────────────────────────────────

export const DELIVERY_OUTCOMES = [
  'sent',
  'delivered',
  'opened',
  'clicked',
  'bounced_hard',
  'bounced_soft',
  'complained',
  'deferred',
  'failed',
] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/** Outcomes that mean the address will never work. Never retried. */
export const PERMANENT_FAILURES: readonly DeliveryOutcome[] = ['bounced_hard', 'complained'];

/*
 * Named `DeliveryOutcomeEvent` rather than `DeliveryEvent`.
 *
 * Prompt 8 already exports a `DeliveryEvent` union of lifecycle names. This is
 * a different thing — a recorded event with a provider code and a timestamp —
 * and giving it the same name would force one of them to be renamed later,
 * under time pressure, in a file someone else is reading.
 */
export const deliveryOutcomeEventSchema = z.object({
  notificationId: z.string().uuid(),
  outcome: z.enum(DELIVERY_OUTCOMES),
  /** Provider's own code, kept verbatim for support conversations. */
  providerCode: z.string().max(120).nullable().default(null),
  detail: z.string().max(600).nullable().default(null),
  occurredAt: z.coerce.date().default(() => new Date()),
});
export type DeliveryOutcomeEvent = z.infer<typeof deliveryOutcomeEventSchema>;

export const addressHealthSchema = z.object({
  candidateId: z.string().uuid(),
  email: z.string().email(),
  /** True after a hard bounce or complaint. Nothing is sent while set. */
  suppressed: z.boolean().default(false),
  suppressedReason: z.string().max(300).nullable().default(null),
  hardBounces: z.number().int().min(0).default(0),
  softBounces: z.number().int().min(0).default(0),
  complaints: z.number().int().min(0).default(0),
  consecutiveFailures: z.number().int().min(0).default(0),
  lastSuccessAt: z.coerce.date().nullable().default(null),
  lastFailureAt: z.coerce.date().nullable().default(null),
});
export type AddressHealth = z.infer<typeof addressHealthSchema>;

// ── Fatigue and calibration (Parts 28, 29) ──────────────────────────────────

export const engagementCountsSchema = z.object({
  sent: z.number().int().min(0).default(0),
  delivered: z.number().int().min(0).default(0),
  opened: z.number().int().min(0).default(0),
  clicked: z.number().int().min(0).default(0),
  saved: z.number().int().min(0).default(0),
  applied: z.number().int().min(0).default(0),
  dismissed: z.number().int().min(0).default(0),
});
export type EngagementCounts = z.infer<typeof engagementCountsSchema>;

/**
 * Whether the candidate is drowning.
 *
 * `advice` is a suggestion and nothing more — the system never changes a
 * frequency setting on its own. Someone receiving thirty-seven alerts a week
 * and opening eight may be overwhelmed, or may be perfectly happy skimming
 * subject lines, and only they know which.
 */
export const fatigueReportSchema = z.object({
  candidateId: z.string().uuid(),
  windowDays: z.number().int().min(1).max(90).default(7),
  counts: engagementCountsSchema,
  openRate: z.number().min(0).max(1).nullable().default(null),
  clickRate: z.number().min(0).max(1).nullable().default(null),
  /** False when too few notifications were sent to read anything into it. */
  sufficientSample: z.boolean().default(false),
  /** True when engagement has fallen materially against the prior window. */
  declining: z.boolean().default(false),
  advice: z.string().max(600).default(''),
  /** The concrete change being suggested, if any. Never applied. */
  suggestedChange: z
    .object({
      setting: z.string().max(80),
      from: z.string().max(80),
      to: z.string().max(80),
      rationale: z.string().max(400),
    })
    .nullable()
    .default(null),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type FatigueReport = z.infer<typeof fatigueReportSchema>;

export const calibrationSignalSchema = z.object({
  dimension: z.string().max(60),
  value: z.string().max(200),
  counts: engagementCountsSchema,
  /** -1..1. Positive means alerts on this dimension get engagement. */
  affinity: z.number().min(-1).max(1).default(0),
  confidence: z.number().min(0).max(1).default(0),
  /** True when it contradicts something explicit. Reported, never applied. */
  conflictsWithExplicit: z.boolean().default(false),
});
export type CalibrationSignal = z.infer<typeof calibrationSignalSchema>;

// ── Analytics and alert quality (Parts 45, 46, 47) ──────────────────────────

export const notificationAnalyticsSchema = z.object({
  candidateId: z.string().uuid(),
  windowDays: z.number().int().min(1).max(365).default(30),
  overall: engagementCountsSchema,
  suppressed: z.number().int().min(0).default(0),
  duplicatesSuppressed: z.number().int().min(0).default(0),

  deliveryRate: z.number().min(0).max(1).nullable().default(null),
  openRate: z.number().min(0).max(1).nullable().default(null),
  clickRate: z.number().min(0).max(1).nullable().default(null),
  applicationRate: z.number().min(0).max(1).nullable().default(null),
  suppressionRate: z.number().min(0).max(1).nullable().default(null),

  byDimension: z
    .record(
      z.string(),
      z.array(z.object({ key: z.string().max(200), counts: engagementCountsSchema })),
    )
    .default({}),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type NotificationAnalytics = z.infer<typeof notificationAnalyticsSchema>;

/**
 * Was the interruption worth it?
 *
 * Precision measured against what the candidate did, not against the score the
 * system gave itself. `sufficientSample` guards the same failure the
 * application analytics guard: twenty alerts is not enough to conclude
 * anything, and a system that draws conclusions from twenty will keep
 * retuning itself on noise.
 */
export const alertQualitySchema = z.object({
  candidateId: z.string().uuid(),
  windowDays: z.number().int().min(1).max(365).default(30),
  buckets: z
    .array(
      z.object({
        /** Score band, e.g. "90-100". */
        band: z.string().max(20),
        counts: engagementCountsSchema,
        precision: z.number().min(0).max(1).nullable().default(null),
        sufficientSample: z.boolean().default(false),
      }),
    )
    .default([]),
  note: z.string().max(600).default(''),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type AlertQuality = z.infer<typeof alertQualitySchema>;

/**
 * What a different threshold would have done.
 *
 * Advisory, and computed by replaying history rather than by modelling it. The
 * brief is firm that thresholds are never changed automatically, so this exists
 * to make the trade legible: fewer interruptions against the clicks that would
 * have been lost.
 */
export const thresholdSimulationSchema = z.object({
  candidateId: z.string().uuid(),
  currentThreshold: z.number().min(0).max(100),
  scenarios: z
    .array(
      z.object({
        threshold: z.number().min(0).max(100),
        alertsSent: z.number().int().min(0),
        alertsChange: z.number(),
        clicksRetained: z.number().int().min(0),
        clicksRetainedShare: z.number().min(0).max(1).nullable().default(null),
        summary: z.string().max(400),
      }),
    )
    .max(10)
    .default([]),
  sufficientSample: z.boolean().default(false),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type ThresholdSimulation = z.infer<typeof thresholdSimulationSchema>;

// ── Digest assembly (Parts 19, 20, 36) ──────────────────────────────────────

export const DIGEST_SECTION_KINDS = [
  'top_opportunities',
  'strong_matches',
  'new_companies',
  'expiring',
  'application_reminders',
  'learning_insights',
] as const;
export type DigestSectionKind = (typeof DIGEST_SECTION_KINDS)[number];

export const digestPlanSchema = z.object({
  candidateId: z.string().uuid(),
  type: z.enum(NOTIFICATION_TYPES).default('DAILY_DIGEST'),
  /** The window the digest covers, so it is reproducible. */
  windowStart: z.coerce.date(),
  windowEnd: z.coerce.date(),
  sections: z
    .array(
      z.object({
        kind: z.enum(DIGEST_SECTION_KINDS),
        title: z.string().max(120),
        jobIds: z.array(z.string().uuid()).max(50).default([]),
        note: z.string().max(300).default(''),
      }),
    )
    .default([]),
  totalJobs: z.number().int().min(0).default(0),
  /** Considered but left out, with counts by reason. */
  excluded: z.record(z.string(), z.number()).default({}),
  generatedAt: z.coerce.date().default(() => new Date()),
});
export type DigestPlan = z.infer<typeof digestPlanSchema>;

// ── Link validation (Parts 23, 24) ──────────────────────────────────────────

export const LINK_VERDICTS = ['usable', 'unverified', 'rejected'] as const;
export type LinkVerdict = (typeof LINK_VERDICTS)[number];

/**
 * Whether a URL is fit to put in an email.
 *
 * `unverified` is the common and acceptable case: the system could not reach
 * the page, which is not the same as the link being bad. `rejected` is reserved
 * for links that are actively wrong — a search results page, an unsafe scheme,
 * a redirect to somewhere unrelated — and those are dropped rather than sent.
 */
export const linkValidationSchema = z.object({
  originalUrl: z.string().max(2000),
  canonicalUrl: z.string().max(2000).nullable().default(null),
  finalUrl: z.string().max(2000).nullable().default(null),
  verdict: z.enum(LINK_VERDICTS).default('unverified'),
  httpStatus: z.number().int().nullable().default(null),
  redirects: z.number().int().min(0).default(0),
  /** Why it was rejected, when it was. */
  rejectionReason: z.string().max(300).nullable().default(null),
  checkedAt: z.coerce.date().nullable().default(null),
});
export type LinkValidation = z.infer<typeof linkValidationSchema>;

/** Re-exported so callers need one import for the whole layer. */
export { clockTimeSchema };
