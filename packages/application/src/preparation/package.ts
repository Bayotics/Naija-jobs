import { randomUUID } from 'node:crypto';
import {
  DEFAULT_DECISION_THRESHOLDS,
  PRIORITY_WEIGHTS,
  applicationDecisionSchema,
  applicationPackageSchema,
  applicationUrlCheckSchema,
  effortEstimateSchema,
  packageQualitySchema,
  type ApplicationDecision,
  type ApplicationPackage,
  type ApplicationRisk,
  type ApplicationUrlCheck,
  type DecisionThresholds,
  type EffortEstimate,
  type PackageQuality,
  type PreparationCheck,
  type PreparationDecision,
  type PreparedAnswer,
  type SupportedClaim,
} from '@job-intel/contracts';
import { factCheck, isPackagePresentable, type CheckedText, type FactCheckContext } from '../integrity/fact-check';

/**
 * Assembling an application package.
 *
 * The last stage, and the one that decides what the candidate actually sees.
 * Three responsibilities, in order of how badly each fails.
 *
 * **The snapshot.** Everything is frozen at preparation time. Jobs get edited
 * and withdrawn; six weeks later, in an interview, the only useful record is
 * what the posting said on the day. A package holding live references would
 * quietly rewrite the candidate's own history.
 *
 * **The integrity gate.** Nothing ships without passing the fact check. A
 * package with a fabricated metric is not a package with a small defect — it is
 * a document that will embarrass the person who sends it, and the only safe
 * response is to remove the claim.
 *
 * **The submission boundary.** There is no `submit`. Not disabled, not flagged
 * — absent. `submittedByUserAt` is written by the interface when a person says
 * they applied, and nothing here can set it.
 */

// ── Priority (Part 3) ───────────────────────────────────────────────────────

export interface PriorityInput {
  matchScore: number;
  confidence: number;
  jobQuality: number | null;
  careerValue: number | null;
  compensationFit: number | null;
  /** Days since posting. Null when unknown. */
  ageDays: number | null;
  /** Days until the deadline. Null when there is none. */
  daysToDeadline: number | null;
  /** Estimated minutes to apply. */
  effortMinutes: number | null;
}

/**
 * How this opportunity ranks against every other one competing for time.
 *
 * Deliberately not the match score. Friction and deadline are what make it
 * different: between two equally good jobs, the ten-minute application beats
 * the hour-long one — not because it is a better job, but because the
 * candidate's time is the scarce resource this product exists to spend well.
 *
 * Dimensions with no data are dropped and the weights renormalised, rather than
 * scored as zero. Scoring an unstated salary as zero would systematically
 * demote every posting that simply omits one, which is most of them.
 */
export function applicationPriority(input: PriorityInput): { score: number; factors: string[] } {
  const factors: string[] = [];
  const parts: Array<{ weight: number; value: number }> = [];

  const add = (weight: number, value: number | null, note?: string): void => {
    if (value === null) return;
    parts.push({ weight, value: Math.max(0, Math.min(100, value)) });
    if (note) factors.push(note);
  };

  add(PRIORITY_WEIGHTS.matchQuality, input.matchScore);
  add(PRIORITY_WEIGHTS.confidence, input.confidence * 100);
  add(PRIORITY_WEIGHTS.jobQuality, input.jobQuality);
  add(PRIORITY_WEIGHTS.careerValue, input.careerValue);
  add(PRIORITY_WEIGHTS.compensation, input.compensationFit);

  if (input.ageDays !== null) {
    /*
     * Freshness decays gently and never to zero. A three-week-old posting is
     * often still open, and discarding it would throw away real opportunities
     * for a signal that is only weakly predictive.
     */
    const freshness = Math.max(20, 100 - input.ageDays * 2);
    add(PRIORITY_WEIGHTS.freshness, freshness, `posted ${input.ageDays} day(s) ago`);
  }

  if (input.daysToDeadline !== null) {
    /*
     * Urgency is the one factor that can legitimately promote a weaker job:
     * a closing deadline is a real constraint, and a slightly worse role the
     * candidate can still apply to beats a better one they have missed.
     */
    const urgency =
      input.daysToDeadline <= 1
        ? 100
        : input.daysToDeadline <= 3
          ? 90
          : input.daysToDeadline <= 7
            ? 75
            : 50;

    add(PRIORITY_WEIGHTS.deadlineUrgency, urgency, `${input.daysToDeadline} day(s) to the deadline`);
  }

  if (input.effortMinutes !== null) {
    const friction = Math.max(10, 100 - input.effortMinutes * 1.5);
    add(PRIORITY_WEIGHTS.friction, friction, `about ${input.effortMinutes} minutes to apply`);
  }

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);

  if (totalWeight === 0) return { score: 0, factors: ['Nothing could be scored.'] };

  const score = parts.reduce((sum, part) => sum + part.value * part.weight, 0) / totalWeight;

  return { score: Math.round(score * 10) / 10, factors };
}

// ── Decision (Parts 1, 2) ───────────────────────────────────────────────────

export interface DecisionInput {
  jobId: string;
  candidateId: string;
  profileId?: string | null;

  eligible: boolean;
  blockers: readonly string[];
  priority: number;
  confidence: number;

  strengths: readonly SupportedClaim[];
  risks: readonly ApplicationRisk[];
  gaps: readonly string[];

  /** Set when the candidate has already engaged with this job. */
  existingStatus?: string | null;
  effortMinutes?: number | null;
  thresholds?: DecisionThresholds;
}

/**
 * The decision.
 *
 * Ineligibility and duplication are checked before the score is consulted at
 * all, because both are facts rather than judgements: a job the candidate
 * cannot take is not a low-priority opportunity, and one they already applied
 * to is not an opportunity.
 */
export function decideApplication(input: DecisionInput): ApplicationDecision {
  const thresholds = input.thresholds ?? DEFAULT_DECISION_THRESHOLDS;

  const base = {
    jobId: input.jobId,
    candidateId: input.candidateId,
    profileId: input.profileId ?? null,
    priorityScore: input.priority,
    confidence: input.confidence,
    strengths: [...input.strengths].slice(0, 8),
    risks: [...input.risks].slice(0, 15),
    gaps: [...input.gaps].slice(0, 15),
    whyApply: [...input.strengths].slice(0, 5),
  };

  if (!input.eligible) {
    return applicationDecisionSchema.parse({
      ...base,
      decision: 'INELIGIBLE',
      whyApply: [],
      whyNot: [...input.blockers].slice(0, 8),
      recommendedAction: 'Not applicable — a hard requirement rules this out.',
    });
  }

  /*
   * Duplicate protection (Part 42). Checked here rather than in the interface
   * so that no caller can skip it: an accidental second application is
   * unrecoverable and looks careless to the employer.
   */
  if (input.existingStatus && DUPLICATE_STATES.includes(input.existingStatus)) {
    return applicationDecisionSchema.parse({
      ...base,
      decision: 'SKIP',
      whyApply: [],
      whyNot: [`You have already engaged with this role (${input.existingStatus.toLowerCase()}).`],
      recommendedAction: 'Already handled. Open the existing application rather than starting again.',
    });
  }

  const critical = input.risks.filter((risk) => risk.severity === 'CRITICAL');

  let decision: PreparationDecision =
    input.priority >= thresholds.applyNow
      ? 'APPLY_NOW'
      : input.priority >= thresholds.apply
        ? 'APPLY'
        : input.priority >= thresholds.applyIfTime
          ? 'APPLY_IF_TIME'
          : input.priority >= thresholds.consider
            ? 'CONSIDER'
            : 'SKIP';

  /*
   * Low confidence softens the decision by one step rather than changing the
   * score. A high number built on thin evidence is a guess, and labelling a
   * guess APPLY_NOW teaches the candidate to distrust the labels.
   */
  if (input.confidence < thresholds.minConfidence) {
    decision = soften(decision);
  }

  /*
   * A long application demotes APPLY_NOW to APPLY. Not a rejection — the job
   * may well be worth an hour — but "now" should mean the thing you can do in
   * the next ten minutes.
   */
  if (decision === 'APPLY_NOW' && (input.effortMinutes ?? 0) > 30) {
    decision = 'APPLY';
  }

  if (critical.length > 0 && decision === 'APPLY_NOW') decision = 'APPLY';

  return applicationDecisionSchema.parse({
    ...base,
    decision,
    whyNot: critical.map((risk) => risk.summary).slice(0, 8),
    recommendedAction: RECOMMENDED_ACTION[decision],
  });
}

const DUPLICATE_STATES = ['APPLIED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'ACCEPTED', 'WITHDRAWN'];

const ORDER: PreparationDecision[] = [
  'APPLY_NOW',
  'APPLY',
  'APPLY_IF_TIME',
  'CONSIDER',
  'SKIP',
  'INELIGIBLE',
];

function soften(decision: PreparationDecision): PreparationDecision {
  const index = ORDER.indexOf(decision);
  return ORDER[Math.min(index + 1, ORDER.length - 2)] ?? decision;
}

const RECOMMENDED_ACTION: Readonly<Record<PreparationDecision, string>> = {
  APPLY_NOW: 'Prepare and send this one today.',
  APPLY: 'Worth applying to this week.',
  APPLY_IF_TIME: 'Solid, but behind your stronger options. Apply if you have time left.',
  CONSIDER: 'Keep it. Revisit if better options do not appear.',
  SKIP: 'Not worth the time relative to your other options.',
  INELIGIBLE: 'Not applicable.',
};

// ── Effort and URL (Parts 38, 47) ───────────────────────────────────────────

const EFFORT_SIGNALS: ReadonlyArray<{ pattern: RegExp; minutes: number; requirement: string }> = [
  { pattern: /cover letter/i, minutes: 25, requirement: 'Cover letter' },
  { pattern: /create an account|sign up|register/i, minutes: 5, requirement: 'Account creation' },
  { pattern: /take[- ]home|assessment|coding (?:test|challenge)/i, minutes: 120, requirement: 'Assessment' },
  { pattern: /portfolio|work samples/i, minutes: 10, requirement: 'Portfolio links' },
  { pattern: /upload (?:your )?(?:resume|cv)/i, minutes: 2, requirement: 'Resume upload' },
  { pattern: /answer the following|application questions/i, minutes: 15, requirement: 'Written questions' },
  { pattern: /references/i, minutes: 10, requirement: 'References' },
];

/** How long this will take, labelled as an estimate because it is one. */
export function estimateEffort(descriptionText: string | null): EffortEstimate {
  const text = descriptionText ?? '';

  let minutes = 5;
  const requirements: string[] = ['Basic details'];

  for (const signal of EFFORT_SIGNALS) {
    if (signal.pattern.test(text)) {
      minutes += signal.minutes;
      requirements.push(signal.requirement);
    }
  }

  return effortEstimateSchema.parse({
    minutes: Math.min(600, minutes),
    complexity: minutes <= 15 ? 'low' : minutes <= 45 ? 'medium' : 'high',
    requirements: requirements.slice(0, 12),
    isEstimate: true,
  });
}

const ATS_HOSTS = [
  'boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
  'apply.workable.com',
  'jobs.smartrecruiters.com',
];

/**
 * Whether the apply link is worth presenting.
 *
 * `safeToPresent` defaults to false and is only raised for destinations we can
 * actually classify. A URL existing is not evidence that it works, and telling
 * someone a dead link is their application route wastes the exact moment they
 * were ready to act.
 */
export function checkApplicationUrl(
  url: string | null,
  options: { companyDomain?: string | null; reachable?: boolean | null } = {},
): ApplicationUrlCheck | null {
  if (!url) return null;

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return applicationUrlCheckSchema.parse({
      url: url.slice(0, 2000),
      verdict: 'BROKEN',
      reachable: false,
      explanation: 'This is not a valid URL.',
      safeToPresent: false,
    });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return applicationUrlCheckSchema.parse({
      url: url.slice(0, 2000),
      verdict: 'BROKEN',
      reachable: false,
      explanation: `Unsupported scheme "${parsed.protocol}".`,
      safeToPresent: false,
    });
  }

  if (options.reachable === false) {
    return applicationUrlCheckSchema.parse({
      url,
      verdict: 'BROKEN',
      reachable: false,
      explanation: 'This link did not respond when checked.',
      safeToPresent: false,
    });
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

  if (ATS_HOSTS.some((ats) => host === ats || host.endsWith(`.${ats}`))) {
    return applicationUrlCheckSchema.parse({
      url,
      verdict: 'ATS_DIRECT',
      reachable: options.reachable ?? null,
      explanation: 'This goes straight to the employer’s applicant tracking system.',
      safeToPresent: true,
    });
  }

  if (options.companyDomain && host.endsWith(options.companyDomain.toLowerCase())) {
    return applicationUrlCheckSchema.parse({
      url,
      verdict: 'EMPLOYER_DIRECT',
      reachable: options.reachable ?? null,
      explanation: 'This is the employer’s own site.',
      safeToPresent: true,
    });
  }

  return applicationUrlCheckSchema.parse({
    url,
    verdict: 'UNVERIFIED',
    reachable: options.reachable ?? null,
    explanation:
      'This is not an employer or ATS domain we recognise. Check where it leads before entering anything.',
    safeToPresent: false,
  });
}

// ── Quality (Part 55) ───────────────────────────────────────────────────────

export interface QualityInput {
  hasResume: boolean;
  hasCustomization: boolean;
  hasCoverLetterDecision: boolean;
  answeredQuestions: number;
  totalQuestions: number;
  claims: readonly SupportedClaim[];
  requirementsCovered: number;
  requirementsTotal: number;
  integrityPassed: boolean;
  integrityFindings: number;
}

/**
 * How complete and well-evidenced the package is.
 *
 * Not a probability of success, and the schema carries that disclaimer so every
 * surface rendering the number renders the caveat with it. Nothing in this
 * system knows whether someone will be hired, and a number that looked like it
 * did would be the most misleading thing on the screen.
 */
export function scorePackage(input: QualityInput): PackageQuality {
  const completenessParts = [
    input.hasResume,
    input.hasCustomization,
    input.hasCoverLetterDecision,
    input.totalQuestions === 0 || input.answeredQuestions > 0,
  ];

  const completeness = (completenessParts.filter(Boolean).length / completenessParts.length) * 100;

  const evidenceConfidence =
    input.claims.length === 0
      ? 0
      : (input.claims.reduce(
          (sum, claim) =>
            sum + claim.evidence.reduce((best, ref) => Math.max(best, ref.confidence), 0),
          0,
        ) /
          input.claims.length) *
        100;

  const relevance =
    input.requirementsTotal === 0
      ? 50
      : (input.requirementsCovered / input.requirementsTotal) * 100;

  /*
   * Consistency collapses on a failed integrity check rather than degrading
   * gracefully. A package containing a fabricated claim is not 70% consistent;
   * it is wrong, and averaging that away would let it through.
   */
  const consistency = input.integrityPassed ? Math.max(0, 100 - input.integrityFindings * 8) : 0;

  const overall = input.integrityPassed
    ? completeness * 0.3 + evidenceConfidence * 0.3 + relevance * 0.25 + consistency * 0.15
    : 0;

  return packageQualitySchema.parse({
    completeness: Math.round(completeness),
    evidenceConfidence: Math.round(evidenceConfidence),
    relevance: Math.round(relevance),
    consistency: Math.round(consistency),
    overall: Math.round(overall),
  });
}

// ── Checklist (Part 37) ─────────────────────────────────────────────────────

export interface PreparationChecklistInput {
  resumeSelected: boolean;
  customizationReviewed: boolean;
  coverLetterVerdict: string | null;
  answers: readonly PreparedAnswer[];
  portfolioRequired: boolean;
  portfolioSelected: number;
  urlCheck: ApplicationUrlCheck | null;
  unresolvedGaps: readonly string[];
}

export function buildPreparationChecklist(input: PreparationChecklistInput): PreparationCheck[] {
  const checks: PreparationCheck[] = [];

  checks.push({
    id: 'resume',
    label: 'Resume selected',
    state: input.resumeSelected ? 'done' : 'todo',
    detail: input.resumeSelected ? null : 'No suitable resume was found on your profile.',
    blocking: !input.resumeSelected,
  });

  checks.push({
    id: 'customization',
    label: 'Resume changes reviewed',
    state: input.customizationReviewed ? 'done' : 'todo',
    detail: input.customizationReviewed ? null : 'Suggestions are waiting for your approval.',
    blocking: false,
  });

  checks.push({
    id: 'cover-letter',
    label: 'Cover letter',
    state:
      input.coverLetterVerdict === 'UNNECESSARY'
        ? 'not_applicable'
        : input.coverLetterVerdict === 'REQUIRED'
          ? 'todo'
          : 'warning',
    detail: input.coverLetterVerdict ? `Verdict: ${input.coverLetterVerdict.toLowerCase()}.` : null,
    blocking: input.coverLetterVerdict === 'REQUIRED',
  });

  /*
   * Unanswerable questions are blocking, and this is the checklist's most
   * useful entry. Discovering mid-form that the salary question needs a number
   * nobody has set is how an application gets abandoned half-finished.
   */
  const needsInput = input.answers.filter((answer) => answer.missingInformation.length > 0);

  checks.push({
    id: 'questions',
    label: 'Application questions prepared',
    state: needsInput.length === 0 ? 'done' : 'blocked',
    detail:
      needsInput.length === 0
        ? null
        : `${needsInput.length} question(s) need information only you can supply.`,
    blocking: needsInput.length > 0,
  });

  if (input.portfolioRequired) {
    checks.push({
      id: 'portfolio',
      label: 'Portfolio attached',
      state: input.portfolioSelected > 0 ? 'done' : 'todo',
      detail:
        input.portfolioSelected > 0
          ? `${input.portfolioSelected} item(s) selected.`
          : 'This posting asks for work samples and none were matched.',
      blocking: input.portfolioSelected === 0,
    });
  }

  checks.push({
    id: 'url',
    label: 'Application link verified',
    state: input.urlCheck?.safeToPresent ? 'done' : input.urlCheck ? 'warning' : 'todo',
    detail: input.urlCheck?.explanation ?? 'No application URL recorded.',
    blocking: input.urlCheck?.verdict === 'BROKEN',
  });

  for (const gap of input.unresolvedGaps.slice(0, 5)) {
    checks.push({
      id: `gap-${gap.slice(0, 20)}`,
      label: `Gap: ${gap}`,
      state: 'warning',
      detail: 'You cannot evidence this. Do not imply otherwise in your materials.',
      blocking: false,
    });
  }

  return checks.slice(0, 30);
}

// ── Assembly (Parts 48, 49) ─────────────────────────────────────────────────

export interface AssembleInput {
  jobId: string;
  candidateId: string;
  /** Frozen at preparation time. Never a live reference. */
  jobSnapshot: Record<string, unknown>;
  matchSnapshot?: Record<string, unknown> | null;

  decision: ApplicationDecision;
  resume: ApplicationPackage['resume'];
  customization?: ApplicationPackage['customization'];
  ats?: ApplicationPackage['ats'];
  coverLetter?: ApplicationPackage['coverLetter'];
  companyResearch?: ApplicationPackage['companyResearch'];
  answers?: readonly PreparedAnswer[];
  salary?: ApplicationPackage['salary'];
  authorization?: ApplicationPackage['authorization'];
  portfolio?: ApplicationPackage['portfolio'];
  portfolioGaps?: ApplicationPackage['portfolioGaps'];
  certifications?: readonly string[];
  effort?: EffortEstimate | null;
  applicationUrl?: ApplicationUrlCheck | null;

  /** Everything generated, for the fact check. */
  generatedTexts: readonly CheckedText[];
  factContext: FactCheckContext;
  requirementsCovered: number;
  requirementsTotal: number;
}

export interface AssembledPackage {
  package: ApplicationPackage;
  integrity: ReturnType<typeof factCheck>;
  presentable: ReturnType<typeof isPackagePresentable>;
}

/**
 * Builds the package, gated on integrity.
 *
 * The fact check runs before the package is constructed, not after, and a
 * failure strips the offending content rather than annotating it. A package
 * that ships a fabricated claim with a warning attached is a package that
 * ships a fabricated claim — people do not read warnings on things that look
 * finished.
 */
export function assemblePackage(input: AssembleInput): AssembledPackage {
  const claims: SupportedClaim[] = [
    ...input.decision.strengths,
    ...input.decision.whyApply,
    ...(input.coverLetter?.brief?.topEvidence ?? []),
    ...(input.customization?.emphasise ?? []),
  ];

  const integrity = factCheck(input.generatedTexts, claims, input.factContext);
  const presentable = isPackagePresentable(integrity);

  const critical = new Set(
    integrity.findings
      .filter((finding) => finding.severity === 'CRITICAL')
      .map((finding) => finding.offendingText),
  );

  /*
   * Offending claims are dropped, not flagged. The candidate never sees a
   * sentence the system could not stand behind.
   */
  const safeClaim = (claim: SupportedClaim): boolean =>
    ![...critical].some((text) => claim.claim.includes(text));

  const decision = applicationDecisionSchema.parse({
    ...input.decision,
    strengths: input.decision.strengths.filter(safeClaim),
    whyApply: input.decision.whyApply.filter(safeClaim),
  });

  const coverLetter =
    input.coverLetter && input.coverLetter.brief
      ? {
          ...input.coverLetter,
          brief: {
            ...input.coverLetter.brief,
            topEvidence: input.coverLetter.brief.topEvidence.filter(safeClaim),
          },
        }
      : (input.coverLetter ?? null);

  const answers = [...(input.answers ?? [])];

  const quality = scorePackage({
    hasResume: input.resume.selected !== null,
    hasCustomization: input.customization !== null && input.customization !== undefined,
    hasCoverLetterDecision: coverLetter !== null,
    answeredQuestions: answers.filter((answer) => answer.recommendedAnswer !== null).length,
    totalQuestions: answers.length,
    claims: claims.filter(safeClaim),
    requirementsCovered: input.requirementsCovered,
    requirementsTotal: input.requirementsTotal,
    integrityPassed: integrity.passed,
    integrityFindings: integrity.findings.length,
  });

  const checklist = buildPreparationChecklist({
    resumeSelected: input.resume.selected !== null,
    customizationReviewed: false,
    coverLetterVerdict: coverLetter?.verdict ?? null,
    answers,
    portfolioRequired: (input.portfolioGaps ?? []).length > 0 || (input.portfolio ?? []).length > 0,
    portfolioSelected: (input.portfolio ?? []).length,
    urlCheck: input.applicationUrl ?? null,
    unresolvedGaps: (input.customization?.gaps ?? [])
      .filter((gap) => !gap.actionable)
      .map((gap) => gap.requirement),
  });

  const built = applicationPackageSchema.parse({
    packageId: randomUUID(),
    jobId: input.jobId,
    candidateId: input.candidateId,
    /*
     * Deep-cloned. A package holding a live reference would silently rewrite
     * the candidate's own record of what they applied to when the job changed.
     */
    jobSnapshot: structuredClone(input.jobSnapshot),
    matchSnapshot: input.matchSnapshot ? structuredClone(input.matchSnapshot) : null,
    decision,
    resume: input.resume,
    customization: input.customization ?? null,
    ats: input.ats ?? null,
    coverLetter: coverLetter ?? null,
    companyResearch: input.companyResearch ?? null,
    answers,
    salary: input.salary ?? null,
    authorization: input.authorization ?? null,
    portfolio: [...(input.portfolio ?? [])],
    portfolioGaps: [...(input.portfolioGaps ?? [])],
    certifications: [...(input.certifications ?? [])],
    checklist,
    effort: input.effort ?? null,
    applicationUrl: input.applicationUrl ?? null,
    quality,
    /* Both null. Only the interface, acting for a person, ever sets these. */
    reviewedByUserAt: null,
    submittedByUserAt: null,
  });

  return { package: built, integrity, presentable };
}
