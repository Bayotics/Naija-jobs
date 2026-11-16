import {
  gapSeverity,
  requirementCoverageSchema,
  skillGapSchema,
  type Learnability,
  type RequirementCoverage,
  type SkillGap,
  type SkillProximity,
} from '@job-intel/contracts';

/**
 * What the candidate is missing, and whether it matters.
 *
 * A list of missing keywords is not gap analysis. The useful questions are:
 * did the posting call this required or nice-to-have, does the candidate have
 * anything adjacent, and — the one people actually want answered — is this
 * closeable before the application closes?
 *
 * The last question is where honesty costs something. It would be pleasant to
 * tell everyone their gaps are learnable, and it would be a lie: "eight years
 * of experience" and "must already hold a work permit" cannot be studied for,
 * and suggesting a weekend course for them wastes the candidate's time on the
 * one thing that will definitely not work.
 */

/**
 * How long a skill takes to become *credible*, not to have heard of.
 *
 * The distinction matters because the audience is a hiring screen. A weekend
 * with GraphQL will let you discuss it; it will not survive "tell me about a
 * schema you designed". These estimates are for the second bar.
 */
const LEARNABILITY_BY_KIND: ReadonlyArray<{
  pattern: RegExp;
  learnability: Learnability;
  note: string;
}> = [
  {
    /*
     * Not skills at all. Nothing about these responds to study, and saying so
     * is more useful than encouragement.
     */
    pattern: /\b(?:\d+\+?\s*years?|years? of experience|degree|bachelor|master|phd|citizen|work permit|visa|clearance|native speaker)\b/i,
    learnability: 'NOT_LEARNABLE',
    note: 'This is a credential or an amount of time, not a skill. It cannot be closed before applying.',
  },
  {
    pattern: /\b(?:leadership|manage(?:ment|d)?|mentor(?:ing|ship)?|stakeholder|strategy|hiring|budget)\b/i,
    learnability: 'SUBSTANTIAL',
    note: 'This is built through role experience rather than study.',
  },
  {
    /* Infrastructure and distributed systems: real depth, months not days. */
    pattern: /\b(?:kubernetes|k8s|terraform|kafka|spark|hadoop|machine learning|kernel|embedded|solidity)\b/i,
    learnability: 'SUBSTANTIAL',
    note: 'Learnable, but months of real use before it is credible in an interview.',
  },
  {
    pattern: /\b(?:aws|azure|gcp|docker|ci\/cd|postgres|mongodb|redis|elasticsearch|rust|go(?:lang)?|scala)\b/i,
    learnability: 'MODERATE',
    note: 'Learnable in weeks with focused practice; a small project would evidence it.',
  },
  {
    /* Libraries adjacent to what most candidates already do. */
    pattern: /\b(?:graphql|jest|cypress|tailwind|redux|zustand|vite|webpack|storybook|prisma|trpc)\b/i,
    learnability: 'QUICK',
    note: 'A focused weekend and a small project would usually be enough to speak to it.',
  },
];

function learnabilityOf(skill: string, requirementText: string | null): {
  learnability: Learnability;
  note: string;
} {
  const haystack = `${skill} ${requirementText ?? ''}`;

  for (const entry of LEARNABILITY_BY_KIND) {
    if (entry.pattern.test(haystack)) {
      return { learnability: entry.learnability, note: entry.note };
    }
  }

  return {
    learnability: 'UNKNOWN',
    note: 'How quickly this could be picked up is not something the system can judge.',
  };
}

export interface GapInput {
  skill: string;
  importance: SkillGap['importance'];
  requirementText?: string | null;
  /** The closest thing the candidate has, if anything. */
  closest?: { skill: string; proximity: SkillProximity; evidence: string } | null;
}

/**
 * Turns one unmet requirement into an explained gap.
 *
 * The recommendation is assembled from severity *and* learnability together,
 * because they pull in different directions: a critical gap that is quick to
 * close is a reason to spend the weekend on it, and a minor gap that is not
 * learnable is a reason to stop thinking about it.
 */
export function analyseGap(input: GapInput): SkillGap {
  const proximity = input.closest?.proximity ?? 'UNRELATED';
  const severity = gapSeverity(input.importance, proximity);
  const { learnability, note } = learnabilityOf(input.skill, input.requirementText ?? null);

  let recommendation: string;

  if (learnability === 'NOT_LEARNABLE') {
    recommendation =
      severity === 'CRITICAL'
        ? `${note} If this is a strict screen, this role is likely out of reach for now.`
        : note;
  } else if (input.closest && (proximity === 'CLOSE' || proximity === 'TRANSFERABLE')) {
    /*
     * The most useful advice in the whole module. A candidate with adjacent
     * experience usually has a real argument to make and does not know it —
     * naming the adjacency turns "I don't have that" into a sentence they can
     * put in a cover letter.
     */
    recommendation =
      `Your ${input.closest.skill} experience is genuinely adjacent — lead with it rather than treating this as a blank. ` +
      note;
  } else if (severity === 'CRITICAL') {
    recommendation = `Named as required and you have nothing adjacent. ${note}`;
  } else {
    recommendation = note;
  }

  return skillGapSchema.parse({
    skill: input.skill,
    importance: input.importance,
    requirementText: input.requirementText ?? null,
    candidateEvidence: input.closest?.evidence ?? null,
    closestRelation: proximity,
    severity,
    learnability,
    recommendation,
  });
}

/**
 * Orders gaps by what to do about them first.
 *
 * Critical before moderate, and within a severity the *closeable* ones first —
 * someone deciding whether to apply wants to know what they could fix, not to
 * read the immovable items twice.
 */
const SEVERITY_ORDER = { CRITICAL: 0, MODERATE: 1, MINOR: 2 } as const;
const LEARNABILITY_ORDER = {
  QUICK: 0,
  MODERATE: 1,
  SUBSTANTIAL: 2,
  UNKNOWN: 3,
  NOT_LEARNABLE: 4,
} as const;

export function rankGaps(gaps: readonly SkillGap[]): SkillGap[] {
  return [...gaps].sort((a, b) => {
    const severity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severity !== 0) return severity;
    return LEARNABILITY_ORDER[a.learnability] - LEARNABILITY_ORDER[b.learnability];
  });
}

export interface CoverageInput {
  requirements: ReadonlyArray<{
    importance: SkillGap['importance'];
    covered: boolean;
    confidence: number;
  }>;
  /** Extraction confidence below which a requirement is not counted as hard. */
  minConfidence?: number;
}

/**
 * Requirement coverage as fractions.
 *
 * "8 of 9 required, 5 of 7 preferred" tells a candidate what a single number
 * cannot. The `minConfidence` gate is the important detail: a requirement the
 * extractor was unsure about must not be counted as a hard miss, because the
 * sentence it came from may not have been a requirement at all.
 */
export function computeCoverage(input: CoverageInput): RequirementCoverage {
  const minConfidence = input.minConfidence ?? 0.5;

  let requiredTotal = 0;
  let requiredCovered = 0;
  let preferredTotal = 0;
  let preferredCovered = 0;
  let optionalTotal = 0;
  let optionalCovered = 0;
  let lowConfidenceCount = 0;

  for (const requirement of input.requirements) {
    const lowConfidence = requirement.confidence < minConfidence;
    if (lowConfidence) lowConfidenceCount += 1;

    /*
     * A low-confidence "required" is counted as preferred rather than dropped.
     * Dropping it would hide a real signal; counting it as hard would let a
     * misread sentence block a good job.
     */
    const importance =
      requirement.importance === 'required' && lowConfidence ? 'preferred' : requirement.importance;

    switch (importance) {
      case 'required':
        requiredTotal += 1;
        if (requirement.covered) requiredCovered += 1;
        break;
      case 'preferred':
        preferredTotal += 1;
        if (requirement.covered) preferredCovered += 1;
        break;
      default:
        optionalTotal += 1;
        if (requirement.covered) optionalCovered += 1;
    }
  }

  return requirementCoverageSchema.parse({
    requiredTotal,
    requiredCovered,
    preferredTotal,
    preferredCovered,
    optionalTotal,
    optionalCovered,
    lowConfidenceCount,
  });
}

/** A one-line summary of coverage, for the interface. */
export function describeCoverage(coverage: RequirementCoverage): string {
  const parts: string[] = [];

  if (coverage.requiredTotal > 0) {
    parts.push(`${coverage.requiredCovered}/${coverage.requiredTotal} required`);
  }

  if (coverage.preferredTotal > 0) {
    parts.push(`${coverage.preferredCovered}/${coverage.preferredTotal} preferred`);
  }

  if (parts.length === 0) return 'No requirements could be extracted from this posting.';

  return `${parts.join(', ')} met.`;
}
