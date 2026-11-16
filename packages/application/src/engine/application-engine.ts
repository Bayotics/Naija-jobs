import {
  APPLICATION_ALGORITHM_VERSION,
  applicationExplanationSchema,
  experienceAlignmentSchema,
  seniorityAlignmentSchema,
  applicationIntelligenceSchema,
  applicationPolicySchema,
  companyHistorySchema,
  dimensionScoreSchema,
  duplicateCheckSchema,
  type ApplicationIntelligence,
  type ApplicationPolicy,
  type ApplicationRecommendation,
  type CandidateEvaluation,
  type CandidateIntelligence,
  type CandidatePreferences,
  type CompanyHistory,
  type DuplicateCheck,
  type JobEnrichment,
  type LearnedSignal,
  type ParsedRequirementRecord,
  type RequirementAssessment,
} from '@job-intel/contracts';
import { SkillGraph } from '@job-intel/candidate';
import type { DocumentExtraction } from '@job-intel/candidate';
import { extractRequirements } from '../requirements/extract';
import { aggregateSkillAlignment, assessRequirement, sortAssessments } from '../requirements/matcher';
import {
  analyseExperience,
  analyseSeniority,
  scoreCareerAlignment,
  scoreExperience,
} from '../dimensions/experience';
import { analyseLocation, scorePreferenceAlignment } from '../dimensions/preferences';
import { analyseCompensation, compensationScore } from '../dimensions/compensation';
import { analyseAuthorization, analyseLanguages } from '../dimensions/eligibility-signals';
import {
  analyseCompetitiveness,
  analyseFriction,
  analyseLegitimacy,
  analyseTiming,
} from '../dimensions/friction';
import { assessEligibility } from '../dimensions/eligibility';
import { buildChecklist, buildPositioning, selectResume } from './resume-selection';

/**
 * The application intelligence engine.
 *
 * Assembles every dimension into one recommendation and one explanation, in a
 * fixed order that mirrors how a person would actually think about it:
 *
 *   1. What is this job asking for?          (requirement extraction)
 *   2. Can I even be hired for it?           (eligibility, blockers)
 *   3. How well do I fit?                    (skills, experience, seniority)
 *   4. Do I want it?                         (preferences, pay, career)
 *   5. Is it worth the effort right now?     (timing, friction, competition)
 *   6. Which resume, and how do I position?  (selection, advice)
 *   7. So: apply, consider, or skip?         (policy)
 *
 * Step 2 comes before step 3 deliberately. A blocker is not a low score — it is
 * a different kind of answer, and computing it after the fit scores invites the
 * temptation to let a great fit outweigh it.
 */

export interface ApplicationEngineInput {
  jobId: string;
  candidateId: string;

  jobTitle: string;
  companyName: string | null;
  companyWebsite: string | null;
  description: string | null;
  postedAt: Date | null;
  validThrough: Date | null;
  /** True when the lifecycle layer has already closed this posting. */
  closed: boolean;
  applyUrl: string | null;
  /** How many distinct sources carried it, for the competition estimate. */
  sourceCount: number;

  enrichment: JobEnrichment | null;
  profile: CandidateIntelligence | null;
  preferences: CandidatePreferences | null;
  /** The constraint evaluation from the matching layer. */
  evaluation: CandidateEvaluation | null;
  learnedSignals: readonly LearnedSignal[];
  documents: readonly DocumentExtraction[];

  /** The job match score, read and never written. */
  matchScore: number | null;
  /** Upstream quality signals, reused rather than recomputed. */
  jobQualityScore: number | null;
  scamScore: number | null;

  duplicate?: DuplicateCheck | null;
  companyHistory?: CompanyHistory | null;
  /** Applicant numbers, only when a source actually reported them. */
  reportedApplicants?: { count: number; source: string } | null;
  acknowledgedBlockerIds?: readonly string[];
  hasPortfolio?: boolean;

  graph?: SkillGraph;
  policy?: Partial<ApplicationPolicy>;
  now?: Date;
}

const clamp = (value: number, min = 0, max = 100): number =>
  Math.max(min, Math.min(max, Math.round(value)));

/**
 * Truncation for anything built from a posting.
 *
 * Same reasoning as in resume selection: requirement text is whatever the
 * employer typed, and a sentence assembled from two of them routinely exceeds
 * the schema's per-item limit. Clipping is cosmetic; the alternative is losing
 * the whole analysis for that job to a validation error.
 */
const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

export function runApplicationIntelligence(
  input: ApplicationEngineInput,
): ApplicationIntelligence {
  const now = input.now ?? new Date();
  const policy = applicationPolicySchema.parse(input.policy ?? {});
  const graph = input.graph ?? new SkillGraph();

  // ── 1. What is this job asking for? ─────────────────────────────────────
  const requirements = extractRequirements({
    requirements: input.enrichment?.requirements ?? [],
    preferredQualifications: input.enrichment?.preferredQualifications ?? [],
    responsibilities: input.enrichment?.responsibilities ?? [],
    description: input.description,
    enrichment: input.enrichment,
  });

  const requiredSlugs = requirements
    .filter((entry) => entry.type === 'technical_skill' && entry.slug !== null)
    .map((entry) => entry.slug!);

  // ── 2 & 3. Requirement-by-requirement assessment ────────────────────────
  const emptyProfile = input.profile === null;

  const skillAssessments: RequirementAssessment[] = emptyProfile
    ? []
    : requirements
        .filter((entry) => entry.type === 'technical_skill' || entry.type === 'soft_skill')
        .map((requirement) =>
          assessRequirement(requirement, {
            profile: input.profile!,
            preferences: input.preferences,
            graph,
            now,
          }),
        );

  const skills = aggregateSkillAlignment(skillAssessments);

  // ── Dimension inputs that eligibility needs ─────────────────────────────
  /*
   * A candidate with no intelligence profile has no experience to analyse.
   *
   * The requirement is still read — the posting's demand exists regardless —
   * so the years requirement shows up as something the profile cannot answer
   * rather than being silently dropped.
   */
  const experience = input.profile
    ? analyseExperience({ profile: input.profile, requirements, requiredSlugs, now })
    : experienceAlignmentSchema.parse({
        requiredYears:
          requirements
            .filter((entry) => entry.type === 'experience_years' && entry.minYears !== null)
            .reduce<number | null>(
              (max, entry) => (max === null ? entry.minYears! : Math.max(max, entry.minYears!)),
              null,
            ),
        explanation: 'No candidate profile exists yet, so experience could not be assessed.',
      });

  const compensation = analyseCompensation({
    enrichment: input.enrichment,
    preferences: input.preferences,
  });

  const authorization = analyseAuthorization({
    enrichment: input.enrichment,
    preferences: input.preferences,
    requirements,
  });

  const language = analyseLanguages({ requirements, profile: input.profile });
  const location = analyseLocation({ enrichment: input.enrichment, preferences: input.preferences });

  const eligibility = assessEligibility({
    requirements,
    skillAssessments,
    profile: input.profile,
    experience,
    authorization,
    language,
    location,
    compensation,
    acknowledgedBlockerIds: input.acknowledgedBlockerIds ?? [],
  });

  // ── 4. Do I want it? ────────────────────────────────────────────────────
  const seniority = input.profile
    ? analyseSeniority({
        profile: input.profile,
        jobLevel: input.enrichment?.seniority ?? null,
        jobLevelConfidence: input.enrichment?.seniorityConfidence ?? 0,
      })
    : seniorityAlignmentSchema.parse({
        jobLevel: input.enrichment?.seniority ?? null,
        explanation: 'No candidate profile exists yet, so seniority could not be compared.',
      });

  const preferenceAlignment = scorePreferenceAlignment({
    preferences: input.preferences,
    evaluation: input.evaluation,
    learnedSignals: input.learnedSignals,
    enrichment: input.enrichment,
  });

  const careerAlignment = input.profile
    ? scoreCareerAlignment({
        profile: input.profile,
        jobTitle: input.jobTitle,
        jobSlugs: requiredSlugs,
        seniority,
      })
    : dimensionScoreSchema.parse({
        dimension: 'careerAlignment',
        score: 0,
        confidence: 0,
        applicable: false,
        inapplicableReason: 'No candidate intelligence profile exists yet.',
        explanation: 'Upload a resume so career direction can be assessed.',
      });

  const experienceScore = scoreExperience(experience);

  // ── 5. Is it worth the effort right now? ────────────────────────────────
  const timing = analyseTiming({
    postedAt: input.postedAt,
    validThrough: input.validThrough,
    description: input.description,
    closed: input.closed,
    now,
  });

  const friction = analyseFriction({ enrichment: input.enrichment, description: input.description });

  const competitiveness = analyseCompetitiveness({
    requirements,
    enrichment: input.enrichment,
    timing,
    reportedApplicants: input.reportedApplicants ?? null,
    skillAlignmentScore: skills.score,
    sourceCount: input.sourceCount,
  });

  const legitimacy = analyseLegitimacy({
    description: input.description,
    companyName: input.companyName,
    companyWebsite: input.companyWebsite,
    applyUrl: input.applyUrl,
    scamScore: input.scamScore,
    qualityScore: input.jobQualityScore,
  });

  const duplicate = input.duplicate ?? duplicateCheckSchema.parse({});
  const companyHistory = input.companyHistory ?? companyHistorySchema.parse({
    companyName: input.companyName,
  });

  // ── Composite dimensions ────────────────────────────────────────────────
  const skillAlignment = dimensionScoreSchema.parse({
    dimension: 'skillAlignment',
    score: skills.score,
    confidence: skills.confidence,
    applicable: skills.assessments.length > 0,
    inapplicableReason:
      skills.assessments.length === 0 ? 'This posting names no specific skills.' : null,
    explanation: skills.explanation,
    evidence: skills.assessments
      .filter((entry) => entry.strength === 'DIRECT_MATCH')
      .slice(0, 8)
      .map((entry) => entry.explanation),
  });

  /*
   * Qualification is the "could they do the job" number.
   *
   * Skills and experience combined, weighted toward skills because a posting
   * that names ten technologies is telling you far more about the work than one
   * that says "5+ years".
   */
  const qualificationParts: Array<{ score: number; weight: number; confidence: number }> = [];
  if (skillAlignment.applicable) {
    qualificationParts.push({ score: skills.score, weight: 0.65, confidence: skills.confidence });
  }
  if (experienceScore.applicable) {
    qualificationParts.push({
      score: experienceScore.score,
      weight: 0.35,
      confidence: experienceScore.confidence,
    });
  }

  const qualificationWeight = qualificationParts.reduce((sum, part) => sum + part.weight, 0);
  const qualificationScore =
    qualificationWeight === 0
      ? 0
      : qualificationParts.reduce((sum, part) => sum + part.score * part.weight, 0) / qualificationWeight;

  const qualification = dimensionScoreSchema.parse({
    dimension: 'qualification',
    score: clamp(qualificationScore),
    confidence:
      qualificationParts.length === 0
        ? 0
        : Math.round(
            (qualificationParts.reduce((sum, part) => sum + part.confidence, 0) /
              qualificationParts.length) *
              100,
          ) / 100,
    applicable: qualificationParts.length > 0,
    inapplicableReason:
      qualificationParts.length === 0 ? 'This posting states no checkable requirements.' : null,
    explanation:
      qualificationParts.length === 0
        ? 'This posting does not state requirements the profile can be checked against.'
        : `${skills.explanation} ${experience.explanation}`,
    evidence: [],
  });

  const jobQuality = dimensionScoreSchema.parse({
    dimension: 'jobQuality',
    score: clamp((input.jobQualityScore ?? 0.5) * 100),
    confidence: input.jobQualityScore === null ? 0.2 : 0.6,
    applicable: input.jobQualityScore !== null,
    inapplicableReason: input.jobQualityScore === null ? 'The posting has not been enriched.' : null,
    explanation:
      legitimacy.verdict === 'SUSPICIOUS'
        ? legitimacy.explanation
        : input.jobQualityScore === null
          ? 'Posting quality has not been assessed.'
          : `Posting quality scored ${Math.round((input.jobQualityScore ?? 0) * 100)}/100 by the enrichment layer.`,
    evidence: legitimacy.signals.slice(0, 4).map((signal) => signal.detail),
  });

  // ── Value score (Part 21) ───────────────────────────────────────────────
  const compensationValue = compensationScore(compensation);

  const contributions: Array<{ score: number; weight: number }> = [];
  const weights = policy.valueWeights;

  const contribute = (score: number, weight: number, applicable: boolean): void => {
    // Inapplicable dimensions drop out of both numerator and denominator, so a
    // silent posting is not penalised for its silence.
    if (applicable) contributions.push({ score, weight });
  };

  contribute(qualification.score, weights.qualification, qualification.applicable);
  contribute(skillAlignment.score, weights.skillAlignment, skillAlignment.applicable);
  contribute(preferenceAlignment.score, weights.preferenceAlignment, preferenceAlignment.applicable);
  contribute(careerAlignment.score, weights.careerAlignment, careerAlignment.applicable);
  contribute(jobQuality.score, weights.jobQuality, jobQuality.applicable);
  contribute(compensationValue.score, weights.compensation, compensationValue.applicable);
  contribute(timing.urgency, weights.timing, timing.state !== 'unknown');
  // Friction is inverted: less effort is more value.
  contribute(100 - friction.frictionScore, weights.friction, true);

  const totalWeight = contributions.reduce((sum, entry) => sum + entry.weight, 0);
  let applicationValueScore =
    totalWeight === 0
      ? 0
      : contributions.reduce((sum, entry) => sum + entry.score * entry.weight, 0) / totalWeight;

  /*
   * How much of the score is actually about the *match*.
   *
   * Dropping inapplicable dimensions is right — a posting that states no salary
   * should not be penalised for its silence — but it has a failure mode the
   * live run exposed clearly. When a posting names no skills the taxonomy
   * recognises, `skillAlignment` and `careerAlignment` both drop out, and the
   * remaining weight concentrates on job quality, freshness and how short the
   * application form is. Those describe the *posting*, not the fit, and they
   * are high for almost everything.
   *
   * The result was a frontend engineer being shown "Milling Shift Supervisor,
   * Rice Mill" at 79/100, above genuinely relevant software roles — a score
   * built almost entirely from the observation that the posting was recent and
   * well-written.
   *
   * So the score is damped by how much fit-bearing weight could be assessed at
   * all. A recommendation resting on nothing about the candidate should not
   * outrank one resting on evidence.
   */
  const fitWeights = [
    { weight: weights.qualification, applicable: qualification.applicable },
    { weight: weights.skillAlignment, applicable: skillAlignment.applicable },
    { weight: weights.preferenceAlignment, applicable: preferenceAlignment.applicable },
    { weight: weights.careerAlignment, applicable: careerAlignment.applicable },
  ];

  const fitTotal = fitWeights.reduce((sum, entry) => sum + entry.weight, 0);
  const fitApplicable = fitWeights
    .filter((entry) => entry.applicable)
    .reduce((sum, entry) => sum + entry.weight, 0);

  const fitCoverage = fitTotal === 0 ? 0 : fitApplicable / fitTotal;

  if (fitCoverage < 0.75) {
    // Scaled rather than zeroed: partial information is still information, and
    // the explanation says which dimensions could not be assessed.
    applicationValueScore *= 0.55 + fitCoverage * 0.6;
  }

  /*
   * Adjustments the weighted mean cannot express.
   *
   * Some facts are not dimensions to average — they are reasons to step back
   * from a number that otherwise looks fine. Each of these was added because
   * the simulation produced a verdict that would have embarrassed the system in
   * front of a real candidate, and none of them can be expressed by nudging a
   * weight without distorting every other job.
   */
  if (legitimacy.verdict === 'SUSPICIOUS') applicationValueScore *= 0.55;
  if (companyHistory.sentiment < 0) applicationValueScore *= 1 + companyHistory.sentiment * 0.15;

  /*
   * Pay well below what the candidate asked for.
   *
   * Compensation is a small weight because most postings are silent about it,
   * and raising that weight would punish silence. But a job paying £50k to
   * someone who said they need £85k is not "a good match that pays a bit less"
   * — showing it at the top of the list is the fastest way to lose someone's
   * trust in every other recommendation.
   */
  if (compensation.verdict === 'below_preference') applicationValueScore *= 0.72;

  /*
   * A role well below the candidate's evidenced level.
   *
   * Not a rejection — some people deliberately step back, and the explanation
   * says so. But a junior role should not outrank a senior one for a senior
   * candidate purely because the skill overlap is trivially perfect.
   */
  if (seniority.fit === 'overqualified') applicationValueScore *= 0.7;
  else if (seniority.fit === 'major_mismatch') applicationValueScore *= 0.75;

  /*
   * A likely blocker.
   *
   * Softer than a hard blocker by construction — a stated degree or years
   * requirement the candidate does not meet is frequently negotiable — but it
   * is a real reason the application may not be read, and the score should
   * reflect that rather than leaving it as a footnote.
   */
  const likelyBlockers = eligibility.blockers.filter(
    (blocker) => blocker.severity === 'LIKELY_BLOCKER' && !blocker.acknowledged,
  );
  if (likelyBlockers.length > 0) {
    applicationValueScore *= Math.max(0.55, 1 - likelyBlockers.length * 0.2);
  }

  // Competition is a ranking input, not a veto, so the effect stays small.
  if (competitiveness.level === 'HIGH' && competitiveness.confidence >= 0.3) {
    applicationValueScore *= 0.92;
  }

  /*
   * Required requirements the profile actively fails.
   *
   * Distinct from a blocker: failing "6+ years of GraphQL" with four and a half
   * does not make someone ineligible, and plenty of people are hired over that
   * line. But it is the first thing a screener will catch, and a weighted mean
   * across eight dimensions dilutes it to nothing — the simulation had a job
   * demanding six years of GraphQL against two and a half coming out as
   * "Apply now", which is the system setting someone up to be filtered out.
   *
   * Counted from assessments rather than blockers so it covers every kind:
   * an excluded technology, a short experience span, an unmet degree.
   */
  const unmetRequired = eligibility.assessments.filter(
    (entry) => entry.requirement.importance === 'required' && entry.support === 'NOT_SUPPORTED',
  ).length;

  if (unmetRequired > 0) {
    applicationValueScore *= Math.max(0.5, 1 - unmetRequired * 0.15);
  }

  if (timing.state === 'expired') applicationValueScore = 0;

  applicationValueScore = clamp(applicationValueScore);

  // ── Confidence ──────────────────────────────────────────────────────────
  const confidenceInputs = [
    { value: qualification.confidence, applicable: qualification.applicable },
    { value: skillAlignment.confidence, applicable: skillAlignment.applicable },
    { value: preferenceAlignment.confidence, applicable: preferenceAlignment.applicable },
    { value: experienceScore.confidence, applicable: experienceScore.applicable },
  ].filter((entry) => entry.applicable);

  let confidence =
    confidenceInputs.length === 0
      ? 0.1
      : confidenceInputs.reduce((sum, entry) => sum + entry.value, 0) / confidenceInputs.length;

  // Unknowns are exactly what confidence is for.
  if (eligibility.unknown > 0) {
    const total = Math.max(1, eligibility.supported + eligibility.notSupported + eligibility.unknown);
    confidence *= 1 - Math.min(0.5, (eligibility.unknown / total) * 0.6);
  }

  if (!input.profile) confidence = Math.min(confidence, 0.2);
  if (!input.enrichment) confidence = Math.min(confidence, 0.25);

  confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;

  // ── 7. The verdict ──────────────────────────────────────────────────────
  const recommendation = decide({
    policy,
    eligibility,
    timing,
    duplicate,
    legitimacy,
    value: applicationValueScore,
    confidence,
    hasProfile: input.profile !== null,
    hasEnrichment: input.enrichment !== null,
    unresolvedRequiredUnknowns: eligibility.assessments.filter(
      (entry) => entry.support === 'UNKNOWN' && entry.requirement.importance === 'required',
    ).length,
    unmetRequired,
  });

  // ── 6. Resume and positioning ───────────────────────────────────────────
  const allAssessments = sortAssessments([...eligibility.assessments]);

  const resume = selectResume({
    documents: input.documents,
    requirements,
    assessments: allAssessments,
    requiredSlugs,
    jobTitle: input.jobTitle,
  });

  const positioning = buildPositioning({
    profile: input.profile,
    assessments: allAssessments,
    resume,
    seniority,
    eligibility,
    jobTitle: input.jobTitle,
  });

  const checklist = buildChecklist({
    recommendation,
    resume,
    friction,
    authorization,
    compensation,
    eligibility,
    hasPortfolio: input.hasPortfolio ?? false,
  });

  // ── Explanation ─────────────────────────────────────────────────────────
  const explanation = buildExplanation({
    recommendation,
    jobTitle: input.jobTitle,
    companyName: input.companyName,
    assessments: allAssessments,
    eligibility,
    skills,
    experience,
    seniority,
    compensation,
    timing,
    friction,
    competitiveness,
    legitimacy,
    duplicate,
    resume,
    value: applicationValueScore,
    confidence,
  });

  return applicationIntelligenceSchema.parse({
    jobId: input.jobId,
    candidateId: input.candidateId,
    eligibility,
    qualification,
    skillAlignment,
    experienceAlignment: experienceScore,
    preferenceAlignment,
    careerAlignment,
    jobQuality,
    experience,
    seniority,
    compensation,
    authorization,
    language,
    location,
    friction,
    competitiveness,
    timing,
    duplicate,
    companyHistory,
    legitimacy,
    resume,
    positioning,
    checklist,
    overallRecommendation: recommendation,
    confidence,
    applicationValueScore,
    blockers: eligibility.blockers,
    strengths: explanation.strengths,
    gaps: [...explanation.missing, ...explanation.unknowns]
      .map((entry) => clip(entry, 400))
      .slice(0, 12),
    explanation,
    matchScore: input.matchScore,
    profileVersion: input.profile?.profileVersion ?? null,
    generatedAt: now,
    algorithmVersion: APPLICATION_ALGORITHM_VERSION,
  });
}

// ── The policy (Part 29) ────────────────────────────────────────────────────

interface DecisionInput {
  policy: ApplicationPolicy;
  eligibility: ApplicationIntelligence['eligibility'];
  timing: ApplicationIntelligence['timing'];
  duplicate: DuplicateCheck;
  legitimacy: ApplicationIntelligence['legitimacy'];
  value: number;
  confidence: number;
  hasProfile: boolean;
  hasEnrichment: boolean;
  /** Required requirements the profile is silent on. */
  unresolvedRequiredUnknowns?: number;
  /** Required requirements the profile actively fails. */
  unmetRequired?: number;
}

/**
 * The decision, as an ordered sequence of gates.
 *
 * Order is the design. Blockers are checked before scores, and scores before
 * confidence, so that no amount of enthusiasm about a fit can talk the system
 * past a requirement the candidate cannot meet — and no amount of uncertainty
 * can talk it past one either.
 */
export function decide(input: DecisionInput): ApplicationRecommendation {
  // ── Gate 1: can they apply at all? ──────────────────────────────────────
  if (input.timing.state === 'expired') return 'SKIP';
  if (input.duplicate.suppresses) return 'SKIP';

  const blocking = input.eligibility.blockers.filter(
    (blocker) => blocker.severity === 'HARD_BLOCKER' && !blocker.acknowledged,
  );

  // Never overridden by score or confidence. That is what "hard" means.
  if (blocking.length > 0) return 'BLOCKED';

  // ── Gate 2: is there enough to judge on? ────────────────────────────────
  if (!input.hasProfile || !input.hasEnrichment) return 'UNKNOWN';

  /*
   * The confidence floor is deliberately one-sided.
   *
   * Its job is to stop the system asserting "apply to this" on thin evidence,
   * because that spends the candidate's evening. It is not a reason to withhold
   * a negative: a frontend engineer looking at an embedded-firmware role whose
   * profile evidences none of C++, RTOS or hardware work is better served by
   * "probably skip, and here is what is missing" than by "not enough
   * information", which reads as a system failure rather than an answer.
   *
   * The safety concern behind the floor — wrongly steering someone away from a
   * job they could get — is handled by the explanation naming every unknown,
   * and by SKIP hiding nothing.
   */
  if (
    input.confidence < input.policy.minConfidenceForVerdict &&
    input.value >= input.policy.considerMinValue
  ) {
    return 'UNKNOWN';
  }

  // ── Gate 3: is the posting itself trustworthy? ──────────────────────────
  if (input.legitimacy.verdict === 'SUSPICIOUS') {
    // Not SKIP: the candidate may know the company. Surfaced with the warning.
    return 'CONSIDER';
  }

  // ── Gate 4: the score ───────────────────────────────────────────────────
  if (input.value >= input.policy.applyNowMinValue) {
    const urgent = input.timing.urgency >= input.policy.applyNowMinUrgency;
    const clean = input.eligibility.blockers.length === 0;

    /*
     * "Apply now" is a claim of no reservations.
     *
     * A posting that requires German C1 against a profile with no German
     * recorded produces no blocker — correctly, since silence is not a
     * negative — but it is emphatically not a job to fire off an application to
     * without thinking. An unresolved *required* unknown caps the verdict at
     * APPLY, where the explanation gets read.
     */
    const noOpenQuestions = (input.unresolvedRequiredUnknowns ?? 0) === 0;
    // Nor is it a claim to make over a requirement the profile plainly fails.
    const nothingUnmet = (input.unmetRequired ?? 0) === 0;

    return urgent && clean && noOpenQuestions && nothingUnmet ? 'APPLY_NOW' : 'APPLY';
  }

  if (input.value >= input.policy.applyMinValue) return 'APPLY';
  if (input.value >= input.policy.considerMinValue) return 'CONSIDER';

  return 'SKIP';
}

// ── The explanation (Parts 31, 32) ──────────────────────────────────────────

interface ExplanationInput {
  recommendation: ApplicationRecommendation;
  jobTitle: string;
  companyName: string | null;
  assessments: readonly RequirementAssessment[];
  eligibility: ApplicationIntelligence['eligibility'];
  skills: ReturnType<typeof aggregateSkillAlignment>;
  experience: ApplicationIntelligence['experience'];
  seniority: ApplicationIntelligence['seniority'];
  compensation: ApplicationIntelligence['compensation'];
  timing: ApplicationIntelligence['timing'];
  friction: ApplicationIntelligence['friction'];
  competitiveness: ApplicationIntelligence['competitiveness'];
  legitimacy: ApplicationIntelligence['legitimacy'];
  duplicate: DuplicateCheck;
  resume: ApplicationIntelligence['resume'];
  value: number;
  confidence: number;
}

/**
 * Every claim traced to what supports it.
 *
 * The rule is that nothing in this paragraph may be a summary of a score. "You
 * have extensive AWS experience" is not an allowed sentence unless the profile
 * carries the evidence, so every strength is drawn from a specific assessment
 * and carries that assessment's own explanation.
 */
export function buildExplanation(input: ExplanationInput): ApplicationIntelligence['explanation'] {
  const direct = input.assessments.filter((entry) => entry.strength === 'DIRECT_MATCH');
  const partial = input.assessments.filter((entry) => entry.strength === 'PARTIAL_MATCH');
  const related = input.assessments.filter((entry) => entry.strength === 'RELATED_MATCH');
  const conflicts = input.assessments.filter((entry) => entry.strength === 'CONFLICT');
  const silent = input.assessments.filter(
    (entry) => entry.strength === 'NO_EVIDENCE' && entry.requirement.importance === 'required',
  );

  const strengths: string[] = [];
  const concerns: string[] = [];
  const unknowns: string[] = [];
  const missing: string[] = [];

  for (const entry of direct.slice(0, 8)) {
    strengths.push(clip(`${clip(entry.requirement.text, 120)}: ${entry.explanation}`, 400));
  }

  for (const entry of partial.slice(0, 4)) {
    strengths.push(
      clip(`${clip(entry.requirement.text, 120)} (adjacent): ${entry.explanation}`, 400),
    );
  }

  for (const entry of conflicts.slice(0, 5)) {
    missing.push(clip(`${clip(entry.requirement.text, 120)}: ${entry.explanation}`, 400));
  }

  for (const entry of [...silent, ...related].slice(0, 8)) {
    unknowns.push(clip(entry.explanation, 400));
  }

  for (const question of input.eligibility.questions.slice(0, 5)) {
    unknowns.push(clip(question, 400));
  }

  // ── Concerns ────────────────────────────────────────────────────────────
  if (input.experience.totalMeetsButRelevantDoesNot) {
    concerns.push(clip(input.experience.explanation, 400));
  }

  if (input.seniority.fit === 'stretch' || input.seniority.fit === 'major_mismatch') {
    concerns.push(clip(input.seniority.explanation, 400));
  }

  if (input.compensation.verdict === 'below_preference') {
    concerns.push(clip(input.compensation.explanation, 400));
  }

  if (input.legitimacy.verdict === 'SUSPICIOUS') concerns.push(clip(input.legitimacy.explanation, 400));
  if (input.competitiveness.level === 'HIGH') concerns.push(clip(input.competitiveness.explanation, 400));
  if (input.friction.estimatedMinutes >= 60) concerns.push(clip(input.friction.explanation, 400));

  for (const blocker of input.eligibility.blockers.filter((entry) => !entry.acknowledged)) {
    concerns.push(clip(`${blocker.statement} ${blocker.detail}`, 400));
  }

  // ── The paragraph ───────────────────────────────────────────────────────
  const role = `${input.jobTitle}${input.companyName ? ` at ${input.companyName}` : ''}`;
  const sentences: string[] = [];

  const blocking = input.eligibility.blockers.filter(
    (entry) => entry.severity === 'HARD_BLOCKER' && !entry.acknowledged,
  );

  if (blocking.length > 0) {
    sentences.push(
      `${role} is blocked: ${blocking.map((entry) => entry.statement).join(' ')} ` +
        'That is separate from how well you fit — it is a requirement the posting states and your profile ' +
        'says you do not meet. If that is wrong, mark it as resolved and this will recompute.',
    );
  } else if (input.timing.state === 'expired') {
    sentences.push(`${role} is no longer open. ${input.timing.explanation}`);
  } else if (input.duplicate.suppresses) {
    sentences.push(`${input.duplicate.explanation}`);
  } else {
    sentences.push(
      `${role}: ${Math.round(input.value)}/100 application value, ` +
        `${Math.round(input.confidence * 100)}% confidence in that reading.`,
    );

    if (direct.length > 0) {
      sentences.push(
        `You directly evidence ${direct.length} of what it asks for, including ` +
          `${direct.slice(0, 3).map((entry) => clip(entry.requirement.text, 60)).join(', ')}.`,
      );
    }

    if (partial.length > 0) {
      sentences.push(
        `${partial.length} requirement${partial.length === 1 ? ' is' : 's are'} met by closely related experience: ` +
          `${partial.slice(0, 3).map((entry) => `${clip(entry.requirement.text, 50)} via ${entry.via[0] ?? 'related work'}`).join(', ')}. ` +
          'Related is not the same as direct, and a screener will read it that way.',
      );
    }

    /*
     * Adjacent-but-unevidenced counts as an unknown here.
     *
     * "You have Docker, which is near Kubernetes" and "you have nothing near
     * Kubernetes" are different amounts of information, but neither of them is
     * evidence of Kubernetes — and the sentence the reader needs is the same in
     * both cases.
     */
    const notEvidenced = [...silent, ...related.filter((entry) => entry.requirement.importance === 'required')];

    if (notEvidenced.length > 0) {
      sentences.push(
        `Your profile does not evidence ${notEvidenced.slice(0, 4).map((entry) => clip(entry.requirement.text, 60)).join(', ')}` +
          `${notEvidenced.length > 4 ? `, and ${notEvidenced.length - 4} other required item${notEvidenced.length - 4 === 1 ? '' : 's'}` : ''}. ` +
          'Those are unknowns, not gaps — the documents are silent, which is not the same as you lacking them.',
      );
    }

    if (conflicts.length > 0) {
      sentences.push(
        `Not met: ${conflicts.slice(0, 3).map((entry) => clip(entry.requirement.text, 60)).join(', ')}.`,
      );
    }

    if (input.experience.totalMeetsButRelevantDoesNot) {
      sentences.push(clip(input.experience.explanation, 400));
    }

    if (input.timing.state === 'closing_soon') sentences.push(input.timing.explanation);
    if (input.legitimacy.verdict === 'SUSPICIOUS') sentences.push(input.legitimacy.explanation);

    if (input.resume.recommendedLabel) {
      sentences.push(`Send your "${input.resume.recommendedLabel}" resume — ${input.resume.reason}`);
    }
  }

  return applicationExplanationSchema.parse({
    summary: sentences.join(' ').slice(0, 2_000),
    strengths: [...new Set(strengths)].slice(0, 12),
    concerns: [...new Set(concerns)].slice(0, 12),
    unknowns: [...new Set(unknowns)].slice(0, 12),
    missing: [...new Set(missing)].slice(0, 12),
    evidence: input.assessments.flatMap((entry) => entry.evidence).slice(0, 30),
  });
}

/** The requirements the engine parsed, exposed for the debugger. */
export function requirementsFor(input: {
  enrichment: JobEnrichment | null;
  description: string | null;
}): ParsedRequirementRecord[] {
  return extractRequirements({
    requirements: input.enrichment?.requirements ?? [],
    preferredQualifications: input.enrichment?.preferredQualifications ?? [],
    responsibilities: input.enrichment?.responsibilities ?? [],
    description: input.description,
    enrichment: input.enrichment,
  });
}
