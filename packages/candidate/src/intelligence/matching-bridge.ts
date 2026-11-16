import {
  candidateSkillEntrySchema,
  type SKILL_PROFICIENCIES,
  type CandidateIntelligence,
  type CandidateSkillEntry,
  type JobCandidateView,
  type ProficiencyLevel,
  type RequirementMatrix,
} from '@job-intel/contracts';

/**
 * The bridge from candidate intelligence into matching.
 *
 * Two conversions, and both are deliberately lossy in one direction only.
 *
 * The matching engine was built in prompt 6 against a hand-maintained skill
 * list. This layer produces the same shape from evidence, so matching gets
 * better inputs without being rewritten — and, critically, without matching
 * gaining any new authority. Nothing here can create a skill the evidence does
 * not support, and nothing here touches preferences or hard constraints.
 *
 * The tri-state survives the crossing. A requirement the profile is silent on
 * arrives at the explanation as an unknown, not as an absent skill, because the
 * whole point of the intelligence layer is lost the moment "we don't know"
 * becomes "they don't have it".
 */

/** Intelligence proficiency → the matching engine's coarser vocabulary. */
const PROFICIENCY_MAP: Readonly<Record<ProficiencyLevel, (typeof SKILL_PROFICIENCIES)[number]>> = {
  BEGINNER: 'beginner',
  WORKING: 'intermediate',
  PROFICIENT: 'advanced',
  ADVANCED: 'advanced',
  EXPERT: 'expert',
};

/**
 * Skill entries for the matching engine, derived from evidence.
 *
 * Only skills the profile can actually evidence are emitted, and the `evidence`
 * string carries where it came from so a match explanation can quote it.
 *
 * Skills with nothing but a skills-section mention are included but marked
 * `secondary` with no years: they are real claims the candidate made, and
 * dropping them would lose genuine information, but they must not carry the
 * same weight as a skill used in a two-year role.
 */
export function skillEntriesFromProfile(profile: CandidateIntelligence): CandidateSkillEntry[] {
  const entries: CandidateSkillEntry[] = [];

  for (const fact of profile.skills) {
    const evidenced =
      fact.strongestSource !== null && fact.strongestSource !== 'resume_skill_section';

    const parsed = candidateSkillEntrySchema.safeParse({
      name: fact.name,
      slug: fact.slug,
      category: fact.category,
      proficiency: fact.proficiency ? PROFICIENCY_MAP[fact.proficiency] : null,
      // Years only where a duration was actually established. A skill with no
      // datable evidence must arrive as null, never as zero — zero reads as
      // "no experience" everywhere downstream.
      yearsOfExperience:
        fact.totalMonths === null ? null : Math.round((fact.totalMonths / 12) * 10) / 10,
      lastUsedYear: fact.lastEvidencedAt ? fact.lastEvidencedAt.getUTCFullYear() : null,
      importance: evidenced && (fact.totalMonths ?? 0) >= 24 ? 'core' : 'secondary',
      evidence: fact.evidence[0]?.context ?? (evidenced ? null : 'Listed in a skills section'),
      // Extracted from a document the candidate supplied, or confirmed by hand.
      source: fact.userVerified ? 'explicit' : 'derived',
    });

    if (parsed.success) entries.push(parsed.data);
  }

  return entries;
}

/**
 * Evidence for the explanation layer.
 *
 * Shaped to the `CandidateEvidence` interface the explainer declares, without
 * this package importing the matching package — the dependency runs matching →
 * candidate, and reversing it here would make the graph cyclic.
 */
export interface MatchEvidenceBundle {
  direct: Array<{ requirement: string; context: string }>;
  transferable: Array<{ requirement: string; via: string }>;
  unknown: string[];
  evidenceConfidence: number;
  bestDocument: { label: string; score: number } | null;
}

export function evidenceForExplanation(
  matrix: RequirementMatrix,
  view?: JobCandidateView | null,
): MatchEvidenceBundle {
  const direct: MatchEvidenceBundle['direct'] = [];
  const transferable: MatchEvidenceBundle['transferable'] = [];
  const unknown: string[] = [];

  for (const row of matrix.rows) {
    if (row.evidenceKind === 'direct' && row.support === 'SUPPORTED') {
      direct.push({
        requirement: row.requirement,
        // The origin of the strongest piece of evidence, which is what makes
        // the sentence checkable rather than merely confident.
        context: row.evidence[0]?.context ?? 'your profile',
      });
      continue;
    }

    if (row.evidenceKind === 'transferable') {
      transferable.push({
        requirement: row.requirement,
        via: row.transferable[0]?.fromSlug ?? 'a related skill',
      });
      continue;
    }

    if (row.support === 'UNKNOWN') unknown.push(row.requirement);
  }

  const best = view?.resumeFits[0] ?? null;

  return {
    direct,
    transferable,
    unknown,
    evidenceConfidence: view?.evidenceConfidence ?? 0,
    bestDocument: best ? { label: best.label, score: best.resumeFitScore } : null,
  };
}

/**
 * How much the matrix should move a match score, and in which direction.
 *
 * Deliberately small and deliberately bounded. The matrix is a second opinion
 * on requirement coverage, not a replacement for the scoring engine, and a
 * bridge that could swing a score by thirty points would quietly become the
 * matching algorithm.
 *
 * Unknowns never subtract. A profile that is silent on half a posting's
 * requirements should not score below one that explicitly fails them — that
 * ranking would be exactly backwards.
 */
export function evidenceAdjustment(matrix: RequirementMatrix): {
  points: number;
  reason: string;
} {
  const required = matrix.rows.filter((row) => row.required);
  if (required.length === 0) return { points: 0, reason: 'The posting states no hard requirements.' };

  const supported = required.filter((row) => row.support === 'SUPPORTED').length;
  const notSupported = required.filter((row) => row.support === 'NOT_SUPPORTED').length;
  const unknowns = required.filter((row) => row.support === 'UNKNOWN').length;

  // Only requirements the profile can actually speak to are scored; unknowns
  // are excluded from the denominator rather than counted as failures.
  const answerable = supported + notSupported;
  if (answerable === 0) {
    return {
      points: 0,
      reason: `Your profile does not address any of the ${required.length} stated requirements, so this adds nothing either way.`,
    };
  }

  const ratio = supported / answerable;
  const points = Math.round((ratio - 0.5) * 10);

  return {
    points,
    reason:
      `Evidence covers ${supported} of ${answerable} requirements your profile can speak to` +
      (unknowns > 0 ? `; ${unknowns} more are unknown and were not counted against you.` : '.'),
  };
}
