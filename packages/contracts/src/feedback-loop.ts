import { z } from 'zod';

/**
 * The intelligence feedback loop.
 *
 * Everything in this file exists under one rule, and the rule is not a
 * guideline:
 *
 *   **Learned behaviour never silently overrides an explicit preference.**
 *
 * That rule is not enforced by care at the call sites — it is enforced by the
 * shape of the data. Learned signals live in their own tables, carry their own
 * versioning, and are combined with explicit preferences through
 * `PREFERENCE_AUTHORITY`, which is an ordering the ranking code must consult
 * rather than a convention it must remember. A learned signal that contradicts
 * an explicit one becomes a *suggestion the candidate can accept or decline*,
 * never a write.
 *
 * The second rule, equally hard: behaviour is used to rank jobs, never to infer
 * anything about the person beyond their job preferences. See
 * `PROHIBITED_INFERENCE_DIMENSIONS`.
 */

export const FEEDBACK_LOOP_VERSION = '1.0.0';

/** Bumped when the affinity maths changes in a way that alters stored values. */
export const LEARNING_ALGORITHM_VERSION = '1.0.0';
/** Bumped when the set of extracted features changes. */
export const FEATURE_VERSION = '1.0.0';

// ── The hierarchy (the absolute principle) ──────────────────────────────────

/**
 * Who wins when two sources of truth disagree.
 *
 * Lower number = higher authority. This is consulted in code, not remembered:
 * `resolveAuthority` returns the winning layer and the reason, and the ranking
 * engine records that reason in the trace. An operator can therefore always see
 * *why* a learned preference did not apply.
 */
export const PREFERENCE_LAYERS = [
  'explicit_hard_constraint',
  'explicit_preference',
  'explicit_exclusion',
  'learned_behavioral',
  'general_optimization',
] as const;
export type PreferenceLayer = (typeof PREFERENCE_LAYERS)[number];

export const PREFERENCE_AUTHORITY: Readonly<Record<PreferenceLayer, number>> = {
  explicit_hard_constraint: 0,
  explicit_preference: 1,
  explicit_exclusion: 2,
  learned_behavioral: 3,
  general_optimization: 4,
};

/**
 * Characteristics the system must never infer or use.
 *
 * Listed explicitly, and asserted in tests, because "we would not do that" is
 * not a control. Feature extraction refuses to emit a feature whose dimension
 * appears here, and the affinity engine drops any that somehow arrives.
 */
export const PROHIBITED_INFERENCE_DIMENSIONS = [
  'religion',
  'race',
  'ethnicity',
  'nationality_origin',
  'political_affiliation',
  'sexual_orientation',
  'gender_identity',
  'health',
  'disability',
  'pregnancy',
  'marital_status',
  'age',
  'union_membership',
  'criminal_record',
] as const;
export type ProhibitedDimension = (typeof PROHIBITED_INFERENCE_DIMENSIONS)[number];

// ── Events (Parts 1–4) ──────────────────────────────────────────────────────

export const BEHAVIOR_EVENT_TYPES = [
  'JOB_VIEWED',
  'JOB_CLICKED',
  'JOB_SAVED',
  'JOB_UNSAVED',
  'JOB_IGNORED',
  'JOB_DISMISSED',
  'JOB_APPLIED',
  'JOB_REJECTED',
  'JOB_SHARED',
  'JOB_ARCHIVED',
  'JOB_NOTIFICATION_CLICKED',
  'JOB_EMAIL_OPENED',
  'FEEDBACK_POSITIVE',
  'FEEDBACK_NEGATIVE',
] as const;
export type BehaviorEventType = (typeof BEHAVIOR_EVENT_TYPES)[number];

/**
 * Where the interaction happened.
 *
 * Context matters because behaviour differs by surface: a click from an email
 * digest is a considered choice made away from the app, while a click in a
 * search results page may be exploratory. Weighting them identically flattens a
 * real distinction.
 */
export const EVENT_CONTEXTS = [
  'EMAIL',
  'DASHBOARD',
  'SEARCH',
  'RECOMMENDATIONS',
  'JOB_DETAIL',
  'NOTIFICATION',
  'API',
  'IMPORT',
  'UNKNOWN',
] as const;
export type EventContext = (typeof EVENT_CONTEXTS)[number];

/**
 * Why *the candidate* rejected a job.
 *
 * Named for whose rejection it is: `common.ts` already has `REJECTION_REASONS`
 * for why the *pipeline* dropped a posting, and the two are entirely different
 * facts about entirely different actors.
 *
 * A structured reason is worth far more than the rejection itself: "rejected"
 * alone is ambiguous between "wrong job" and "wrong everything", while
 * `SALARY_TOO_LOW` names a dimension and a direction in one token.
 */
export const CANDIDATE_REJECTION_REASONS = [
  'NOT_INTERESTED',
  'WRONG_LOCATION',
  'SALARY_TOO_LOW',
  'NOT_REMOTE',
  'TOO_SENIOR',
  'TOO_JUNIOR',
  'WRONG_TECHNOLOGY',
  'NO_VISA_SPONSORSHIP',
  'COMPANY_NOT_INTERESTED',
  'ALREADY_APPLIED',
  'DUPLICATE',
  'OTHER',
] as const;
export type CandidateRejectionReason = (typeof CANDIDATE_REJECTION_REASONS)[number];

/**
 * Which dimension a rejection reason speaks to, and in which direction.
 *
 * `null` means the reason says nothing transferable: "not interested" is about
 * this job, and generalising it into a dislike of the company or the stack
 * would be exactly the over-inference the brief warns against.
 */
export const REJECTION_DIMENSION: Readonly<
  Record<CandidateRejectionReason, { dimension: string | null; polarity: number }>
> = {
  NOT_INTERESTED: { dimension: null, polarity: -0.2 },
  WRONG_LOCATION: { dimension: 'location', polarity: -0.8 },
  SALARY_TOO_LOW: { dimension: 'salary_band', polarity: -0.9 },
  NOT_REMOTE: { dimension: 'work_arrangement', polarity: -0.9 },
  TOO_SENIOR: { dimension: 'seniority', polarity: -0.7 },
  TOO_JUNIOR: { dimension: 'seniority', polarity: -0.7 },
  WRONG_TECHNOLOGY: { dimension: 'technology', polarity: -0.7 },
  NO_VISA_SPONSORSHIP: { dimension: 'visa', polarity: -0.9 },
  COMPANY_NOT_INTERESTED: { dimension: 'company', polarity: -0.8 },
  // Neither of these is a preference signal at all — they are about state.
  ALREADY_APPLIED: { dimension: null, polarity: 0 },
  DUPLICATE: { dimension: null, polarity: 0 },
  OTHER: { dimension: null, polarity: -0.1 },
};

/**
 * One recorded interaction.
 *
 * Append-only: nothing ever updates a row of this shape. An "unsave" is a new
 * `JOB_UNSAVED` event, not a deletion of the `JOB_SAVED` one — which is what
 * makes the history replayable when the algorithm changes.
 *
 * `metadata` is deliberately narrow. The brief asks for minimal personal data,
 * and the honest way to hold that line is to not have a general-purpose bag
 * that grows.
 */
export const behaviorEventSchema = z.object({
  /**
   * Generated, not supplied.
   *
   * Defaulted so the *input* type does not demand an id a caller has no way to
   * produce meaningfully, while the *output* type still guarantees one — the
   * input/output distinction that has bitten this codebase before.
   */
  eventId: z.string().uuid().default(() => crypto.randomUUID()),
  candidateId: z.string().uuid(),
  jobId: z.string().uuid().nullable().default(null),
  eventType: z.enum(BEHAVIOR_EVENT_TYPES),
  occurredAt: z.coerce.date().default(() => new Date()),
  /** Where the interaction originated. */
  context: z.enum(EVENT_CONTEXTS).default('UNKNOWN'),
  /** Opaque, rotating, client-side. Never an identifier for a person. */
  sessionId: z.string().max(80).nullable().default(null),
  notificationId: z.string().uuid().nullable().default(null),
  /** The recommendation this interaction was against, for Precision@K. */
  recommendationId: z.string().max(120).nullable().default(null),
  /** Rank at which the job was shown, for position-aware metrics. */
  shownAtRank: z.number().int().min(1).max(10_000).nullable().default(null),
  rejectionReason: z.enum(CANDIDATE_REJECTION_REASONS).nullable().default(null),
  /** Free text the candidate typed, when they chose to explain. */
  reasonText: z.string().trim().max(500).nullable().default(null),
  /** Experiment attribution, when one is running. */
  experimentId: z.string().max(80).nullable().default(null),
  variant: z.string().max(40).nullable().default(null),
  /** Bounded, non-identifying extras. */
  metadata: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])).default({}),
});
export type BehaviorEvent = z.infer<typeof behaviorEventSchema>;
export type BehaviorEventInput = z.input<typeof behaviorEventSchema>;

// ── Signal weights (Parts 5–6) ──────────────────────────────────────────────

/**
 * How much each event says, and how confidently.
 *
 * `polarity` is direction and magnitude; `evidenceWeight` is how much this
 * event should move confidence. They are separate because a strong opinion and
 * a reliable one are different things: a dismissal is a strong negative
 * (polarity −0.6) but weak evidence about *why* (evidenceWeight 0.5), because a
 * person dismisses jobs for reasons that have nothing to do with their
 * attributes.
 *
 * Configurable, as the brief requires — these are defaults, not constants.
 */
export const signalWeightSchema = z.object({
  polarity: z.number().min(-1).max(1),
  evidenceWeight: z.number().min(0).max(1),
});
export type SignalWeight = z.infer<typeof signalWeightSchema>;

export const DEFAULT_SIGNAL_WEIGHTS: Readonly<Record<BehaviorEventType, SignalWeight>> = {
  // Positive, ascending in strength.
  JOB_EMAIL_OPENED: { polarity: 0.05, evidenceWeight: 0.1 },
  JOB_VIEWED: { polarity: 0.1, evidenceWeight: 0.25 },
  JOB_NOTIFICATION_CLICKED: { polarity: 0.3, evidenceWeight: 0.5 },
  JOB_CLICKED: { polarity: 0.35, evidenceWeight: 0.55 },
  JOB_SHARED: { polarity: 0.5, evidenceWeight: 0.6 },
  JOB_SAVED: { polarity: 0.7, evidenceWeight: 0.85 },
  FEEDBACK_POSITIVE: { polarity: 0.85, evidenceWeight: 1 },
  JOB_APPLIED: { polarity: 1, evidenceWeight: 1 },

  // Negative. Note how much weaker `IGNORED` is than `DISMISSED`.
  JOB_IGNORED: { polarity: -0.15, evidenceWeight: 0.2 },
  JOB_ARCHIVED: { polarity: -0.2, evidenceWeight: 0.3 },
  JOB_UNSAVED: { polarity: -0.4, evidenceWeight: 0.5 },
  JOB_DISMISSED: { polarity: -0.6, evidenceWeight: 0.5 },
  JOB_REJECTED: { polarity: -0.7, evidenceWeight: 0.8 },
  FEEDBACK_NEGATIVE: { polarity: -0.85, evidenceWeight: 1 },
};

/**
 * Per-context multipliers on evidence weight.
 *
 * A click from an email is a deliberate act taken outside the app; a click in a
 * search results page may be someone scanning. The difference is real but
 * modest, so the multipliers are close to 1.
 */
export const DEFAULT_CONTEXT_WEIGHTS: Readonly<Record<EventContext, number>> = {
  EMAIL: 1.15,
  NOTIFICATION: 1.1,
  RECOMMENDATIONS: 1,
  JOB_DETAIL: 1,
  DASHBOARD: 0.95,
  SEARCH: 0.85,
  API: 0.8,
  IMPORT: 0.5,
  UNKNOWN: 0.8,
};

// ── Features (Parts 14–15) ──────────────────────────────────────────────────

/**
 * Job attributes behaviour can attach to.
 *
 * Every one is a property of the *job*, not of the person. That is the
 * structural reason this system cannot infer a protected characteristic: there
 * is no dimension in which to record one.
 */
export const FEATURE_DIMENSIONS = [
  'technology',
  'company',
  'location',
  'country',
  'industry',
  'title_token',
  'seniority',
  'work_arrangement',
  'employment_type',
  'salary_band',
  'source',
  'company_size',
] as const;
export type FeatureDimension = (typeof FEATURE_DIMENSIONS)[number];

export const jobFeatureSchema = z.object({
  dimension: z.enum(FEATURE_DIMENSIONS),
  value: z.string().trim().min(1).max(160),
  /**
   * How central this feature is to the job, 0–1.
   *
   * A job's primary technology should not count the same as the tenth item in
   * its "nice to have" list, or every posting mentioning Git teaches the system
   * that the candidate loves Git.
   */
  salience: z.number().min(0).max(1).default(1),
});
export type JobFeature = z.infer<typeof jobFeatureSchema>;

// ── Affinity (Parts 10–13) ──────────────────────────────────────────────────

/**
 * What behaviour suggests about one (dimension, value).
 *
 * `affinity` is the direction and strength; `confidence` is how much the system
 * believes it. Keeping them separate is what stops one click becoming a strong
 * preference: a single save yields affinity 0.7 with confidence 0.1, and
 * confidence is what the ranking layer multiplies by.
 */
export const featureAffinitySchema = z.object({
  dimension: z.enum(FEATURE_DIMENSIONS),
  value: z.string().max(160),
  /** -1..1 */
  affinity: z.number().min(-1).max(1),
  /** 0..1, rising with independent observations. */
  confidence: z.number().min(0).max(1),
  /** Distinct events contributing. */
  sampleSize: z.number().int().min(0),
  positiveEvents: z.number().int().min(0).default(0),
  negativeEvents: z.number().int().min(0).default(0),
  /** Sum of decayed evidence weight — the real denominator. */
  evidence: z.number().min(0).default(0),
  firstObservedAt: z.coerce.date().nullable().default(null),
  lastObservedAt: z.coerce.date().nullable().default(null),
  lastUpdated: z.coerce.date().default(() => new Date()),
  /** True when this contradicts something the candidate explicitly said. */
  conflictsWithExplicit: z.boolean().default(false),
  /** Set when it conflicts: what they said, in their words. */
  explicitValue: z.string().max(200).nullable().default(null),
  algorithmVersion: z.string().max(20).default(LEARNING_ALGORITHM_VERSION),
  featureVersion: z.string().max(20).default(FEATURE_VERSION),
});
export type FeatureAffinity = z.infer<typeof featureAffinitySchema>;

/**
 * The behavioural profile.
 *
 * Deliberately a *separate object* from `CandidateProfile`, not a section of
 * it. Two reasons, both structural: it can be reset or frozen without touching
 * anything explicit, and no code path that writes preferences can reach it.
 */
export const behavioralProfileSchema = z.object({
  candidateId: z.string().uuid(),
  affinities: z.array(featureAffinitySchema).default([]),
  totalEvents: z.number().int().min(0).default(0),
  distinctJobs: z.number().int().min(0).default(0),
  firstEventAt: z.coerce.date().nullable().default(null),
  lastEventAt: z.coerce.date().nullable().default(null),
  /** False until there is enough history to personalise at all. */
  hasSufficientData: z.boolean().default(false),
  /** Why not, when `hasSufficientData` is false. */
  coldStartReason: z.string().max(300).nullable().default(null),
  algorithmVersion: z.string().max(20).default(LEARNING_ALGORITHM_VERSION),
  featureVersion: z.string().max(20).default(FEATURE_VERSION),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type BehavioralProfile = z.infer<typeof behavioralProfileSchema>;

// ── Learning configuration (Parts 6, 11–13, 18–19, 32) ──────────────────────

export const EXPLORATION_LEVELS = ['off', 'conservative', 'balanced', 'aggressive'] as const;
export type ExplorationLevel = (typeof EXPLORATION_LEVELS)[number];

export const EXPLORATION_SHARE: Readonly<Record<ExplorationLevel, number>> = {
  off: 0,
  conservative: 0.08,
  balanced: 0.15,
  aggressive: 0.3,
};

export const learningConfigSchema = z.object({
  /** Master switch. Off means explicit preferences keep working, learning stops. */
  enabled: z.boolean().default(true),
  /**
   * Frozen: existing affinities still apply, but stop updating.
   *
   * Distinct from `enabled: false`, which stops applying them too. "Pause
   * personalization" is a different request from "stop learning new things".
   */
  frozen: z.boolean().default(false),

  signalWeights: z.record(z.string(), signalWeightSchema).default({}),
  contextWeights: z.record(z.string(), z.number().min(0).max(2)).default({}),

  /** Half-life in days for behavioural evidence. Explicit prefs never decay. */
  halfLifeDays: z.number().int().min(1).max(3_650).default(45),
  /** Evidence below this floor is dropped entirely rather than kept as noise. */
  minEvidence: z.number().min(0).max(10).default(0.5),
  /** Distinct observations at which confidence reaches ~0.63 of its ceiling. */
  confidenceSaturation: z.number().min(1).max(100).default(6),
  /** Confidence can never exceed this — behaviour is always inference. */
  maxConfidence: z.number().min(0).max(1).default(0.9),

  /** Largest change behaviour may make to a ranking score, in points. */
  maxBehavioralAdjustment: z.number().min(0).max(50).default(12),
  /** Events needed before any personalisation applies at all. */
  minEventsForPersonalization: z.number().int().min(0).max(1_000).default(8),

  exploration: z.enum(EXPLORATION_LEVELS).default('balanced'),
  /** Overrides the level's share when set. */
  explorationShare: z.number().min(0).max(0.5).nullable().default(null),

  /** Minimum evidence before a preference *suggestion* is offered. */
  suggestionMinObservations: z.number().int().min(1).max(200).default(8),
  suggestionMinConfidence: z.number().min(0).max(1).default(0.6),

  algorithmVersion: z.string().max(20).default(LEARNING_ALGORITHM_VERSION),
  featureVersion: z.string().max(20).default(FEATURE_VERSION),
  configurationVersion: z.number().int().min(1).default(1),
});
export type LearningConfig = z.infer<typeof learningConfigSchema>;

// ── Behavioral ranking adjustment (Parts 16–17) ─────────────────────────────

export const behavioralContributionSchema = z.object({
  dimension: z.enum(FEATURE_DIMENSIONS),
  value: z.string().max(160),
  affinity: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  /** Points contributed. Positive raises, negative lowers. */
  contribution: z.number(),
  /** Plain language, generated from these numbers — never model prose. */
  explanation: z.string().max(300),
});
export type BehavioralContribution = z.infer<typeof behavioralContributionSchema>;

/**
 * The behavioural verdict on one job.
 *
 * Emitted alongside — never merged into — `matchScore` and
 * `recommendationScore`. The final ranking multiplies them; each remains
 * independently inspectable, which is what makes "why did this move?"
 * answerable.
 */
export const behavioralAdjustmentSchema = z.object({
  jobId: z.string().uuid(),
  /** Points to add to the recommendation score. Bounded by config. */
  adjustment: z.number(),
  /** -1..1 before scaling, for display. */
  rawAffinity: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  contributions: z.array(behavioralContributionSchema).default([]),
  /** One sentence an operator or candidate can read. */
  explanation: z.string().max(400),
  /** Layers that were consulted and what each decided. */
  authorityTrace: z
    .array(
      z.object({
        layer: z.enum(PREFERENCE_LAYERS),
        applied: z.boolean(),
        detail: z.string().max(300),
      }),
    )
    .default([]),
  /** True when the job was selected for exploration rather than on score. */
  exploration: z.boolean().default(false),
  algorithmVersion: z.string().max(20).default(LEARNING_ALGORITHM_VERSION),
});
export type BehavioralAdjustment = z.infer<typeof behavioralAdjustmentSchema>;

// ── Preference suggestions (Parts 27–28) ────────────────────────────────────

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'declined', 'dismissed', 'expired'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/**
 * A proposed preference change, derived from behaviour.
 *
 * The single most important property: this is a *row in a suggestions table*,
 * not a mutation. Accepting it goes through the same validated preference-write
 * path a UI edit uses. Nothing here can write a preference on its own.
 */
export const preferenceSuggestionSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  /** Dot path into the preference payload, as the preference engine expects. */
  path: z.string().max(120),
  operation: z.enum(['set', 'add', 'remove', 'update_strength']),
  currentValue: z.unknown(),
  suggestedValue: z.unknown(),
  /** Shown verbatim. Must state the evidence, not just the conclusion. */
  message: z.string().max(500),
  /** The counts behind it, so the candidate can judge for themselves. */
  evidence: z.object({
    supporting: z.number().int().min(0),
    contradicting: z.number().int().min(0),
    windowDays: z.number().int().min(1),
    examples: z.array(z.string().max(200)).max(5).default([]),
  }),
  confidence: z.number().min(0).max(1),
  status: z.enum(SUGGESTION_STATUSES).default('pending'),
  createdAt: z.coerce.date().default(() => new Date()),
  respondedAt: z.coerce.date().nullable().default(null),
  algorithmVersion: z.string().max(20).default(LEARNING_ALGORITHM_VERSION),
});
export type PreferenceSuggestion = z.infer<typeof preferenceSuggestionSchema>;

// ── Query and source learning (Parts 20–23) ─────────────────────────────────

/**
 * How useful a discovery query turned out to be.
 *
 * Volume is explicitly not the measure. A query returning 100 jobs and zero
 * interactions is worse than one returning 20 with five saves, and
 * `engagementRate` is what says so.
 */
export const queryPerformanceSchema = z.object({
  queryId: z.string().max(120),
  candidateId: z.string().uuid(),
  jobsDiscovered: z.number().int().min(0).default(0),
  jobsMatched: z.number().int().min(0).default(0),
  jobsShown: z.number().int().min(0).default(0),
  views: z.number().int().min(0).default(0),
  clicks: z.number().int().min(0).default(0),
  saves: z.number().int().min(0).default(0),
  applications: z.number().int().min(0).default(0),
  rejections: z.number().int().min(0).default(0),
  /** Positive interactions per discovered job. */
  engagementRate: z.number().min(0).max(1).default(0),
  /** 0–100. Drives query prioritisation on the next plan. */
  valueScore: z.number().min(0).max(100).default(0),
  explanation: z.string().max(300).default(''),
  windowDays: z.number().int().min(1).default(30),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type QueryPerformance = z.infer<typeof queryPerformanceSchema>;

/**
 * Source effectiveness, from the candidate's point of view.
 *
 * Deliberately distinct from the *technical* source health of prompt 10. A
 * source can be perfectly reliable — 100% uptime, fast, well-formed — and
 * produce nothing this person wants. Collapsing the two would hide whichever
 * problem you were not looking for.
 */
export const sourceUserValueSchema = z.object({
  sourceId: z.string().max(120),
  candidateId: z.string().uuid(),
  jobsDiscovered: z.number().int().min(0).default(0),
  jobsShown: z.number().int().min(0).default(0),
  views: z.number().int().min(0).default(0),
  clicks: z.number().int().min(0).default(0),
  saves: z.number().int().min(0).default(0),
  applications: z.number().int().min(0).default(0),
  rejections: z.number().int().min(0).default(0),
  engagementRate: z.number().min(0).max(1).default(0),
  /** 0–100, *user* value. Technical health is tracked separately. */
  userValueScore: z.number().min(0).max(100).default(0),
  explanation: z.string().max(300).default(''),
  windowDays: z.number().int().min(1).default(30),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type SourceUserValue = z.infer<typeof sourceUserValueSchema>;

// ── Analytics and recommendation quality (Parts 39–40) ──────────────────────

export const engagementMetricsSchema = z.object({
  candidateId: z.string().uuid(),
  windowDays: z.number().int().min(1),
  recommendationsShown: z.number().int().min(0).default(0),
  jobsViewed: z.number().int().min(0).default(0),
  jobsClicked: z.number().int().min(0).default(0),
  jobsSaved: z.number().int().min(0).default(0),
  jobsRejected: z.number().int().min(0).default(0),
  jobsApplied: z.number().int().min(0).default(0),
  viewRate: z.number().min(0).max(1).default(0),
  clickRate: z.number().min(0).max(1).default(0),
  saveRate: z.number().min(0).max(1).default(0),
  applicationRate: z.number().min(0).max(1).default(0),
  /** Share of shown recommendations that got any positive interaction. */
  acceptanceRate: z.number().min(0).max(1).default(0),
  rejectionRate: z.number().min(0).max(1).default(0),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type EngagementMetrics = z.infer<typeof engagementMetricsSchema>;

/**
 * Ranking quality at a cutoff.
 *
 * `k` matters because a recommender is judged on what it puts at the top. A
 * system with excellent precision@100 and poor precision@10 is a system nobody
 * benefits from, since nobody reads a hundred jobs.
 */
export const rankingQualitySchema = z.object({
  candidateId: z.string().uuid(),
  k: z.number().int().min(1).max(100),
  windowDays: z.number().int().min(1),
  /** Recommendations at rank ≤ k that were shown at all. */
  shown: z.number().int().min(0).default(0),
  /** Any positive interaction. */
  relevant: z.number().int().min(0).default(0),
  precisionAtK: z.number().min(0).max(1).default(0),
  saveAtK: z.number().min(0).max(1).default(0),
  clickAtK: z.number().min(0).max(1).default(0),
  applyAtK: z.number().min(0).max(1).default(0),
  /**
   * Of everything positively engaged with in the window, the share that was in
   * the top k. Recall is only measurable against engagement, not against the
   * true set of good jobs, and this field name says so.
   */
  recallOfEngaged: z.number().min(0).max(1).default(0),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type RankingQuality = z.infer<typeof rankingQualitySchema>;

// ── Experiments (Part 41) ───────────────────────────────────────────────────

export const EXPERIMENT_STATUSES = ['draft', 'running', 'paused', 'completed'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/**
 * A ranking experiment.
 *
 * `enabled` defaults to false and assignment is deterministic per candidate, so
 * an experiment cannot start affecting a real person as a side effect of being
 * defined. The brief is explicit about that, and it is also simply how you
 * avoid discovering a month later that half your recommendations were a variant.
 */
export const experimentSchema = z.object({
  id: z.string().max(80),
  name: z.string().max(200),
  hypothesis: z.string().max(500).default(''),
  status: z.enum(EXPERIMENT_STATUSES).default('draft'),
  variants: z
    .array(
      z.object({
        key: z.string().max(40),
        description: z.string().max(300).default(''),
        /** Config overlaid on the learning config for this variant. */
        config: z.record(z.string(), z.unknown()).default({}),
        /** 0–1; must sum to 1 across variants. */
        allocation: z.number().min(0).max(1),
      }),
    )
    .min(2)
    .max(6),
  startedAt: z.coerce.date().nullable().default(null),
  endedAt: z.coerce.date().nullable().default(null),
  /** Candidates explicitly opted in. Empty means nobody is enrolled. */
  enrolledCandidateIds: z.array(z.string().uuid()).default([]),
});
export type Experiment = z.infer<typeof experimentSchema>;

export const experimentResultSchema = z.object({
  experimentId: z.string().max(80),
  variant: z.string().max(40),
  candidates: z.number().int().min(0).default(0),
  recommendationsShown: z.number().int().min(0).default(0),
  clicks: z.number().int().min(0).default(0),
  saves: z.number().int().min(0).default(0),
  applications: z.number().int().min(0).default(0),
  acceptanceRate: z.number().min(0).max(1).default(0),
  /** Stated plainly rather than implied by a p-value nobody computed. */
  note: z.string().max(300).default(''),
});
export type ExperimentResult = z.infer<typeof experimentResultSchema>;
