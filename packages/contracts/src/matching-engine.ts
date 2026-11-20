import { z } from 'zod';

/**
 * Matching engine contracts.
 *
 * The governing design rule: **a match is never a single number.** Every score
 * carries the evidence that produced it, and every dimension is stored
 * separately, because the only useful answer to "why did this get 72?" is a
 * breakdown, not a number.
 *
 * Two invariants the engine enforces in code, not by convention:
 *
 *  1. **Semantic similarity never overrides eligibility.** A 0.98-similar job
 *     that violates a hard constraint is INELIGIBLE, full stop.
 *  2. **The LLM never decides a hard constraint** and can only move the score
 *     within a bounded, configurable range.
 */

/** Bumped when scoring behaviour changes, so old matches stay explainable. */
export const MATCHING_VERSION = '1.0.0';

// ── Constraint results ──────────────────────────────────────────────────────

/**
 * Three states, not two.
 *
 * `UNKNOWN` exists because most postings omit salary and say nothing about
 * sponsorship. Collapsing it into FAIL would discard the majority of the
 * corpus; collapsing it into PASS would hide real risk. It is surfaced as its
 * own state and only becomes a failure when the candidate explicitly asked for
 * that.
 */
export const CONSTRAINT_RESULTS = ['PASS', 'FAIL', 'UNKNOWN'] as const;
export type ConstraintResult = (typeof CONSTRAINT_RESULTS)[number];

/**
 * How binding a constraint is.
 *
 * `ABSOLUTE` excludes the job. `PREFERRED` only shifts the score. "Cannot work
 * on-site" and "prefer remote" are different instructions and must not share a
 * representation.
 */
export const CONSTRAINT_SEVERITIES = ['ABSOLUTE', 'PREFERRED'] as const;
export type ConstraintSeverity = (typeof CONSTRAINT_SEVERITIES)[number];

export const hardConstraintCheckSchema = z.object({
  constraint: z.string().max(60),
  severity: z.enum(CONSTRAINT_SEVERITIES),
  result: z.enum(CONSTRAINT_RESULTS),
  /** What the candidate asked for, in display form. */
  required: z.string().max(200).nullable().default(null),
  /** What the job offers, in display form. */
  actual: z.string().max(200).nullable().default(null),
  /** Plain-language sentence shown directly in the UI. */
  explanation: z.string().max(400),
});
export type HardConstraintCheck = z.infer<typeof hardConstraintCheckSchema>;

export const hardConstraintResultSchema = z.object({
  eligible: z.boolean(),
  checks: z.array(hardConstraintCheckSchema).default([]),
  /** Only ABSOLUTE checks that returned FAIL. */
  violations: z.array(hardConstraintCheckSchema).default([]),
  /** Checks that could not be decided from the available data. */
  unknowns: z.array(hardConstraintCheckSchema).default([]),
});
export type HardConstraintResult = z.infer<typeof hardConstraintResultSchema>;

// ── Component scores ────────────────────────────────────────────────────────

/**
 * One dimension's verdict.
 *
 * `applicable: false` means the candidate expressed no preference here, or the
 * job supplied no data. Such a dimension is excluded from the weighted average
 * entirely rather than averaged in as zero — scoring silence as a failure
 * systematically punishes postings that merely omit a field.
 */
export const componentScoreSchema = z.object({
  dimension: z.string().max(40),
  /** 0-100. */
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  applicable: z.boolean().default(true),
  explanation: z.string().max(400),
  /** Concrete supporting facts, e.g. matched skill names. */
  evidence: z.array(z.string().max(200)).default([]),
});
export type ComponentScore = z.infer<typeof componentScoreSchema>;

export const SCORE_DIMENSIONS = [
  'skills',
  'experience',
  'seniority',
  'title',
  'location',
  'workArrangement',
  'salary',
  'visa',
  'education',
  'industry',
  'employmentType',
  'company',
  'semantic',
  'behavioral',
  'quality',
] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

// ── Skill matching detail ───────────────────────────────────────────────────

/** How a candidate skill satisfied a job requirement. */
export const SKILL_MATCH_KINDS = ['exact', 'closely_related', 'transferable', 'missing'] as const;
export type SkillMatchKind = (typeof SKILL_MATCH_KINDS)[number];

/** Named `…Detail` to stay distinct from `SkillGraph`'s traversal result. */
export const skillMatchDetailSchema = z.object({
  required: z.string().max(120),
  requirement: z.enum(['required', 'preferred', 'optional', 'inferred']),
  kind: z.enum(SKILL_MATCH_KINDS),
  /** The candidate skill that satisfied it, when any did. */
  satisfiedBy: z.string().max(120).nullable().default(null),
  /** 0-1. 1 for an exact match; less when credit came through the graph. */
  strength: z.number().min(0).max(1),
  /** Path through the skill graph, for an explainable indirect match. */
  via: z.array(z.string().max(80)).default([]),
});
export type SkillMatchDetail = z.infer<typeof skillMatchDetailSchema>;

// ── Recommendation ──────────────────────────────────────────────────────────

export const RECOMMENDATION_CATEGORIES = [
  'EXCEPTIONAL_MATCH',
  'STRONG_MATCH',
  'GOOD_MATCH',
  'POSSIBLE_MATCH',
  'WEAK_MATCH',
  'UNCERTAIN',
  'INELIGIBLE',
] as const;
export type RecommendationCategory = (typeof RECOMMENDATION_CATEGORIES)[number];

/**
 * Thresholds, configurable rather than constant.
 *
 * `minConfidence` is why `UNCERTAIN` exists: a high score built on almost no
 * data is not a strong match, it is a guess, and labelling it STRONG_MATCH
 * would teach the candidate to distrust the labels.
 */
export const recommendationThresholdsSchema = z.object({
  exceptional: z.number().min(0).max(100).default(90),
  strong: z.number().min(0).max(100).default(78),
  good: z.number().min(0).max(100).default(65),
  possible: z.number().min(0).max(100).default(50),
  /** Below this confidence a match is reported as UNCERTAIN regardless of score. */
  minConfidence: z.number().min(0).max(1).default(0.35),
});
export type RecommendationThresholds = z.infer<typeof recommendationThresholdsSchema>;

// ── LLM reasoning ───────────────────────────────────────────────────────────

/**
 * The only shape a model may return.
 *
 * `scoreAdjustment` is deliberately small and bounded by configuration. The
 * model refines a structured result; it does not replace it. A model that
 * returns 100 for a structurally-72 job moves it to at most 72 + maxAdjustment.
 */
export const llmReasoningSchema = z.object({
  assessment: z.string().max(1500),
  /** Bounded at validation time by the configured range. */
  scoreAdjustment: z.number().min(-50).max(50),
  confidence: z.number().min(0).max(1),
  positiveSignals: z.array(z.string().max(300)).max(10).default([]),
  negativeSignals: z.array(z.string().max(300)).max(10).default([]),
  missingRequirements: z.array(z.string().max(200)).max(15).default([]),
  concerns: z.array(z.string().max(300)).max(10).default([]),
});
export type LlmReasoning = z.infer<typeof llmReasoningSchema>;

export const llmUsageSchema = z.object({
  model: z.string().max(120),
  inputTokens: z.number().int().min(0).nullable().default(null),
  outputTokens: z.number().int().min(0).nullable().default(null),
  costUsd: z.number().min(0).nullable().default(null),
  latencyMs: z.number().min(0).nullable().default(null),
  cached: z.boolean().default(false),
});
export type LlmUsage = z.infer<typeof llmUsageSchema>;

// ── Match trace ─────────────────────────────────────────────────────────────

/**
 * Everything needed to reconstruct why a score came out the way it did.
 *
 * Without this, a surprising score is unfalsifiable: you cannot tell whether
 * the weights, the preference version, the enrichment or the model changed.
 */
export const matchTraceSchema = z.object({
  matchingVersion: z.string().max(20),
  profileVersion: z.number().int().min(0),
  preferenceVersion: z.number().int().min(0),
  jobVersion: z.number().int().min(0),
  enrichmentVersion: z.number().int().min(0),
  embeddingModel: z.string().max(120).nullable().default(null),
  llmModel: z.string().max(120).nullable().default(null),

  /** Weights actually used, after normalisation. */
  weightsUsed: z.record(z.string(), z.number()).prefault({}),
  /** Raw component scores before weighting. */
  componentScores: z.array(componentScoreSchema).default([]),

  structuredScore: z.number().min(0).max(100),
  semanticScore: z.number().min(0).max(100).nullable().default(null),
  behavioralAdjustment: z.number().min(-20).max(20).default(0),
  llmAdjustment: z.number().min(-50).max(50).default(0),
  finalScore: z.number().min(0).max(100),

  /** Why the LLM ran, or why it did not. */
  llmDecision: z.string().max(300),
  durationMs: z.number().min(0).default(0),
  /** Steps skipped and why, e.g. "semantic: no candidate embedding". */
  notes: z.array(z.string().max(300)).default([]),
});
export type MatchTrace = z.infer<typeof matchTraceSchema>;

// ── The match ───────────────────────────────────────────────────────────────

export const jobMatchSchema = z.object({
  jobId: z.string().uuid(),
  /** Present so the engine is not hardwired to one candidate. */
  candidateProfileId: z.string().uuid(),

  overallScore: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  recommendation: z.enum(RECOMMENDATION_CATEGORIES),
  eligible: z.boolean(),

  hardConstraintResult: hardConstraintResultSchema,
  componentScores: z.array(componentScoreSchema).default([]),
  skillMatches: z.array(skillMatchDetailSchema).default([]),

  matchedRequirements: z.array(z.string().max(200)).default([]),
  missingRequirements: z.array(z.string().max(200)).default([]),
  concerns: z.array(z.string().max(300)).default([]),
  positiveSignals: z.array(z.string().max(300)).default([]),
  negativeSignals: z.array(z.string().max(300)).default([]),

  /** One paragraph a person can read without knowing how any of this works. */
  explanation: z.string().max(2000),

  trace: matchTraceSchema,
  llmUsage: llmUsageSchema.nullable().default(null),
});
export type JobMatch = z.infer<typeof jobMatchSchema>;

// ── Engine configuration ────────────────────────────────────────────────────

/**
 * Engine-level knobs.
 *
 * Deliberately does *not* hold per-dimension weights: those belong to the
 * candidate (`matchingWeights`), because they express what that person cares
 * about. Keeping a second copy here would let the two drift, and the losing
 * copy would be the one the candidate actually edited.
 */
export const matchingConfigSchema = z.object({
  /** Maximum points the LLM may move a score, in either direction. */
  maxLlmAdjustment: z.number().min(0).max(50).default(10),
  /** Maximum points behavioural signals may move a score. */
  maxBehavioralAdjustment: z.number().min(0).max(20).default(5),
  thresholds: recommendationThresholdsSchema.prefault({}),

  /** LLM gating — the cost control. */
  llm: z
    .object({
      enabled: z.boolean().default(false),
      /** Only consider jobs scoring at least this well structurally. */
      minStructuredScore: z.number().min(0).max(100).default(55),
      /** Only when confidence is below this, i.e. genuinely ambiguous. */
      maxConfidence: z.number().min(0).max(1).default(0.75),
      maxCallsPerRun: z.number().int().min(0).max(1000).default(50),
      model: z.string().max(120).default('claude-haiku-4-5'),
    })
    .prefault({}),
});
export type MatchingConfig = z.infer<typeof matchingConfigSchema>;
