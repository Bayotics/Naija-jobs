import type { ExtractedSkill, SkillRequirementType } from '@job-intel/contracts';
import { collapseWhitespace } from '@job-intel/core';
import {
  CONTEXTUAL_IMPLICATIONS,
  SKILL_TAXONOMY,
  compileSkillPattern,
  findSkill,
  type SkillDefinition,
} from '../taxonomy/skills';
import type { JobSections } from '../cleaning/content-cleaner';

/**
 * Skill and technology extraction.
 *
 * Beyond exact keyword matching in three ways:
 *
 *  1. **Aliases** — "ReactJS" and "React.js" resolve to one skill.
 *  2. **Contextual implication** — "modern React ecosystem" yields React,
 *     Next.js and TypeScript, marked `inferred` at lower confidence.
 *  3. **Transitive implication** — Next.js implies React even when React is
 *     never written, again as `inferred`.
 *
 * The requirement type is what the matching engine actually needs. It comes
 * from *where in the posting* the skill appeared: a skill under "Requirements"
 * is `required`, under "Nice to have" is `optional`, and one merely implied is
 * `inferred`. Weighting an inferred skill like a stated requirement is how a
 * matcher ends up confidently wrong.
 */

/** Precompiled once: recompiling ~90 regexes per job is a real cost. */
const COMPILED: Array<{ definition: SkillDefinition; pattern: RegExp }> = SKILL_TAXONOMY.flatMap(
  (definition) => {
    const pattern = compileSkillPattern(definition);
    return pattern ? [{ definition, pattern }] : [];
  },
);

/** Inline cues, used when a skill appears outside any recognised section. */
const INLINE_REQUIRED = /\b(?:must have|required|essential|proficien\w*|strong (?:knowledge|experience|command)|expert(?:ise)? in|solid (?:knowledge|experience))\b/i;
const INLINE_PREFERRED = /\b(?:nice to have|preferred|bonus|a plus|desirable|advantageous|would be great|familiarity with|exposure to)\b/i;

const PRECEDENCE: Record<SkillRequirementType, number> = {
  required: 4,
  preferred: 3,
  optional: 2,
  inferred: 1,
};

export interface SkillExtractionInput {
  title: string;
  description: string | null;
  sections: JobSections;
  /** Structured tags from the source; treated as weak but explicit signals. */
  tags?: readonly string[];
}

export function extractSkills(input: SkillExtractionInput): ExtractedSkill[] {
  const found = new Map<string, ExtractedSkill>();

  const record = (skill: ExtractedSkill): void => {
    const existing = found.get(skill.slug);
    // Keep the strongest claim about each skill: a mention under Requirements
    // outranks the same word appearing in a benefits blurb.
    if (
      !existing ||
      PRECEDENCE[skill.requirement] > PRECEDENCE[existing.requirement] ||
      (PRECEDENCE[skill.requirement] === PRECEDENCE[existing.requirement] &&
        skill.confidence > existing.confidence)
    ) {
      found.set(skill.slug, skill);
    }
  };

  // ── 1. Section-scoped matches, strongest signal ───────────────────────────
  const scoped: Array<{ lines: string[]; requirement: SkillRequirementType; confidence: number }> = [
    { lines: input.sections.requirements, requirement: 'required', confidence: 0.92 },
    { lines: input.sections.preferredQualifications, requirement: 'optional', confidence: 0.85 },
    { lines: input.sections.responsibilities, requirement: 'preferred', confidence: 0.7 },
    { lines: input.sections.benefits, requirement: 'inferred', confidence: 0.3 },
    { lines: input.sections.other, requirement: 'preferred', confidence: 0.6 },
  ];

  for (const group of scoped) {
    for (const line of group.lines) {
      for (const { definition, pattern } of COMPILED) {
        const match = pattern.exec(line);
        if (!match) continue;

        // An inline cue inside the line overrides the section default.
        let requirement = group.requirement;
        let confidence = group.confidence;
        if (INLINE_PREFERRED.test(line)) {
          requirement = 'optional';
          confidence = Math.min(confidence, 0.8);
        } else if (INLINE_REQUIRED.test(line) && group.requirement !== 'optional') {
          requirement = 'required';
          confidence = Math.max(confidence, 0.9);
        }

        record({
          slug: definition.slug,
          displayName: definition.displayName,
          category: definition.category,
          requirement,
          confidence,
          method: 'taxonomy',
          matchedText: match[0].slice(0, 200),
          evidence: collapseWhitespace(line).slice(0, 400),
        });
      }
    }
  }

  // ── 2. Title matches ──────────────────────────────────────────────────────
  // A technology in the title ("React Engineer") is as strong as a requirement.
  for (const { definition, pattern } of COMPILED) {
    const match = pattern.exec(input.title);
    if (!match) continue;
    record({
      slug: definition.slug,
      displayName: definition.displayName,
      category: definition.category,
      requirement: 'required',
      confidence: 0.9,
      method: 'taxonomy',
      matchedText: match[0].slice(0, 200),
      evidence: `job title: ${collapseWhitespace(input.title).slice(0, 200)}`,
    });
  }

  // ── 3. Source tags ────────────────────────────────────────────────────────
  for (const tag of input.tags ?? []) {
    for (const { definition, pattern } of COMPILED) {
      if (!pattern.test(tag)) continue;
      record({
        slug: definition.slug,
        displayName: definition.displayName,
        category: definition.category,
        requirement: 'preferred',
        confidence: 0.65,
        method: 'source_structured',
        matchedText: tag.slice(0, 200),
        evidence: `source tag: ${tag}`,
      });
    }
  }

  // ── 4. Whole-description sweep ────────────────────────────────────────────
  // Catches skills in postings with no section structure at all.
  if (input.description) {
    for (const { definition, pattern } of COMPILED) {
      if (found.has(definition.slug)) continue;
      const match = pattern.exec(input.description);
      if (!match) continue;
      record({
        slug: definition.slug,
        displayName: definition.displayName,
        category: definition.category,
        requirement: 'preferred',
        confidence: 0.55,
        method: 'taxonomy',
        matchedText: match[0].slice(0, 200),
        evidence: sentenceAround(input.description, match.index ?? 0),
      });
    }
  }

  // ── 5. Contextual implication ─────────────────────────────────────────────
  const haystack = `${input.title}\n${input.description ?? ''}`;
  for (const rule of CONTEXTUAL_IMPLICATIONS) {
    const match = rule.pattern.exec(haystack);
    if (!match) continue;
    for (const slug of rule.slugs) {
      const definition = findSkill(slug);
      if (!definition) continue;
      record({
        slug: definition.slug,
        displayName: definition.displayName,
        category: definition.category,
        requirement: 'inferred',
        confidence: 0.5,
        method: 'heuristic',
        matchedText: match[0].slice(0, 200),
        evidence: `implied by "${rule.note}"`,
      });
    }
  }

  // ── 6. Transitive implication ─────────────────────────────────────────────
  // Snapshot first: implications must not cascade off other implications.
  for (const skill of [...found.values()]) {
    const definition = findSkill(skill.slug);
    for (const impliedSlug of definition?.implies ?? []) {
      if (found.has(impliedSlug)) continue;
      const implied = findSkill(impliedSlug);
      if (!implied) continue;
      record({
        slug: implied.slug,
        displayName: implied.displayName,
        category: implied.category,
        requirement: 'inferred',
        confidence: Math.max(0.4, skill.confidence - 0.25),
        method: 'heuristic',
        matchedText: null,
        evidence: `implied by ${skill.displayName}`,
      });
    }
  }

  return [...found.values()].sort(
    (a, b) => PRECEDENCE[b.requirement] - PRECEDENCE[a.requirement] || b.confidence - a.confidence,
  );
}

/** The sentence containing `index`, for readable evidence. */
function sentenceAround(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('.', index) + 1);
  const dot = text.indexOf('.', index);
  const end = dot === -1 ? Math.min(text.length, index + 200) : dot + 1;
  return collapseWhitespace(text.slice(start, end)).slice(0, 400);
}
