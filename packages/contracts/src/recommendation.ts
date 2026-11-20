import { z } from 'zod';

/**
 * Recommendation contracts.
 *
 * The distinction this whole layer rests on: **matching and recommending are
 * different questions.**
 *
 *   match:          "how well does this job fit this candidate?"
 *   recommendation: "of everything available right now, what should they
 *                    actually see, in what order, and why?"
 *
 * A 96-match posted 25 days ago on an aggregator that has since removed it is a
 * worse *recommendation* than a 91-match posted an hour ago on the company's
 * own careers page. Both statements are true at once, which is precisely why
 * the match score is never modified to express the second one.
 */

/** Bumped when ranking behaviour changes, so old rankings stay explainable. */
export const RECOMMENDATION_VERSION = '1.0.0';

// ── Deduplication ───────────────────────────────────────────────────────────

/**
 * How confident the system is that two records are the same opening.
 *
 * A tier rather than a boolean because the consequences differ: `exact` may be
 * merged silently, `probable` should be merged but shown as such, and `weak`
 * is worth recording without acting on. Collapsing these to `duplicate: true`
 * throws away exactly the information needed to debug a bad merge.
 */
export const DUPLICATE_TIERS = ['exact', 'strong', 'probable', 'weak', 'distinct'] as const;
export type DuplicateTier = (typeof DUPLICATE_TIERS)[number];

/** Minimum confidence for each tier. Configurable; see `dedupConfigSchema`. */
export const DEDUP_SIGNALS = [
  'external_id',
  'canonical_url',
  'application_url',
  'ats_identity',
  'company',
  'company_domain',
  'title',
  'location',
  'salary',
  'posted_date',
  'description_similarity',
  'requirements_similarity',
] as const;
export type DedupSignal = (typeof DEDUP_SIGNALS)[number];

/**
 * One signal's verdict.
 *
 * `unknown` is its own state and is never counted as agreement. Two postings
 * that both omit salary have not agreed about salary — treating that as a match
 * would let a pile of missing fields manufacture a confident duplicate.
 */
export const SIGNAL_AGREEMENTS = ['match', 'conflict', 'unknown'] as const;
export type SignalAgreement = (typeof SIGNAL_AGREEMENTS)[number];

export const dedupSignalResultSchema = z.object({
  signal: z.enum(DEDUP_SIGNALS),
  agreement: z.enum(SIGNAL_AGREEMENTS),
  /** 0-1. How much this signal moves the verdict when it agrees. */
  weight: z.number().min(0).max(1),
  /** 0-1 for graded signals (similarity); 1 or 0 for binary ones. */
  strength: z.number().min(0).max(1).default(0),
  detail: z.string().max(300),
});
export type DedupSignalResult = z.infer<typeof dedupSignalResultSchema>;

export const duplicateVerdictSchema = z.object({
  isDuplicate: z.boolean(),
  tier: z.enum(DUPLICATE_TIERS),
  /** 0-1. Never a bare boolean — see the tier comment. */
  duplicateConfidence: z.number().min(0).max(1),
  /** Plain-language, ordered by how much each contributed. */
  duplicateReason: z.string().max(500),
  signals: z.array(dedupSignalResultSchema).default([]),
  /** Signals that actively disagreed. A single hard conflict vetoes a merge. */
  conflicts: z.array(dedupSignalResultSchema).default([]),
});
export type DuplicateVerdict = z.infer<typeof duplicateVerdictSchema>;

// ── Source authority ────────────────────────────────────────────────────────

/**
 * How much a source's version of a fact should be trusted.
 *
 * Deliberately not a fixed hierarchy. A company careers page is *usually* more
 * authoritative than an aggregator, but not always — plenty of careers pages
 * are stale mirrors of an ATS, and some aggregators carry structured salary a
 * careers page omits. The default ordering is configuration, not code.
 */
export const SOURCE_AUTHORITY_LEVELS = [
  'authoritative',
  'high',
  'medium',
  'low',
  'unverified',
] as const;
export type SourceAuthorityLevel = (typeof SOURCE_AUTHORITY_LEVELS)[number];

export const AUTHORITY_WEIGHTS: Readonly<Record<SourceAuthorityLevel, number>> = {
  authoritative: 1,
  high: 0.8,
  medium: 0.55,
  low: 0.35,
  unverified: 0.15,
};

export const sourceAuthorityConfigSchema = z.object({
  /** Per-source override, checked first. Keyed by source id. */
  bySourceId: z.record(z.string(), z.enum(SOURCE_AUTHORITY_LEVELS)).prefault({}),
  /** Fallback by source type. */
  bySourceType: z.record(z.string(), z.enum(SOURCE_AUTHORITY_LEVELS)).default({
    ats: 'authoritative',
    job_api: 'medium',
    rss_feed: 'medium',
    mailbox: 'medium',
    html_page: 'high',
    search_discovery: 'low',
    social: 'low',
    manual: 'high',
  }),
  /** Last resort. */
  default: z.enum(SOURCE_AUTHORITY_LEVELS).default('medium'),
});
export type SourceAuthorityConfig = z.infer<typeof sourceAuthorityConfigSchema>;

// ── Canonical job ───────────────────────────────────────────────────────────

/** Where one merged field came from, so a merged value stays attributable. */
export const fieldProvenanceSchema = z.object({
  field: z.string().max(60),
  sourceId: z.string().max(120),
  authority: z.enum(SOURCE_AUTHORITY_LEVELS),
  confidence: z.number().min(0).max(1),
  observedAt: z.coerce.date(),
  reason: z.string().max(200),
});
export type FieldProvenance = z.infer<typeof fieldProvenanceSchema>;

/**
 * A disagreement between sources, recorded rather than silently resolved.
 *
 * "LinkedIn says hybrid, the careers page says remote" is information the
 * candidate needs before applying. Picking one and discarding the other would
 * present a guess as a fact.
 */
export const mergeConflictSchema = z.object({
  field: z.string().max(60),
  chosen: z.string().max(300).nullable(),
  chosenSourceId: z.string().max(120).nullable(),
  alternatives: z
    .array(
      z.object({
        value: z.string().max(300),
        sourceId: z.string().max(120),
        authority: z.enum(SOURCE_AUTHORITY_LEVELS),
        observedAt: z.coerce.date(),
      }),
    )
    .default([]),
  reason: z.string().max(300),
});
export type MergeConflict = z.infer<typeof mergeConflictSchema>;

export const canonicalMemberSchema = z.object({
  jobId: z.string().uuid(),
  sourceId: z.string().max(120),
  authority: z.enum(SOURCE_AUTHORITY_LEVELS),
  sourceUrl: z.string().max(2000),
  applyUrl: z.string().max(2000).nullable().default(null),
  postedAt: z.coerce.date().nullable().default(null),
  lastSeenAt: z.coerce.date(),
  duplicateConfidence: z.number().min(0).max(1).default(1),
  duplicateReason: z.string().max(500).default('seed member'),
});
export type CanonicalMember = z.infer<typeof canonicalMemberSchema>;

export const canonicalJobSchema = z.object({
  groupId: z.string().uuid(),
  /** The member whose record represents the group. */
  canonicalJobId: z.string().uuid(),
  /** Best application path across all members, not merely the canonical one's. */
  bestApplyUrl: z.string().max(2000).nullable().default(null),
  bestApplyUrlSourceId: z.string().max(120).nullable().default(null),
  members: z.array(canonicalMemberSchema).default([]),
  provenance: z.array(fieldProvenanceSchema).default([]),
  conflicts: z.array(mergeConflictSchema).default([]),
  /** Earliest first-seen and latest last-seen across the whole group. */
  firstSeenAt: z.coerce.date(),
  lastSeenAt: z.coerce.date(),
});
export type CanonicalJob = z.infer<typeof canonicalJobSchema>;

// ── Freshness ───────────────────────────────────────────────────────────────

/** What the age was actually measured from — they are not equally trustworthy. */
export const FRESHNESS_BASES = ['posted', 'updated', 'verified', 'first_seen'] as const;
export type FreshnessBasis = (typeof FRESHNESS_BASES)[number];

export const freshnessScoreSchema = z.object({
  /** 0-100. */
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  basis: z.enum(FRESHNESS_BASES),
  ageDays: z.number().min(0),
  ageHours: z.number().min(0),
  explanation: z.string().max(300),
});
export type FreshnessScore = z.infer<typeof freshnessScoreSchema>;

// ── Lifecycle / staleness ───────────────────────────────────────────────────

/**
 * Where a posting is in its life.
 *
 * `UNKNOWN` is a real state, not a placeholder: a source that stopped listing a
 * job tells us nothing definite about whether it was filled or the source
 * merely changed its feed. Nothing here deletes anything — a job that turns out
 * to be alive after all must be recoverable.
 */
export const LIFECYCLE_STATUSES = ['ACTIVE', 'STALE', 'EXPIRED', 'CLOSED', 'UNKNOWN'] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const STALENESS_SIGNALS = [
  'old_posting',
  'past_valid_through',
  'absent_from_source',
  'dead_application_url',
  'http_404',
  'http_error',
  'position_filled_text',
  'no_longer_accepting_text',
  'closing_date_passed',
  'source_removed',
] as const;
export type StalenessSignal = (typeof STALENESS_SIGNALS)[number];

export const stalenessSignalResultSchema = z.object({
  signal: z.enum(STALENESS_SIGNALS),
  /** 0-1. How strongly this signal implies the job is gone. */
  strength: z.number().min(0).max(1),
  detail: z.string().max(300),
});
export type StalenessSignalResult = z.infer<typeof stalenessSignalResultSchema>;

export const stalenessVerdictSchema = z.object({
  status: z.enum(LIFECYCLE_STATUSES),
  confidence: z.number().min(0).max(1),
  signals: z.array(stalenessSignalResultSchema).default([]),
  explanation: z.string().max(400),
});
export type StalenessVerdict = z.infer<typeof stalenessVerdictSchema>;

// ── Verification ────────────────────────────────────────────────────────────

export const VERIFICATION_OUTCOMES = [
  'reachable',
  'not_found',
  'gone',
  'error',
  'blocked',
  'skipped',
] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export const verificationResultSchema = z.object({
  outcome: z.enum(VERIFICATION_OUTCOMES),
  url: z.string().max(2000),
  httpStatus: z.number().int().nullable().default(null),
  checkedAt: z.coerce.date(),
  durationMs: z.number().min(0).default(0),
  detail: z.string().max(300).default(''),
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;

// ── Job quality ─────────────────────────────────────────────────────────────

/**
 * Quality of the *posting*, independent of any candidate.
 *
 * The governing rule, stated as code below: **missing information reduces
 * confidence, not quality.** Most legitimate postings omit salary; a model that
 * punishes them for it systematically demotes exactly the sort of role a real
 * employer posts and promotes the aggregator spam that fills every field.
 */
export const jobQualityComponentSchema = z.object({
  component: z.string().max(40),
  score: z.number().min(0).max(100),
  weight: z.number().min(0),
  applicable: z.boolean().default(true),
  explanation: z.string().max(300),
});
export type JobQualityComponent = z.infer<typeof jobQualityComponentSchema>;

export const jobQualitySchema = z.object({
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  components: z.array(jobQualityComponentSchema).default([]),
  /** Short labels for the UI, e.g. "no application url". */
  flags: z.array(z.string().max(60)).default([]),
  explanation: z.string().max(500),
});
export type JobQuality = z.infer<typeof jobQualitySchema>;

// ── Scam detection ──────────────────────────────────────────────────────────

export const SCAM_VERDICTS = ['clear', 'suspicious', 'likely_scam'] as const;
export type ScamVerdict = (typeof SCAM_VERDICTS)[number];

export const scamSignalSchema = z.object({
  signal: z.string().max(60),
  weight: z.number().min(0).max(1),
  evidence: z.string().max(300).nullable().default(null),
  /** Which layer raised it. Kept so an AI-only verdict is visibly AI-only. */
  origin: z.enum(['deterministic', 'ai']),
});
export type ScamSignal = z.infer<typeof scamSignalSchema>;

/**
 * Deterministic and AI risk are stored **separately and never averaged into
 * one opaque number**. A model is one opinion among the rules, and a scam
 * verdict that no rule can account for is a verdict nobody can audit.
 */
export const scamAssessmentSchema = z.object({
  risk: z.number().min(0).max(1),
  verdict: z.enum(SCAM_VERDICTS),
  deterministicRisk: z.number().min(0).max(1),
  aiRisk: z.number().min(0).max(1).nullable().default(null),
  aiModel: z.string().max(120).nullable().default(null),
  signals: z.array(scamSignalSchema).default([]),
  explanation: z.string().max(500),
});
export type ScamAssessment = z.infer<typeof scamAssessmentSchema>;

// ── Reposts ─────────────────────────────────────────────────────────────────

/**
 * `refresh` — the source bumped the date without changing anything.
 * `repost`  — the same opening advertised again after a gap.
 * `reopened`— a long gap and material changes; effectively a new opportunity.
 */
export const REPOST_KINDS = ['new', 'refresh', 'repost', 'reopened'] as const;
export type RepostKind = (typeof REPOST_KINDS)[number];

export const repostAssessmentSchema = z.object({
  kind: z.enum(REPOST_KINDS),
  occurrences: z.number().int().min(1),
  firstSeenAt: z.coerce.date(),
  lastSeenAt: z.coerce.date(),
  /** Days between the previous sighting and this one. */
  gapDays: z.number().min(0).nullable().default(null),
  /** Penalty applied to the recommendation score, 0-1 (1 = no penalty). */
  noveltyFactor: z.number().min(0).max(1).default(1),
  explanation: z.string().max(300),
});
export type RepostAssessment = z.infer<typeof repostAssessmentSchema>;

// ── Candidate exposure ──────────────────────────────────────────────────────

/**
 * What the candidate has already seen of this job.
 *
 * Exists so the system can stop re-recommending something the person already
 * dismissed, and — more importantly — stop emailing the same job every night.
 */
export const EXPOSURE_STATES = [
  'never_shown',
  'shown',
  'clicked',
  'saved',
  'applied',
  'dismissed',
  'rejected',
  'notified',
] as const;
export type ExposureState = (typeof EXPOSURE_STATES)[number];

export const exposureSchema = z.object({
  state: z.enum(EXPOSURE_STATES).default('never_shown'),
  timesShown: z.number().int().min(0).default(0),
  firstShownAt: z.coerce.date().nullable().default(null),
  lastShownAt: z.coerce.date().nullable().default(null),
  notifiedAt: z.coerce.date().nullable().default(null),
  /** Content hash at the moment of notification, for material-change detection. */
  notifiedContentHash: z.string().max(80).nullable().default(null),
  notifiedScore: z.number().min(0).max(100).nullable().default(null),
});
export type Exposure = z.infer<typeof exposureSchema>;

// ── Material change ─────────────────────────────────────────────────────────

/** Fields whose movement is worth interrupting someone about. */
export const MATERIAL_FIELDS = [
  'salary',
  'location',
  'work_arrangement',
  'visa_sponsorship',
  'seniority',
  'employment_type',
  'requirements',
  'application_url',
] as const;
export type MaterialField = (typeof MATERIAL_FIELDS)[number];

export const materialChangeSchema = z.object({
  field: z.enum(MATERIAL_FIELDS),
  before: z.string().max(300).nullable(),
  after: z.string().max(300).nullable(),
  /** 0-1. Only changes above the configured threshold justify re-notifying. */
  significance: z.number().min(0).max(1),
  direction: z.enum(['improved', 'worsened', 'changed']),
  summary: z.string().max(300),
});
export type MaterialChange = z.infer<typeof materialChangeSchema>;

export const materialChangeResultSchema = z.object({
  changed: z.boolean(),
  changes: z.array(materialChangeSchema).default([]),
  maxSignificance: z.number().min(0).max(1).default(0),
  explanation: z.string().max(400),
});
export type MaterialChangeResult = z.infer<typeof materialChangeResultSchema>;

// ── Recommendation ──────────────────────────────────────────────────────────

export const RECOMMENDATION_TIERS = [
  'EXCEPTIONAL',
  'HIGHLY_RECOMMENDED',
  'STRONG',
  'WORTH_CONSIDERING',
  'LOW_PRIORITY',
  'EXCLUDED',
  'STALE',
] as const;
export type RecommendationTier = (typeof RECOMMENDATION_TIERS)[number];

export const TIER_ICONS: Readonly<Record<RecommendationTier, string>> = {
  EXCEPTIONAL: '🚨',
  HIGHLY_RECOMMENDED: '🔥',
  STRONG: '🟢',
  WORTH_CONSIDERING: '🟡',
  LOW_PRIORITY: '⚪',
  EXCLUDED: '🔴',
  STALE: '⚫',
};

/** One term of the recommendation formula, shown exactly as it was computed. */
export const recommendationFactorSchema = z.object({
  factor: z.string().max(40),
  /** 0-100, the factor's own scale. */
  value: z.number().min(0).max(100),
  weight: z.number().min(0),
  /** value × normalisedWeight — what this factor actually contributed. */
  contribution: z.number(),
  explanation: z.string().max(300),
});
export type RecommendationFactor = z.infer<typeof recommendationFactorSchema>;

/**
 * The score, with its arithmetic exposed.
 *
 * `rawScore → calibrated → penalised → final` is kept as four separate numbers
 * so a surprising result can be traced to the stage that produced it rather
 * than argued about.
 */
export const recommendationScoreSchema = z.object({
  factors: z.array(recommendationFactorSchema).default([]),
  weightsUsed: z.record(z.string(), z.number()).prefault({}),
  rawScore: z.number().min(0).max(100),
  calibratedScore: z.number().min(0).max(100),
  diversityPenalty: z.number().min(0).max(100).default(0),
  diversityReason: z.string().max(300).default(''),
  finalScore: z.number().min(0).max(100),
  tier: z.enum(RECOMMENDATION_TIERS),
});
export type RecommendationScore = z.infer<typeof recommendationScoreSchema>;

/**
 * Named `JobRecommendation`, not `Recommendation`: `common.ts` already uses
 * that name for the apply/maybe/skip *action* scale from prompt 2. Two things
 * called Recommendation in one contracts package is how a barrel export becomes
 * ambiguous and how a reader stops trusting either name.
 */
export const jobRecommendationSchema = z.object({
  jobId: z.string().uuid(),
  candidateProfileId: z.string().uuid(),
  rank: z.number().int().min(1),

  score: recommendationScoreSchema,
  /** The underlying match, unmodified. Never overwritten by ranking logic. */
  matchScore: z.number().min(0).max(100),
  matchConfidence: z.number().min(0).max(1),

  quality: jobQualitySchema,
  freshness: freshnessScoreSchema,
  lifecycle: stalenessVerdictSchema,
  scam: scamAssessmentSchema,
  repost: repostAssessmentSchema,
  exposure: exposureSchema,
  sourceAuthority: z.enum(SOURCE_AUTHORITY_LEVELS),
  duplicateOf: z.string().uuid().nullable().default(null),

  /** Built from structured data only — never model prose. */
  rankExplanation: z.string().max(1500),
  rankReasons: z.array(z.string().max(200)).default([]),

  notificationEligible: z.boolean(),
  notificationBlockers: z.array(z.string().max(200)).default([]),
  recommendationVersion: z.string().max(20),
  computedAt: z.coerce.date(),
});
export type JobRecommendation = z.infer<typeof jobRecommendationSchema>;

// ── Notification eligibility ────────────────────────────────────────────────

export const NOTIFICATION_BLOCKERS = [
  'not_active',
  'duplicate',
  'previously_rejected',
  'previously_dismissed',
  'ineligible_match',
  'below_score_threshold',
  'below_confidence_threshold',
  'already_notified',
  'no_application_path',
  'scam_risk',
  'outside_freshness_window',
  'company_cap_reached',
  'source_cap_reached',
  'digest_cap_reached',
] as const;
export type NotificationBlocker = (typeof NOTIFICATION_BLOCKERS)[number];

export const notificationEligibilitySchema = z.object({
  eligible: z.boolean(),
  blockers: z.array(z.enum(NOTIFICATION_BLOCKERS)).default([]),
  reasons: z.array(z.string().max(200)).default([]),
  /** Set when a previously-notified job qualifies again. */
  renotifyReason: z.string().max(300).nullable().default(null),
});
export type NotificationEligibility = z.infer<typeof notificationEligibilitySchema>;

// ── Configuration ───────────────────────────────────────────────────────────

export const dedupConfigSchema = z.object({
  /** Confidence at or above which a pair is merged automatically. */
  mergeThreshold: z.number().min(0).max(1).default(0.82),
  /** Confidence at or above which a pair is recorded but not merged. */
  reviewThreshold: z.number().min(0).max(1).default(0.6),
  simhashMaxDistance: z.number().int().min(0).max(64).default(6),
  descriptionSimilarityThreshold: z.number().min(0).max(1).default(0.85),
  /** Postings further apart than this are not compared at all. */
  postedWindowDays: z.number().int().min(1).max(180).default(21),
  tierThresholds: z
    .object({
      exact: z.number().min(0).max(1).default(0.97),
      strong: z.number().min(0).max(1).default(0.85),
      probable: z.number().min(0).max(1).default(0.7),
      weak: z.number().min(0).max(1).default(0.45),
    })
    .prefault({}),
});
export type DedupConfig = z.infer<typeof dedupConfigSchema>;

export const freshnessConfigSchema = z.object({
  /** Age at which freshness has decayed to half. */
  halfLifeDays: z.number().min(0.1).max(365).default(7),
  /** Anything newer than this scores 100. */
  peakHours: z.number().min(0).max(720).default(6),
  /** Past this age a posting is treated as stale unless re-verified. */
  staleAfterDays: z.number().int().min(1).max(365).default(45),
  /** Consecutive absences from a source listing before presuming closed. */
  absenceRunsBeforeClosed: z.number().int().min(1).max(20).default(3),
});
export type FreshnessConfig = z.infer<typeof freshnessConfigSchema>;

export const verificationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Recommendation score at or above which a job is re-verified before use. */
  highValueScore: z.number().min(0).max(100).default(80),
  /** Skip if verified more recently than this. */
  maxAgeHoursHighValue: z.number().min(0).max(720).default(6),
  maxAgeHoursNormal: z.number().min(0).max(2160).default(168),
  /** Cap per run, so verification cannot become the slowest stage. */
  maxChecksPerRun: z.number().int().min(0).max(1000).default(25),
  timeoutMs: z.number().int().min(500).max(60_000).default(8000),
});
export type VerificationConfig = z.infer<typeof verificationConfigSchema>;

/**
 * The recommendation formula's weights.
 *
 * Relative, not percentages — the engine normalises them. Stored as data so a
 * candidate who cares more about freshness than about a perfect skill match can
 * say so without a code change.
 */
export const recommendationWeightsSchema = z.object({
  match: z.number().min(0).max(100).default(50),
  matchConfidence: z.number().min(0).max(100).default(10),
  quality: z.number().min(0).max(100).default(12),
  freshness: z.number().min(0).max(100).default(15),
  sourceAuthority: z.number().min(0).max(100).default(6),
  applicationAvailability: z.number().min(0).max(100).default(4),
  novelty: z.number().min(0).max(100).default(3),
});
export type RecommendationWeights = z.infer<typeof recommendationWeightsSchema>;

export const diversificationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxPerCompany: z.number().int().min(1).max(50).default(3),
  maxPerSource: z.number().int().min(1).max(200).default(15),
  /**
   * Deliberately loose. Role diversification exists to stop ten *identical*
   * postings, not to stop a frontend engineer being shown frontend jobs — at
   * the default of 5 it demoted a genuinely strong role below aggregator filler
   * purely for sharing a role slug with earlier picks. Company and technology
   * penalties already do the work this was reaching for.
   */
  maxPerRole: z.number().int().min(1).max(200).default(20),
  /** Points deducted for each earlier pick sharing a dimension. */
  companyPenalty: z.number().min(0).max(100).default(9),
  sourcePenalty: z.number().min(0).max(100).default(3),
  rolePenalty: z.number().min(0).max(100).default(4),
  technologyPenalty: z.number().min(0).max(100).default(2),
  /** Total penalty ceiling, so diversity can never bury an exceptional job. */
  maxPenalty: z.number().min(0).max(100).default(22),
  /**
   * How deep to diversify. Greedy re-ranking is quadratic, and beyond a few
   * hundred results nobody is scrolling — so the tail is left in score order.
   */
  horizon: z.number().int().min(10).max(5000).default(250),
});
export type DiversificationConfig = z.infer<typeof diversificationConfigSchema>;

/**
 * Tier thresholds.
 *
 * Set high on purpose. If most jobs land in 90-99 the number has stopped
 * carrying information, and the calibration stage exists to keep that from
 * happening — see `ranking/calibration.ts`.
 */
export const recommendationThresholdConfigSchema = z.object({
  exceptional: z.number().min(0).max(100).default(88),
  highlyRecommended: z.number().min(0).max(100).default(76),
  strong: z.number().min(0).max(100).default(64),
  worthConsidering: z.number().min(0).max(100).default(48),
  /** Below this a job is LOW_PRIORITY and never notified. */
  minimumConfidence: z.number().min(0).max(1).default(0.3),
});
export type RecommendationThresholdConfig = z.infer<typeof recommendationThresholdConfigSchema>;

export const notificationPolicySchema = z.object({
  minimumScore: z.number().min(0).max(100).default(64),
  minimumConfidence: z.number().min(0).max(1).default(0.4),
  maxPerDigest: z.number().int().min(1).max(100).default(10),
  maxPerCompanyPerDigest: z.number().int().min(1).max(20).default(2),
  maxPerSourcePerDigest: z.number().int().min(1).max(50).default(6),
  /** Candidate-configurable: "only jobs posted in the last N hours". */
  freshnessWindowHours: z.number().int().min(1).max(8760).nullable().default(null),
  requireApplicationPath: z.boolean().default(true),
  maxScamRisk: z.number().min(0).max(1).default(0.4),
  /** Significance a change must reach before a notified job is sent again. */
  renotifyMinSignificance: z.number().min(0).max(1).default(0.5),
  /** Do not re-notify within this window regardless of changes. */
  renotifyCooldownHours: z.number().int().min(0).max(8760).default(72),
  allowedLifecycleStatuses: z
    .array(z.enum(LIFECYCLE_STATUSES))
    .default(['ACTIVE', 'UNKNOWN']),
});
export type NotificationPolicy = z.infer<typeof notificationPolicySchema>;

export const recommendationConfigSchema = z.object({
  dedup: dedupConfigSchema.prefault({}),
  authority: sourceAuthorityConfigSchema.prefault({}),
  freshness: freshnessConfigSchema.prefault({}),
  verification: verificationConfigSchema.prefault({}),
  weights: recommendationWeightsSchema.prefault({}),
  diversification: diversificationConfigSchema.prefault({}),
  thresholds: recommendationThresholdConfigSchema.prefault({}),
  notification: notificationPolicySchema.prefault({}),
  /** Stretch the score distribution so the top of the range means something. */
  calibration: z
    .object({
      enabled: z.boolean().default(true),
      /** Raw score mapped to the top of the scale. */
      referenceHigh: z.number().min(0).max(100).default(82),
      /** Raw score mapped to the bottom. */
      referenceLow: z.number().min(0).max(100).default(30),
      /** Ceiling after calibration; leaves headroom above the top tier. */
      ceiling: z.number().min(0).max(100).default(98),
    })
    .prefault({}),
});
export type RecommendationConfig = z.infer<typeof recommendationConfigSchema>;

// ── Top-N query ─────────────────────────────────────────────────────────────

/**
 * Options for `getTopRecommendations`.
 *
 * Every filter is an enum, a uuid or a bounded number. Nothing here becomes a
 * SQL fragment, so a caller cannot widen the query past what the repository
 * intends to expose.
 */
export const topRecommendationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  minimumScore: z.coerce.number().min(0).max(100).optional(),
  minimumConfidence: z.coerce.number().min(0).max(1).optional(),
  freshnessWindowHours: z.coerce.number().int().min(1).max(8760).optional(),
  tiers: z.array(z.enum(RECOMMENDATION_TIERS)).optional(),
  countries: z.array(z.string().trim().min(2).max(2)).optional(),
  sourceIds: z.array(z.string().trim().max(120)).optional(),
  companyIds: z.array(z.string().uuid()).optional(),
  roleSlugs: z.array(z.string().trim().max(120)).optional(),
  lifecycleStatuses: z.array(z.enum(LIFECYCLE_STATUSES)).optional(),
  notificationEligibleOnly: z.boolean().default(false),
  /** Exclude anything the candidate has already been shown. */
  unseenOnly: z.boolean().default(false),
  diversify: z.boolean().default(true),
});
export type TopRecommendationsQuery = z.infer<typeof topRecommendationsQuerySchema>;
