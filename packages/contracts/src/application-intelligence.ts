import { z } from 'zod';
import {
  EDUCATION_LEVELS,
  SALARY_PERIODS,
  SENIORITY_LEVELS,
  currencyCodeSchema,
} from './common';
import { evidenceItemSchema, SUPPORT_STATES } from './candidate-intelligence';

/**
 * The application intelligence layer.
 *
 * This answers one question — *should I spend an hour of my life on this
 * application?* — and it answers it the way a thoughtful friend would: with a
 * verdict, the reasons behind it, and an honest account of what is not known.
 *
 * Three design commitments run through every schema here.
 *
 * **One number is not an answer.** A single "suitability score" collapses
 * eligibility, fit, pay, timing and effort into a value that cannot be argued
 * with. Each of those is scored separately below, because they fail
 * differently: a job you are ineligible for is not a slightly worse version of
 * one that pays badly, and the actions they call for are opposite.
 *
 * **Absence of evidence never becomes evidence of absence.** The tri-state from
 * prompt 12 is carried all the way through to the verdict. A resume that does
 * not mention German means German is UNKNOWN, and a requirement that is UNKNOWN
 * produces a question for the candidate, never a rejection.
 *
 * **Confidence is not a score.** `overallRecommendation` says what to do;
 * `confidence` says how sure the system is that it worked the question out
 * correctly. Low confidence never upgrades a blocker, and high confidence never
 * manufactures one.
 */

export const APPLICATION_ALGORITHM_VERSION = '1.0.0';

// ── Requirements (Parts 4, 5, 6) ────────────────────────────────────────────

/**
 * What kind of thing a posting is asking for.
 *
 * Kept wider than the enrichment layer's skill vocabulary because a posting
 * demands things that are not skills at all — a licence, a timezone, a
 * clearance — and each of those is checked by different evidence.
 */
export const REQUIREMENT_TYPES = [
  'technical_skill',
  'soft_skill',
  'experience_years',
  'education',
  'certification',
  'license',
  'language',
  'location',
  'work_authorization',
  'employment_type',
  'seniority',
  'industry',
  'domain',
  'responsibility',
  'availability',
  'other',
] as const;
export type RequirementType = (typeof REQUIREMENT_TYPES)[number];

/**
 * How badly the posting wants it.
 *
 * `required` and `preferred` must score differently, and `nice_to_have` must
 * barely move the needle: "Rust is a plus" is not a reason to skip a job. The
 * fourth value is the one that matters most for honesty — `inferred` marks a
 * requirement the extractor read between the lines, and an inferred requirement
 * can never produce a blocker.
 */
export const REQUIREMENT_IMPORTANCE = ['required', 'preferred', 'nice_to_have', 'inferred'] as const;
export type RequirementImportance = (typeof REQUIREMENT_IMPORTANCE)[number];

/** Weight per importance. Deliberately steep between required and preferred. */
export const IMPORTANCE_WEIGHT: Readonly<Record<RequirementImportance, number>> = {
  required: 1,
  preferred: 0.4,
  nice_to_have: 0.12,
  // Something nobody actually wrote down. Counted, but barely.
  inferred: 0.1,
};

export const parsedRequirementSchema = z.object({
  /** Stable id derived from the text, so a re-parse produces the same rows. */
  id: z.string().max(80),
  /** Verbatim from the posting where possible. Never paraphrased away. */
  text: z.string().max(600),
  type: z.enum(REQUIREMENT_TYPES),
  importance: z.enum(REQUIREMENT_IMPORTANCE),

  /** Canonical skill slug when the requirement names a technology. */
  slug: z.string().max(80).nullable().default(null),
  /** Surface form that matched, so "ReactJS" is traceable back to `react`. */
  matchedText: z.string().max(200).nullable().default(null),

  /** Years demanded, when a number was actually stated. */
  minYears: z.number().min(0).max(60).nullable().default(null),
  educationLevel: z.enum(EDUCATION_LEVELS).nullable().default(null),
  /** CEFR level for a language requirement: A1…C2, or null when unstated. */
  languageLevel: z.string().max(8).nullable().default(null),

  /** The sentence it came from, so every requirement is checkable. */
  evidence: z.string().max(600).nullable().default(null),
  /** How sure the extractor is that this is a requirement at all. */
  confidence: z.number().min(0).max(1).default(0.5),
});
export type ParsedRequirementRecord = z.infer<typeof parsedRequirementSchema>;

// ── Match kinds (Parts 7, 8, 9) ─────────────────────────────────────────────

/**
 * How a requirement is met, if it is.
 *
 * The five values are not points on one scale. `NO_EVIDENCE` and `CONFLICT` are
 * different in kind: the first means the profile is silent, the second means the
 * profile actively says otherwise, and only the second is a reason not to apply.
 */
export const MATCH_STRENGTHS = [
  'DIRECT_MATCH',
  'PARTIAL_MATCH',
  'RELATED_MATCH',
  'NO_EVIDENCE',
  'CONFLICT',
] as const;
export type MatchStrength = (typeof MATCH_STRENGTHS)[number];

/** Credit each kind earns. Related experience is never worth direct evidence. */
export const MATCH_STRENGTH_CREDIT: Readonly<Record<MatchStrength, number>> = {
  DIRECT_MATCH: 1,
  // Same family, adjacent service: real, and visibly not the same thing.
  PARTIAL_MATCH: 0.6,
  RELATED_MATCH: 0.35,
  NO_EVIDENCE: 0,
  CONFLICT: 0,
};

export const requirementAssessmentSchema = z.object({
  requirement: parsedRequirementSchema,
  strength: z.enum(MATCH_STRENGTHS),
  support: z.enum(SUPPORT_STATES),
  /** 0–1 credit toward the dimension this requirement belongs to. */
  credit: z.number().min(0).max(1),

  /** What in the profile answered it, with its origin. */
  evidence: z.array(evidenceItemSchema).max(8).default([]),
  /** Named skills that transfer, when the match is partial or related. */
  via: z.array(z.string().max(80)).max(6).default([]),

  /** One sentence, generated from the fields above. Shown to the candidate. */
  explanation: z.string().max(500),
});
export type RequirementAssessment = z.infer<typeof requirementAssessmentSchema>;

// ── Eligibility and blockers (Parts 2, 3) ───────────────────────────────────

export const BLOCKER_SEVERITIES = ['HARD_BLOCKER', 'LIKELY_BLOCKER', 'SOFT_BLOCKER'] as const;
export type BlockerSeverity = (typeof BLOCKER_SEVERITIES)[number];

/**
 * A reason not to apply, stated plainly.
 *
 * `HARD_BLOCKER` is reserved for the case where the posting states a hard
 * requirement *and* the profile positively establishes it is not met. A
 * requirement the profile is silent about is never a hard blocker — it is an
 * `unknown`, which is a question, not a wall.
 *
 * `acknowledged` exists because the candidate is the authority on their own
 * situation. Someone who knows they will get sponsorship, or who is happy to
 * apply anyway, can dismiss a blocker and the recommendation recomputes without
 * it.
 */
export const applicationBlockerSchema = z.object({
  id: z.string().max(80),
  severity: z.enum(BLOCKER_SEVERITIES),
  requirementType: z.enum(REQUIREMENT_TYPES),
  /** "Requires German C1." — phrased as the posting's demand, not a verdict. */
  statement: z.string().max(300),
  /** Why the system believes it is not met. */
  detail: z.string().max(500),
  evidence: z.array(evidenceItemSchema).max(4).default([]),
  /** What would resolve it, when anything could. */
  resolution: z.string().max(300).nullable().default(null),
  /** Set when the candidate has said this does not apply to them. */
  acknowledged: z.boolean().default(false),
  acknowledgedNote: z.string().max(300).nullable().default(null),
});
export type ApplicationBlocker = z.infer<typeof applicationBlockerSchema>;

export const eligibilityAssessmentSchema = z.object({
  /** False only when an unacknowledged HARD_BLOCKER exists. */
  eligible: z.boolean(),
  /** True when eligibility turns on something the profile does not say. */
  hasUnknowns: z.boolean().default(false),
  supported: z.number().int().min(0).default(0),
  notSupported: z.number().int().min(0).default(0),
  unknown: z.number().int().min(0).default(0),
  assessments: z.array(requirementAssessmentSchema).max(60).default([]),
  blockers: z.array(applicationBlockerSchema).max(20).default([]),
  /** Questions for the candidate, one per unknown hard requirement. */
  questions: z.array(z.string().max(300)).max(20).default([]),
});
export type EligibilityAssessment = z.infer<typeof eligibilityAssessmentSchema>;

// ── Dimensions (Part 1) ─────────────────────────────────────────────────────

/**
 * One scored dimension.
 *
 * `applicable` is what keeps a silent posting from being scored as a bad one. A
 * job that states no salary has an inapplicable compensation dimension, which
 * is excluded from the aggregate rather than counted as zero — the difference
 * between "pays badly" and "does not say".
 */
export const dimensionScoreSchema = z.object({
  dimension: z.string().max(60),
  /** 0–100 when applicable; meaningless otherwise. */
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  applicable: z.boolean().default(true),
  /** Why it is inapplicable, when it is. */
  inapplicableReason: z.string().max(300).nullable().default(null),
  explanation: z.string().max(500),
  evidence: z.array(z.string().max(300)).max(8).default([]),
});
export type DimensionScore = z.infer<typeof dimensionScoreSchema>;

// ── Experience and seniority (Parts 10, 11) ─────────────────────────────────

export const experienceAlignmentSchema = z.object({
  /** Total non-overlapping professional months from the profile. */
  totalYears: z.number().min(0).max(60).nullable().default(null),
  /** Years in work that involved the job's core technologies. */
  relevantYears: z.number().min(0).max(60).nullable().default(null),
  /** Years in the *specific* skill the posting names most loudly. */
  coreSkillYears: z.number().min(0).max(60).nullable().default(null),
  coreSkillSlug: z.string().max(80).nullable().default(null),
  /** Years of that skill within the last five. Currency, not just tenure. */
  recentYears: z.number().min(0).max(60).nullable().default(null),
  requiredYears: z.number().min(0).max(60).nullable().default(null),

  /**
   * True when total experience clears the bar but the *relevant* experience
   * does not — six years of engineering and two of React against a four-year
   * React requirement. Presenting those as equivalent is the single most
   * common way an application scorer flatters a candidate into a rejection.
   */
  totalMeetsButRelevantDoesNot: z.boolean().default(false),
  isEstimate: z.boolean().default(false),
  explanation: z.string().max(500).default(''),
});
export type ExperienceAlignment = z.infer<typeof experienceAlignmentSchema>;

export const SENIORITY_FITS = [
  'strong_alignment',
  'stretch',
  'overqualified',
  'major_mismatch',
  'unknown',
] as const;
export type SeniorityFit = (typeof SENIORITY_FITS)[number];

export const seniorityAlignmentSchema = z.object({
  candidateLevel: z.enum(SENIORITY_LEVELS).nullable().default(null),
  jobLevel: z.enum(SENIORITY_LEVELS).nullable().default(null),
  /** Signed distance on the ladder. Negative means the job is more junior. */
  levelGap: z.number().int().min(-10).max(10).nullable().default(null),
  fit: z.enum(SENIORITY_FITS).default('unknown'),
  /**
   * Never a rejection on its own. A stretch role is how careers move, and an
   * overqualified one is sometimes exactly what someone wants.
   */
  explanation: z.string().max(400).default(''),
  confidence: z.number().min(0).max(1).default(0),
});
export type SeniorityAlignment = z.infer<typeof seniorityAlignmentSchema>;

// ── Compensation (Parts 15, 16) ─────────────────────────────────────────────

export const SALARY_VERDICTS = [
  'excellent',
  'good',
  'acceptable',
  'below_preference',
  'unknown',
] as const;
export type SalaryVerdict = (typeof SALARY_VERDICTS)[number];

export const compensationAssessmentSchema = z.object({
  /** `unknown` when the posting is silent. Never `below_preference`. */
  verdict: z.enum(SALARY_VERDICTS).default('unknown'),
  stated: z.boolean().default(false),
  minimum: z.number().nonnegative().nullable().default(null),
  maximum: z.number().nonnegative().nullable().default(null),
  currency: currencyCodeSchema.nullable().default(null),
  period: z.enum(SALARY_PERIODS).nullable().default(null),
  annualUsd: z.number().nonnegative().nullable().default(null),
  /** True when a currency conversion was applied to reach `annualUsd`. */
  converted: z.boolean().default(false),

  /** Non-salary components the posting mentions: bonus, equity, commission. */
  components: z.array(z.string().max(80)).max(10).default([]),

  candidateMinimum: z.number().nonnegative().nullable().default(null),
  candidateTarget: z.number().nonnegative().nullable().default(null),
  /** Only true when the candidate set the minimum as a hard constraint. */
  belowHardMinimum: z.boolean().default(false),
  explanation: z.string().max(400).default(''),
  confidence: z.number().min(0).max(1).default(0),
});
export type CompensationAssessment = z.infer<typeof compensationAssessmentSchema>;

// ── Work authorization and language (Parts 18, 19) ──────────────────────────

export const authorizationAssessmentSchema = z.object({
  /** Tri-state, because "the posting does not say" is the common case. */
  sponsorshipAvailable: z.enum(['yes', 'no', 'unknown']).default('unknown'),
  authorizationRequired: z.enum(['yes', 'no', 'unknown']).default('unknown'),
  /** Where the requirement applies, when it names a country. */
  countryCode: z.string().max(2).nullable().default(null),
  candidateAuthorized: z.enum(SUPPORT_STATES).default('UNKNOWN'),
  candidateNeedsSponsorship: z.boolean().nullable().default(null),
  /** Verbatim from the posting. Never paraphrased into a claim. */
  evidenceText: z.string().max(400).nullable().default(null),
  explanation: z.string().max(400).default(''),
  confidence: z.number().min(0).max(1).default(0),
});
export type AuthorizationAssessment = z.infer<typeof authorizationAssessmentSchema>;

export const languageAssessmentSchema = z.object({
  requirements: z
    .array(
      z.object({
        language: z.string().max(60),
        level: z.string().max(8).nullable().default(null),
        required: z.boolean().default(true),
        candidateLevel: z.string().max(40).nullable().default(null),
        support: z.enum(SUPPORT_STATES),
        explanation: z.string().max(300),
      }),
    )
    .max(10)
    .default([]),
  explanation: z.string().max(400).default(''),
});
export type LanguageAssessment = z.infer<typeof languageAssessmentSchema>;

// ── Location (Part 17) ──────────────────────────────────────────────────────

export const locationAssessmentSchema = z.object({
  arrangement: z.string().max(40).nullable().default(null),
  /** Countries the posting will accept remote work from, when it says. */
  remoteCountries: z.array(z.string().max(2)).max(40).default([]),
  remoteRegions: z.array(z.string().max(60)).max(20).default([]),
  /** True only when the posting actually says "anywhere". */
  remoteWorldwide: z.boolean().default(false),
  city: z.string().max(120).nullable().default(null),
  countryCode: z.string().max(2).nullable().default(null),
  officeDaysPerWeek: z.number().int().min(0).max(7).nullable().default(null),
  support: z.enum(SUPPORT_STATES).default('UNKNOWN'),
  explanation: z.string().max(400).default(''),
});
export type LocationAssessment = z.infer<typeof locationAssessmentSchema>;

// ── Friction and value (Parts 20, 21) ───────────────────────────────────────

export const FRICTION_FACTORS = [
  'one_click',
  'simple_form',
  'account_required',
  'external_ats',
  'long_questionnaire',
  'cover_letter_required',
  'portfolio_required',
  'assessment_required',
  'references_required',
  'unclear_route',
] as const;
export type FrictionFactor = (typeof FRICTION_FACTORS)[number];

/** Estimated minutes each factor adds. Additive, and openly approximate. */
export const FRICTION_MINUTES: Readonly<Record<FrictionFactor, number>> = {
  one_click: 2,
  simple_form: 8,
  account_required: 5,
  external_ats: 10,
  long_questionnaire: 20,
  cover_letter_required: 40,
  portfolio_required: 15,
  assessment_required: 90,
  references_required: 10,
  unclear_route: 15,
};

export const applicationFrictionSchema = z.object({
  factors: z.array(z.enum(FRICTION_FACTORS)).max(10).default([]),
  estimatedMinutes: z.number().min(0).max(600).default(0),
  /** 0–100, higher means more effort. A ranking input, never a veto. */
  frictionScore: z.number().min(0).max(100).default(0),
  coverLetterRequired: z.boolean().default(false),
  coverLetterOptional: z.boolean().default(false),
  portfolioRequired: z.boolean().default(false),
  assessmentRequired: z.boolean().default(false),
  applicationUrl: z.string().max(2000).nullable().default(null),
  atsVendor: z.string().max(60).nullable().default(null),
  explanation: z.string().max(400).default(''),
  confidence: z.number().min(0).max(1).default(0.4),
});
export type ApplicationFriction = z.infer<typeof applicationFrictionSchema>;

// ── Competitiveness (Part 22) ───────────────────────────────────────────────

export const COMPETITION_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'] as const;
export type CompetitionLevel = (typeof COMPETITION_LEVELS)[number];

/**
 * How hard this is likely to be to win.
 *
 * Every signal here is one the system genuinely has. `applicantCount` is
 * nullable and stays null unless a source actually reported it — guessing at
 * applicant numbers would be inventing the single most decision-relevant fact
 * on the page.
 */
export const competitivenessAssessmentSchema = z.object({
  level: z.enum(COMPETITION_LEVELS).default('UNKNOWN'),
  confidence: z.number().min(0).max(1).default(0),
  /** Only ever populated from a source that reported it. */
  applicantCount: z.number().int().min(0).nullable().default(null),
  applicantCountSource: z.string().max(120).nullable().default(null),
  signals: z
    .array(
      z.object({
        name: z.string().max(60),
        detail: z.string().max(300),
        direction: z.enum(['raises', 'lowers', 'neutral']),
        weight: z.number().min(0).max(1),
      }),
    )
    .max(12)
    .default([]),
  explanation: z.string().max(400).default(''),
});
export type CompetitivenessAssessment = z.infer<typeof competitivenessAssessmentSchema>;

// ── Timing (Parts 23, 24) ───────────────────────────────────────────────────

export const TIMING_STATES = ['fresh', 'active', 'ageing', 'closing_soon', 'expired', 'unknown'] as const;
export type TimingState = (typeof TIMING_STATES)[number];

export const timingAssessmentSchema = z.object({
  state: z.enum(TIMING_STATES).default('unknown'),
  hoursSincePosted: z.number().min(0).nullable().default(null),
  daysSincePosted: z.number().min(0).nullable().default(null),
  deadline: z.coerce.date().nullable().default(null),
  daysUntilDeadline: z.number().nullable().default(null),
  /** True when the posting says "open until filled" or similar. */
  openUntilFilled: z.boolean().default(false),
  /** 0–100. Drives ordering, not eligibility. */
  urgency: z.number().min(0).max(100).default(0),
  explanation: z.string().max(400).default(''),
});
export type TimingAssessment = z.infer<typeof timingAssessmentSchema>;

// ── Duplicate and history (Parts 25, 26) ────────────────────────────────────

export const DUPLICATE_REASONS = [
  'already_applied',
  'already_rejected',
  'already_dismissed',
  'same_job_other_url',
  'repost_of_applied',
  'none',
] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

export const duplicateCheckSchema = z.object({
  reason: z.enum(DUPLICATE_REASONS).default('none'),
  /** The job this duplicates, when it duplicates one. */
  relatedJobId: z.string().uuid().nullable().default(null),
  relatedAppliedAt: z.coerce.date().nullable().default(null),
  /** True when this alone should stop an APPLY recommendation. */
  suppresses: z.boolean().default(false),
  explanation: z.string().max(400).default(''),
});
export type DuplicateCheck = z.infer<typeof duplicateCheckSchema>;

export const companyHistorySchema = z.object({
  companyName: z.string().max(200).nullable().default(null),
  applications: z.number().int().min(0).default(0),
  rejections: z.number().int().min(0).default(0),
  interviews: z.number().int().min(0).default(0),
  saves: z.number().int().min(0).default(0),
  lastInteractionAt: z.coerce.date().nullable().default(null),
  /**
   * -1..1. Bounded small on purpose: one rejection from a company that
   * interviews well is noise, and letting a single outcome close a door is how
   * a system quietly narrows someone's search.
   */
  sentiment: z.number().min(-1).max(1).default(0),
  explanation: z.string().max(400).default(''),
});
export type CompanyHistory = z.infer<typeof companyHistorySchema>;

// ── Legitimacy (Part 28) ────────────────────────────────────────────────────

export const LEGITIMACY_VERDICTS = ['LEGITIMATE_LIKELY', 'SUSPICIOUS', 'UNKNOWN'] as const;
export type LegitimacyVerdict = (typeof LEGITIMACY_VERDICTS)[number];

export const legitimacyAssessmentSchema = z.object({
  /**
   * Three values, and deliberately no "SCAM".
   *
   * The system can observe that a posting asks for bank details and has no
   * company identity. It cannot establish fraud, and a product that accuses
   * named companies of crime on pattern-matching is one defamation claim from
   * being switched off.
   */
  verdict: z.enum(LEGITIMACY_VERDICTS).default('UNKNOWN'),
  confidence: z.number().min(0).max(1).default(0),
  signals: z
    .array(
      z.object({
        name: z.string().max(60),
        detail: z.string().max(300),
        severity: z.enum(['low', 'medium', 'high']),
      }),
    )
    .max(12)
    .default([]),
  explanation: z.string().max(400).default(''),
});
export type LegitimacyAssessment = z.infer<typeof legitimacyAssessmentSchema>;

// ── Resume selection and positioning (Parts 34, 35, 36) ─────────────────────

export const resumeRecommendationSchema = z.object({
  recommendedDocumentId: z.string().uuid().nullable().default(null),
  recommendedLabel: z.string().max(120).nullable().default(null),
  resumeFitScore: z.number().min(0).max(100).default(0),
  reason: z.string().max(500).default(''),
  alternatives: z
    .array(
      z.object({
        documentId: z.string().uuid(),
        label: z.string().max(120),
        resumeFitScore: z.number().min(0).max(100),
        note: z.string().max(300).default(''),
      }),
    )
    .max(10)
    .default([]),
  /** What the chosen resume should lead with. Guidance, never an edit. */
  emphasise: z.array(z.string().max(120)).max(12).default([]),
  /** True and evidenced, but secondary for this role. */
  support: z.array(z.string().max(120)).max(12).default([]),
  /** Things the resume does not currently mention that this job asks for. */
  missingFromResume: z.array(z.string().max(160)).max(12).default([]),
});
export type ResumeRecommendation = z.infer<typeof resumeRecommendationSchema>;

export const positioningAdviceSchema = z.object({
  headlineEmphasis: z.string().max(200).default(''),
  keyEvidence: z.array(z.string().max(300)).max(8).default([]),
  supportingEvidence: z.array(z.string().max(300)).max(8).default([]),
  /** How to address a gap honestly, without claiming what is not there. */
  addressGaps: z.array(z.string().max(400)).max(8).default([]),
  /** Concerns a reader will have, named so they can be pre-empted. */
  anticipatedConcerns: z.array(z.string().max(400)).max(8).default([]),
});
export type PositioningAdvice = z.infer<typeof positioningAdviceSchema>;

// ── Checklist (Part 38) ─────────────────────────────────────────────────────

export const checklistItemSchema = z.object({
  id: z.string().max(80),
  label: z.string().max(300),
  detail: z.string().max(400).default(''),
  /** True when skipping it would likely sink the application. */
  required: z.boolean().default(false),
  done: z.boolean().default(false),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

// ── The recommendation (Parts 29, 30, 31) ───────────────────────────────────

export const APPLICATION_RECOMMENDATIONS = [
  'APPLY_NOW',
  'APPLY',
  'CONSIDER',
  /*
   * Added by the matching engine (Prompt 18, Part 44).
   *
   * The gap between CONSIDER and SKIP was doing too much work: a job worth
   * keeping but not worth acting on this week had to be called one or the
   * other, and both readings were wrong.
   */
  'LOW_PRIORITY',
  'SKIP',
  'BLOCKED',
  'UNKNOWN',
] as const;
export type ApplicationRecommendation = (typeof APPLICATION_RECOMMENDATIONS)[number];

export const RECOMMENDATION_LABEL: Readonly<Record<ApplicationRecommendation, string>> = {
  APPLY_NOW: 'Apply now',
  APPLY: 'Worth applying',
  CONSIDER: 'Worth considering',
  LOW_PRIORITY: 'Keep, but low priority',
  SKIP: 'Probably skip',
  BLOCKED: 'Blocked',
  UNKNOWN: 'Not enough information',
};

export const applicationExplanationSchema = z.object({
  /** The paragraph a person actually reads. Assembled from the dimensions. */
  summary: z.string().max(2_000).default(''),
  strengths: z.array(z.string().max(400)).max(12).default([]),
  concerns: z.array(z.string().max(400)).max(12).default([]),
  /** Requirements the profile is silent on, phrased as questions. */
  unknowns: z.array(z.string().max(400)).max(12).default([]),
  /** Requirements the profile actively fails. */
  missing: z.array(z.string().max(400)).max(12).default([]),
  /** Every claim above, traced to what supports it. */
  evidence: z.array(evidenceItemSchema).max(30).default([]),
});
export type ApplicationExplanation = z.infer<typeof applicationExplanationSchema>;

/**
 * The assembled recommendation.
 *
 * Note what is *not* here: the job match score. This layer reads it and never
 * writes it. Match asks "does this job suit this person"; application
 * intelligence asks "is applying a good use of an hour", and they diverge
 * constantly — a perfect match with a hard visa blocker is not worth an hour,
 * and a merely good match closing tomorrow might be.
 */
export const applicationIntelligenceSchema = z.object({
  jobId: z.string().uuid(),
  candidateId: z.string().uuid(),

  eligibility: eligibilityAssessmentSchema,

  /** The scored dimensions. Each independently explainable. */
  qualification: dimensionScoreSchema,
  skillAlignment: dimensionScoreSchema,
  experienceAlignment: dimensionScoreSchema,
  preferenceAlignment: dimensionScoreSchema,
  careerAlignment: dimensionScoreSchema,
  jobQuality: dimensionScoreSchema,

  experience: experienceAlignmentSchema,
  seniority: seniorityAlignmentSchema,
  compensation: compensationAssessmentSchema,
  authorization: authorizationAssessmentSchema,
  language: languageAssessmentSchema,
  location: locationAssessmentSchema,
  friction: applicationFrictionSchema,
  competitiveness: competitivenessAssessmentSchema,
  timing: timingAssessmentSchema,
  duplicate: duplicateCheckSchema,
  companyHistory: companyHistorySchema,
  legitimacy: legitimacyAssessmentSchema,

  resume: resumeRecommendationSchema,
  positioning: positioningAdviceSchema,
  checklist: z.array(checklistItemSchema).max(20).default([]),

  overallRecommendation: z.enum(APPLICATION_RECOMMENDATIONS),
  /** Belief that the recommendation is right, not that the job is good. */
  confidence: z.number().min(0).max(1),
  /** 0–100. Ranks opportunities against each other. */
  applicationValueScore: z.number().min(0).max(100).default(0),

  blockers: z.array(applicationBlockerSchema).max(20).default([]),
  strengths: z.array(z.string().max(400)).max(12).default([]),
  gaps: z.array(z.string().max(400)).max(12).default([]),

  explanation: applicationExplanationSchema,

  /** The match this was computed alongside, for traceability. */
  matchScore: z.number().min(0).max(100).nullable().default(null),
  profileVersion: z.number().int().min(0).nullable().default(null),
  generatedAt: z.coerce.date().default(() => new Date()),
  algorithmVersion: z.string().max(20).default(APPLICATION_ALGORITHM_VERSION),
});
export type ApplicationIntelligence = z.infer<typeof applicationIntelligenceSchema>;

// ── Opportunity state machine (Part 40) ─────────────────────────────────────

export const OPPORTUNITY_STATES = [
  'DISCOVERED',
  'ANALYZED',
  'RECOMMENDED',
  'REVIEWED',
  'APPROVED',
  'SKIPPED',
  'APPLIED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

/**
 * Legal transitions.
 *
 * Encoded rather than left to convention because the one transition that must
 * never exist is `RECOMMENDED → APPLIED` without a human in between. The
 * machine can recommend; only a person can approve, and only a person records
 * that they applied.
 */
export const OPPORTUNITY_TRANSITIONS: Readonly<Record<OpportunityState, readonly OpportunityState[]>> = {
  DISCOVERED: ['ANALYZED', 'SKIPPED'],
  ANALYZED: ['RECOMMENDED', 'SKIPPED'],
  RECOMMENDED: ['REVIEWED', 'SKIPPED', 'ANALYZED'],
  REVIEWED: ['APPROVED', 'SKIPPED', 'ANALYZED'],
  APPROVED: ['APPLIED', 'SKIPPED', 'WITHDRAWN'],
  SKIPPED: ['ANALYZED', 'REVIEWED'],
  APPLIED: ['REJECTED', 'WITHDRAWN'],
  REJECTED: [],
  WITHDRAWN: [],
};

export const applicationOpportunitySchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  jobId: z.string().uuid(),
  state: z.enum(OPPORTUNITY_STATES).default('DISCOVERED'),
  recommendation: z.enum(APPLICATION_RECOMMENDATIONS).nullable().default(null),
  applicationValueScore: z.number().min(0).max(100).nullable().default(null),
  /** Set when a person acts, never by the system. */
  reviewedAt: z.coerce.date().nullable().default(null),
  reviewNote: z.string().max(600).nullable().default(null),
  createdAt: z.coerce.date().default(() => new Date()),
  updatedAt: z.coerce.date().default(() => new Date()),
});
export type ApplicationOpportunity = z.infer<typeof applicationOpportunitySchema>;

// ── Tracking (Part 41) ──────────────────────────────────────────────────────

export const APPLICATION_STATUSES = [
  'applied',
  'recruiter_contacted',
  'screening',
  'interview',
  'technical_interview',
  'final_interview',
  'offer',
  'rejected',
  'withdrawn',
  'ghosted',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Statuses that count as the employer having responded at all. */
export const RESPONDED_STATUSES: readonly ApplicationStatus[] = [
  'recruiter_contacted',
  'screening',
  'interview',
  'technical_interview',
  'final_interview',
  'offer',
  'rejected',
];

/** Statuses that count as having reached an interview. */
export const INTERVIEW_STATUSES: readonly ApplicationStatus[] = [
  'interview',
  'technical_interview',
  'final_interview',
  'offer',
];

export const applicationRecordSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  jobId: z.string().uuid(),
  status: z.enum(APPLICATION_STATUSES).default('applied'),
  appliedAt: z.coerce.date(),
  applicationUrl: z.string().max(2000).nullable().default(null),
  /** Which resume was sent, so resume performance is answerable. */
  documentId: z.string().uuid().nullable().default(null),
  coverLetterUsed: z.boolean().default(false),
  referral: z.string().max(200).nullable().default(null),
  contactName: z.string().max(200).nullable().default(null),
  notes: z.string().max(4_000).nullable().default(null),

  /** What the system said at the time, for calibration. */
  recommendationAtApply: z.enum(APPLICATION_RECOMMENDATIONS).nullable().default(null),
  valueScoreAtApply: z.number().min(0).max(100).nullable().default(null),

  firstResponseAt: z.coerce.date().nullable().default(null),
  lastStatusChangeAt: z.coerce.date().nullable().default(null),
  createdAt: z.coerce.date().default(() => new Date()),
  updatedAt: z.coerce.date().default(() => new Date()),
});
export type ApplicationRecord = z.infer<typeof applicationRecordSchema>;

// ── Analytics (Parts 42, 43, 45) ────────────────────────────────────────────

/**
 * Sample size below which a rate is reported but not believed.
 *
 * Seven applications and one response is not a 14% response rate; it is one
 * response. Every rate below carries `sufficientSample` so the UI can show the
 * number without inviting a conclusion from it.
 */
export const MIN_SAMPLE_FOR_INFERENCE = 15;

export const funnelRatesSchema = z.object({
  applications: z.number().int().min(0).default(0),
  responses: z.number().int().min(0).default(0),
  interviews: z.number().int().min(0).default(0),
  offers: z.number().int().min(0).default(0),
  rejections: z.number().int().min(0).default(0),
  responseRate: z.number().min(0).max(1).nullable().default(null),
  interviewRate: z.number().min(0).max(1).nullable().default(null),
  offerRate: z.number().min(0).max(1).nullable().default(null),
  /** False when the sample is too small to read anything into. */
  sufficientSample: z.boolean().default(false),
  medianDaysToResponse: z.number().min(0).nullable().default(null),
});
export type FunnelRates = z.infer<typeof funnelRatesSchema>;

export const applicationAnalyticsSchema = z.object({
  candidateId: z.string().uuid(),
  overall: funnelRatesSchema,
  /** Same funnel, split by a dimension. Each carries its own sample flag. */
  byDimension: z
    .record(
      z.string(),
      z.array(z.object({ key: z.string().max(200), rates: funnelRatesSchema })),
    )
    .prefault({}),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type ApplicationAnalytics = z.infer<typeof applicationAnalyticsSchema>;

export const resumePerformanceSchema = z.object({
  documentId: z.string().uuid(),
  label: z.string().max(120),
  rates: funnelRatesSchema,
  /**
   * Null until the sample supports a comparison.
   *
   * The whole point of this record is to stop "30 applications, 7 responses"
   * from being read as proof against "20 applications, 1 response" when the
   * difference is within noise.
   */
  comparedToBest: z.number().nullable().default(null),
  note: z.string().max(400).default(''),
});
export type ResumePerformance = z.infer<typeof resumePerformanceSchema>;

export const calibrationReportSchema = z.object({
  candidateId: z.string().uuid(),
  /** Per recommendation: how often the candidate acted on it. */
  buckets: z
    .array(
      z.object({
        recommendation: z.enum(APPLICATION_RECOMMENDATIONS),
        recommended: z.number().int().min(0),
        applied: z.number().int().min(0),
        skipped: z.number().int().min(0),
        responses: z.number().int().min(0),
        interviews: z.number().int().min(0),
        /** Applied ÷ recommended. Agreement, not correctness. */
        followRate: z.number().min(0).max(1).nullable().default(null),
        sufficientSample: z.boolean().default(false),
      }),
    )
    .default([]),
  /** Applications the candidate made against a SKIP. Worth knowing about. */
  appliedAgainstAdvice: z.number().int().min(0).default(0),
  /** Of those, how many got a response. The system being wrong is a finding. */
  appliedAgainstAdviceResponses: z.number().int().min(0).default(0),
  note: z.string().max(600).default(''),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type CalibrationReport = z.infer<typeof calibrationReportSchema>;

// ── Engine configuration ────────────────────────────────────────────────────

/**
 * Thresholds, as data.
 *
 * Every number that decides between APPLY and CONSIDER lives here rather than
 * in a comparison buried in the engine, so tuning the policy is a config change
 * and its current values are inspectable from the ops console.
 */
export const applicationPolicySchema = z.object({
  applyNowMinValue: z.number().min(0).max(100).default(78),
  applyMinValue: z.number().min(0).max(100).default(62),
  considerMinValue: z.number().min(0).max(100).default(42),
  /** Below this confidence the verdict degrades to UNKNOWN. */
  minConfidenceForVerdict: z.number().min(0).max(1).default(0.35),
  /** Urgency at or above which a qualifying APPLY becomes APPLY_NOW. */
  applyNowMinUrgency: z.number().min(0).max(100).default(55),
  /** Weights for `applicationValueScore`. Normalised at use. */
  valueWeights: z
    .object({
      qualification: z.number().min(0).max(100).default(28),
      skillAlignment: z.number().min(0).max(100).default(20),
      preferenceAlignment: z.number().min(0).max(100).default(16),
      careerAlignment: z.number().min(0).max(100).default(10),
      jobQuality: z.number().min(0).max(100).default(10),
      compensation: z.number().min(0).max(100).default(8),
      timing: z.number().min(0).max(100).default(5),
      friction: z.number().min(0).max(100).default(3),
    })
    .prefault({}),
  algorithmVersion: z.string().max(20).default(APPLICATION_ALGORITHM_VERSION),
});
export type ApplicationPolicy = z.infer<typeof applicationPolicySchema>;
