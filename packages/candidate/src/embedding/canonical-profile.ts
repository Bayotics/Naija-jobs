import { createHash } from 'node:crypto';
import type {
  CandidatePreferences,
  CandidateProfilePayload,
  CandidateSkillEntry,
} from '@job-intel/contracts';

/**
 * Canonical profile text and embedding staleness.
 *
 * The semantic representation of the candidate is *derived*, never authored.
 * A deterministic function turns the structured profile into prose, and the
 * hash of that prose decides whether the stored embedding still represents the
 * candidate:
 *
 *   profile/preferences change → canonical text changes → hash changes
 *   → embedding marked stale → regeneration queued
 *
 * Because the text is a pure function of the profile, "is this embedding
 * current?" is a string comparison rather than a guess, and re-embedding never
 * happens for a change that carries no semantic content (a salary floor, say).
 */

export interface CanonicalProfileInput {
  profile: CandidateProfilePayload;
  preferences: CandidatePreferences;
  skills: readonly CandidateSkillEntry[];
}

export interface CanonicalProfile {
  text: string;
  /** SHA-256 of the text. Stored alongside the embedding. */
  hash: string;
  /** Which sections contributed, for debugging a surprising embedding. */
  sections: string[];
}

/**
 * Builds the canonical text.
 *
 * Ordering is fixed and content is normalised (sorted, lower-cased where
 * appropriate) so that semantically identical profiles produce byte-identical
 * text. Without that, re-saving an unchanged profile would churn embeddings.
 */
export function buildCanonicalProfile(input: CanonicalProfileInput): CanonicalProfile {
  const { profile, preferences, skills } = input;
  const parts: string[] = [];
  const sections: string[] = [];

  // ── Headline ──────────────────────────────────────────────────────────────
  const professional = profile.professional;
  const headline: string[] = [];
  if (professional.currentTitle) headline.push(professional.currentTitle);
  if (professional.seniority) headline.push(`${professional.seniority} level`);
  if (professional.yearsOfExperience !== undefined && professional.yearsOfExperience !== null) {
    headline.push(`${professional.yearsOfExperience} years of professional experience`);
  }
  if (headline.length > 0) {
    parts.push(headline.join(', ') + '.');
    sections.push('headline');
  }

  if (professional.summary) {
    parts.push(professional.summary.trim());
    sections.push('summary');
  }

  // ── Skills, strongest first ───────────────────────────────────────────────
  // Primary skills carry the most semantic weight, so they lead. Proficiency
  // and recency are stated in words because the embedding reads prose.
  const ordered = [...skills].sort((a, b) => {
    const rank = { primary: 0, secondary: 1, peripheral: 2 } as const;
    const byImportance = rank[a.importance] - rank[b.importance];
    if (byImportance !== 0) return byImportance;
    return (b.yearsOfExperience ?? 0) - (a.yearsOfExperience ?? 0);
  });

  const skillPhrases = ordered.slice(0, 40).map((skill) => {
    const bits = [skill.name];
    if (skill.proficiency) bits.push(skill.proficiency);
    if (skill.yearsOfExperience) bits.push(`${skill.yearsOfExperience} years`);
    return bits.length > 1 ? `${bits[0]} (${bits.slice(1).join(', ')})` : `${bits[0]}`;
  });
  if (skillPhrases.length > 0) {
    parts.push(`Skills: ${skillPhrases.join('; ')}.`);
    sections.push('skills');
  }

  // ── Target roles ──────────────────────────────────────────────────────────
  // Only positive strengths belong in the semantic profile: an excluded title
  // describes what the candidate is not, and embedding it would pull the vector
  // *towards* the thing they are avoiding.
  const wantedTitles = preferences.titles
    .filter((t) => ['required', 'strongly_preferred', 'preferred'].includes(t.strength))
    .map((t) => t.value);
  if (wantedTitles.length > 0) {
    parts.push(`Seeking roles such as ${wantedTitles.join(', ')}.`);
    sections.push('titles');
  }

  const wantedTech = preferences.technologies
    .filter((t) => ['required', 'strongly_preferred', 'preferred'].includes(t.strength))
    .map((t) => t.value);
  if (wantedTech.length > 0) {
    parts.push(`Wants to work with ${wantedTech.join(', ')}.`);
    sections.push('technologies');
  }

  const wantedIndustries = preferences.industries
    .filter((i) => ['required', 'strongly_preferred', 'preferred'].includes(i.strength))
    .map((i) => i.value);
  if (wantedIndustries.length > 0) {
    parts.push(`Interested in ${wantedIndustries.join(', ')} industries.`);
    sections.push('industries');
  }

  if (preferences.seniorityLevels.length > 0) {
    parts.push(`Targeting ${preferences.seniorityLevels.join(', ')} positions.`);
    sections.push('seniority');
  }

  // ── Background ────────────────────────────────────────────────────────────
  if (professional.industries.length > 0) {
    parts.push(`Industry background: ${[...professional.industries].sort().join(', ')}.`);
    sections.push('background');
  }

  const education = profile.professional.education
    .map((e) => [e.degree, e.field, e.institution].filter(Boolean).join(' in '))
    .filter((e) => e.length > 0);
  if (education.length > 0) {
    parts.push(`Education: ${education.join('; ')}.`);
    sections.push('education');
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return {
    text,
    hash: createHash('sha256').update(text).digest('hex'),
    sections,
  };
}

export interface EmbeddingState {
  /** Hash of the text the stored embedding was generated from. */
  storedHash: string | null;
  storedModel: string | null;
  currentModel: string;
}

/**
 * Decides whether the embedding needs regenerating.
 *
 * Two independent triggers: the profile changed, or the embedding model did.
 * A model change invalidates every vector because distances are not comparable
 * across models — mixing them silently degrades every similarity score.
 */
export function isEmbeddingStale(
  canonical: CanonicalProfile,
  state: EmbeddingState,
): { stale: boolean; reason: string } {
  if (state.storedHash === null) {
    return { stale: true, reason: 'no embedding has been generated yet' };
  }
  if (state.storedModel !== state.currentModel) {
    return {
      stale: true,
      reason: `embedding model changed from ${state.storedModel ?? 'none'} to ${state.currentModel}`,
    };
  }
  if (state.storedHash !== canonical.hash) {
    return { stale: true, reason: 'profile content changed since the embedding was generated' };
  }
  return { stale: false, reason: 'embedding is current' };
}
