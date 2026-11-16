import {
  MATCH_STRENGTH_CREDIT,
  evidenceItemSchema,
  requirementAssessmentSchema,
  type CandidateIntelligence,
  type CandidatePreferences,
  type CandidateSkillFact,
  type EvidenceItem,
  type MatchStrength,
  type ParsedRequirementRecord,
  type RequirementAssessment,
  type SupportState,
} from '@job-intel/contracts';
import type { SkillGraph } from '@job-intel/candidate';

/**
 * Matching one requirement against one profile.
 *
 * The five-way outcome is the point of this module, and the two that matter
 * most are the ones a simpler system collapses:
 *
 *   `NO_EVIDENCE` — the profile is silent. Not a failure. Produces a question.
 *   `CONFLICT`    — the profile positively says otherwise. A real failure.
 *
 * Between them sit the two shades of partial credit. A candidate with AWS ECS
 * and S3 against a Lambda requirement has *AWS* experience, which is worth
 * something and is visibly not Lambda experience. Calling that a match would
 * flatter them into an application that gets screened out on the first
 * question; calling it nothing would hide a genuine strength.
 */

/**
 * Strength floors on the skill graph.
 *
 * A route through the graph at 0.75 or better is the same family — `s3` and
 * `lambda` both `part_of` `aws`, `nextjs` `implies` `react`. Below 0.4 the
 * connection is real but distant, and below that it is noise.
 */
const PARTIAL_FLOOR = 0.7;
const RELATED_FLOOR = 0.3;

/** Months of evidenced use below which a skill is real but thin. */
const THIN_MONTHS = 6;

export interface MatchContext {
  profile: CandidateIntelligence;
  preferences: CandidatePreferences | null;
  graph: SkillGraph;
  now: Date;
}

const strengthOrder: readonly MatchStrength[] = [
  'DIRECT_MATCH',
  'PARTIAL_MATCH',
  'RELATED_MATCH',
  'NO_EVIDENCE',
  'CONFLICT',
];

/** Recency multiplier. A skill last used in 2016 is not current experience. */
function recencyFactor(fact: CandidateSkillFact, now: Date): number {
  if (!fact.lastEvidencedAt) return 0.85;

  const months = (now.getTime() - fact.lastEvidencedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months <= 18) return 1;
  if (months <= 36) return 0.95;
  if (months <= 60) return 0.85;
  if (months <= 96) return 0.72;
  return 0.6;
}

/** Depth multiplier from what the evidence actually establishes. */
function depthFactor(fact: CandidateSkillFact): number {
  const byProficiency: Record<string, number> = {
    BEGINNER: 0.55,
    WORKING: 0.75,
    PROFICIENT: 0.9,
    ADVANCED: 0.97,
    EXPERT: 1,
  };

  let factor = fact.proficiency ? byProficiency[fact.proficiency]! : 0.7;

  // A skill nothing evidences beyond a list entry is a claim, not a record.
  if (fact.strongestSource === 'resume_skill_section' || fact.strongestSource === null) {
    factor = Math.min(factor, 0.6);
  }

  if (fact.totalMonths !== null && fact.totalMonths < THIN_MONTHS) factor = Math.min(factor, 0.65);
  // The candidate confirming it by hand is the strongest evidence there is.
  if (fact.userVerified) factor = Math.max(factor, 0.92);

  return factor;
}

function evidenceFor(fact: CandidateSkillFact, limit = 4): EvidenceItem[] {
  return fact.evidence.slice(0, limit);
}

/**
 * Does the candidate's *stated* position contradict this requirement?
 *
 * Only explicit preferences can produce a CONFLICT. Behaviour never can — a
 * candidate who mostly clicks remote jobs has not said they refuse onsite work,
 * and treating that as a conflict would be behavioural learning overriding an
 * explicit position, which is exactly backwards.
 */
function conflictsWithPreferences(
  requirement: ParsedRequirementRecord,
  preferences: CandidatePreferences | null,
): { conflict: boolean; detail: string } {
  if (!preferences) return { conflict: false, detail: '' };

  if (requirement.type === 'technical_skill' && requirement.slug) {
    const excluded = preferences.technologies.find(
      (entry) =>
        entry.strength === 'excluded' &&
        (entry.value.toLowerCase() === requirement.slug ||
          entry.value.toLowerCase().replace(/[^a-z0-9]/g, '') ===
            requirement.slug!.replace(/[^a-z0-9]/g, '')),
    );

    if (excluded) {
      return {
        conflict: true,
        detail: `You have excluded ${excluded.value} from your preferences.`,
      };
    }
  }

  if (requirement.type === 'employment_type') {
    const excluded = preferences.employmentTypes.find(
      (entry) =>
        entry.strength === 'excluded' &&
        requirement.text.toLowerCase().includes(entry.value.toLowerCase()),
    );

    if (excluded) {
      return { conflict: true, detail: `You have excluded ${excluded.value} roles.` };
    }
  }

  return { conflict: false, detail: '' };
}

/**
 * Assesses a single requirement.
 *
 * Non-skill requirements — education, language, authorisation — are handled by
 * their own dimension modules, which have the candidate data this one does not.
 * Here they resolve to UNKNOWN with a stated reason rather than being guessed
 * at, and the caller replaces them with the real assessment.
 */
export function assessRequirement(
  requirement: ParsedRequirementRecord,
  context: MatchContext,
): RequirementAssessment {
  const build = (
    strength: MatchStrength,
    support: SupportState,
    credit: number,
    explanation: string,
    evidence: EvidenceItem[] = [],
    via: string[] = [],
  ): RequirementAssessment =>
    requirementAssessmentSchema.parse({
      requirement,
      strength,
      support,
      credit: Math.round(Math.max(0, Math.min(1, credit)) * 100) / 100,
      evidence: evidence.slice(0, 8),
      via: via.slice(0, 6),
      explanation,
    });

  const contradiction = conflictsWithPreferences(requirement, context.preferences);
  if (contradiction.conflict) {
    return build('CONFLICT', 'NOT_SUPPORTED', 0, contradiction.detail);
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  if (requirement.type === 'technical_skill' || requirement.type === 'soft_skill') {
    if (!requirement.slug) {
      return build(
        'NO_EVIDENCE',
        'UNKNOWN',
        0,
        'This requirement could not be matched to a known skill, so your profile could not be checked against it.',
      );
    }

    const byslug = new Map(context.profile.skills.map((fact) => [fact.slug, fact]));
    const direct = byslug.get(requirement.slug);

    if (direct) {
      const factor = depthFactor(direct) * recencyFactor(direct, context.now);
      const years = direct.totalMonths === null ? null : direct.totalMonths / 12;

      const detail =
        years === null
          ? `${direct.name} is evidenced, though nothing dates it.`
          : `${direct.name}: about ${years.toFixed(1)} years evidenced${
              direct.monthsIsEstimate ? ' (estimated from partial dates)' : ''
            }.`;

      const currency =
        direct.lastEvidencedAt && recencyFactor(direct, context.now) < 0.9
          ? ` Last evidenced ${direct.lastEvidencedAt.getUTCFullYear()}.`
          : '';

      return build(
        'DIRECT_MATCH',
        'SUPPORTED',
        MATCH_STRENGTH_CREDIT.DIRECT_MATCH * factor,
        `${detail}${currency}`,
        evidenceFor(direct),
      );
    }

    // Nothing direct. Does anything the candidate has reach it?
    const route = context.graph.coverage(
      context.profile.skills.map((fact) => fact.slug),
      requirement.slug,
    );

    if (route && route.strength >= PARTIAL_FLOOR) {
      const source = byslug.get(route.via[0]!);
      const factor = source ? depthFactor(source) * recencyFactor(source, context.now) : 0.6;

      return build(
        'PARTIAL_MATCH',
        'SUPPORTED',
        MATCH_STRENGTH_CREDIT.PARTIAL_MATCH * route.strength * factor,
        `No direct ${requirement.text} evidence, but ${source?.name ?? route.via[0]} is closely related${
          route.via.length > 2 ? ` (via ${route.via.slice(1, -1).join(' → ')})` : ''
        }. Related is not the same as direct.`,
        source ? evidenceFor(source, 2) : [],
        route.via,
      );
    }

    if (route && route.strength >= RELATED_FLOOR) {
      const source = byslug.get(route.via[0]!);

      return build(
        'RELATED_MATCH',
        // Adjacent experience does not answer the question the posting asked.
        'UNKNOWN',
        MATCH_STRENGTH_CREDIT.RELATED_MATCH * route.strength,
        `${source?.name ?? route.via[0]} is adjacent to ${requirement.text}, but ${requirement.text} itself is not evidenced.`,
        [],
        route.via,
      );
    }

    return build(
      'NO_EVIDENCE',
      'UNKNOWN',
      0,
      `Nothing in your profile mentions ${requirement.text}. That is not evidence you lack it — your documents simply do not say.`,
    );
  }

  // ── Everything else defers to its own dimension ──────────────────────────
  return build(
    'NO_EVIDENCE',
    'UNKNOWN',
    0,
    'Assessed separately from your profile documents.',
  );
}

export interface SkillAlignment {
  assessments: RequirementAssessment[];
  /** 0–100, weighted by requirement importance. */
  score: number;
  confidence: number;
  direct: number;
  partial: number;
  related: number;
  noEvidence: number;
  conflicts: number;
  explanation: string;
}

/**
 * Aggregates skill requirements into one dimension.
 *
 * Two arithmetic decisions carry most of the honesty here.
 *
 * The denominator counts every requirement the posting stated, including ones
 * with no evidence — a candidate who evidences two of ten required skills has
 * not scored 100% on the two they answered.
 *
 * But `confidence` falls as unknowns rise, so a profile that is mostly silent
 * produces a low score *and* says it might be wrong, rather than a low score
 * presented as a settled finding.
 */
export function aggregateSkillAlignment(
  assessments: readonly RequirementAssessment[],
): SkillAlignment {
  const skills = assessments.filter(
    (entry) =>
      entry.requirement.type === 'technical_skill' || entry.requirement.type === 'soft_skill',
  );

  const counts = { direct: 0, partial: 0, related: 0, noEvidence: 0, conflicts: 0 };
  for (const entry of skills) {
    if (entry.strength === 'DIRECT_MATCH') counts.direct += 1;
    else if (entry.strength === 'PARTIAL_MATCH') counts.partial += 1;
    else if (entry.strength === 'RELATED_MATCH') counts.related += 1;
    else if (entry.strength === 'CONFLICT') counts.conflicts += 1;
    else counts.noEvidence += 1;
  }

  if (skills.length === 0) {
    return {
      assessments: [...skills],
      score: 0,
      confidence: 0,
      ...counts,
      explanation: 'This posting names no specific skills, so there is nothing to align against.',
    };
  }

  const weightOf = (entry: RequirementAssessment): number => {
    const byImportance: Record<string, number> = {
      required: 1,
      preferred: 0.4,
      nice_to_have: 0.12,
      inferred: 0.1,
    };
    return byImportance[entry.requirement.importance] ?? 0.1;
  };

  const totalWeight = skills.reduce((sum, entry) => sum + weightOf(entry), 0);
  const earned = skills.reduce((sum, entry) => sum + weightOf(entry) * entry.credit, 0);
  const score = totalWeight === 0 ? 0 : Math.round((earned / totalWeight) * 100);

  const answered = counts.direct + counts.partial + counts.conflicts;
  const answeredRatio = answered / skills.length;

  // Confident when the profile could actually speak to most of what was asked.
  const confidence = Math.min(0.92, 0.25 + answeredRatio * 0.6 + Math.min(skills.length, 8) * 0.01);

  const parts: string[] = [];
  if (counts.direct > 0) parts.push(`${counts.direct} directly evidenced`);
  if (counts.partial > 0) parts.push(`${counts.partial} met by closely related experience`);
  if (counts.related > 0) parts.push(`${counts.related} adjacent but not evidenced`);
  if (counts.noEvidence > 0) parts.push(`${counts.noEvidence} your profile does not mention`);
  if (counts.conflicts > 0) parts.push(`${counts.conflicts} you have excluded`);

  return {
    assessments: [...skills],
    score,
    confidence: Math.round(confidence * 100) / 100,
    ...counts,
    explanation: `Of ${skills.length} skills this posting names: ${parts.join(', ')}.`,
  };
}

/** Orders assessments so the reader meets the strongest evidence first. */
export function sortAssessments(
  assessments: readonly RequirementAssessment[],
): RequirementAssessment[] {
  const importanceRank: Record<string, number> = {
    required: 0,
    preferred: 1,
    nice_to_have: 2,
    inferred: 3,
  };

  return [...assessments].sort((a, b) => {
    const byImportance =
      (importanceRank[a.requirement.importance] ?? 9) - (importanceRank[b.requirement.importance] ?? 9);
    if (byImportance !== 0) return byImportance;

    return strengthOrder.indexOf(a.strength) - strengthOrder.indexOf(b.strength);
  });
}

/** Evidence item helper, used where a dimension needs to cite a non-skill fact. */
export function statedEvidence(context: string, excerpt: string, confidence = 0.9): EvidenceItem {
  return evidenceItemSchema.parse({
    id: `stated-${context.slice(0, 24)}`,
    source: 'candidate_self_report',
    documentId: null,
    context: context.slice(0, 300),
    excerpt: excerpt.slice(0, 1_000),
    confidence,
    observedFrom: null,
    observedTo: null,
    extractedBy: null,
    extractedAt: new Date(),
  });
}
