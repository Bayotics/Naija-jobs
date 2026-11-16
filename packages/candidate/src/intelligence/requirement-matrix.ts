import {
  requirementEvidenceSchema,
  requirementMatrixSchema,
  transferableSkillSchema,
  type CandidateIntelligence,
  type CandidateSkillFact,
  type EvidenceItem,
  type MatchEvidenceKind,
  type RequirementEvidence,
  type RequirementKind,
  type RequirementMatrix,
  type SupportState,
  type TransferableSkill,
} from '@job-intel/contracts';
import { SkillGraph } from '../skills/skill-graph';

/**
 * The requirement evidence matrix.
 *
 * For every requirement a job states, this answers three separate questions and
 * keeps the answers separate:
 *
 *  1. Is it met? (`support`: SUPPORTED / NOT_SUPPORTED / UNKNOWN)
 *  2. How is it met? (`evidenceKind`: direct / transferable / adjacent)
 *  3. What is the proof? (`evidence`: the actual excerpts, with origins)
 *
 * The distinction the brief insists on lives in the gap between `missing` and
 * `insufficient_evidence`. A resume that never mentions German does not tell us
 * the candidate lacks German — it tells us the resume does not say. Rendering
 * those identically produces two failures at once: honest candidates get
 * screened out for things they can do, and the explanation shown to the user is
 * a lie about what the system knows.
 *
 * So absence of evidence produces UNKNOWN, and UNKNOWN is a first-class state
 * that survives all the way to the UI, where it is shown as a question the
 * candidate can answer rather than a red cross.
 */

/** A requirement as stated by a job, after the enrichment layer parses it. */
export interface ParsedRequirement {
  text: string;
  kind: RequirementKind;
  /** Canonical skill slug when the requirement names one. */
  slug: string | null;
  required: boolean;
  /** Years demanded, when the requirement states a number. */
  minYears?: number | null;
  /** Education level demanded, e.g. `bachelors`. */
  educationLevel?: string | null;
}

export interface MatrixInput {
  jobId: string;
  candidateId: string;
  profile: CandidateIntelligence;
  requirements: readonly ParsedRequirement[];
  graph?: SkillGraph;
  now?: Date;
}

/** Strength below which a graph route is too weak to call transferable. */
const TRANSFER_FLOOR = 0.45;
/** Strength below which a route is merely adjacent — related, not equivalent. */
const ADJACENT_FLOOR = 0.25;

const EDUCATION_ORDER = ['none', 'high_school', 'diploma', 'bachelors', 'masters', 'doctorate'];

/**
 * Evidence a skill requirement is met directly.
 *
 * Strength reflects both proficiency and recency: five years of React ending in
 * 2016 and five years ending last month are not the same answer to "do you know
 * React", and a matrix that scores them identically will keep recommending
 * roles the candidate has long since moved away from.
 */
function directStrength(fact: CandidateSkillFact, now: Date): number {
  const byProficiency: Record<string, number> = {
    BEGINNER: 0.4,
    WORKING: 0.6,
    PROFICIENT: 0.8,
    ADVANCED: 0.92,
    EXPERT: 1,
  };

  let strength = fact.proficiency ? byProficiency[fact.proficiency]! : 0.5;

  if (fact.lastEvidencedAt) {
    const months = (now.getTime() - fact.lastEvidencedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    // Gentle decay: skills do not evaporate, but currency is real.
    if (months > 24) strength *= 0.9;
    if (months > 48) strength *= 0.85;
    if (months > 84) strength *= 0.8;
  }

  // The candidate confirming it by hand is the strongest evidence available.
  if (fact.userVerified) strength = Math.max(strength, 0.9);

  return Math.round(Math.min(1, strength) * 100) / 100;
}

function yearsEvidence(profile: CandidateIntelligence): number | null {
  const months = profile.trajectory.totalExperienceMonths;
  return months === null ? null : months / 12;
}

/** One matrix row. */
function evaluateRequirement(
  requirement: ParsedRequirement,
  profile: CandidateIntelligence,
  graph: SkillGraph,
  now: Date,
): RequirementEvidence {
  const skillBySlug = new Map(profile.skills.map((fact) => [fact.slug, fact]));

  const row = (
    evidenceKind: MatchEvidenceKind,
    strength: number,
    support: SupportState,
    explanation: string,
    evidence: readonly EvidenceItem[] = [],
    transferable: readonly TransferableSkill[] = [],
  ): RequirementEvidence =>
    requirementEvidenceSchema.parse({
      requirement: requirement.text,
      kind: requirement.kind,
      slug: requirement.slug,
      required: requirement.required,
      evidenceKind,
      strength: Math.round(Math.min(1, Math.max(0, strength)) * 100) / 100,
      support,
      evidence: evidence.slice(0, 10),
      transferable: transferable.slice(0, 6),
      explanation,
    });

  switch (requirement.kind) {
    // ── Skills ────────────────────────────────────────────────────────────
    case 'skill': {
      if (!requirement.slug) {
        return row(
          'insufficient_evidence',
          0,
          'UNKNOWN',
          'This requirement could not be matched to a known skill, so the profile cannot be checked against it.',
        );
      }

      const direct = skillBySlug.get(requirement.slug);

      if (direct) {
        const strength = directStrength(direct, now);
        return row(
          'direct',
          strength,
          'SUPPORTED',
          `${direct.name} is evidenced directly — ${direct.proficiencyRationale || 'found in the profile'}`,
          direct.evidence,
        );
      }

      // Nothing direct. Does anything transfer?
      const route = graph.coverage(
        profile.skills.map((fact) => fact.slug),
        requirement.slug,
      );

      if (route && route.strength >= TRANSFER_FLOOR) {
        const sourceSlug = route.via[0]!;
        const source = skillBySlug.get(sourceSlug);
        const sourceStrength = source ? directStrength(source, now) : 0.5;

        const transfer = transferableSkillSchema.parse({
          fromSlug: sourceSlug,
          toSlug: requirement.slug,
          // Transfer is never equivalence, so the product is capped below 1.
          strength: Math.min(0.95, route.strength * sourceStrength),
          rationale: `${source?.name ?? sourceSlug} demonstrates related capability.`,
          via: route.via,
        });

        return row(
          'transferable',
          transfer.strength,
          // Transferable evidence supports the requirement, but the row records
          // *how*, so the explanation never claims direct experience.
          'SUPPORTED',
          `No direct evidence of this skill, but ${source?.name ?? sourceSlug} transfers${
            route.via.length > 2 ? ` via ${route.via.slice(1, -1).join(' → ')}` : ''
          }. Related experience is not the same as direct experience.`,
          source?.evidence ?? [],
          [transfer],
        );
      }

      if (route && route.strength >= ADJACENT_FLOOR) {
        return row(
          'adjacent',
          route.strength * 0.5,
          'UNKNOWN',
          `${route.via[0]} is loosely related, but not close enough to stand in for this requirement. The profile does not say either way.`,
          [],
          [],
        );
      }

      /*
       * The important branch. Nothing in the profile mentions this skill —
       * which is not the same as the candidate not having it. Resumes are
       * lossy: people leave off skills they consider obvious, skills from
       * older roles, and skills they use daily but never wrote down.
       */
      return row(
        'insufficient_evidence',
        0,
        'UNKNOWN',
        `Nothing in the profile mentions this. That is not evidence the candidate lacks it — the documents simply do not say.`,
      );
    }

    // ── Years of experience ───────────────────────────────────────────────
    case 'experience_years': {
      const years = yearsEvidence(profile);
      const needed = requirement.minYears ?? null;

      if (years === null) {
        return row(
          'insufficient_evidence',
          0,
          'UNKNOWN',
          'No datable employment history was found, so total experience could not be established.',
        );
      }

      if (needed === null) {
        return row(
          'direct',
          0.6,
          'SUPPORTED',
          `About ${years.toFixed(1)} years of experience recorded; the requirement does not state a number.`,
        );
      }

      if (years >= needed) {
        return row(
          'direct',
          1,
          'SUPPORTED',
          `About ${years.toFixed(1)} years recorded against ${needed} required.`,
        );
      }

      // Genuinely short. This is one of the few cases where the profile really
      // does establish the negative, because dates are dates.
      const ratio = years / needed;
      return row(
        ratio >= 0.75 ? 'adjacent' : 'missing',
        ratio,
        ratio >= 0.75 ? 'UNKNOWN' : 'NOT_SUPPORTED',
        ratio >= 0.75
          ? `About ${years.toFixed(1)} years recorded against ${needed} required — close enough that stated experience may differ from what the documents show.`
          : `About ${years.toFixed(1)} years recorded against ${needed} required.`,
      );
    }

    // ── Education ─────────────────────────────────────────────────────────
    case 'education': {
      if (profile.education.length === 0) {
        return row(
          'insufficient_evidence',
          0,
          'UNKNOWN',
          'No education records were found in the profile.',
        );
      }

      const needed = requirement.educationLevel ?? null;
      const highest = profile.education
        .map((record) => EDUCATION_ORDER.indexOf(record.level ?? 'none'))
        .reduce((max, index) => Math.max(max, index), -1);

      if (needed === null) {
        const best = profile.education[0]!;
        return row(
          'direct',
          0.7,
          'SUPPORTED',
          `${best.degree ?? best.level ?? 'A qualification'} from ${best.institution} is recorded.`,
        );
      }

      const neededIndex = EDUCATION_ORDER.indexOf(needed);
      if (neededIndex < 0 || highest < 0) {
        return row(
          'insufficient_evidence',
          0,
          'UNKNOWN',
          'The required qualification level could not be compared with what the profile records.',
        );
      }

      if (highest >= neededIndex) {
        return row(
          'direct',
          1,
          'SUPPORTED',
          `Holds ${EDUCATION_ORDER[highest]} against ${needed} required.`,
        );
      }

      return row(
        'missing',
        highest / Math.max(1, neededIndex),
        'NOT_SUPPORTED',
        `The highest recorded qualification is ${EDUCATION_ORDER[highest]}, below the ${needed} required.`,
      );
    }

    // ── Certifications ────────────────────────────────────────────────────
    case 'certification': {
      const needle = requirement.text.toLowerCase();
      const held = profile.certifications.find(
        (record) =>
          needle.includes(record.name.toLowerCase()) || record.name.toLowerCase().includes(needle.slice(0, 30)),
      );

      if (held) {
        return row(
          'direct',
          held.verification === 'VERIFIED' ? 1 : 0.85,
          'SUPPORTED',
          `Holds ${held.name}${held.issuer ? ` from ${held.issuer}` : ''}. The system has not verified this with the issuer.`,
        );
      }

      return row(
        'insufficient_evidence',
        0,
        'UNKNOWN',
        'No matching certification appears in the profile. It may be held but not listed.',
      );
    }

    // ── Languages ─────────────────────────────────────────────────────────
    case 'language': {
      const needle = requirement.text.toLowerCase();
      const spoken = profile.languages.find((record) => needle.includes(record.language.toLowerCase()));

      if (spoken) {
        return row(
          'direct',
          spoken.proficiency === 'UNKNOWN' ? 0.6 : 0.9,
          'SUPPORTED',
          `${spoken.language} is listed${
            spoken.proficiency === 'UNKNOWN' ? ' with no stated level' : ` at ${spoken.proficiency.toLowerCase()} level`
          }.`,
        );
      }

      return row(
        'insufficient_evidence',
        0,
        'UNKNOWN',
        'This language is not listed in the profile. Resumes commonly omit languages, so this is not evidence it is not spoken.',
      );
    }

    /*
     * Work authorisation, location and licences are eligibility questions that
     * a resume cannot answer. They are answered from explicit preferences and
     * hard constraints, never inferred here — the matching engine's constraint
     * evaluator owns them, and this matrix records that it does not know.
     */
    case 'work_authorization':
    case 'location':
    case 'license':
      return row(
        'insufficient_evidence',
        0,
        'UNKNOWN',
        'This is an eligibility question that the resume cannot answer. It is decided from the candidate\'s stated constraints, not inferred from documents.',
      );

    default: {
      // Free-text requirement. Look for its distinctive words in the profile.
      const words = requirement.text
        .toLowerCase()
        .split(/\W+/)
        .filter((word) => word.length > 4);

      const corpus = [
        ...profile.experience.map((role) =>
          [role.title, role.description ?? '', ...role.responsibilities, ...role.achievements].join(' '),
        ),
        ...profile.projects.map((project) => `${project.name} ${project.description ?? ''}`),
      ]
        .join(' ')
        .toLowerCase();

      const hits = words.filter((word) => corpus.includes(word));
      const ratio = words.length === 0 ? 0 : hits.length / words.length;

      if (ratio >= 0.6) {
        return row(
          'direct',
          ratio,
          'SUPPORTED',
          `The profile discusses ${hits.slice(0, 4).join(', ')}, which the requirement asks about.`,
        );
      }

      return row(
        'insufficient_evidence',
        ratio,
        'UNKNOWN',
        'The profile does not clearly address this requirement.',
      );
    }
  }
}

/**
 * Builds the full matrix.
 *
 * `coverageScore` counts *stated* requirements only, and unknowns count as
 * neither met nor unmet — they lower coverage without being scored as failures,
 * which is the only honest arithmetic available when the profile is silent.
 */
export function buildRequirementMatrix(input: MatrixInput): RequirementMatrix {
  const now = input.now ?? new Date();
  const graph = input.graph ?? new SkillGraph();

  const rows = input.requirements
    .slice(0, 80)
    .map((requirement) => evaluateRequirement(requirement, input.profile, graph, now));

  const directMatches = rows.filter((row) => row.evidenceKind === 'direct').length;
  const transferableMatches = rows.filter((row) => row.evidenceKind === 'transferable').length;
  const unknowns = rows.filter((row) => row.support === 'UNKNOWN').length;
  const missing = rows.filter((row) => row.support === 'NOT_SUPPORTED').length;

  // Required rows carry full weight; nice-to-haves carry a third.
  const weightOf = (row: RequirementEvidence): number => (row.required ? 1 : 0.33);
  const totalWeight = rows.reduce((sum, row) => sum + weightOf(row), 0);
  const earned = rows.reduce((sum, row) => sum + weightOf(row) * row.strength, 0);

  const coverageScore = totalWeight === 0 ? 0 : Math.round((earned / totalWeight) * 100);

  return requirementMatrixSchema.parse({
    jobId: input.jobId,
    candidateId: input.candidateId,
    rows,
    directMatches,
    transferableMatches,
    unknowns,
    missing,
    coverageScore,
    profileVersion: input.profile.profileVersion,
    computedAt: now,
  });
}

/**
 * Gap analysis (Part 28).
 *
 * Splits what is genuinely absent from what is merely unrecorded, because the
 * two call for opposite responses: a real gap is something to learn, an
 * unrecorded one is something to add to the resume.
 */
export interface GapAnalysis {
  /** Requirements the profile actively fails. */
  hardGaps: Array<{ requirement: string; detail: string; required: boolean }>;
  /** Requirements the profile is simply silent on. */
  unknowns: Array<{ requirement: string; question: string; required: boolean }>;
  /** Requirements met only through transfer, worth naming in an application. */
  transferable: Array<{ requirement: string; detail: string; strength: number }>;
  /** True when every *required* row is supported. */
  meetsAllRequired: boolean;
}

export function analyseGaps(matrix: RequirementMatrix): GapAnalysis {
  const hardGaps: GapAnalysis['hardGaps'] = [];
  const unknowns: GapAnalysis['unknowns'] = [];
  const transferable: GapAnalysis['transferable'] = [];

  for (const row of matrix.rows) {
    if (row.support === 'NOT_SUPPORTED') {
      hardGaps.push({ requirement: row.requirement, detail: row.explanation, required: row.required });
      continue;
    }

    if (row.support === 'UNKNOWN') {
      unknowns.push({
        requirement: row.requirement,
        // Phrased as a question, because that is what it is.
        question: `Do you have experience with ${row.requirement}? Nothing in your profile says either way.`,
        required: row.required,
      });
      continue;
    }

    if (row.evidenceKind === 'transferable') {
      transferable.push({
        requirement: row.requirement,
        detail: row.explanation,
        strength: row.strength,
      });
    }
  }

  return {
    hardGaps,
    unknowns,
    transferable,
    meetsAllRequired: matrix.rows
      .filter((row) => row.required)
      .every((row) => row.support === 'SUPPORTED'),
  };
}

/**
 * Hard requirement check (Part 27).
 *
 * Returns the tri-state per required row. Note what this deliberately does not
 * do: it does not collapse UNKNOWN into a pass or a fail. The matching engine
 * decides what to do with an unknown hard requirement, and the answer there is
 * to surface it as a question rather than to reject the job.
 */
export function checkHardRequirements(
  matrix: RequirementMatrix,
): Array<{ requirement: string; support: SupportState; explanation: string }> {
  return matrix.rows
    .filter((row) => row.required)
    .map((row) => ({
      requirement: row.requirement,
      support: row.support,
      explanation: row.explanation,
    }));
}
