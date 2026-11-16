import {
  EVIDENCE_SOURCE_WEIGHT,
  candidateSkillFactSchema,
  dateRangeSchema,
  partialDateSchema,
  type CandidateSkillFact,
  type DateRange,
  type EvidenceItem,
  type EvidenceSource,
  type ProficiencyLevel,
} from '@job-intel/contracts';
import { mergedMonths } from '../parse/dates';
import type { SkillMention } from '../parse/skills';

/**
 * Turning skill mentions into skill facts.
 *
 * Three separate questions, deliberately answered separately because they have
 * different answers and different reliability:
 *
 *  - **How long?** Non-overlapping months across every span the skill was
 *    evidenced in. Two concurrent roles using React are one stretch of React
 *    experience, not two.
 *
 *  - **How recently?** A skill last used in 2016 and one used last month are
 *    both "5 years of experience" and are not the same thing.
 *
 *  - **How strongly evidenced?** A skill named in a two-year role, a
 *    certification and a personal project is on much firmer ground than one
 *    that appears once in a comma-separated list.
 *
 * Proficiency is derived from all three, and is always phrased as what the
 * evidence supports. The system says "evidence suggests proficient", never
 * "candidate is an expert" — the first is a claim about the document, which is
 * true, and the second is a claim about the person, which nothing here can
 * establish.
 */

/** Evidence sources that place a skill in *professional* use. */
const PROFESSIONAL_SOURCES: ReadonlySet<EvidenceSource> = new Set([
  'employment_responsibility',
]);

/** Sources that assert a skill without demonstrating its use. */
const ASSERTION_ONLY: ReadonlySet<EvidenceSource> = new Set([
  'resume_skill_section',
  'candidate_self_report',
]);

export interface SkillFactOptions {
  now?: Date;
  /** Months after which a skill is treated as stale for proficiency purposes. */
  staleAfterMonths?: number;
}

/**
 * Confidence that the skill exists at all.
 *
 * Saturating rather than additive: a fourth mention of React adds less than the
 * first did, and no amount of evidence reaches certainty. The same shape used
 * by the affinity engine, for the same reason — repeated mentions of the same
 * fact are correlated, not independent.
 */
function existenceConfidence(evidence: readonly EvidenceItem[]): number {
  const total = evidence.reduce((sum, item) => sum + EVIDENCE_SOURCE_WEIGHT[item.source], 0);
  return Math.min(0.98, 1 - Math.exp(-total / 1.2));
}

/**
 * Estimates proficiency from duration, recency, evidence depth and source mix.
 *
 * The rules are conservative in one specific direction: a skill with only
 * assertion evidence never rises above WORKING, however many times it is
 * asserted. A candidate listing "Kubernetes" in a skills section three times has
 * told us they know the word, and the system should not pretend otherwise.
 */
export function estimateProficiency(input: {
  months: number | null;
  monthsIsEstimate: boolean;
  lastEvidencedAt: Date | null;
  evidence: readonly EvidenceItem[];
  now: Date;
  staleAfterMonths: number;
}): { level: ProficiencyLevel | null; confidence: number; rationale: string } {
  const { evidence, months, now, staleAfterMonths } = input;

  if (evidence.length === 0) {
    return { level: null, confidence: 0, rationale: 'No evidence found for this skill.' };
  }

  const professional = evidence.filter((item) => PROFESSIONAL_SOURCES.has(item.source));
  const assertionOnly = evidence.every((item) => ASSERTION_ONLY.has(item.source));
  const hasCertification = evidence.some((item) => item.source === 'certification');
  const projects = evidence.filter((item) => item.source === 'project_implementation');

  const monthsSinceUse =
    input.lastEvidencedAt === null
      ? null
      : Math.max(
          0,
          Math.round(
            (now.getTime() - input.lastEvidencedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44),
          ),
        );

  const reasons: string[] = [];

  // ── Assertion-only skills stop at WORKING ───────────────────────────────
  if (assertionOnly) {
    return {
      level: 'WORKING',
      // Low, and deliberately so: a skills list is a claim, not a demonstration.
      confidence: Math.min(0.35, 0.15 + evidence.length * 0.05),
      rationale:
        'Listed in a skills section but not evidenced in any role, project or certification, ' +
        'so the level of use is unknown.',
    };
  }

  let level: ProficiencyLevel;

  if (months === null) {
    // Evidenced in use but with no datable span. Real, but unquantified.
    level = professional.length > 0 ? 'WORKING' : 'BEGINNER';
    reasons.push('used in undated work, so duration could not be established');
  } else if (months >= 84 && professional.length >= 2) {
    level = 'EXPERT';
    reasons.push(`about ${Math.round(months / 12)} years of professional use across ${professional.length} roles`);
  } else if (months >= 48) {
    level = 'ADVANCED';
    reasons.push(`about ${Math.round(months / 12)} years of evidenced use`);
  } else if (months >= 18) {
    level = 'PROFICIENT';
    reasons.push(`about ${Math.round(months / 12) || 1} year${months >= 24 ? 's' : ''} of evidenced use`);
  } else if (months >= 6) {
    level = 'WORKING';
    reasons.push(`about ${months} months of evidenced use`);
  } else {
    level = 'BEGINNER';
    reasons.push(`under six months of evidenced use`);
  }

  // ── Adjustments ─────────────────────────────────────────────────────────
  const order: ProficiencyLevel[] = ['BEGINNER', 'WORKING', 'PROFICIENT', 'ADVANCED', 'EXPERT'];
  let index = order.indexOf(level);

  if (hasCertification && index < order.length - 1) {
    index += 1;
    reasons.push('holds a related certification');
  }

  if (projects.length >= 2 && index < order.length - 1) {
    index += 1;
    reasons.push(`built ${projects.length} projects using it`);
  }

  /*
   * Staleness reduces the estimate rather than the confidence. A skill last
   * used six years ago is genuinely less current — that is a fact about the
   * evidence, not uncertainty about it — and pretending otherwise would let
   * long-dormant skills outrank recent ones in matching.
   */
  if (monthsSinceUse !== null && monthsSinceUse > staleAfterMonths && index > 0) {
    index -= 1;
    reasons.push(`last evidenced about ${Math.round(monthsSinceUse / 12)} years ago`);
  }

  level = order[index]!;

  // ── Confidence in the estimate itself ───────────────────────────────────
  let confidence = 0.3;
  if (professional.length > 0) confidence += 0.25;
  if (professional.length > 1) confidence += 0.1;
  if (months !== null) confidence += 0.15;
  if (!input.monthsIsEstimate) confidence += 0.1;
  if (hasCertification) confidence += 0.05;
  // Only ever a claim about evidence, so never certainty.
  confidence = Math.min(0.9, confidence);

  return {
    level,
    confidence,
    rationale: `Evidence suggests ${level.toLowerCase()}: ${reasons.join(', ')}.`,
  };
}

/**
 * Aggregates mentions into one fact per skill.
 *
 * The duration merge is the load-bearing part. Every mention contributes its
 * observed span, all spans go through `mergedMonths`, and overlapping periods
 * are counted once — which is why a candidate with three concurrent React roles
 * from 2021 to 2023 gets two years of React, not six.
 */
export function buildSkillFacts(
  mentions: readonly SkillMention[],
  options: SkillFactOptions = {},
): CandidateSkillFact[] {
  const now = options.now ?? new Date();
  const staleAfterMonths = options.staleAfterMonths ?? 48;

  interface Bucket {
    slug: string;
    name: string;
    category: SkillMention['skill']['category'];
    aliases: Set<string>;
    evidence: EvidenceItem[];
    ranges: DateRange[];
  }

  const buckets = new Map<string, Bucket>();

  for (const mention of mentions) {
    let bucket = buckets.get(mention.skill.slug);
    if (!bucket) {
      bucket = {
        slug: mention.skill.slug,
        name: mention.skill.name,
        category: mention.skill.category,
        aliases: new Set(),
        evidence: [],
        ranges: [],
      };
      buckets.set(mention.skill.slug, bucket);
    }

    bucket.aliases.add(mention.skill.name);
    bucket.evidence.push(mention.evidence);

    const { observedFrom, observedTo } = mention.evidence;
    if (observedFrom) {
      bucket.ranges.push(
        dateRangeSchema.parse({
          start: partialDateSchema.parse({
            year: observedFrom.getUTCFullYear(),
            month: observedFrom.getUTCMonth() + 1,
            precision: 'month',
          }),
          end: observedTo
            ? partialDateSchema.parse({
                year: observedTo.getUTCFullYear(),
                month: observedTo.getUTCMonth() + 1,
                precision: 'month',
              })
            : partialDateSchema.parse({}),
          isCurrent: observedTo === null,
        }),
      );
    }
  }

  const facts: CandidateSkillFact[] = [];

  for (const bucket of buckets.values()) {
    // Strongest evidence first, so the truncated list keeps what matters.
    const evidence = [...bucket.evidence].sort(
      (a, b) => EVIDENCE_SOURCE_WEIGHT[b.source] - EVIDENCE_SOURCE_WEIGHT[a.source],
    );

    const duration = mergedMonths(bucket.ranges, now);
    const hasDates = bucket.ranges.length > 0;

    const dated = bucket.evidence
      .flatMap((item) => [item.observedFrom, item.observedTo])
      .filter((value): value is Date => value instanceof Date);

    const lastEvidencedAt =
      dated.length > 0 ? new Date(Math.max(...dated.map((date) => date.getTime()))) : null;
    const firstEvidencedAt =
      dated.length > 0 ? new Date(Math.min(...dated.map((date) => date.getTime()))) : null;

    const proficiency = estimateProficiency({
      months: hasDates ? duration.months : null,
      monthsIsEstimate: duration.isEstimate,
      lastEvidencedAt,
      evidence,
      now,
      staleAfterMonths,
    });

    const strongest = evidence[0]?.source ?? null;

    const parsed = candidateSkillFactSchema.safeParse({
      slug: bucket.slug,
      name: bucket.name,
      category: bucket.category,
      aliasesSeen: [...bucket.aliases].slice(0, 20),
      proficiency: proficiency.level,
      proficiencyConfidence: proficiency.confidence,
      proficiencyRationale: proficiency.rationale,
      totalMonths: hasDates ? duration.months : null,
      monthsIsEstimate: duration.isEstimate,
      lastEvidencedAt,
      firstEvidencedAt,
      evidence: evidence.slice(0, 40),
      strongestSource: strongest,
      userVerified: false,
    });

    if (parsed.success) facts.push(parsed.data);
  }

  // Strongest evidence first, then longest use: the order the candidate expects
  // when they open their own profile.
  return facts.sort((a, b) => {
    const byConfidence = existenceConfidence(b.evidence) - existenceConfidence(a.evidence);
    if (Math.abs(byConfidence) > 0.01) return byConfidence;
    return (b.totalMonths ?? 0) - (a.totalMonths ?? 0);
  });
}

/** Confidence that a skill exists, exposed for callers that need it directly. */
export function skillExistenceConfidence(fact: CandidateSkillFact): number {
  // A verified skill is certain, because the candidate said so.
  return fact.userVerified ? 1 : existenceConfidence(fact.evidence);
}

/** Months since a skill was last evidenced, or null when nothing is dated. */
export function monthsSinceUse(fact: CandidateSkillFact, now = new Date()): number | null {
  if (!fact.lastEvidencedAt) return null;
  return Math.max(
    0,
    Math.round((now.getTime() - fact.lastEvidencedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44)),
  );
}
