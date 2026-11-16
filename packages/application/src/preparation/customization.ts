import {
  customizationPlanSchema,
  type BulletRecommendation,
  type CustomizationPlan,
  type EvidenceRef,
  type KeywordCoverage,
  type ResumeGap,
  type SupportedClaim,
} from '@job-intel/contracts';

/**
 * What to change about a resume for one job.
 *
 * A plan, not a rewrite. Regenerating the whole document per application is the
 * obvious approach and the wrong one: it destroys the candidate's voice, it
 * makes every version different for reasons nobody can reconstruct, and it puts
 * a model in a position to restate the candidate's history — which is precisely
 * where fabrication enters.
 *
 * So this produces instructions a person can accept or reject one at a time.
 * The most valuable output is not a rewritten bullet; it is the distinction
 * between *you have this and the resume does not say so* and *you do not have
 * this*. The first has a safe fix. The second has none, and pretending
 * otherwise is the failure this whole layer exists to prevent.
 */

export interface CustomizationInput {
  documentId: string;
  jobId: string;

  /** Requirements the posting states, with how it framed them. */
  requirements: ReadonlyArray<{
    text: string;
    slug: string | null;
    importance: ResumeGap['importance'];
    confidence: number;
  }>;

  /** What the candidate can evidence, keyed by canonical slug. */
  candidateEvidence: ReadonlyArray<{
    slug: string;
    label: string;
    refs: readonly EvidenceRef[];
    /** Whether professional, project, or merely listed. */
    strength: 'professional' | 'project' | 'listed';
  }>;

  /** The resume's current content, section by section. */
  resumeSections: ReadonlyArray<{
    heading: string;
    bullets: readonly string[];
  }>;

  /** Skills the resume currently names, as slugs. */
  resumeSkills: readonly string[];
}

/** Words that mean the same thing in a posting and on a resume. */
const EQUIVALENCES: ReadonlyArray<{ term: RegExp; equivalents: RegExp[] }> = [
  {
    term: /\bci\/?cd\b/i,
    equivalents: [/automated (?:deployment|build|release)/i, /continuous (?:integration|delivery)/i],
  },
  {
    term: /\bunit test(?:ing)?\b/i,
    equivalents: [/\bjest\b/i, /\bvitest\b/i, /\btest coverage\b/i, /\bwrote tests\b/i],
  },
  {
    term: /\bfrontend architecture\b/i,
    equivalents: [/component (?:library|architecture|system)/i, /design system/i, /\bmonorepo\b/i],
  },
  {
    term: /\bmentor(?:ing|ship)?\b/i,
    equivalents: [/onboard(?:ed|ing)/i, /code review/i, /\bcoached\b/i],
  },
  {
    term: /\bagile\b/i,
    equivalents: [/\bscrum\b/i, /\bsprint/i, /\bkanban\b/i],
  },
];

/**
 * Whether the resume already says this, in different words.
 *
 * The check that stops this tool from telling someone to add "CI/CD" to a
 * resume that already says "automated deployment pipelines" — which is the
 * better phrase, and which they earned. Reporting it as missing would push them
 * toward jargon and away from accuracy.
 */
function findEquivalent(term: string, resumeText: string): string | null {
  for (const entry of EQUIVALENCES) {
    if (!entry.term.test(term)) continue;

    for (const equivalent of entry.equivalents) {
      const match = equivalent.exec(resumeText);
      if (match) return match[0];
    }
  }

  return null;
}

/**
 * Classifies one unmet requirement.
 *
 * The order of the branches is the whole argument. Evidence is checked before
 * the resume text, because a candidate who has the experience has a completely
 * different problem from one who does not — and only the first can be fixed by
 * editing a document.
 */
function classifyGap(
  requirement: CustomizationInput['requirements'][number],
  input: CustomizationInput,
  resumeText: string,
): ResumeGap {
  const evidence = requirement.slug
    ? input.candidateEvidence.find((entry) => entry.slug === requirement.slug)
    : undefined;

  const equivalent = findEquivalent(requirement.text, resumeText);

  if (equivalent) {
    return {
      requirement: requirement.text,
      importance: requirement.importance,
      kind: 'TERMINOLOGY_MISMATCH',
      candidateEvidence: evidence ? [...evidence.refs] : [],
      resumeSays: equivalent,
      recommendation:
        `Your resume says "${equivalent}", which is the same thing in different words. ` +
        'Consider matching the posting’s phrasing only if it reads naturally — the meaning is already there.',
      actionable: true,
    };
  }

  if (!evidence) {
    /*
     * The honest case, and the one no amount of editing fixes. Nothing here
     * suggests wording that would imply the experience.
     */
    return {
      requirement: requirement.text,
      importance: requirement.importance,
      kind: 'NOT_EVIDENCED',
      candidateEvidence: [],
      resumeSays: null,
      recommendation:
        'Nothing in your record supports this. Leave it out rather than implying it — a claim you cannot defend in an interview costs more than the gap does.',
      actionable: false,
    };
  }

  const mentioned = requirement.slug
    ? input.resumeSkills.includes(requirement.slug) ||
      new RegExp(`\\b${escapeRegExp(requirement.slug)}\\b`, 'i').test(resumeText)
    : false;

  if (!mentioned) {
    /*
     * The most valuable finding this module produces: the candidate has it and
     * the document does not say so.
     */
    return {
      requirement: requirement.text,
      importance: requirement.importance,
      kind: 'NOT_DEMONSTRATED',
      candidateEvidence: [...evidence.refs],
      resumeSays: null,
      recommendation:
        `You can evidence this through ${evidence.refs[0]?.locator ?? 'your experience'}, ` +
        'but the resume does not currently make that explicit. Naming it is accurate, not embellishment.',
      actionable: true,
    };
  }

  if (evidence.strength === 'listed') {
    return {
      requirement: requirement.text,
      importance: requirement.importance,
      kind: 'UNDERSTATED',
      candidateEvidence: [...evidence.refs],
      resumeSays: evidence.label,
      recommendation:
        'This appears only in your skills list. If you used it in a role or project, saying where would make it far stronger.',
      actionable: true,
    };
  }

  return {
    requirement: requirement.text,
    importance: requirement.importance,
    kind: 'BURIED',
    candidateEvidence: [...evidence.refs],
    resumeSays: evidence.label,
    recommendation: 'Present, but far down the document. Moving it earlier would help.',
    actionable: true,
  };
}

/**
 * Builds the plan.
 *
 * Every emphasis is a `SupportedClaim`, so the schema refuses one the candidate
 * cannot back. Every de-emphasis is a plain string, because it is a statement
 * about the *document* rather than about the person and needs no evidence —
 * "this paragraph is not relevant here" asserts nothing about anyone.
 */
export function buildCustomizationPlan(input: CustomizationInput): CustomizationPlan {
  const resumeText = input.resumeSections
    .flatMap((section) => [section.heading, ...section.bullets])
    .join('\n');

  const gaps = input.requirements
    .filter((requirement) => requirement.confidence >= 0.4)
    .map((requirement) => classifyGap(requirement, input, resumeText));

  /*
   * Emphasis is drawn from what the job asks for *and* the candidate can
   * evidence — the intersection, not the candidate's whole skill list. A plan
   * that says "emphasise everything" is a plan that says nothing.
   */
  const wanted = new Set(
    input.requirements
      .filter((requirement) => requirement.importance === 'required')
      .map((requirement) => requirement.slug)
      .filter((slug): slug is string => slug !== null),
  );

  const emphasise: SupportedClaim[] = input.candidateEvidence
    .filter((entry) => wanted.has(entry.slug) && entry.refs.length > 0)
    .sort((a, b) => strengthRank(a.strength) - strengthRank(b.strength))
    .slice(0, 6)
    .map((entry) => ({
      claim: `${entry.label} — ${describeStrength(entry.strength)}`,
      evidence: [...entry.refs].slice(0, 4),
      verified: false,
    }));

  /*
   * De-emphasis targets skills the resume names and the job never mentions.
   * Bounded to a handful: a plan that proposes cutting fifteen things is a
   * rewrite wearing a plan's clothes.
   */
  const jobSlugs = new Set(
    input.requirements.map((requirement) => requirement.slug).filter(Boolean) as string[],
  );

  const deemphasise = input.resumeSkills
    .filter((slug) => !jobSlugs.has(slug))
    .slice(0, 6)
    .map((slug) => `"${slug}" is not mentioned in this posting and could move down the list.`);

  const skillPriority = [
    ...input.requirements
      .filter((r) => r.importance === 'required' && r.slug)
      .map((r) => r.slug as string),
    ...input.requirements
      .filter((r) => r.importance === 'preferred' && r.slug)
      .map((r) => r.slug as string),
  ].filter((slug, index, all) => all.indexOf(slug) === index);

  return customizationPlanSchema.parse({
    documentId: input.documentId,
    jobId: input.jobId,
    emphasise,
    deemphasise,
    sectionOrder: input.resumeSections.map((section) => section.heading),
    skillPriority: skillPriority.slice(0, 40),
    bullets: recommendBullets(input, gaps),
    gaps: gaps.slice(0, 25),
    requiresReview: true,
  });
}

function strengthRank(strength: 'professional' | 'project' | 'listed'): number {
  return strength === 'professional' ? 0 : strength === 'project' ? 1 : 2;
}

function describeStrength(strength: 'professional' | 'project' | 'listed'): string {
  switch (strength) {
    case 'professional':
      return 'demonstrated in professional work';
    case 'project':
      return 'demonstrated in a project';
    default:
      return 'listed on your profile';
  }
}

/**
 * Per-bullet recommendations.
 *
 * Reorder and de-emphasise dominate deliberately; `REWRITE` is only proposed
 * where there is specific evidence to fold in, and even then the proposed text
 * reuses the candidate's own words rather than generating new claims. A tool
 * that rewrites every bullet produces a document its owner does not recognise
 * and cannot defend.
 */
function recommendBullets(
  input: CustomizationInput,
  gaps: readonly ResumeGap[],
): BulletRecommendation[] {
  const recommendations: BulletRecommendation[] = [];

  const undemonstrated = gaps.filter((gap) => gap.kind === 'NOT_DEMONSTRATED');

  const relevantSlugs = new Set(
    input.requirements.map((requirement) => requirement.slug).filter(Boolean) as string[],
  );

  for (const section of input.resumeSections) {
    section.bullets.forEach((bullet, index) => {
      const mentionsRelevant = [...relevantSlugs].some((slug) =>
        new RegExp(`\\b${escapeRegExp(slug)}\\b`, 'i').test(bullet),
      );

      if (mentionsRelevant && index > 1) {
        recommendations.push({
          section: section.heading,
          anchor: `${section.heading}#${index}`,
          original: bullet.slice(0, 1000),
          action: 'REORDER',
          proposed: null,
          reason: 'This names something the posting asks for but sits below less relevant lines.',
          evidence: [],
          userDecision: 'pending',
        });
        return;
      }

      if (!mentionsRelevant && section.bullets.length > 3 && index >= 3) {
        recommendations.push({
          section: section.heading,
          anchor: `${section.heading}#${index}`,
          original: bullet.slice(0, 1000),
          action: 'DEEMPHASIZE',
          proposed: null,
          reason: 'Nothing here relates to what this posting asks for.',
          evidence: [],
          userDecision: 'pending',
        });
      }
    });
  }

  /*
   * One rewrite suggestion per undemonstrated requirement, and only where the
   * evidence carries a verbatim quote to build from. No quote, no proposal —
   * that is the line between surfacing something the candidate did and writing
   * something they did not.
   */
  for (const gap of undemonstrated.slice(0, 4)) {
    const ref = gap.candidateEvidence[0];
    if (!ref?.quote) continue;

    recommendations.push({
      section: ref.locator ?? 'Experience',
      anchor: `${ref.locator ?? 'Experience'}#evidence`,
      original: ref.quote.slice(0, 1000),
      action: 'REWRITE',
      proposed: null,
      reason:
        `This line already describes work that meets "${gap.requirement}". ` +
        'Naming the requirement explicitly would make it visible to a screener — using your own words, not new claims.',
      evidence: [ref],
      userDecision: 'pending',
    });
  }

  return recommendations.slice(0, 40);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keyword coverage, with equivalence.
 *
 * The `equivalent` state is the reason this is not a set-difference. Reporting
 * a term as missing when the resume expresses it better is how keyword tools
 * make documents worse.
 */
export function analyseKeywords(
  requirements: CustomizationInput['requirements'],
  resumeText: string,
): KeywordCoverage[] {
  return requirements.slice(0, 60).map((requirement) => {
    const term = requirement.slug ?? requirement.text;
    const present = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(resumeText);

    if (present) {
      return {
        term,
        importance: requirement.importance,
        state: 'covered' as const,
        resumeEquivalent: null,
        recommendation: null,
      };
    }

    const equivalent = findEquivalent(requirement.text, resumeText);

    if (equivalent) {
      return {
        term,
        importance: requirement.importance,
        state: 'equivalent' as const,
        resumeEquivalent: equivalent,
        recommendation:
          `Your resume says "${equivalent}", which means the same thing. No change needed unless the exact phrase matters to an automated filter.`,
      };
    }

    return {
      term,
      importance: requirement.importance,
      state: 'missing' as const,
      resumeEquivalent: null,
      recommendation:
        'Only add this if you can point to where you did it. An unbacked term will not survive an interview.',
    };
  });
}
