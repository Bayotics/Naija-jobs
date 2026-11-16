import {
  TRAJECTORY_SCORE,
  seniorityRank,
  trajectoryAssessmentSchema,
  type TrajectoryAssessment,
  type TrajectoryVerdict,
} from '@job-intel/contracts';

/**
 * Whether a job makes sense as the candidate's next move.
 *
 * The signal is deliberately weak. Its whole range sits between 30 and 92, and
 * a system that scored career fit harshly would spend its life arguing with
 * someone who has decided to change direction — which is a thing people do on
 * purpose, and not the system's business to discourage.
 *
 * It earns its place by catching one specific failure: a frontend engineer
 * being shown an accounting role because both descriptions contain "stakeholder
 * management" and "Excel". That is not a career pivot, it is a matching bug,
 * and `UNRELATED` is how the engine says so.
 *
 * Two inputs, both computed rather than asked of a model: the seniority step
 * and the domain overlap. Neither needs reasoning, and using a model for
 * arithmetic this simple would be slower, costlier and less predictable.
 */

export interface TrajectoryInput {
  /** Titles the candidate has actually held, most recent first. */
  candidateTitles: readonly string[];
  candidateSeniority: string | null;
  /** Canonical skill slugs the candidate can demonstrate. */
  candidateDomains: readonly string[];

  jobTitle: string;
  jobSeniority: string | null;
  /** Canonical skill slugs the job asks for. */
  jobDomains: readonly string[];
}

/** Tokens that carry no domain meaning and would inflate every overlap. */
const STOPWORDS = new Set([
  'senior',
  'junior',
  'lead',
  'staff',
  'principal',
  'engineer',
  'developer',
  'specialist',
  'manager',
  'analyst',
  'consultant',
  'i',
  'ii',
  'iii',
  'the',
  'of',
  'and',
  'a',
  'an',
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
  );
}

/**
 * Overlap between what the candidate has done and what the job is about.
 *
 * Jaccard over the *job's* terms rather than the union, because the question is
 * "how much of this job does the candidate's background cover", not "how
 * similar are these two sets". A candidate with a very broad history should not
 * be penalised for knowing things this particular job does not need.
 */
function domainOverlap(
  candidate: readonly string[],
  job: readonly string[],
): number | null {
  if (job.length === 0) return null;

  const candidateSet = new Set(candidate.map((entry) => entry.toLowerCase()));
  const matched = job.filter((entry) => candidateSet.has(entry.toLowerCase())).length;

  return matched / job.length;
}

/** Title-level overlap, used when neither side lists skills. */
function titleOverlap(candidateTitles: readonly string[], jobTitle: string): number | null {
  if (candidateTitles.length === 0) return null;

  const jobTokens = tokens(jobTitle);
  if (jobTokens.size === 0) return null;

  let best = 0;

  for (const title of candidateTitles) {
    const candidateTokens = tokens(title);
    if (candidateTokens.size === 0) continue;

    const shared = [...jobTokens].filter((token) => candidateTokens.has(token)).length;
    best = Math.max(best, shared / jobTokens.size);
  }

  return best;
}

/**
 * Classifies the move.
 *
 * The order of the checks is the policy. Domain relatedness is decided *first*,
 * because an unrelated field is unrelated whether the title says senior or
 * junior — asking "is this a promotion?" about an accounting role offered to a
 * frontend engineer is answering the wrong question.
 */
export function assessTrajectory(input: TrajectoryInput): TrajectoryAssessment {
  const skillOverlap = domainOverlap(input.candidateDomains, input.jobDomains);
  const nameOverlap = titleOverlap(input.candidateTitles, input.jobTitle);

  /*
   * Skills first, titles as a fallback. Titles are noisy — "Engineer" appears
   * in half the postings on earth — so they only decide when there is nothing
   * better.
   */
  const overlap = skillOverlap ?? nameOverlap;

  const candidateRank = seniorityRank(input.candidateSeniority);
  const jobRank = seniorityRank(input.jobSeniority);
  const delta = candidateRank !== null && jobRank !== null ? jobRank - candidateRank : null;

  if (overlap === null) {
    return trajectoryAssessmentSchema.parse({
      verdict: 'UNKNOWN',
      score: TRAJECTORY_SCORE.UNKNOWN,
      seniorityDelta: delta,
      domainOverlap: null,
      explanation: 'Not enough history to judge whether this fits your trajectory.',
      confidence: 0.2,
    });
  }

  /*
   * The floor for "this is a different field entirely". Set low because the
   * check must not fire on a legitimate adjacent move — a frontend engineer
   * taking a full-stack role shares plenty, and only a genuinely foreign
   * posting falls below this.
   */
  if (overlap < 0.12) {
    return trajectoryAssessmentSchema.parse({
      verdict: 'UNRELATED',
      score: TRAJECTORY_SCORE.UNRELATED,
      seniorityDelta: delta,
      domainOverlap: Number(overlap.toFixed(3)),
      explanation:
        'This role has almost nothing in common with your background. Generic overlap in a description is not the same as relevant experience.',
      confidence: 0.7,
    });
  }

  if (overlap < 0.35) {
    return trajectoryAssessmentSchema.parse({
      verdict: 'PIVOT',
      score: TRAJECTORY_SCORE.PIVOT,
      seniorityDelta: delta,
      domainOverlap: Number(overlap.toFixed(3)),
      explanation:
        'This is a change of direction rather than a continuation. That may be exactly what you want, but expect to argue for the transferable parts.',
      confidence: 0.55,
    });
  }

  let verdict: TrajectoryVerdict;
  let explanation: string;

  if (delta === null) {
    verdict = 'LATERAL_MOVE';
    explanation = 'The role is in your field. Its seniority is not stated, so the step is unclear.';
  } else if (delta === 0) {
    verdict = 'LATERAL_MOVE';
    explanation = 'A move at the same level, in a field you already work in.';
  } else if (delta === 1) {
    verdict = 'NATURAL_PROGRESSION';
    explanation = 'One step up from where you are, in your own field — the usual next move.';
  } else if (delta >= 2) {
    verdict = 'STRETCH';
    explanation = `This is ${delta} levels above your current seniority. Worth attempting if the evidence is strong, but expect scrutiny.`;
  } else {
    /*
     * A step down is not scored as a failure. People take them deliberately —
     * to change domain, to leave management, to join a company they want. The
     * score reflects that it is unusual, not that it is wrong.
     */
    verdict = 'STEP_BACK';
    explanation = `This sits ${Math.abs(delta)} level(s) below your current seniority. Sometimes deliberate; worth checking it is what you intended.`;
  }

  return trajectoryAssessmentSchema.parse({
    verdict,
    score: TRAJECTORY_SCORE[verdict],
    seniorityDelta: delta,
    domainOverlap: Number(overlap.toFixed(3)),
    explanation,
    confidence: skillOverlap !== null ? 0.75 : 0.45,
  });
}
