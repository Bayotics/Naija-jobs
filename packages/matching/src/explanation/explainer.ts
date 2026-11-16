import type {
  ComponentScore,
  HardConstraintResult,
  LlmReasoning,
  RecommendationCategory,
  SkillMatchDetail,
} from '@job-intel/contracts';
import { RECOMMENDATION_LABELS } from '../engine/recommendation';

/**
 * Explanation generation.
 *
 * Written for a person deciding whether to spend an hour on an application, so
 * it leads with the decision, then the reason, then the caveat. Assembled from
 * the same component scores that produced the number — not narrated separately
 * — so the prose cannot drift from the arithmetic and claim something the score
 * does not support.
 */

const STRONG = 75;
const WEAK = 45;

/** Reads better than the internal camelCase keys. */
const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  skills: 'skills',
  experience: 'experience',
  seniority: 'seniority',
  title: 'job title',
  location: 'location',
  workArrangement: 'work arrangement',
  salary: 'salary',
  visa: 'visa sponsorship',
  education: 'education',
  industry: 'industry',
  employmentType: 'employment type',
  company: 'company',
  semantic: 'overall description fit',
  behavioral: 'your past activity',
  quality: 'posting quality',
};

function label(dimension: string): string {
  return DIMENSION_LABELS[dimension] ?? dimension;
}

export interface ExplanationInput {
  jobTitle: string;
  companyName: string;
  recommendation: RecommendationCategory;
  score: number;
  confidence: number;
  constraints: HardConstraintResult;
  components: readonly ComponentScore[];
  skillMatches: readonly SkillMatchDetail[];
  reasoning: LlmReasoning | null;
  /**
   * Candidate evidence for this job, when the intelligence layer has produced
   * it. Optional so matching still works for a candidate who has uploaded
   * nothing — the explanation is simply thinner.
   */
  evidence?: CandidateEvidence | null;
}

/**
 * Evidence-grounded detail from the candidate intelligence layer.
 *
 * The upgrade this enables is specific: instead of "fits well on skills", the
 * explanation can say *why* — which role evidenced React, whether the match is
 * direct or transferable, and which requirements the profile is simply silent
 * about. The last of those is the one that matters most, because "your profile
 * does not say" and "you do not have this" produce opposite actions from the
 * reader.
 */
export interface CandidateEvidence {
  /** Requirements met by direct evidence, with where it came from. */
  direct: ReadonlyArray<{ requirement: string; context: string }>;
  /** Requirements met through a related skill, named as such. */
  transferable: ReadonlyArray<{ requirement: string; via: string }>;
  /** Requirements the profile is silent on. Never rendered as failures. */
  unknown: readonly string[];
  /** Mean confidence of the evidence behind the matched requirements. */
  evidenceConfidence: number;
  /** Which of the candidate's documents argues this job best. */
  bestDocument: { label: string; score: number } | null;
}

export interface ExplanationResult {
  explanation: string;
  matchedRequirements: string[];
  missingRequirements: string[];
  concerns: string[];
  positiveSignals: string[];
  negativeSignals: string[];
}

export function explain(input: ExplanationInput): ExplanationResult {
  const applicable = input.components.filter((c) => c.applicable);
  const strengths = applicable
    .filter((c) => c.score >= STRONG && c.dimension !== 'quality')
    .sort((a, b) => b.score - a.score);
  const weaknesses = applicable
    .filter((c) => c.score < WEAK && c.dimension !== 'quality')
    .sort((a, b) => a.score - b.score);

  const matchedRequirements = input.skillMatches
    .filter((m) => m.kind !== 'missing')
    .map((m) =>
      m.kind === 'exact' ? m.required : `${m.required} (via ${m.satisfiedBy ?? 'related skill'})`,
    );

  const missingRequirements = input.skillMatches
    .filter((m) => m.kind === 'missing' && (m.requirement === 'required' || m.requirement === 'preferred'))
    .map((m) => `${m.required} (${m.requirement})`);

  const concerns: string[] = [];
  const positiveSignals: string[] = strengths.map((c) => c.explanation);
  const negativeSignals: string[] = weaknesses.map((c) => c.explanation);

  for (const unknown of input.constraints.unknowns) {
    concerns.push(`${unknown.constraint}: ${unknown.explanation}`);
  }
  const quality = applicable.find((c) => c.dimension === 'quality');
  if (quality && quality.score < 50) concerns.push(quality.explanation);

  if (input.reasoning) {
    positiveSignals.push(...input.reasoning.positiveSignals);
    negativeSignals.push(...input.reasoning.negativeSignals);
    concerns.push(...input.reasoning.concerns);
    missingRequirements.push(...input.reasoning.missingRequirements);
  }

  // ── The paragraph ─────────────────────────────────────────────────────────
  const sentences: string[] = [];
  const role = `${input.jobTitle}${input.companyName ? ` at ${input.companyName}` : ''}`;

  if (!input.constraints.eligible) {
    const reasons = input.constraints.violations.map((v) => v.explanation);
    sentences.push(
      `${role} is ineligible: ${reasons.join('; ')}.`,
      'It is excluded regardless of how well the rest of the role fits — this is a requirement you marked as non-negotiable.',
    );
    return {
      explanation: sentences.join(' '),
      matchedRequirements,
      missingRequirements,
      concerns,
      positiveSignals,
      negativeSignals,
    };
  }

  sentences.push(
    `${RECOMMENDATION_LABELS[input.recommendation]} (${Math.round(input.score)}/100) for ${role}.`,
  );

  if (strengths.length > 0) {
    sentences.push(
      `It fits well on ${joinList(strengths.slice(0, 3).map((c) => label(c.dimension)))}: ` +
        `${strengths[0]?.explanation}.`,
    );
  }

  if (weaknesses.length > 0) {
    sentences.push(
      `The weaker points are ${joinList(weaknesses.slice(0, 3).map((c) => label(c.dimension)))} — ` +
        `${weaknesses[0]?.explanation}.`,
    );
  }

  if (input.recommendation === 'UNCERTAIN') {
    sentences.push(
      `Confidence is low (${Math.round(input.confidence * 100)}%) because the posting leaves too much unstated to judge properly.`,
    );
  } else if (input.constraints.unknowns.length > 0) {
    sentences.push(
      `Worth checking before applying: ${joinList(input.constraints.unknowns.map((u) => u.constraint.toLowerCase()))}.`,
    );
  }

  /*
   * Evidence, when the intelligence layer has any.
   *
   * Placed before the model's prose deliberately: this part is traceable to a
   * document and a date, and the reader should meet it before they meet an
   * assessment that is not.
   */
  if (input.evidence) {
    const { direct, transferable, unknown, bestDocument } = input.evidence;

    if (direct.length > 0) {
      sentences.push(
        `Your evidence for this: ${direct
          .slice(0, 3)
          .map((entry) => `${entry.requirement} (${entry.context})`)
          .join('; ')}.`,
      );
    }

    if (transferable.length > 0) {
      sentences.push(
        `Met through related experience rather than directly: ${transferable
          .slice(0, 3)
          .map((entry) => `${entry.requirement} via ${entry.via}`)
          .join('; ')}.`,
      );
    }

    if (unknown.length > 0) {
      // The wording is load-bearing. Absence of evidence is not evidence of
      // absence, and a reader who is told "missing" will not apply.
      sentences.push(
        `Your profile does not say either way about ${joinList(unknown.slice(0, 3))}` +
          `${unknown.length > 3 ? `, and ${unknown.length - 3} more` : ''} — unknowns, not gaps.`,
      );
      concerns.push(
        ...unknown.slice(0, 5).map((item) => `Profile is silent on: ${item}`),
      );
    }

    if (bestDocument) {
      sentences.push(
        `Of your documents, "${bestDocument.label}" argues this best (${bestDocument.score}/100 coverage).`,
      );
    }
  }

  if (input.reasoning?.assessment) {
    sentences.push(input.reasoning.assessment.trim());
  }

  return {
    explanation: sentences.join(' ').slice(0, 2000),
    matchedRequirements: dedupe(matchedRequirements),
    missingRequirements: dedupe(missingRequirements),
    concerns: dedupe(concerns),
    positiveSignals: dedupe(positiveSignals),
    negativeSignals: dedupe(negativeSignals),
  };
}

function joinList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}
