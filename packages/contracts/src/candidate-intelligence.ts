import { z } from 'zod';
import { EDUCATION_LEVELS, SENIORITY_LEVELS } from './common';
import { SKILL_CATEGORIES } from './enrichment';

/**
 * Advanced candidate intelligence.
 *
 * The organising idea, and the one every schema here serves: **three kinds of
 * thing about a candidate that must never be mixed.**
 *
 *   1. **Facts** — supported by a document or stated explicitly by the person.
 *      "Has three years of React in professional experience."
 *   2. **Preferences** — what they want. Lives in `candidate.ts`.
 *   3. **Behavioural signals** — what their clicks suggest. Lives in
 *      `feedback-loop.ts`.
 *
 * They are separate files, separate tables and separate write paths. A
 * behavioural signal cannot become a fact, because nothing in the learning
 * layer can reach these types.
 *
 * The second organising idea is `UNKNOWN`. Absence of evidence is not evidence
 * of absence: a resume that never mentions German means German proficiency is
 * `UNKNOWN`, not `NONE`. Every attribute that could be wrongly inferred is
 * tri-state, and the tests assert it.
 */

export const CANDIDATE_INTELLIGENCE_VERSION = '1.0.0';
/** Bumped when extraction changes in a way that alters stored structure. */
export const EXTRACTION_VERSION = '1.0.0';
/** Bumped when the canonical skill taxonomy changes. */
export const TAXONOMY_VERSION = '1.0.0';

// ── Tri-state (Part 30) ─────────────────────────────────────────────────────

/**
 * The three-valued logic the whole layer runs on.
 *
 * `UNKNOWN` is not a failure state and not a default to be tidied away — it is
 * the correct and common answer. A matcher that treats it as `NOT_SUPPORTED`
 * silently rejects candidates for things nobody asked about.
 */
export const SUPPORT_STATES = ['SUPPORTED', 'NOT_SUPPORTED', 'UNKNOWN'] as const;
export type SupportState = (typeof SUPPORT_STATES)[number];

// ── Evidence (Parts 12, 16, 40) ─────────────────────────────────────────────

/**
 * Where a piece of evidence came from.
 *
 * Ordered by how much weight it deserves. A certification is a third party
 * asserting something; a resume skills list is the candidate asserting it; a
 * behavioural signal is us guessing. Treating them alike is how a system ends
 * up claiming expertise nobody supports.
 */
export const EVIDENCE_SOURCES = [
  'user_verified',
  'certification',
  'employment_responsibility',
  'project_implementation',
  'portfolio',
  'public_repository',
  'resume_skill_section',
  'candidate_self_report',
  'education_coursework',
  'behavioral_signal',
  'inferred',
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * Baseline confidence per source.
 *
 * These are *ceilings on believability*, not measurements. A skill listed in a
 * resume's skills section is a claim with no context — common, cheap to make,
 * and frequently aspirational — so it sits well below the same skill appearing
 * in the description of a two-year role.
 */
export const EVIDENCE_SOURCE_WEIGHT: Readonly<Record<EvidenceSource, number>> = {
  user_verified: 1,
  certification: 0.9,
  employment_responsibility: 0.85,
  project_implementation: 0.75,
  public_repository: 0.6,
  portfolio: 0.6,
  resume_skill_section: 0.5,
  education_coursework: 0.4,
  candidate_self_report: 0.5,
  // Deliberately the weakest, and never sufficient on its own to claim a fact.
  behavioral_signal: 0.15,
  inferred: 0.3,
};

/**
 * One piece of supporting evidence.
 *
 * `excerpt` is the candidate's own words, kept so a claim can always be traced
 * back to the sentence that produced it. That traceability is what lets the
 * match explanation say *where* a skill came from rather than merely asserting
 * it — the difference the brief draws in Part 46.
 */
export const evidenceItemSchema = z.object({
  id: z.string().max(80),
  source: z.enum(EVIDENCE_SOURCES),
  /** Document this came from, when it came from one. */
  documentId: z.string().uuid().nullable().default(null),
  /** Human-readable origin: "CINNSOL — Frontend Developer". */
  context: z.string().max(300),
  /** Verbatim supporting text, bounded. */
  excerpt: z.string().max(1_000).nullable().default(null),
  /** 0–1. Extraction confidence, never a claim about the world. */
  confidence: z.number().min(0).max(1),
  /** When the evidence describes activity, not when it was extracted. */
  observedFrom: z.coerce.date().nullable().default(null),
  observedTo: z.coerce.date().nullable().default(null),
  /** Model that produced it, when a model was involved. */
  extractedBy: z.string().max(80).nullable().default(null),
  extractedAt: z.coerce.date().default(() => new Date()),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

// ── Dates (Part 6) ──────────────────────────────────────────────────────────

export const DATE_PRECISIONS = ['day', 'month', 'year', 'unknown'] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

/**
 * A date that knows how precisely it is known.
 *
 * "2024" and "January 2024" are different facts. Storing both as
 * `2024-01-01` and forgetting the difference makes every duration calculation
 * silently wrong by up to eleven months, and the brief is explicit: do not
 * invent missing months.
 */
export const partialDateSchema = z.object({
  year: z.number().int().min(1900).max(2100).nullable().default(null),
  month: z.number().int().min(1).max(12).nullable().default(null),
  day: z.number().int().min(1).max(31).nullable().default(null),
  precision: z.enum(DATE_PRECISIONS).default('unknown'),
  /** Exactly as written, for the evidence trail. */
  raw: z.string().max(80).nullable().default(null),
});
export type PartialDate = z.infer<typeof partialDateSchema>;

export const dateRangeSchema = z.object({
  start: partialDateSchema,
  end: partialDateSchema,
  /** "Present", "Current" — the end is open, not missing. */
  isCurrent: z.boolean().default(false),
  /** Months, computed conservatively. Null when it cannot be established. */
  durationMonths: z.number().min(0).max(1200).nullable().default(null),
  /** True when precision forced an assumption in the duration. */
  durationIsEstimate: z.boolean().default(false),
});
export type DateRange = z.infer<typeof dateRangeSchema>;

// ── Documents (Parts 2, 3, 41, 42) ──────────────────────────────────────────

export const DOCUMENT_KINDS = [
  'resume',
  'cover_letter',
  'portfolio_export',
  /* Added by the preparation layer (Prompt 19, Part 9). */
  'cv',
  'case_study',
  'certificate',
  'transcript',
  'other',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_STATUSES = [
  'uploaded',
  'validated',
  'rejected',
  'extracting',
  'extracted',
  'failed',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
] as const;
export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

/**
 * An uploaded document.
 *
 * Note what is *not* here: the file bytes and the extracted text. Those live in
 * a separate store with their own access path, because this record is read by
 * list views, logged, and returned from APIs — and resume contents must never
 * travel through any of those by accident.
 */
export const candidateDocumentSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  kind: z.enum(DOCUMENT_KINDS).default('resume'),
  /** The candidate's own name for it: "Frontend CV", "Cloud CV". */
  label: z.string().trim().max(120),
  filename: z.string().max(255),
  mimeType: z.string().max(120),
  sizeBytes: z.number().int().min(0),
  /** SHA-256 of the bytes. Re-uploading the same file is detectable. */
  contentHash: z.string().max(64),
  status: z.enum(DOCUMENT_STATUSES).default('uploaded'),
  rejectionReason: z.string().max(400).nullable().default(null),
  /** Set when this resume targets a particular kind of role. */
  targetRole: z.string().max(120).nullable().default(null),
  uploadedAt: z.coerce.date().default(() => new Date()),
  extractedAt: z.coerce.date().nullable().default(null),
  /** Soft delete, so match history referencing it stays resolvable. */
  deletedAt: z.coerce.date().nullable().default(null),
});
export type CandidateDocument = z.infer<typeof candidateDocumentSchema>;

/** The outcome of file validation, before anything is parsed. */
export const documentValidationSchema = z.object({
  accepted: z.boolean(),
  detectedMimeType: z.string().max(120).nullable().default(null),
  declaredMimeType: z.string().max(120).nullable().default(null),
  sizeBytes: z.number().int().min(0),
  /** Every check that ran, and what it found. */
  checks: z
    .array(
      z.object({
        name: z.string().max(60),
        passed: z.boolean(),
        detail: z.string().max(300),
      }),
    )
    .default([]),
  rejectionReason: z.string().max(400).nullable().default(null),
});
export type DocumentValidation = z.infer<typeof documentValidationSchema>;

// ── Sections (Part 4) ───────────────────────────────────────────────────────

export const SECTION_KINDS = [
  'summary',
  'experience',
  'education',
  'skills',
  'projects',
  'certifications',
  'awards',
  'publications',
  'languages',
  'volunteer',
  'interests',
  'contact',
  'unknown',
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export const documentSectionSchema = z.object({
  kind: z.enum(SECTION_KINDS),
  /** The heading exactly as written: "Professional Journey". */
  heading: z.string().max(200),
  /** Character offsets into the extracted text, for the evidence trail. */
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  text: z.string().max(100_000),
  /** How sure the classifier is that this heading means this kind. */
  confidence: z.number().min(0).max(1),
  /** True when a model, not the heading vocabulary, decided. */
  aiClassified: z.boolean().default(false),
});
export type DocumentSection = z.infer<typeof documentSectionSchema>;

// ── Experience (Parts 5, 7) ─────────────────────────────────────────────────

export const EMPLOYMENT_KINDS = [
  'full_time',
  'part_time',
  'contract',
  'freelance',
  'internship',
  'volunteer',
  'unknown',
] as const;
export type EmploymentKind = (typeof EMPLOYMENT_KINDS)[number];

export const experienceEntrySchema = z.object({
  id: z.string().max(80),
  company: z.string().max(200),
  title: z.string().max(200),
  location: z.string().max(200).nullable().default(null),
  employmentKind: z.enum(EMPLOYMENT_KINDS).default('unknown'),
  dates: dateRangeSchema,
  description: z.string().max(8_000).nullable().default(null),
  responsibilities: z.array(z.string().max(600)).max(30).default([]),
  achievements: z.array(z.string().max(600)).max(30).default([]),
  /** Canonical skill slugs evidenced by this role. */
  technologies: z.array(z.string().max(80)).max(60).default([]),
  domain: z.string().max(120).nullable().default(null),
  /** Phrases suggesting scope: "led a team of 5", "owned the platform". */
  seniorityIndicators: z.array(z.string().max(200)).max(20).default([]),
  /** Verbatim block this was parsed from. */
  sourceText: z.string().max(8_000).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
  /** True once a human has confirmed or edited it. */
  userVerified: z.boolean().default(false),
});
export type ExperienceEntry = z.infer<typeof experienceEntrySchema>;

// ── Education, certifications, projects (Parts 17, 21, 22, 23) ──────────────

export const educationRecordSchema = z.object({
  id: z.string().max(80),
  institution: z.string().max(200),
  degree: z.string().max(200).nullable().default(null),
  field: z.string().max(200).nullable().default(null),
  level: z.enum(EDUCATION_LEVELS).nullable().default(null),
  dates: dateRangeSchema,
  /** Only when explicitly stated. Never inferred — see Part 21. */
  grade: z.string().max(80).nullable().default(null),
  coursework: z.array(z.string().max(200)).max(40).default([]),
  sourceText: z.string().max(4_000).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
  userVerified: z.boolean().default(false),
});
export type EducationRecord = z.infer<typeof educationRecordSchema>;

export const CERTIFICATION_VERIFICATION = ['VERIFIED', 'UNVERIFIED', 'EXPIRED', 'UNKNOWN'] as const;
export type CertificationVerification = (typeof CERTIFICATION_VERIFICATION)[number];

export const certificationRecordSchema = z.object({
  id: z.string().max(80),
  name: z.string().max(200),
  issuer: z.string().max(200).nullable().default(null),
  issued: partialDateSchema,
  expires: partialDateSchema,
  credentialId: z.string().max(200).nullable().default(null),
  credentialUrl: z.string().max(2_000).nullable().default(null),
  /**
   * Defaults to `UNVERIFIED`, never `VERIFIED`.
   *
   * Nothing in this system checks a credential with its issuer, so claiming
   * verification would be fabricating a check that never happened.
   */
  verification: z.enum(CERTIFICATION_VERIFICATION).default('UNVERIFIED'),
  sourceText: z.string().max(2_000).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
  userVerified: z.boolean().default(false),
});
export type CertificationRecord = z.infer<typeof certificationRecordSchema>;

export const PROJECT_CONTEXTS = ['professional', 'personal', 'academic', 'open_source', 'unknown'] as const;
export type ProjectContext = (typeof PROJECT_CONTEXTS)[number];

export const projectRecordSchema = z.object({
  id: z.string().max(80),
  name: z.string().max(200),
  description: z.string().max(4_000).nullable().default(null),
  role: z.string().max(200).nullable().default(null),
  /**
   * Professional and personal projects are different evidence.
   *
   * A side project demonstrates use; a shipped professional system
   * demonstrates use under constraints, review and consequence. The brief asks
   * for the distinction and matching honours it.
   */
  context: z.enum(PROJECT_CONTEXTS).default('unknown'),
  technologies: z.array(z.string().max(80)).max(60).default([]),
  outcome: z.string().max(1_000).nullable().default(null),
  scale: z.string().max(200).nullable().default(null),
  links: z.array(z.string().max(2_000)).max(10).default([]),
  dates: dateRangeSchema,
  sourceText: z.string().max(4_000).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
  userVerified: z.boolean().default(false),
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

export const achievementRecordSchema = z.object({
  id: z.string().max(80),
  title: z.string().max(300),
  kind: z
    .enum(['award', 'scholarship', 'competition', 'leadership', 'publication', 'launch', 'other'])
    .default('other'),
  date: partialDateSchema,
  detail: z.string().max(1_000).nullable().default(null),
  /**
   * Whether this is a distinction or a restated duty.
   *
   * "Led the migration" in a responsibilities list is a job description;
   * "Awarded engineer of the year" is an achievement. Conflating them inflates
   * every profile equally, which helps nobody.
   */
  isDistinction: z.boolean().default(false),
  sourceText: z.string().max(2_000).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
  userVerified: z.boolean().default(false),
});
export type AchievementRecord = z.infer<typeof achievementRecordSchema>;

export const languageRecordSchema = z.object({
  language: z.string().max(80),
  /** Only when stated. `UNKNOWN` when the document says only "German". */
  proficiency: z
    .enum(['NATIVE', 'FLUENT', 'PROFESSIONAL', 'CONVERSATIONAL', 'BASIC', 'UNKNOWN'])
    .default('UNKNOWN'),
  sourceText: z.string().max(400).nullable().default(null),
  userVerified: z.boolean().default(false),
});
export type LanguageRecord = z.infer<typeof languageRecordSchema>;

// ── Skills (Parts 9–16) ─────────────────────────────────────────────────────

/*
 * Skill categories are shared with the job side.
 *
 * `enrichment.ts` already defines the vocabulary a job posting's skills are
 * classified into. Reusing it rather than defining a candidate-side twin is
 * what keeps "job wants a `framework`" and "candidate has a `framework`"
 * directly comparable — two vocabularies would need a mapping, and the mapping
 * would drift.
 */

/**
 * Proficiency, phrased as what the evidence supports.
 *
 * The label is deliberately about the evidence rather than the person. The
 * brief is explicit: the system should say "evidence suggests proficient", not
 * "candidate is definitely expert" — because use is observable and skill is
 * not.
 */
export const PROFICIENCY_LEVELS = ['BEGINNER', 'WORKING', 'PROFICIENT', 'ADVANCED', 'EXPERT'] as const;
export type ProficiencyLevel = (typeof PROFICIENCY_LEVELS)[number];

export const candidateSkillFactSchema = z.object({
  /** Canonical slug from the taxonomy: `react`, not `React.js`. */
  slug: z.string().max(80),
  /** Display name for the canonical skill. */
  name: z.string().max(120),
  category: z.enum(SKILL_CATEGORIES).default('other'),
  /** Every surface form seen: React, ReactJS, React.js. */
  aliasesSeen: z.array(z.string().max(80)).max(20).default([]),

  /** What the evidence supports. Never a claim about the person. */
  proficiency: z.enum(PROFICIENCY_LEVELS).nullable().default(null),
  /** How confident the *proficiency estimate* is, not the skill's existence. */
  proficiencyConfidence: z.number().min(0).max(1).default(0),
  /** Sentence shown to the candidate, generated from the evidence. */
  proficiencyRationale: z.string().max(400).default(''),

  /** Non-overlapping months across all evidence. See Part 15. */
  totalMonths: z.number().min(0).max(1200).nullable().default(null),
  monthsIsEstimate: z.boolean().default(false),
  /** Most recent date any evidence places this skill in use. */
  lastEvidencedAt: z.coerce.date().nullable().default(null),
  firstEvidencedAt: z.coerce.date().nullable().default(null),

  evidence: z.array(evidenceItemSchema).max(40).default([]),
  /** Highest-weight source backing this skill. */
  strongestSource: z.enum(EVIDENCE_SOURCES).nullable().default(null),

  /** True when the candidate confirmed or edited this entry. */
  userVerified: z.boolean().default(false),
  taxonomyVersion: z.string().max(20).default(TAXONOMY_VERSION),
});
export type CandidateSkillFact = z.infer<typeof candidateSkillFactSchema>;

// ── Seniority and trajectory (Parts 8, 24) ──────────────────────────────────

export const seniorityEstimateSchema = z.object({
  estimatedLevel: z.enum(SENIORITY_LEVELS).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
  /** Named signals with their contribution, so the estimate is inspectable. */
  signals: z
    .array(
      z.object({
        name: z.string().max(60),
        detail: z.string().max(300),
        weight: z.number(),
        supports: z.enum(SENIORITY_LEVELS).nullable().default(null),
      }),
    )
    .default([]),
  evidence: z.array(evidenceItemSchema).max(20).default([]),
  /** Stated when the title and the evidence disagree. */
  titleVsEvidenceNote: z.string().max(400).nullable().default(null),
});
export type SeniorityEstimate = z.infer<typeof seniorityEstimateSchema>;

export const timelineEntrySchema = z.object({
  year: z.number().int().min(1900).max(2100),
  month: z.number().int().min(1).max(12).nullable().default(null),
  label: z.string().max(200),
  company: z.string().max(200).nullable().default(null),
  kind: z.enum(['role_start', 'role_end', 'education', 'certification', 'project', 'gap']),
  /** Seniority the system reads this point as, when it can. */
  seniority: z.enum(SENIORITY_LEVELS).nullable().default(null),
  detail: z.string().max(300).default(''),
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const TRAJECTORY_DIMENSIONS = [
  'technical_depth',
  'technical_breadth',
  'leadership',
  'management',
  'domain_specialization',
  'industry_movement',
  'seniority_progression',
] as const;
export type TrajectoryDimension = (typeof TRAJECTORY_DIMENSIONS)[number];

export const careerTrajectorySchema = z.object({
  dimensions: z
    .array(
      z.object({
        dimension: z.enum(TRAJECTORY_DIMENSIONS),
        /** -1 declining, 0 flat, 1 strongly increasing. */
        direction: z.number().min(-1).max(1),
        confidence: z.number().min(0).max(1),
        detail: z.string().max(400),
        evidence: z.array(z.string().max(300)).max(8).default([]),
      }),
    )
    .default([]),
  /** One or two sentences, generated from the dimensions above. */
  trajectorySummary: z.string().max(800).default(''),
  trajectoryConfidence: z.number().min(0).max(1).default(0),
  timeline: z.array(timelineEntrySchema).max(200).default([]),
  /** Total non-overlapping professional months. */
  totalExperienceMonths: z.number().min(0).max(1200).nullable().default(null),
  /** Employment gaps over three months, stated without interpretation. */
  gaps: z
    .array(
      z.object({
        fromYear: z.number().int(),
        toYear: z.number().int(),
        months: z.number().min(0),
        note: z.string().max(200).default(''),
      }),
    )
    .default([]),
});
export type CareerTrajectory = z.infer<typeof careerTrajectorySchema>;

// ── Transferable skills (Part 25) ───────────────────────────────────────────

export const MATCH_EVIDENCE_KINDS = [
  'direct',
  'transferable',
  'adjacent',
  'insufficient_evidence',
  'missing',
] as const;
export type MatchEvidenceKind = (typeof MATCH_EVIDENCE_KINDS)[number];

export const transferableSkillSchema = z.object({
  fromSlug: z.string().max(80),
  toSlug: z.string().max(80),
  /** 0–1. Always below 1: transfer is never equivalence. */
  strength: z.number().min(0).max(1),
  rationale: z.string().max(300),
  /** Path through the skill graph, so a surprising claim is explainable. */
  via: z.array(z.string().max(80)).max(6).default([]),
});
export type TransferableSkill = z.infer<typeof transferableSkillSchema>;

// ── Requirement evidence matrix (Parts 26–29) ───────────────────────────────

export const REQUIREMENT_KINDS = [
  'skill',
  'experience_years',
  'education',
  'certification',
  'language',
  'work_authorization',
  'license',
  'location',
  'other',
] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/**
 * One row of the requirement matrix.
 *
 * The distinction the brief cares most about lives in `evidenceKind`:
 * `missing` means the requirement is genuinely unmet, while
 * `insufficient_evidence` means the profile does not say — and those must
 * never be rendered as the same thing.
 */
export const requirementEvidenceSchema = z.object({
  requirement: z.string().max(300),
  kind: z.enum(REQUIREMENT_KINDS),
  /** Canonical slug when the requirement is a skill. */
  slug: z.string().max(80).nullable().default(null),
  required: z.boolean().default(true),

  evidenceKind: z.enum(MATCH_EVIDENCE_KINDS),
  /** 0–1. How well the evidence meets the requirement. */
  strength: z.number().min(0).max(1),
  support: z.enum(SUPPORT_STATES),

  /** The actual evidence, with its origin. */
  evidence: z.array(evidenceItemSchema).max(10).default([]),
  /** Named skills that transfer, when `evidenceKind` is transferable. */
  transferable: z.array(transferableSkillSchema).max(6).default([]),

  /** One sentence, generated from the fields above. */
  explanation: z.string().max(500),
});
export type RequirementEvidence = z.infer<typeof requirementEvidenceSchema>;

export const requirementMatrixSchema = z.object({
  jobId: z.string().uuid(),
  candidateId: z.string().uuid(),
  rows: z.array(requirementEvidenceSchema).max(80).default([]),

  /** Counts, so a summary needs no re-derivation. */
  directMatches: z.number().int().min(0).default(0),
  transferableMatches: z.number().int().min(0).default(0),
  unknowns: z.number().int().min(0).default(0),
  missing: z.number().int().min(0).default(0),

  /** 0–100. Coverage of stated requirements. Not the match score. */
  coverageScore: z.number().min(0).max(100).default(0),
  profileVersion: z.number().int().min(0).nullable().default(null),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type RequirementMatrix = z.infer<typeof requirementMatrixSchema>;

// ── Resume fit (Parts 35, 36) ───────────────────────────────────────────────

export const resumeFitSchema = z.object({
  documentId: z.string().uuid(),
  label: z.string().max(120),
  jobId: z.string().uuid(),
  /**
   * 0–100. Deliberately *not* the match score.
   *
   * Match asks "should this person apply". Fit asks "which of their documents
   * argues it best". Merging them would make a strong candidate with one weak
   * resume look like a weak candidate.
   */
  resumeFitScore: z.number().min(0).max(100),
  coveredRequirements: z.array(z.string().max(200)).max(40).default([]),
  uncoveredRequirements: z.array(z.string().max(200)).max(40).default([]),
  rationale: z.string().max(500).default(''),

  /*
   * Sub-dimensions (Prompt 19, Part 11).
   *
   * Added here rather than in a parallel schema because they explain the same
   * number. A document can score 60 because the role is wrong or because the
   * formatting defeats an ATS, and those need completely different fixes — a
   * single figure sends the candidate to guess which.
   */
  roleAlignment: z.number().min(0).max(100).nullable().default(null),
  skillCoverage: z.number().min(0).max(100).nullable().default(null),
  experienceRelevance: z.number().min(0).max(100).nullable().default(null),
  keywordCoverage: z.number().min(0).max(100).nullable().default(null),
  achievementRelevance: z.number().min(0).max(100).nullable().default(null),
  seniorityAlignment: z.number().min(0).max(100).nullable().default(null),
  atsCompatibility: z.number().min(0).max(100).nullable().default(null),
});
export type ResumeFit = z.infer<typeof resumeFitSchema>;

export const resumeComparisonSchema = z.object({
  candidateId: z.string().uuid(),
  documents: z
    .array(
      z.object({
        documentId: z.string().uuid(),
        label: z.string().max(120),
        targetRole: z.string().max(120).nullable().default(null),
        skillCount: z.number().int().min(0),
        experienceCount: z.number().int().min(0),
        /** Skills only this document evidences. */
        uniqueSkills: z.array(z.string().max(80)).max(60).default([]),
        positioning: z.string().max(400).default(''),
      }),
    )
    .default([]),
  /** Skills every document agrees on. */
  sharedSkills: z.array(z.string().max(80)).max(120).default([]),
  differences: z.array(z.string().max(400)).max(40).default([]),
});
export type ResumeComparison = z.infer<typeof resumeComparisonSchema>;

// ── Conflicts and overrides (Parts 32, 34) ──────────────────────────────────

export const CONFLICT_KINDS = [
  'skill_duration',
  'employment_dates',
  'job_title',
  'education',
  'seniority',
  'contact',
  'other',
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

/**
 * A contradiction between sources.
 *
 * Never resolved automatically. Two resumes disagreeing about how long someone
 * used React is a question only they can answer, and silently picking the
 * larger number is how a profile starts overstating itself.
 */
export const profileConflictSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  kind: z.enum(CONFLICT_KINDS),
  subject: z.string().max(200),
  /** Each side, with where it came from. */
  positions: z
    .array(
      z.object({
        value: z.string().max(400),
        documentId: z.string().uuid().nullable().default(null),
        documentLabel: z.string().max(120).nullable().default(null),
        source: z.enum(EVIDENCE_SOURCES),
        confidence: z.number().min(0).max(1),
      }),
    )
    .min(2)
    .max(6),
  detail: z.string().max(600),
  status: z.enum(['open', 'resolved', 'ignored']).default('open'),
  /** The value the candidate chose, once they choose. */
  resolvedValue: z.string().max(400).nullable().default(null),
  resolvedAt: z.coerce.date().nullable().default(null),
  detectedAt: z.coerce.date().default(() => new Date()),
});
export type ProfileConflict = z.infer<typeof profileConflictSchema>;

export const FIELD_ORIGIN_KINDS = ['extracted', 'user_verified', 'user_added', 'merged'] as const;
export type FieldOriginKind = (typeof FIELD_ORIGIN_KINDS)[number];

/**
 * A candidate's manual correction.
 *
 * `user_verified` outranks every extraction, permanently. Re-uploading a resume
 * must not silently undo a correction the person made by hand — that is the
 * fastest way to make someone stop trusting an editor.
 */
export const fieldOverrideSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  /** Dotted path into the intelligence profile. */
  path: z.string().max(200),
  value: z.unknown().optional(),
  previousValue: z.unknown().optional(),
  origin: z.enum(FIELD_ORIGIN_KINDS).default('user_verified'),
  note: z.string().max(400).nullable().default(null),
  createdAt: z.coerce.date().default(() => new Date()),
});
export type FieldOverride = z.infer<typeof fieldOverrideSchema>;

// ── Profile quality (Parts 47, 48) ──────────────────────────────────────────

/**
 * Three scores, deliberately not one.
 *
 * They answer different questions and move independently: a profile can be
 * complete and poorly evidenced (everything filled in by hand, nothing backed
 * by a document), or sparse and superbly evidenced. Collapsing them produces a
 * number that cannot be acted on.
 */
export const profileQualitySchema = z.object({
  /** Do we have the fields that materially affect matching? */
  completenessScore: z.number().min(0).max(100),
  /** How good is the evidence behind what we have? */
  evidenceQualityScore: z.number().min(0).max(100),
  /** How sure are we of the extractions? */
  confidenceScore: z.number().min(0).max(100),

  /** Missing items that would actually change match outcomes. */
  materialGaps: z
    .array(
      z.object({
        field: z.string().max(80),
        impact: z.enum(['high', 'medium', 'low']),
        reason: z.string().max(300),
        action: z.string().max(200),
      }),
    )
    .default([]),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type ProfileQuality = z.infer<typeof profileQualitySchema>;

// ── The intelligence profile (Parts 1, 31) ──────────────────────────────────

/**
 * The assembled candidate intelligence profile.
 *
 * Versioned as a whole: a resume upload creates a new version rather than
 * mutating this one, so a match computed last month can be reproduced against
 * the profile that actually produced it.
 */
export const candidateIntelligenceSchema = z.object({
  candidateId: z.string().uuid(),
  profileVersion: z.number().int().min(1),

  summary: z.string().max(2_000).nullable().default(null),
  /** True when the summary was generated rather than written by the person. */
  summaryGenerated: z.boolean().default(true),

  skills: z.array(candidateSkillFactSchema).max(400).default([]),
  experience: z.array(experienceEntrySchema).max(60).default([]),
  education: z.array(educationRecordSchema).max(30).default([]),
  certifications: z.array(certificationRecordSchema).max(40).default([]),
  projects: z.array(projectRecordSchema).max(60).default([]),
  achievements: z.array(achievementRecordSchema).max(60).default([]),
  languages: z.array(languageRecordSchema).max(20).default([]),

  seniority: seniorityEstimateSchema.prefault({}),
  trajectory: careerTrajectorySchema.prefault({}),
  quality: profileQualitySchema.nullable().default(null),

  /** Documents that contributed. */
  sourceDocumentIds: z.array(z.string().uuid()).max(20).default([]),
  openConflicts: z.number().int().min(0).default(0),

  extractionVersion: z.string().max(20).default(EXTRACTION_VERSION),
  taxonomyVersion: z.string().max(20).default(TAXONOMY_VERSION),
  /** Model used for the AI-assisted parts, when one was used. */
  extractionModel: z.string().max(80).nullable().default(null),
  computedAt: z.coerce.date().default(() => new Date()),
});
export type CandidateIntelligence = z.infer<typeof candidateIntelligenceSchema>;

// ── Job-specific candidate view (Part 37) ───────────────────────────────────

export const jobCandidateViewSchema = z.object({
  jobId: z.string().uuid(),
  candidateId: z.string().uuid(),
  matrix: requirementMatrixSchema,
  relevantExperience: z
    .array(z.object({ id: z.string().max(80), summary: z.string().max(400) }))
    .max(10)
    .default([]),
  relevantProjects: z
    .array(z.object({ id: z.string().max(80), summary: z.string().max(400) }))
    .max(10)
    .default([]),
  relevantSkills: z.array(z.string().max(80)).max(40).default([]),
  gaps: z.array(z.string().max(300)).max(20).default([]),
  transferable: z.array(transferableSkillSchema).max(20).default([]),
  resumeFits: z.array(resumeFitSchema).max(10).default([]),
  /** Mean evidence confidence behind the matched requirements. */
  evidenceConfidence: z.number().min(0).max(1).default(0),
  /** Prose for the notification, generated from the matrix. */
  explanation: z.string().max(2_000).default(''),
});
export type JobCandidateView = z.infer<typeof jobCandidateViewSchema>;
