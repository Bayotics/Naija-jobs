import {
  checklistItemSchema,
  positioningAdviceSchema,
  resumeRecommendationSchema,
  type ApplicationFriction,
  type ApplicationRecommendation,
  type AuthorizationAssessment,
  type CandidateIntelligence,
  type ChecklistItem,
  type CompensationAssessment,
  type EligibilityAssessment,
  type ParsedRequirementRecord,
  type PositioningAdvice,
  type RequirementAssessment,
  type ResumeRecommendation,
  type SeniorityAlignment,
} from '@job-intel/contracts';
import type { DocumentExtraction } from '@job-intel/candidate';

/**
 * Resume selection, positioning and the application checklist.
 *
 * Three pieces of advice, all of them guidance and none of them an edit. The
 * system will say "lead with React and TypeScript"; it will not touch the
 * document. That boundary matters because the resume is the candidate's own
 * account of their career, and a tool that rewrites it — however helpfully —
 * has started making claims on their behalf that they may not be able to back
 * up in an interview.
 *
 * The positioning advice is bounded by the same rule as everything else: it can
 * only tell someone to emphasise things their documents already evidence.
 */

const MIN_ALTERNATIVE_MARGIN = 8;

/**
 * Truncation for anything built from a posting.
 *
 * Requirement text is whatever the employer typed, and employers type
 * paragraph-long bullets. Every string assembled from it is clipped at the
 * schema's own limit rather than trusted to fit — an over-long sentence failed
 * validation on real postings and took the entire analysis for those jobs down
 * with it, which is a spectacularly bad trade for a cosmetic overflow.
 */
const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

export interface ResumeSelectionInput {
  documents: readonly DocumentExtraction[];
  requirements: readonly ParsedRequirementRecord[];
  assessments: readonly RequirementAssessment[];
  /** Slugs the posting requires, so a document can be scored against them. */
  requiredSlugs: readonly string[];
  jobTitle: string;
}

/**
 * Scores one document against one posting.
 *
 * Deliberately not the same as the candidate's fit. This asks a narrower
 * question — *does this particular document make the case?* — and a strong
 * candidate can have a document that makes it badly. Telling them which one to
 * send is often worth more than telling them to apply.
 */
function scoreDocument(
  document: DocumentExtraction,
  input: ResumeSelectionInput,
): { score: number; covered: string[]; uncovered: string[] } {
  const slugs = new Set(document.skills.map((fact) => fact.slug));

  const corpus = [
    document.summary ?? '',
    ...document.experience.map((role) =>
      [role.title, role.description ?? '', ...role.responsibilities, ...role.achievements].join(' '),
    ),
    ...document.projects.map((project) => `${project.name} ${project.description ?? ''}`),
  ]
    .join(' ')
    .toLowerCase();

  const covered: string[] = [];
  const uncovered: string[] = [];
  let earned = 0;
  let total = 0;

  const weightOf = (requirement: ParsedRequirementRecord): number =>
    requirement.importance === 'required' ? 1 : requirement.importance === 'preferred' ? 0.4 : 0.12;

  for (const requirement of input.requirements) {
    // Only requirements a resume can plausibly answer.
    if (
      requirement.type !== 'technical_skill' &&
      requirement.type !== 'soft_skill' &&
      requirement.type !== 'responsibility' &&
      requirement.type !== 'domain'
    ) {
      continue;
    }

    const weight = weightOf(requirement);
    total += weight;

    if (requirement.slug && slugs.has(requirement.slug)) {
      covered.push(requirement.text);
      earned += weight;
      continue;
    }

    const words = requirement.text
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 4);

    const hits = words.filter((word) => corpus.includes(word)).length;
    const ratio = words.length === 0 ? 0 : hits / words.length;

    if (ratio >= 0.6) {
      covered.push(requirement.text);
      // Prose mentions count less than an evidenced skill: a reader has to
      // notice it themselves, and many will not.
      earned += weight * ratio * 0.7;
    } else {
      uncovered.push(requirement.text);
    }
  }

  /*
   * A title echo is worth real points.
   *
   * The first thing a screener reads is the most recent job title, and a
   * document whose top line already says "Frontend Engineer" against a frontend
   * role has done half the work before anyone reaches the bullets.
   */
  const jobWords = new Set(
    input.jobTitle
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 3),
  );

  const titleEcho = document.experience
    .slice(0, 2)
    .some((role) =>
      role.title
        .toLowerCase()
        .split(/\W+/)
        .some((word) => word.length > 3 && jobWords.has(word)),
    );

  const base = total === 0 ? 0 : (earned / total) * 100;
  const score = Math.min(100, Math.round(base + (titleEcho ? 8 : 0)));

  return { score, covered, uncovered };
}

export function selectResume(input: ResumeSelectionInput): ResumeRecommendation {
  if (input.documents.length === 0) {
    return resumeRecommendationSchema.parse({
      recommendedDocumentId: null,
      recommendedLabel: null,
      resumeFitScore: 0,
      reason: 'You have not uploaded a resume yet, so there is nothing to recommend.',
      alternatives: [],
      emphasise: [],
      support: [],
      missingFromResume: [],
    });
  }

  const scored = input.documents
    .map((document) => ({ document, ...scoreDocument(document, input) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const runnerUp = scored[1] ?? null;

  /*
   * Whether the choice is meaningful.
   *
   * Two documents within eight points are, for this purpose, the same document.
   * Announcing a winner on a two-point margin invites the candidate to trust a
   * distinction the data does not support.
   */
  const decisive = runnerUp === null || best.score - runnerUp.score >= MIN_ALTERNATIVE_MARGIN;

  // ── What to lead with ───────────────────────────────────────────────────
  const directlyEvidenced = input.assessments
    .filter((entry) => entry.strength === 'DIRECT_MATCH' && entry.requirement.importance === 'required')
    .map((entry) => entry.requirement.text);

  const bestSlugs = new Set(best.document.skills.map((fact) => fact.slug));

  const emphasise = input.assessments
    .filter(
      (entry) =>
        entry.strength === 'DIRECT_MATCH' &&
        entry.requirement.slug !== null &&
        bestSlugs.has(entry.requirement.slug) &&
        (entry.requirement.importance === 'required' || entry.requirement.importance === 'preferred'),
    )
    .sort(
      (a, b) =>
        (a.requirement.importance === 'required' ? 0 : 1) -
        (b.requirement.importance === 'required' ? 0 : 1),
    )
    .map((entry) => entry.requirement.text.slice(0, 120))
    .slice(0, 12);

  // True, evidenced, and not what this posting is about.
  const support = best.document.skills
    .filter((fact) => !emphasise.includes(fact.name) && fact.strongestSource !== 'resume_skill_section')
    .slice(0, 8)
    .map((fact) => fact.name.slice(0, 120));

  /*
   * Requirements the profile evidences but *this document* does not mention.
   *
   * The most actionable output in the module: the candidate genuinely has the
   * experience, and the resume they are about to send leaves it out.
   */
  const missingFromResume = input.assessments
    .filter(
      (entry) =>
        entry.strength === 'DIRECT_MATCH' &&
        entry.requirement.slug !== null &&
        !bestSlugs.has(entry.requirement.slug),
    )
    .map((entry) =>
      `${entry.requirement.text.slice(0, 80)} — evidenced elsewhere in your profile but not in this resume`.slice(
        0,
        160,
      ),
    )
    .slice(0, 12);

  /*
   * When nothing scores, say so.
   *
   * The live run produced "Send your 'undated' resume (0/100)", which is worse
   * than useless — it puts the system's name behind a document that evidences
   * none of what the posting asked for. A zero is a finding about the match
   * between these documents and this job, and it should read as one.
   */
  if (best.score === 0) {
    return resumeRecommendationSchema.parse({
      recommendedDocumentId: null,
      recommendedLabel: null,
      resumeFitScore: 0,
      reason:
        'None of your documents evidence what this posting asks for, so there is no useful ' +
        'recommendation to make between them.',
      alternatives: scored.slice(0, 10).map((entry) => ({
        documentId: entry.document.documentId,
        label: clip(entry.document.label, 120),
        resumeFitScore: entry.score,
        note: 'Covers none of the stated requirements.',
      })),
      emphasise: [],
      support: [],
      missingFromResume: [],
    });
  }

  const reason = (
    decisive
      ? `"${best.document.label}" covers ${best.covered.length} of the ${best.covered.length + best.uncovered.length} requirements a resume can answer` +
        (directlyEvidenced.length > 0
          ? `, including ${directlyEvidenced.slice(0, 3).map((text) => text.slice(0, 60)).join(', ')}.`
          : '.')
      : `"${best.document.label}" scores highest, but "${runnerUp!.document.label}" is within ${best.score - runnerUp!.score} points — either would work.`
  ).slice(0, 500);

  return resumeRecommendationSchema.parse({
    recommendedDocumentId: best.document.documentId,
    recommendedLabel: best.document.label,
    resumeFitScore: best.score,
    reason,
    /*
     * Requirement text comes from the posting, and postings write bullets of
     * arbitrary length. Every string built from them is truncated here rather
     * than trusted to fit — an over-long note failed schema validation on real
     * data and took the whole analysis for that job down with it.
     */
    alternatives: scored.slice(1, 10).map((entry) => ({
      documentId: entry.document.documentId,
      label: entry.document.label.slice(0, 120),
      resumeFitScore: entry.score,
      note: (entry.uncovered.length > 0
        ? `Does not mention ${entry.uncovered.slice(0, 3).map((text) => text.slice(0, 60)).join(', ')}.`
        : 'Covers the same ground.'
      ).slice(0, 300),
    })),
    emphasise,
    support,
    missingFromResume,
  });
}

// ── Positioning (Parts 35, 36) ──────────────────────────────────────────────

export interface PositioningInput {
  profile: CandidateIntelligence | null;
  assessments: readonly RequirementAssessment[];
  resume: ResumeRecommendation;
  seniority: SeniorityAlignment;
  eligibility: EligibilityAssessment;
  jobTitle: string;
}

export function buildPositioning(input: PositioningInput): PositioningAdvice {
  const direct = input.assessments.filter(
    (entry) => entry.strength === 'DIRECT_MATCH' && entry.requirement.importance === 'required',
  );

  const partial = input.assessments.filter((entry) => entry.strength === 'PARTIAL_MATCH');
  const related = input.assessments.filter((entry) => entry.strength === 'RELATED_MATCH');
  const unknown = input.assessments.filter(
    (entry) => entry.strength === 'NO_EVIDENCE' && entry.requirement.importance === 'required',
  );

  const headline = clip(
    direct.length > 0
      ? `Lead with ${direct.slice(0, 3).map((entry) => clip(entry.requirement.text, 50)).join(' + ')}`
      : 'Lead with your strongest evidenced experience',
    200,
  );

  const keyEvidence = direct
    .slice(0, 8)
    .map((entry) => clip(`${clip(entry.requirement.text, 100)}: ${entry.explanation}`, 300));

  const supportingEvidence = input.resume.support
    .slice(0, 6)
    .map((skill) => clip(`${skill} — evidenced, and worth a line rather than a headline here`, 300));

  // ── Gaps, addressed honestly ────────────────────────────────────────────
  const addressGaps: string[] = [];

  for (const entry of partial.slice(0, 4)) {
    addressGaps.push(
      clip(
        `The posting asks for ${clip(entry.requirement.text, 120)}. You have ${entry.via[0] ?? 'related'} experience — ` +
          'name it as adjacent rather than claiming the specific tool.',
        400,
      ),
    );
  }

  for (const entry of related.slice(0, 3)) {
    addressGaps.push(
      clip(
        `${clip(entry.requirement.text, 120)} is not evidenced in your profile. Your ${entry.via[0] ?? 'nearby'} experience is the honest bridge, ` +
          'and it is worth saying explicitly that you have not used the tool itself.',
        400,
      ),
    );
  }

  for (const entry of unknown.slice(0, 3)) {
    addressGaps.push(
      clip(
        `Nothing in your documents mentions ${clip(entry.requirement.text, 120)}. If you have used it, add it — ` +
          'if not, decide whether to address the gap directly or let the rest of the application carry it.',
        400,
      ),
    );
  }

  for (const item of input.resume.missingFromResume.slice(0, 4)) {
    addressGaps.push(clip(`Consider adding to this resume: ${item}`, 400));
  }

  // ── Concerns a reader will have ─────────────────────────────────────────
  const anticipatedConcerns: string[] = [];

  if (input.seniority.fit === 'stretch' || input.seniority.fit === 'major_mismatch') {
    anticipatedConcerns.push(
      'The role is pitched above where your profile reads. Lead with scope — what you owned, not what you were assigned. ' +
        `${input.seniority.explanation}`,
    );
  } else if (input.seniority.fit === 'overqualified') {
    anticipatedConcerns.push(
      'The role sits below your evidenced level. A reader will wonder why you want it, so say so.',
    );
  }

  for (const blocker of input.eligibility.blockers.filter((entry) => !entry.acknowledged).slice(0, 3)) {
    anticipatedConcerns.push(clip(`${blocker.statement} ${blocker.detail}`, 400));
  }

  if (input.eligibility.questions.length > 0) {
    anticipatedConcerns.push(
      clip(
        `The posting asks about things your profile does not cover: ${input.eligibility.questions.slice(0, 3).join(' ')}`,
        400,
      ),
    );
  }

  return positioningAdviceSchema.parse({
    headlineEmphasis: headline,
    keyEvidence,
    supportingEvidence,
    addressGaps: addressGaps.slice(0, 8),
    anticipatedConcerns: anticipatedConcerns.slice(0, 8),
  });
}

// ── Checklist (Part 38) ─────────────────────────────────────────────────────

export interface ChecklistInput {
  recommendation: ApplicationRecommendation;
  resume: ResumeRecommendation;
  friction: ApplicationFriction;
  authorization: AuthorizationAssessment;
  compensation: CompensationAssessment;
  eligibility: EligibilityAssessment;
  hasPortfolio: boolean;
}

/**
 * The checklist for an application the candidate has decided to make.
 *
 * Generated only for recommendations worth acting on: producing a to-do list
 * for a job the system just advised skipping is noise, and noise is what stops
 * people reading the ones that matter.
 */
export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  if (
    input.recommendation === 'SKIP' ||
    input.recommendation === 'BLOCKED' ||
    input.recommendation === 'UNKNOWN'
  ) {
    return [];
  }

  const items: ChecklistItem[] = [];

  const add = (id: string, label: string, detail: string, required: boolean): void => {
    const parsed = checklistItemSchema.safeParse({
      id: clip(id, 80),
      label: clip(label, 300),
      detail: clip(detail, 400),
      required,
      done: false,
    });
    if (parsed.success) items.push(parsed.data);
  };

  if (input.resume.recommendedLabel) {
    add(
      'resume',
      `Use your "${input.resume.recommendedLabel}" resume`,
      input.resume.reason,
      true,
    );
  } else {
    add('resume', 'Upload a resume', 'You have no documents on file yet.', true);
  }

  if (input.resume.missingFromResume.length > 0) {
    add(
      'resume-gaps',
      'Add missing experience to that resume',
      input.resume.missingFromResume.slice(0, 3).join('; '),
      false,
    );
  }

  for (const question of input.eligibility.questions.slice(0, 4)) {
    add(`question-${question.slice(0, 20)}`, question, 'The posting asks; your profile does not say.', true);
  }

  if (input.authorization.authorizationRequired === 'yes') {
    add(
      'work-authorization',
      'Confirm your work authorisation for this location',
      input.authorization.explanation,
      true,
    );
  }

  if (input.friction.coverLetterRequired) {
    add('cover-letter', 'Write a cover letter', 'This posting requires one.', true);
  } else if (input.friction.coverLetterOptional) {
    add('cover-letter', 'Consider a short cover letter', 'Optional here, and it usually helps.', false);
  }

  if (input.friction.portfolioRequired) {
    add(
      'portfolio',
      'Prepare your portfolio link',
      input.hasPortfolio
        ? 'You have a linked public profile you can point to.'
        : 'The posting asks for work samples and you have none linked.',
      true,
    );
  }

  if (input.friction.assessmentRequired) {
    add(
      'assessment',
      'Set aside time for the assessment',
      'This process includes a take-home or coding test.',
      false,
    );
  }

  if (input.compensation.verdict === 'unknown') {
    add(
      'salary',
      'Decide what to say about salary',
      'The posting does not state a range, so you may be asked first.',
      false,
    );
  } else if (input.compensation.verdict === 'below_preference') {
    add(
      'salary',
      'Decide whether the pay works for you',
      input.compensation.explanation,
      false,
    );
  }

  add(
    'review',
    'Read the posting once more before submitting',
    'The system read the structured fields; you should read the prose.',
    false,
  );

  return items.slice(0, 20);
}
