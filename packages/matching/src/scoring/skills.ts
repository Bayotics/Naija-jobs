import type { ComponentScore, SkillMatchDetail, SkillRequirementType } from '@job-intel/contracts';
import { resolveSkillSlug } from '@job-intel/enrichment';
import type { ScorerInput } from '../types';
import { clamp, notApplicable, round, score } from './util';

/**
 * Skill matching.
 *
 * Three things separate this from string intersection:
 *
 *  1. **Requirements are not equal.** A missing `required` skill costs far more
 *     than a missing `optional` one, so each requirement carries a weight.
 *  2. **Related counts, but less.** Next.js against a React requirement is a
 *     real signal; treating it as a miss throws away most of a candidate's
 *     transferable experience. The skill graph supplies the credit and, more
 *     importantly, the path — so an indirect match is explainable.
 *  3. **Depth matters.** Listing a skill is not the same as being expert in it,
 *     so proficiency scales the credit rather than being ignored.
 */

/** How much each requirement class contributes to the denominator. */
const REQUIREMENT_WEIGHTS: Readonly<Record<SkillRequirementType, number>> = {
  required: 1,
  preferred: 0.6,
  optional: 0.3,
  // Inferred skills were deduced by the enrichment layer, not stated by the
  // employer, so they inform the score without dominating it.
  inferred: 0.2,
};

/**
 * Proficiency multiplier.
 *
 * An unstated proficiency scores near the top rather than the bottom: most
 * candidates never fill this in, and treating a blank as "beginner" would
 * punish an incomplete profile rather than a weak one.
 */
const PROFICIENCY_FACTORS: Readonly<Record<string, number>> = {
  expert: 1,
  advanced: 0.95,
  intermediate: 0.85,
  beginner: 0.7,
};
const UNSTATED_PROFICIENCY = 0.9;

/** Above this, the graph route is close enough to call the skill "related". */
const CLOSELY_RELATED_THRESHOLD = 0.7;

interface CandidateSkillIndex {
  slugs: string[];
  bySlug: Map<string, { name: string; factor: number }>;
}

/**
 * Everything the candidate can claim, from all three places it can be recorded.
 *
 * Preference technologies count because a candidate who lists a technology as a
 * preference has almost always used it; they are folded in at unstated
 * proficiency rather than being treated as expertise.
 */
function indexCandidateSkills(input: ScorerInput): CandidateSkillIndex {
  const bySlug = new Map<string, { name: string; factor: number }>();

  const add = (name: string, slug: string | null, factor: number) => {
    const resolved = slug ?? resolveSkillSlug(name);
    const existing = bySlug.get(resolved);
    if (existing && existing.factor >= factor) return;
    bySlug.set(resolved, { name, factor });
  };

  for (const skill of input.candidate.skills) {
    const factor = skill.proficiency
      ? (PROFICIENCY_FACTORS[skill.proficiency] ?? UNSTATED_PROFICIENCY)
      : UNSTATED_PROFICIENCY;
    add(skill.name, skill.slug, factor);
  }
  for (const technology of input.candidate.profile.professional.technologies) {
    add(technology, null, UNSTATED_PROFICIENCY);
  }
  for (const preference of input.candidate.preferences.technologies) {
    // Only positively-held technologies; an excluded one is not a claim of
    // ability and is handled as a constraint, not a skill.
    if (preference.strength === 'excluded' || preference.strength === 'undesirable') continue;
    add(preference.value, null, UNSTATED_PROFICIENCY);
  }

  return { slugs: [...bySlug.keys()], bySlug };
}

export interface SkillScoreResult {
  component: ComponentScore;
  matches: SkillMatchDetail[];
}

export function scoreSkills(input: ScorerInput): SkillScoreResult {
  const required = input.job.enrichment.skills;
  const index = indexCandidateSkills(input);

  if (required.length === 0) {
    return {
      component: notApplicable('skills', 'Posting lists no identifiable skills'),
      matches: [],
    };
  }
  if (index.slugs.length === 0) {
    return {
      component: notApplicable('skills', 'No skills recorded on your profile yet'),
      matches: [],
    };
  }

  const graph = input.candidate.skillGraph;
  const matches: SkillMatchDetail[] = [];
  let earned = 0;
  let possible = 0;
  let extractionConfidence = 0;

  for (const skill of required) {
    const weight = REQUIREMENT_WEIGHTS[skill.requirement];
    possible += weight;
    extractionConfidence += skill.confidence;

    const coverage = graph.coverage(index.slugs, skill.slug);
    if (!coverage) {
      matches.push({
        required: skill.displayName,
        requirement: skill.requirement,
        kind: 'missing',
        satisfiedBy: null,
        strength: 0,
        via: [],
      });
      continue;
    }

    // `via[0]` is the candidate skill the route started from.
    const originSlug = coverage.via[0] ?? skill.slug;
    const origin = index.bySlug.get(originSlug);
    const factor = origin?.factor ?? UNSTATED_PROFICIENCY;
    const strength = clamp(coverage.strength * factor, 0, 1);

    earned += weight * strength;
    matches.push({
      required: skill.displayName,
      requirement: skill.requirement,
      kind:
        coverage.strength >= 1
          ? 'exact'
          : coverage.strength >= CLOSELY_RELATED_THRESHOLD
            ? 'closely_related'
            : 'transferable',
      satisfiedBy: origin?.name ?? originSlug,
      strength: round(strength, 3),
      via: coverage.via.length > 1 ? coverage.via : [],
    });
  }

  const value = possible === 0 ? 0 : (earned / possible) * 100;

  // Confidence tracks how well the *extraction* did, not how good the match is.
  // A confident score built on badly-parsed skills would be a lie.
  const meanExtraction = extractionConfidence / required.length;
  const breadth = Math.min(1, required.length / 5);
  const confidence = meanExtraction * (0.6 + 0.4 * breadth);

  const hit = matches.filter((m) => m.kind !== 'missing');
  const missingRequired = matches.filter((m) => m.kind === 'missing' && m.requirement === 'required');

  const explanation =
    missingRequired.length === 0
      ? `Covers ${hit.length} of ${matches.length} listed skills, including every required one`
      : `Covers ${hit.length} of ${matches.length} listed skills; missing ` +
        `${missingRequired.length} required (${missingRequired.map((m) => m.required).join(', ')})`;

  const evidence = hit
    .slice(0, 8)
    .map((m) =>
      m.kind === 'exact'
        ? `${m.required} (direct)`
        : `${m.required} via ${m.satisfiedBy} (${m.kind.replace('_', ' ')})`,
    );

  return { component: score('skills', value, confidence, explanation, evidence), matches };
}
