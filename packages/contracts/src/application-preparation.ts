import { z } from 'zod';

/**
 * Application preparation.
 *
 * Prompt 13 built the decision half of this layer: should the candidate apply,
 * on eleven dimensions, with blockers and a recommendation. This is the other
 * half — *how* to apply. What to select, what to emphasise, what to write, what
 * to prepare, and what the candidate is missing.
 *
 * One constraint shapes every type in this file: **nothing may be invented.**
 *
 * That is easy to state and hard to enforce, because the entire purpose of this
 * layer is to generate text, and generated text is exactly where fabrication
 * lives. So the enforcement is structural rather than instructional. Every
 * claim carries an `EvidenceRef`, and a claim without one is not a claim with
 * low confidence — it is a claim the schema will not hold. A generator that
 * cannot cite cannot emit.
 *
 * The second constraint is **the candidate submits**. This engine analyses,
 * recommends, drafts, organises and tracks. It does not submit applications,
 * message recruiters, accept offers or withdraw anything, and there is no code
 * path here that could — not a disabled one, not a flagged one. The way to
 * guarantee a system does not do something is to not write the thing that does
 * it.
 */

export const PREPARATION_VERSION = '1.0.0';

// ── Evidence references (Parts 13, 14, 52) ──────────────────────────────────

/**
 * Where a claim comes from.
 *
 * `job_posting` and `external_research` are separated from the candidate
 * sources deliberately: a fact about the employer and a fact about the
 * candidate fail in different ways and need different scrutiny. Getting the
 * candidate's own history wrong is embarrassing; getting the employer's wrong
 * in a cover letter is disqualifying.
 */
export const EVIDENCE_REF_KINDS = [
  'employment',
  'project',
  'education',
  'certification',
  'portfolio',
  'resume_section',
  'candidate_stated',
  'job_posting',
  'external_research',
] as const;

export type EvidenceRefKind = (typeof EVIDENCE_REF_KINDS)[number];

/** Kinds that describe the candidate, as opposed to the world. */
export const CANDIDATE_EVIDENCE_KINDS: readonly EvidenceRefKind[] = [
  'employment',
  'project',
  'education',
  'certification',
  'portfolio',
  'resume_section',
  'candidate_stated',
];

export const evidenceRefSchema = z.object({
  kind: z.enum(EVIDENCE_REF_KINDS),
  /** The record this points at, so the claim can be opened and checked. */
  sourceId: z.string().max(120),
  /** Verbatim supporting text. Never paraphrased — paraphrase is where drift starts. */
  quote: z.string().max(600),
  /** Human-readable location: employer name, project title, section heading. */
  locator: z.string().max(200).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.8),
});

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

/**
 * A statement the system is prepared to make, and its backing.
 *
 * `evidence` has a minimum length of one, enforced by the schema. This is the
 * single most important line in the file: it makes an unsupported claim
 * unrepresentable rather than merely discouraged, so a generator that wants to
 * assert something it cannot cite fails at validation instead of producing
 * confident prose nobody can check.
 */
export const supportedClaimSchema = z.object({
  claim: z.string().max(600),
  evidence: z.array(evidenceRefSchema).min(1).max(8),
  /** True when a person has confirmed this, not merely when we inferred it. */
  verified: z.boolean().default(false),
});

export type SupportedClaim = z.infer<typeof supportedClaimSchema>;

// ── Application decision (Parts 1, 2, 3) ────────────────────────────────────

export const PREPARATION_DECISIONS = [
  'APPLY_NOW',
  'APPLY',
  'APPLY_IF_TIME',
  'CONSIDER',
  'SKIP',
  'INELIGIBLE',
] as const;

export type PreparationDecision = (typeof PREPARATION_DECISIONS)[number];

export const RISK_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

export const APPLICATION_RISK_KINDS = [
  'experience_gap',
  'skill_gap',
  'authorization_uncertainty',
  'salary_uncertainty',
  'location_uncertainty',
  'seniority_mismatch',
  'portfolio_gap',
  'resume_weakness',
  'application_complexity',
  'deadline_risk',
  'duplicate_application',
  'job_quality',
] as const;

export type ApplicationRiskKind = (typeof APPLICATION_RISK_KINDS)[number];

export const applicationRiskSchema = z.object({
  kind: z.enum(APPLICATION_RISK_KINDS),
  severity: z.enum(RISK_SEVERITIES),
  summary: z.string().max(400),
  /** What the candidate could do about it, or an honest statement that nothing. */
  mitigation: z.string().max(400).nullable().default(null),
  evidence: z.array(evidenceRefSchema).max(5).default([]),
});

export type ApplicationRisk = z.infer<typeof applicationRiskSchema>;

/**
 * The decision, kept deliberately separate from the match score.
 *
 * A 94-match job behind a sixty-minute application with an unknown salary and
 * no deadline is not automatically `APPLY_NOW`; a 79-match job closing tomorrow
 * at a company the candidate has wanted for a year might be. Mirroring the
 * match score would make this whole record redundant.
 */
export const applicationDecisionSchema = z.object({
  jobId: z.string().uuid(),
  candidateId: z.string().uuid(),
  profileId: z.string().uuid().nullable().default(null),

  decision: z.enum(PREPARATION_DECISIONS),
  confidence: z.number().min(0).max(1),

  /** 0–100. Ranks this against every other opportunity competing for time. */
  priorityScore: z.number().min(0).max(100),

  /** Why to apply, in the candidate's own evidence. */
  whyApply: z.array(supportedClaimSchema).max(8).default([]),
  /** Why not, when the answer is not. Never invented weaknesses. */
  whyNot: z.array(z.string().max(400)).max(8).default([]),

  strengths: z.array(supportedClaimSchema).max(8).default([]),
  risks: z.array(applicationRiskSchema).max(15).default([]),
  gaps: z.array(z.string().max(300)).max(15).default([]),

  recommendedAction: z.string().max(400),
  createdAt: z.coerce.date().default(() => new Date()),
});

export type ApplicationDecision = z.infer<typeof applicationDecisionSchema>;

/**
 * Weights for the priority score.
 *
 * Friction and deadline are the two that make this different from a match
 * score. Between two equally good jobs, the one that takes ten minutes beats
 * the one that takes an hour — not because it is a better job, but because the
 * candidate's time is the scarce resource this whole product exists to spend
 * well.
 */
export const PRIORITY_WEIGHTS = {
  matchQuality: 0.3,
  confidence: 0.1,
  jobQuality: 0.12,
  careerValue: 0.12,
  compensation: 0.1,
  freshness: 0.06,
  deadlineUrgency: 0.1,
  friction: 0.1,
} as const;

export const decisionThresholdsSchema = z.object({
  applyNow: z.number().min(0).max(100).default(88),
  apply: z.number().min(0).max(100).default(76),
  applyIfTime: z.number().min(0).max(100).default(66),
  consider: z.number().min(0).max(100).default(55),
  /** Below this confidence the decision is softened by one step. */
  minConfidence: z.number().min(0).max(1).default(0.45),
});

export type DecisionThresholds = z.infer<typeof decisionThresholdsSchema>;

export const DEFAULT_DECISION_THRESHOLDS: DecisionThresholds = decisionThresholdsSchema.parse({});

// ── Resume inventory and fit (Parts 9, 10, 11) ──────────────────────────────

/*
 * Document kinds and resume fit live in `candidate-intelligence.ts`, where
 * Prompt 12 put them, and were extended there rather than re-declared. Two
 * vocabularies for "what kind of document is this" would drift, and the drift
 * would surface as a document visible on one screen and missing from another.
 */
export { DOCUMENT_KINDS, resumeFitSchema, type DocumentKind, type ResumeFit } from './candidate-intelligence';

import { DOCUMENT_KINDS, resumeFitSchema } from './candidate-intelligence';


export const documentInventoryEntrySchema = z.object({
  documentId: z.string().max(120),
  kind: z.enum(DOCUMENT_KINDS),
  label: z.string().max(200),
  version: z.number().int().min(1).default(1),

  targetRole: z.string().max(120).nullable().default(null),
  targetIndustry: z.string().max(120).nullable().default(null),
  targetSeniority: z.string().max(40).nullable().default(null),

  /** Canonical skill slugs this document actually evidences. */
  skills: z.array(z.string().max(80)).max(120).default([]),

  lastUpdated: z.coerce.date().nullable().default(null),
  /** Structural quality: length, sections, parseability. Not relevance. */
  qualityScore: z.number().min(0).max(100).nullable().default(null),
  status: z.enum(['active', 'draft', 'archived']).default('active'),
});

export type DocumentInventoryEntry = z.infer<typeof documentInventoryEntrySchema>;


export const RESUME_ACTIONS = ['reuse', 'light_edit', 'tailor', 'create_new'] as const;
export type ResumeAction = (typeof RESUME_ACTIONS)[number];

export const resumePlanSchema = z.object({
  action: z.enum(RESUME_ACTIONS),
  selected: resumeFitSchema.nullable().default(null),
  alternatives: z.array(resumeFitSchema).max(5).default([]),
  reason: z.string().max(500),
});

export type ResumePlanRecommendation = z.infer<typeof resumePlanSchema>;

// ── Resume gaps and customisation (Parts 12, 15, 19) ────────────────────────

/**
 * The distinction this layer exists to make.
 *
 * `NOT_DEMONSTRATED` means the candidate has the experience and the resume does
 * not say so — a presentation problem with a safe fix. `NOT_EVIDENCED` means
 * the candidate does not have it — a real gap, and inventing text to cover it
 * would be fabrication.
 *
 * Collapsing these two into "missing" is what produces resume tools that
 * confidently write experience their user never had.
 */
export const GAP_KINDS = [
  'NOT_DEMONSTRATED',
  'UNDERSTATED',
  'BURIED',
  'NOT_EVIDENCED',
  'TERMINOLOGY_MISMATCH',
] as const;

export type ResumeGapKind = (typeof GAP_KINDS)[number];

export const resumeGapSchema = z.object({
  requirement: z.string().max(300),
  importance: z.enum(['required', 'preferred', 'nice_to_have', 'inferred']),
  kind: z.enum(GAP_KINDS),

  /** What the candidate actually has, when they have anything. */
  candidateEvidence: z.array(evidenceRefSchema).max(5).default([]),
  /** What the resume currently says, verbatim. */
  resumeSays: z.string().max(600).nullable().default(null),

  recommendation: z.string().max(600),
  /** False when nothing honest can be done — the evidence is not there. */
  actionable: z.boolean().default(true),
});

export type ResumeGap = z.infer<typeof resumeGapSchema>;

export const BULLET_ACTIONS = ['KEEP', 'REWRITE', 'REORDER', 'DEEMPHASIZE', 'REMOVE'] as const;
export type BulletAction = (typeof BULLET_ACTIONS)[number];

/**
 * One recommended edit.
 *
 * `proposed` is nullable because most recommendations are not rewrites — moving
 * a bullet up or cutting an irrelevant one needs no new text. When there *is*
 * new text, `evidence` must back it, which is what stops a rewrite from
 * upgrading "built web applications" into "architected a distributed platform".
 */
export const bulletRecommendationSchema = z.object({
  section: z.string().max(120),
  /** Where it currently sits, for a stable diff. */
  anchor: z.string().max(300),
  original: z.string().max(1000),
  action: z.enum(BULLET_ACTIONS),
  proposed: z.string().max(1000).nullable().default(null),
  reason: z.string().max(500),
  evidence: z.array(evidenceRefSchema).max(5).default([]),
  /** Set when the user has accepted or rejected it. */
  userDecision: z.enum(['pending', 'accepted', 'rejected']).default('pending'),
});

export type BulletRecommendation = z.infer<typeof bulletRecommendationSchema>;

export const customizationPlanSchema = z.object({
  documentId: z.string().max(120),
  jobId: z.string().uuid(),

  /** What to foreground, in order. */
  emphasise: z.array(supportedClaimSchema).max(10).default([]),
  /** What to cut or push down. Never a claim about the candidate. */
  deemphasise: z.array(z.string().max(300)).max(10).default([]),

  sectionOrder: z.array(z.string().max(120)).max(15).default([]),
  skillPriority: z.array(z.string().max(80)).max(40).default([]),
  bullets: z.array(bulletRecommendationSchema).max(40).default([]),

  gaps: z.array(resumeGapSchema).max(25).default([]),

  /** Everything here is a suggestion until a person accepts it. */
  requiresReview: z.literal(true).default(true),
});

export type CustomizationPlan = z.infer<typeof customizationPlanSchema>;

// ── Keyword and ATS analysis (Parts 16, 17) ─────────────────────────────────

export const KEYWORD_STATES = ['covered', 'equivalent', 'missing', 'misleading'] as const;
export type KeywordState = (typeof KEYWORD_STATES)[number];

export const keywordCoverageSchema = z.object({
  term: z.string().max(120),
  importance: z.enum(['required', 'preferred', 'nice_to_have', 'inferred']),
  state: z.enum(KEYWORD_STATES),
  /**
   * What the resume says instead, when it says the same thing differently.
   *
   * "Automated deployment pipelines" and "CI/CD" are the same claim. Reporting
   * the first as missing would push the candidate to bolt on jargon they
   * already expressed better, which is exactly the keyword stuffing this
   * analysis is supposed to prevent.
   */
  resumeEquivalent: z.string().max(300).nullable().default(null),
  recommendation: z.string().max(400).nullable().default(null),
});

export type KeywordCoverage = z.infer<typeof keywordCoverageSchema>;

export const atsAnalysisSchema = z.object({
  score: z.number().min(0).max(100),
  keywords: z.array(keywordCoverageSchema).max(60).default([]),
  structuralIssues: z.array(z.string().max(300)).max(15).default([]),
  /** Stated explicitly so nobody reads this as a licence to stuff keywords. */
  guidance: z
    .string()
    .max(400)
    .default(
      'These suggestions align terminology you already earn the right to use. Adding a term you cannot evidence would misrepresent you and fail at interview.',
    ),
});

export type AtsAnalysis = z.infer<typeof atsAnalysisSchema>;

// ── Cover letter (Parts 23, 24) ─────────────────────────────────────────────

export const COVER_LETTER_VERDICTS = [
  'REQUIRED',
  'RECOMMENDED',
  'OPTIONAL',
  'UNNECESSARY',
  'UNKNOWN',
] as const;

export type CoverLetterVerdict = (typeof COVER_LETTER_VERDICTS)[number];

/**
 * Whether to write one at all, answered before what to write.
 *
 * Generating a cover letter for every application is the default behaviour of
 * every tool in this space and it is wrong: most applications do not read them,
 * a generic one is worse than none, and producing one costs the candidate time
 * they could spend on an application that does. `UNNECESSARY` is a real and
 * frequently correct answer.
 */
export const coverLetterStrategySchema = z.object({
  verdict: z.enum(COVER_LETTER_VERDICTS),
  reason: z.string().max(500),
  /** Only present when the verdict warrants writing one. */
  brief: z
    .object({
      openingAngle: z.string().max(600),
      topEvidence: z.array(supportedClaimSchema).min(1).max(4),
      motivation: z.string().max(600),
      relevantAchievement: supportedClaimSchema.nullable().default(null),
      /** Requires verified company research; null when none exists. */
      companyPoint: supportedClaimSchema.nullable().default(null),
      closingAngle: z.string().max(400),
      suggestedLength: z.enum(['short', 'standard']).default('short'),
    })
    .nullable()
    .default(null),
});

export type CoverLetterStrategy = z.infer<typeof coverLetterStrategySchema>;

// ── Company research (Parts 25, 26) ─────────────────────────────────────────

/**
 * What is known about the employer, and how well.
 *
 * `verified` and `inferred` are separate arrays rather than one list with a
 * flag, because they end up in different places: a verified fact can go in a
 * cover letter, and an inference cannot. Keeping them in one collection makes
 * it one careless `.map()` away from a candidate asserting something about a
 * company that the company will know is wrong.
 */
export const companyResearchSchema = z.object({
  companyName: z.string().max(200),
  /** Facts with a source. Safe to reference. */
  verified: z.array(supportedClaimSchema).max(12).default([]),
  /** Reasonable readings that must not be stated as fact. */
  inferred: z.array(z.string().max(400)).max(12).default([]),
  sources: z.array(z.string().max(500)).max(10).default([]),
  researchedAt: z.coerce.date().nullable().default(null),
});

export type CompanyResearch = z.infer<typeof companyResearchSchema>;

// ── Application questions (Parts 27–33) ─────────────────────────────────────

export const QUESTION_KINDS = [
  'motivation',
  'fit',
  'salary',
  'notice_period',
  'work_authorization',
  'experience_years',
  'behavioral',
  'technical',
  'logistics',
  'other',
] as const;

export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const starEvidenceSchema = z.object({
  situation: z.string().max(600),
  task: z.string().max(600),
  action: z.string().max(800),
  result: z.string().max(600),
  evidence: z.array(evidenceRefSchema).min(1).max(5),
});

export type StarEvidence = z.infer<typeof starEvidenceSchema>;

export const preparedAnswerSchema = z.object({
  question: z.string().max(600),
  kind: z.enum(QUESTION_KINDS),

  /**
   * Guidance, not a submitted answer.
   *
   * Null when the system cannot answer honestly — a behavioural question with
   * no matching experience, or a salary question with no market data. A null
   * with a stated `missingInformation` is a far better outcome than a plausible
   * paragraph the candidate cannot stand behind in an interview.
   */
  recommendedAnswer: z.string().max(2000).nullable().default(null),
  evidence: z.array(evidenceRefSchema).max(6).default([]),
  star: starEvidenceSchema.nullable().default(null),

  confidence: z.number().min(0).max(1).default(0.5),
  risk: z.string().max(400).nullable().default(null),
  /** What the candidate must supply before this can be answered. */
  missingInformation: z.array(z.string().max(300)).max(6).default([]),
});

export type PreparedAnswer = z.infer<typeof preparedAnswerSchema>;

export const SALARY_STRATEGIES = ['range', 'market_anchored', 'defer', 'decline_to_state'] as const;
export type SalaryStrategy = (typeof SALARY_STRATEGIES)[number];

export const salaryGuidanceSchema = z.object({
  strategy: z.enum(SALARY_STRATEGIES),
  /** What the posting itself says. Never estimated. */
  postedRange: z.string().max(200).nullable().default(null),
  /** What the candidate configured. Never inferred from their history. */
  candidateTarget: z.string().max(200).nullable().default(null),
  /** Only from a real source, and labelled as an estimate when present. */
  marketContext: z.string().max(400).nullable().default(null),
  recommendedResponse: z.string().max(1000),
  considerations: z.array(z.string().max(300)).max(6).default([]),
  /** True when any figure shown is an estimate rather than a stated fact. */
  containsEstimates: z.boolean().default(false),
});

export type SalaryGuidance = z.infer<typeof salaryGuidanceSchema>;

/**
 * The authorisation answer.
 *
 * Every field comes from the candidate's own configuration. Nothing here is
 * derived from nationality, location, name or anything else — inferring
 * someone's right to work from who they appear to be is both wrong and
 * discriminatory, and the only correct source is what they told us.
 */
export const authorizationGuidanceSchema = z.object({
  authorizedCountries: z.array(z.string().length(2)).max(30).default([]),
  requiresSponsorship: z.boolean().nullable().default(null),
  /** What the posting says about sponsoring, when it says anything. */
  employerPosition: z.string().max(300).nullable().default(null),
  recommendedResponse: z.string().max(1000),
  /** True when the candidate has not configured this and must before answering. */
  needsCandidateInput: z.boolean().default(false),
});

export type AuthorizationGuidance = z.infer<typeof authorizationGuidanceSchema>;

// ── Portfolio and certifications (Parts 34–36) ──────────────────────────────

export const portfolioSelectionSchema = z.object({
  itemId: z.string().max(120),
  title: z.string().max(200),
  relevanceScore: z.number().min(0).max(100),
  reasons: z.array(z.string().max(300)).max(5).default([]),
  demonstrates: z.array(z.string().max(80)).max(20).default([]),
  url: z.string().max(2000).nullable().default(null),
});

export type PortfolioSelection = z.infer<typeof portfolioSelectionSchema>;

export const portfolioGapSchema = z.object({
  requirement: z.string().max(300),
  importance: z.enum(['required', 'preferred', 'nice_to_have', 'inferred']),
  /**
   * Deliberately phrased as a suggestion to build something real.
   *
   * The one thing this must never do is propose inventing a project, so the
   * schema carries the honest framing rather than leaving it to a prompt.
   */
  suggestion: z.string().max(400),
});

export type PortfolioGap = z.infer<typeof portfolioGapSchema>;

// ── Checklist (Part 37) ─────────────────────────────────────────────────────

export const CHECK_STATES = ['done', 'todo', 'warning', 'blocked', 'not_applicable'] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export const preparationCheckSchema = z.object({
  id: z.string().max(60),
  label: z.string().max(200),
  state: z.enum(CHECK_STATES),
  detail: z.string().max(400).nullable().default(null),
  /** True when the candidate must act before applying. */
  blocking: z.boolean().default(false),
});

export type PreparationCheck = z.infer<typeof preparationCheckSchema>;

// ── Friction and effort (Parts 38, 39) ──────────────────────────────────────

export const effortEstimateSchema = z.object({
  minutes: z.number().int().min(1).max(600),
  complexity: z.enum(['low', 'medium', 'high']),
  requirements: z.array(z.string().max(200)).max(12).default([]),
  /** Always true. Rendered next to the number so it is never read as fact. */
  isEstimate: z.literal(true).default(true),
});

export type EffortEstimate = z.infer<typeof effortEstimateSchema>;

// ── URL validation (Part 47) ────────────────────────────────────────────────

export const URL_VERDICTS = [
  'EMPLOYER_DIRECT',
  'ATS_DIRECT',
  'TRUSTED_BOARD',
  'AGGREGATOR',
  'UNVERIFIED',
  'BROKEN',
  'NOT_A_JOB_PAGE',
] as const;

export type UrlVerdict = (typeof URL_VERDICTS)[number];

export const applicationUrlCheckSchema = z.object({
  url: z.string().max(2000),
  verdict: z.enum(URL_VERDICTS),
  /** Never asserted from the URL alone; only from an actual check. */
  reachable: z.boolean().nullable().default(null),
  redirectChain: z.array(z.string().max(2000)).max(10).default([]),
  explanation: z.string().max(400),
  /** False for anything not confirmed to be an application destination. */
  safeToPresent: z.boolean().default(false),
});

export type ApplicationUrlCheck = z.infer<typeof applicationUrlCheckSchema>;

// ── Package (Parts 48, 49, 55) ──────────────────────────────────────────────

export const packageQualitySchema = z.object({
  completeness: z.number().min(0).max(100),
  evidenceConfidence: z.number().min(0).max(100),
  relevance: z.number().min(0).max(100),
  consistency: z.number().min(0).max(100),
  overall: z.number().min(0).max(100),
  /*
   * Carried on the record, not left to the interface, so every surface that
   * renders this number renders the caveat with it.
   */
  disclaimer: z
    .string()
    .max(300)
    .default(
      'This measures how complete and well-evidenced the package is. It is not a probability of being hired.',
    ),
});

export type PackageQuality = z.infer<typeof packageQualitySchema>;

/**
 * The immutable record of an application as prepared.
 *
 * A snapshot, taken when the candidate says "prepare this". Jobs get edited and
 * withdrawn, resumes get revised, preferences change — and six weeks later,
 * when the candidate is asked about the role in an interview, the only useful
 * record is what the posting said on the day they applied.
 */
export const applicationPackageSchema = z.object({
  packageId: z.string().uuid(),
  jobId: z.string().uuid(),
  candidateId: z.string().uuid(),

  /** Frozen copies. Never references that could be mutated underneath. */
  jobSnapshot: z.record(z.string(), z.unknown()),
  matchSnapshot: z.record(z.string(), z.unknown()).nullable().default(null),

  decision: applicationDecisionSchema,
  resume: resumePlanSchema,
  customization: customizationPlanSchema.nullable().default(null),
  ats: atsAnalysisSchema.nullable().default(null),
  coverLetter: coverLetterStrategySchema.nullable().default(null),
  companyResearch: companyResearchSchema.nullable().default(null),
  answers: z.array(preparedAnswerSchema).max(30).default([]),
  salary: salaryGuidanceSchema.nullable().default(null),
  authorization: authorizationGuidanceSchema.nullable().default(null),
  portfolio: z.array(portfolioSelectionSchema).max(12).default([]),
  portfolioGaps: z.array(portfolioGapSchema).max(10).default([]),
  certifications: z.array(z.string().max(200)).max(10).default([]),

  checklist: z.array(preparationCheckSchema).max(30).default([]),
  effort: effortEstimateSchema.nullable().default(null),
  applicationUrl: applicationUrlCheckSchema.nullable().default(null),

  quality: packageQualitySchema,
  notes: z.string().max(4000).nullable().default(null),

  /*
   * The submission boundary, in the type system.
   *
   * There is no `submit()` anywhere in this package and no field that could
   * record an automatic submission. `submittedByUserAt` is set only by an
   * explicit user action in the interface.
   */
  preparedAt: z.coerce.date().default(() => new Date()),
  reviewedByUserAt: z.coerce.date().nullable().default(null),
  submittedByUserAt: z.coerce.date().nullable().default(null),

  preparationVersion: z.string().max(20).default(PREPARATION_VERSION),
  modelName: z.string().max(120).nullable().default(null),
  promptVersion: z.string().max(20).nullable().default(null),
});

export type ApplicationPackage = z.infer<typeof applicationPackageSchema>;

// ── Integrity (Parts 52, 53, 54) ────────────────────────────────────────────

export const INTEGRITY_VIOLATIONS = [
  'UNSUPPORTED_CLAIM',
  'FABRICATED_METRIC',
  'FABRICATED_EMPLOYER',
  'FABRICATED_CREDENTIAL',
  'CROSS_JOB_CONTAMINATION',
  'CROSS_CANDIDATE_CONTAMINATION',
  'INVENTED_COMPANY_FACT',
  'INVENTED_SALARY',
  'INVENTED_AUTHORIZATION',
  'DATE_INCONSISTENCY',
] as const;

export type IntegrityViolation = (typeof INTEGRITY_VIOLATIONS)[number];

export const integrityFindingSchema = z.object({
  violation: z.enum(INTEGRITY_VIOLATIONS),
  severity: z.enum(RISK_SEVERITIES),
  location: z.string().max(200),
  offendingText: z.string().max(600),
  explanation: z.string().max(500),
});

export type IntegrityFinding = z.infer<typeof integrityFindingSchema>;

export const integrityReportSchema = z.object({
  passed: z.boolean(),
  findings: z.array(integrityFindingSchema).max(50).default([]),
  claimsChecked: z.number().int().min(0).default(0),
  claimsWithEvidence: z.number().int().min(0).default(0),
  checkedAt: z.coerce.date().default(() => new Date()),
});

export type IntegrityReport = z.infer<typeof integrityReportSchema>;

// ── Preparation history and feedback (Parts 56, 58) ─────────────────────────

export const PREP_FEEDBACK_KINDS = [
  'SUGGESTION_USEFUL',
  'SUGGESTION_UNHELPFUL',
  'DO_NOT_EMPHASISE',
  'NOT_HOW_I_DESCRIBE_IT',
  'PREFER_SHORTER',
  'PREFER_LONGER',
  'COMPANY_NOT_INTERESTING',
  'WRONG_RESUME_SELECTED',
] as const;

export type PrepFeedbackKind = (typeof PREP_FEEDBACK_KINDS)[number];

export const preparationFeedbackSchema = z.object({
  packageId: z.string().uuid(),
  kind: z.enum(PREP_FEEDBACK_KINDS),
  /** What the feedback was about: a bullet anchor, a skill, a section. */
  target: z.string().max(300).nullable().default(null),
  comment: z.string().max(1000).nullable().default(null),
  createdAt: z.coerce.date().default(() => new Date()),
});

export type PreparationFeedback = z.infer<typeof preparationFeedbackSchema>;
