import {
  experienceAlignmentSchema,
  seniorityAlignmentSchema,
  dimensionScoreSchema,
  type CandidateIntelligence,
  type DimensionScore,
  type ExperienceAlignment,
  type ParsedRequirementRecord,
  type SeniorityAlignment,
  type SeniorityFit,
  type SeniorityLevel,
} from '@job-intel/contracts';

/**
 * Experience, seniority and career direction.
 *
 * The mistake this module exists to avoid is stated plainly in the brief: a
 * candidate with six years of software development and two years of React does
 * not meet a four-year React requirement. Total tenure and relevant tenure are
 * different quantities, and a scorer that quietly substitutes one for the other
 * produces confident recommendations that end at the first screening question.
 *
 * So four numbers are computed and kept apart:
 *
 *   total        — non-overlapping professional months, all of it
 *   relevant     — months in roles that touched this job's technologies
 *   coreSkill    — months of the specific skill the posting leans on hardest
 *   recent       — of that, how much falls in the last five years
 *
 * The flag `totalMeetsButRelevantDoesNot` marks the exact case above, and the
 * explanation says so in words rather than burying it in a score.
 */

/** Management levels mapped onto the IC ladder purely for distance. */
const LEVEL_POSITION: Readonly<Record<SeniorityLevel, number>> = {
  intern: 0,
  entry: 1,
  junior: 2,
  mid: 3,
  senior: 4,
  staff: 5,
  principal: 6,
  // A different track, not simply "more senior". Positioned where the scope
  // usually sits so distance is meaningful, never so one implies the other.
  lead: 4.5,
  manager: 5,
  director: 6,
  executive: 7,
};

const RECENT_YEARS_WINDOW = 5;

export interface ExperienceInput {
  profile: CandidateIntelligence;
  requirements: readonly ParsedRequirementRecord[];
  /** Canonical slugs the posting asks for, strongest first. */
  requiredSlugs: readonly string[];
  now: Date;
}

/**
 * A representative required skill, for the explanation.
 *
 * Reported, never decisive. Nothing here can reliably tell which of a posting's
 * required skills matters most — postings do not order them by importance, and
 * extraction confidence measures how sure the parser is that it read a line
 * correctly, which is a different thing entirely. An earlier version used
 * confidence as a stand-in for importance and judged "4+ years of platform
 * engineering" against one year of Terraform while ignoring three years of AWS.
 *
 * So the pass/fail measure is `relevantYears`, and this exists to let the
 * explanation name a specific skill when the shortfall is worth spelling out.
 * The first required skill wins, which at least follows the posting's own
 * order.
 */
function coreSkillOf(requirements: readonly ParsedRequirementRecord[]): ParsedRequirementRecord | null {
  return (
    requirements.find(
      (requirement) =>
        requirement.type === 'technical_skill' &&
        requirement.importance === 'required' &&
        requirement.slug !== null,
    ) ?? null
  );
}

export function analyseExperience(input: ExperienceInput): ExperienceAlignment {
  const { profile, now } = input;

  const totalMonths = profile.trajectory.totalExperienceMonths;
  const totalYears = totalMonths === null ? null : totalMonths / 12;

  const required = input.requirements
    .filter((requirement) => requirement.type === 'experience_years' && requirement.minYears !== null)
    .reduce<number | null>(
      (max, requirement) => (max === null ? requirement.minYears! : Math.max(max, requirement.minYears!)),
      null,
    );

  const wanted = new Set(input.requiredSlugs);

  /*
   * Relevant months, counted once.
   *
   * Roles overlap, and a candidate with two concurrent jobs that both used
   * React has one stretch of React-relevant time, not two. The spans are merged
   * before they are summed, for the same reason the skill layer merges them.
   */
  interface Span {
    start: number;
    end: number;
  }

  const spans: Span[] = [];
  let estimated = false;

  for (const role of profile.experience) {
    if (!role.technologies.some((slug) => wanted.has(slug))) continue;
    if (role.dates.start.year === null) continue;

    const start = role.dates.start.year * 12 + ((role.dates.start.month ?? 6) - 1);
    const endYear = role.dates.isCurrent ? now.getUTCFullYear() : role.dates.end.year;
    if (endYear === null) continue;

    const endMonth = role.dates.isCurrent ? now.getUTCMonth() : (role.dates.end.month ?? 6) - 1;
    const end = endYear * 12 + endMonth;
    if (end < start) continue;

    if (role.dates.durationIsEstimate) estimated = true;
    spans.push({ start, end });
  }

  spans.sort((a, b) => a.start - b.start);
  const merged: Span[] = spans.length > 0 ? [spans[0]!] : [];

  for (const span of spans.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  const relevantMonths = merged.reduce((sum, span) => sum + (span.end - span.start), 0);

  /*
   * Zero relevant years is a finding, not a missing value.
   *
   * The distinction decides whether a fallback to *total* experience is
   * legitimate. When the posting names no skills there is nothing to be
   * relevant to, and total experience is the only sensible measure — that is a
   * genuine null. But when the posting names its stack and not one of the
   * candidate's roles touched any of it, the answer is zero, and reporting null
   * lets total experience stand in for relevant experience. That is exactly the
   * substitution this module exists to prevent: nine years of frontend work
   * would otherwise satisfy "6+ years of embedded C++".
   */
  const relevantYears = wanted.size === 0 ? null : relevantMonths / 12;

  // ── The core skill ──────────────────────────────────────────────────────
  const core = coreSkillOf(input.requirements);
  const coreFact = core?.slug ? profile.skills.find((fact) => fact.slug === core.slug) : undefined;

  const coreSkillYears =
    coreFact?.totalMonths === null || coreFact?.totalMonths === undefined
      ? null
      : coreFact.totalMonths / 12;

  if (coreFact?.monthsIsEstimate) estimated = true;

  /*
   * Recent years of the core skill.
   *
   * Bounded by the observation window rather than reported as the full
   * duration: five years of React ending in 2016 is five years of React and
   * zero recent years, and the second number is what a hiring manager is
   * actually asking about.
   */
  let recentYears: number | null = null;

  if (coreFact && coreFact.lastEvidencedAt && coreFact.totalMonths !== null) {
    const monthsSince =
      (now.getTime() - coreFact.lastEvidencedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    const windowMonths = RECENT_YEARS_WINDOW * 12;
    const overlap = Math.max(0, Math.min(coreFact.totalMonths, windowMonths - monthsSince));
    recentYears = overlap / 12;
  }

  // ── The flag that matters ───────────────────────────────────────────────
  const totalMeetsButRelevantDoesNot =
    required !== null &&
    totalYears !== null &&
    totalYears >= required &&
    // Either measure falling short is the same failure: overall tenure clears
    // the bar and the experience the posting actually asked about does not.
    ((relevantYears !== null && relevantYears < required) ||
      (coreSkillYears !== null && coreSkillYears < required));

  const parts: string[] = [];

  if (totalYears !== null) {
    parts.push(`About ${totalYears.toFixed(1)} years of recorded experience overall`);
  } else {
    parts.push('No datable employment history, so total experience is unknown');
  }

  if (core && coreSkillYears !== null) {
    parts.push(`about ${coreSkillYears.toFixed(1)} years of ${core.text}`);
  } else if (relevantYears !== null) {
    parts.push(`about ${relevantYears.toFixed(1)} years in roles using this job's technologies`);
  }

  if (required !== null) parts.push(`against ${required} required`);

  if (totalMeetsButRelevantDoesNot) {
    parts.push(
      `— your overall experience clears the bar but your ${core?.text ?? 'relevant'} experience does not, ` +
        'which is what a screener will look at',
    );
  }

  if (recentYears !== null && coreSkillYears !== null && recentYears < coreSkillYears * 0.5) {
    parts.push('and most of it is not recent');
  }

  return experienceAlignmentSchema.parse({
    totalYears,
    relevantYears,
    coreSkillYears,
    coreSkillSlug: core?.slug ?? null,
    recentYears,
    requiredYears: required,
    totalMeetsButRelevantDoesNot,
    isEstimate: estimated,
    explanation: `${parts.join(', ')}.`,
  });
}

/** Turns the analysis into a scored dimension. */
export function scoreExperience(alignment: ExperienceAlignment): DimensionScore {
  const build = (
    score: number,
    confidence: number,
    explanation: string,
    applicable = true,
    inapplicableReason: string | null = null,
  ): DimensionScore =>
    dimensionScoreSchema.parse({
      dimension: 'experienceAlignment',
      score: Math.max(0, Math.min(100, Math.round(score))),
      confidence,
      applicable,
      inapplicableReason,
      explanation,
      evidence: [],
    });

  if (alignment.requiredYears === null) {
    // A posting that states no years requirement is not scored on years. It is
    // silent, and silence is not a pass or a fail.
    return build(
      60,
      0.3,
      'This posting does not state a years requirement.',
      false,
      'The posting states no experience requirement.',
    );
  }

  // The span of relevant work, for the same reason eligibility uses it.
  const measured = alignment.relevantYears ?? alignment.totalYears ?? null;

  if (measured === null) {
    return build(
      0,
      0.15,
      'No datable experience was found, so this could not be checked.',
      true,
      null,
    );
  }

  const ratio = measured / Math.max(0.5, alignment.requiredYears);

  // Curved rather than linear: the difference between 90% and 100% of a stated
  // requirement barely matters, while the difference between 40% and 60% does.
  const score =
    ratio >= 1 ? 100 : ratio >= 0.75 ? 78 + (ratio - 0.75) * 88 : ratio >= 0.5 ? 50 + (ratio - 0.5) * 112 : ratio * 100;

  let confidence = 0.7;
  if (alignment.isEstimate) confidence -= 0.15;
  if (alignment.coreSkillYears === null) confidence -= 0.1;

  return build(score, Math.max(0.15, confidence), alignment.explanation);
}

// ── Seniority (Part 11) ─────────────────────────────────────────────────────

export function analyseSeniority(input: {
  profile: CandidateIntelligence;
  jobLevel: SeniorityLevel | null;
  jobLevelConfidence: number;
}): SeniorityAlignment {
  const candidateLevel = input.profile.seniority.estimatedLevel;
  const jobLevel = input.jobLevel;

  if (!candidateLevel || !jobLevel) {
    return seniorityAlignmentSchema.parse({
      candidateLevel,
      jobLevel,
      levelGap: null,
      fit: 'unknown',
      explanation: !jobLevel
        ? 'The posting does not state a seniority level.'
        : 'Your profile does not establish a seniority level yet.',
      confidence: 0,
    });
  }

  const gap = LEVEL_POSITION[jobLevel] - LEVEL_POSITION[candidateLevel];

  let fit: SeniorityFit;
  let explanation: string;

  if (Math.abs(gap) <= 0.5) {
    fit = 'strong_alignment';
    explanation = `The role is pitched at ${jobLevel} and your profile reads as ${candidateLevel}.`;
  } else if (gap > 0 && gap <= 1) {
    fit = 'stretch';
    explanation =
      `The role is pitched a level above where your profile currently reads (${candidateLevel} → ${jobLevel}). ` +
      'That is a stretch, not a disqualification — it is how most people move up.';
  } else if (gap > 1) {
    fit = 'major_mismatch';
    explanation =
      `The role is pitched at ${jobLevel}, well above the ${candidateLevel} your profile evidences. ` +
      'Worth applying only if you have experience the documents do not show.';
  } else if (gap >= -2.5) {
    fit = 'overqualified';
    explanation =
      `The role is pitched at ${jobLevel}, below the ${candidateLevel} your profile evidences. ` +
      'Some people want exactly this; others find it a step back.';
  } else {
    fit = 'major_mismatch';
    explanation =
      `The role is pitched at ${jobLevel}, far below the ${candidateLevel} your profile evidences.`;
  }

  return seniorityAlignmentSchema.parse({
    candidateLevel,
    jobLevel,
    levelGap: Math.round(gap),
    fit,
    explanation,
    confidence:
      Math.round(Math.min(input.profile.seniority.confidence, input.jobLevelConfidence) * 100) / 100,
  });
}

/**
 * Career alignment (Part 12).
 *
 * Asks whether this job continues the direction the candidate is already
 * travelling, using the trajectory model from prompt 12. A frontend engineer
 * moving frontend → full-stack → platform has a stronger claim on a *frontend
 * platform* role than on a generic frontend one, and neither the skill overlap
 * nor the seniority comparison notices that.
 */
export function scoreCareerAlignment(input: {
  profile: CandidateIntelligence;
  jobTitle: string;
  jobSlugs: readonly string[];
  seniority: SeniorityAlignment;
}): DimensionScore {
  const { profile } = input;

  const signals: string[] = [];
  let score = 50;
  let confidence = 0.3;

  // ── Direction of travel ───────────────────────────────────────────────
  const rising = profile.trajectory.dimensions.filter(
    (entry) => entry.direction > 0.25 && entry.confidence >= 0.35,
  );

  if (rising.length > 0) {
    confidence += 0.15;
    signals.push(`Your trajectory shows growth in ${rising.map((e) => e.dimension.replace(/_/g, ' ')).join(', ')}.`);
  }

  /*
   * Continuity with the most recent role.
   *
   * Weighted toward what the candidate is doing *now* rather than the whole
   * history: someone two years into a platform role is a platform engineer,
   * whatever the previous six years said.
   */
  const recent = [...profile.experience]
    .sort((a, b) => (b.dates.start.year ?? 0) - (a.dates.start.year ?? 0))
    .slice(0, 2);

  const recentSlugs = new Set(recent.flatMap((role) => role.technologies));
  const overlap = input.jobSlugs.filter((slug) => recentSlugs.has(slug));

  if (input.jobSlugs.length > 0) {
    const ratio = overlap.length / input.jobSlugs.length;
    score = 30 + ratio * 55;
    confidence += 0.25;

    signals.push(
      overlap.length > 0
        ? `${overlap.length} of this job's ${input.jobSlugs.length} technologies appear in your most recent roles.`
        : "None of this job's technologies appear in your most recent roles.",
    );
  }

  // ── Title continuity ──────────────────────────────────────────────────
  const jobWords = new Set(
    input.jobTitle
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 3),
  );

  const titleOverlap = recent.some((role) =>
    role.title
      .toLowerCase()
      .split(/\W+/)
      .some((word) => word.length > 3 && jobWords.has(word)),
  );

  if (titleOverlap) {
    score += 10;
    confidence += 0.1;
    signals.push('The job title echoes a role you have held.');
  }

  // ── Direction of the move ─────────────────────────────────────────────
  if (input.seniority.fit === 'stretch') {
    // A stretch upward is what a rising trajectory is for.
    score += rising.length > 0 ? 8 : 0;
    signals.push('It is a step up from where your profile currently reads.');
  } else if (input.seniority.fit === 'overqualified') {
    score -= 12;
    signals.push('It sits below your evidenced level, which is a sideways or backward move.');
  }

  return dimensionScoreSchema.parse({
    dimension: 'careerAlignment',
    score: Math.max(0, Math.min(100, Math.round(score))),
    confidence: Math.min(0.75, confidence),
    applicable: true,
    inapplicableReason: null,
    explanation: signals.join(' ') || 'Not enough career history to judge direction.',
    evidence: profile.trajectory.dimensions.slice(0, 4).map((entry) => entry.detail),
  });
}
