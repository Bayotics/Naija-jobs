import {
  jobCandidateViewSchema,
  resumeComparisonSchema,
  resumeFitSchema,
  type CandidateIntelligence,
  type JobCandidateView,
  type JobEnrichment,
  type RequirementMatrix,
  type ResumeComparison,
  type ResumeFit,
  type TransferableSkill,
} from '@job-intel/contracts';
import { SkillGraph } from '../skills/skill-graph';
import { analyseGaps, buildRequirementMatrix, type ParsedRequirement } from './requirement-matrix';
import type { DocumentExtraction } from './profile-builder';

/**
 * The job-specific candidate view.
 *
 * The same person looks different against different jobs, and that is not a
 * presentation trick — it is the actual answer. Someone with a decade of
 * backend work and two years of React is a strong backend candidate and a
 * middling frontend one, and a single static profile summary cannot say both.
 *
 * So this module reorders and re-explains the profile *for one job*: which
 * roles are relevant, which skills matter here, what is missing, what
 * transfers, and which of the candidate's resumes argues the case best.
 */

/**
 * Converts an enriched job into requirements the matrix can evaluate.
 *
 * `inferred` skills — ones the enrichment layer read between the lines — are
 * carried through as *not required*. A skill the posting never actually listed
 * must not be able to produce a hard gap.
 */
export function requirementsFromEnrichment(enrichment: JobEnrichment): ParsedRequirement[] {
  const requirements: ParsedRequirement[] = [];

  for (const skill of enrichment.skills) {
    requirements.push({
      text: skill.displayName,
      kind: 'skill',
      slug: skill.slug,
      required: skill.requirement === 'required',
    });
  }

  if (enrichment.experience.minimumYears !== null) {
    requirements.push({
      text: `${enrichment.experience.minimumYears}+ years of experience`,
      kind: 'experience_years',
      slug: null,
      required: true,
      minYears: enrichment.experience.minimumYears,
    });
  }

  if (enrichment.education.level !== null && enrichment.education.requirement !== 'not_specified') {
    requirements.push({
      text: `${enrichment.education.level.replace(/_/g, ' ')} degree`,
      kind: 'education',
      slug: null,
      required: enrichment.education.requirement === 'required',
      educationLevel: enrichment.education.level,
    });
  }

  for (const certification of enrichment.education.certifications) {
    requirements.push({
      text: certification,
      kind: 'certification',
      slug: null,
      required: false,
    });
  }

  if (enrichment.workAuthorization.workAuthorizationRequirement) {
    requirements.push({
      text: enrichment.workAuthorization.workAuthorizationRequirement,
      kind: 'work_authorization',
      slug: null,
      required: true,
    });
  }

  /*
   * Free-text requirement lines that no structured extractor claimed. These are
   * where the human-readable demands live — "experience leading a team",
   * "comfortable with ambiguity" — and dropping them would make the matrix look
   * complete while ignoring half of what the posting asks for.
   */
  const claimed = new Set(enrichment.skills.map((skill) => skill.displayName.toLowerCase()));

  for (const line of enrichment.requirements.slice(0, 30)) {
    const lower = line.toLowerCase();
    if ([...claimed].some((name) => lower.includes(name))) continue;
    requirements.push({ text: line.slice(0, 300), kind: 'other', slug: null, required: true });
  }

  for (const line of enrichment.preferredQualifications.slice(0, 20)) {
    const lower = line.toLowerCase();
    if ([...claimed].some((name) => lower.includes(name))) continue;
    requirements.push({ text: line.slice(0, 300), kind: 'other', slug: null, required: false });
  }

  return requirements.slice(0, 80);
}

/**
 * How well one document argues the case for one job (Part 36).
 *
 * Deliberately not the match score. Match asks whether the candidate should
 * apply; fit asks which document to send. Someone perfectly suited to a role
 * can have a resume that never mentions the relevant half of their career, and
 * merging the two numbers would hide exactly the problem worth telling them
 * about.
 */
export function scoreResumeFit(input: {
  document: DocumentExtraction;
  jobId: string;
  requirements: readonly ParsedRequirement[];
  graph?: SkillGraph;
  now?: Date;
}): ResumeFit {
  const graph = input.graph ?? new SkillGraph();
  const documentSlugs = input.document.skills.map((fact) => fact.slug);

  const covered: string[] = [];
  const uncovered: string[] = [];
  let earned = 0;
  let total = 0;

  const corpus = [
    ...input.document.experience.map((role) =>
      [role.title, role.description ?? '', ...role.responsibilities, ...role.achievements].join(' '),
    ),
    ...input.document.projects.map((project) => `${project.name} ${project.description ?? ''}`),
    input.document.summary ?? '',
  ]
    .join(' ')
    .toLowerCase();

  for (const requirement of input.requirements) {
    const weight = requirement.required ? 1 : 0.33;
    total += weight;

    if (requirement.kind === 'skill' && requirement.slug) {
      if (documentSlugs.includes(requirement.slug)) {
        covered.push(requirement.text);
        earned += weight;
        continue;
      }

      const route = graph.coverage(documentSlugs, requirement.slug);
      if (route && route.strength >= 0.45) {
        covered.push(`${requirement.text} (via ${route.via[0]})`);
        // Transfer counts, but less: the reader of this resume has to make the
        // connection themselves, and many will not.
        earned += weight * route.strength * 0.7;
        continue;
      }

      uncovered.push(requirement.text);
      continue;
    }

    const words = requirement.text
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 4);
    const hits = words.filter((word) => corpus.includes(word)).length;
    const ratio = words.length === 0 ? 0 : hits / words.length;

    if (ratio >= 0.6) {
      covered.push(requirement.text);
      earned += weight * ratio;
    } else {
      uncovered.push(requirement.text);
    }
  }

  const score = total === 0 ? 0 : Math.round((earned / total) * 100);

  return resumeFitSchema.parse({
    documentId: input.document.documentId,
    label: input.document.label,
    jobId: input.jobId,
    resumeFitScore: score,
    coveredRequirements: covered.slice(0, 40),
    uncoveredRequirements: uncovered.slice(0, 40),
    rationale:
      `This document evidences ${covered.length} of ${input.requirements.length} stated requirements` +
      (uncovered.length > 0
        ? `. It does not mention ${uncovered.slice(0, 3).join(', ')}${uncovered.length > 3 ? ` and ${uncovered.length - 3} more` : ''}.`
        : '.'),
  });
}

/**
 * Compares the candidate's documents against each other (Part 35).
 *
 * The useful output is not "which is best" — that depends entirely on the job —
 * but what each one uniquely says. A candidate maintaining three CVs usually
 * knows they are positioned differently; this makes that explicit, including
 * when a document has drifted so far that it evidences almost nothing the
 * others do.
 */
export function compareResumes(
  candidateId: string,
  documents: readonly DocumentExtraction[],
): ResumeComparison {
  const slugSets = documents.map((document) => new Set(document.skills.map((fact) => fact.slug)));

  const shared =
    slugSets.length === 0
      ? new Set<string>()
      : [...slugSets[0]!].filter((slug) => slugSets.every((set) => set.has(slug)));

  const entries = documents.map((document, index) => {
    const others = slugSets.filter((_, other) => other !== index);
    const unique = [...slugSets[index]!].filter((slug) => !others.some((set) => set.has(slug)));

    const topSkills = document.skills
      .slice(0, 5)
      .map((fact) => fact.name)
      .join(', ');

    return {
      documentId: document.documentId,
      label: document.label,
      targetRole: document.targetRole ?? null,
      skillCount: document.skills.length,
      experienceCount: document.experience.length,
      uniqueSkills: unique.slice(0, 60),
      positioning:
        `Leads with ${topSkills || 'no clearly evidenced skills'}` +
        (unique.length > 0 ? `; uniquely evidences ${unique.slice(0, 5).join(', ')}.` : '.'),
    };
  });

  const differences: string[] = [];

  for (const entry of entries) {
    if (entry.uniqueSkills.length > 0) {
      differences.push(
        `"${entry.label}" is the only document evidencing ${entry.uniqueSkills.slice(0, 6).join(', ')}.`,
      );
    }
  }

  const counts = entries.map((entry) => entry.experienceCount);
  if (counts.length > 1 && Math.max(...counts) - Math.min(...counts) >= 2) {
    const fullest = entries.reduce((best, entry) =>
      entry.experienceCount > best.experienceCount ? entry : best,
    );
    const thinnest = entries.reduce((worst, entry) =>
      entry.experienceCount < worst.experienceCount ? entry : worst,
    );
    differences.push(
      `"${fullest.label}" lists ${fullest.experienceCount} roles against ${thinnest.experienceCount} in "${thinnest.label}" — the shorter one may be omitting relevant history.`,
    );
  }

  return resumeComparisonSchema.parse({
    candidateId,
    documents: entries,
    sharedSkills: [...shared].slice(0, 120),
    differences: differences.slice(0, 40),
  });
}

/**
 * Assembles everything for one job.
 *
 * The `explanation` this produces is the prose that reaches the notification,
 * and it is built entirely from the matrix — every sentence traces back to a
 * row. Unknowns are stated as unknowns, transfers are stated as transfers, and
 * nothing is claimed that the evidence does not carry.
 */
export function buildJobCandidateView(input: {
  jobId: string;
  candidateId: string;
  profile: CandidateIntelligence;
  requirements: readonly ParsedRequirement[];
  documents?: readonly DocumentExtraction[];
  graph?: SkillGraph;
  matrix?: RequirementMatrix;
  now?: Date;
}): JobCandidateView {
  const now = input.now ?? new Date();
  const graph = input.graph ?? new SkillGraph();

  const matrix =
    input.matrix ??
    buildRequirementMatrix({
      jobId: input.jobId,
      candidateId: input.candidateId,
      profile: input.profile,
      requirements: input.requirements,
      graph,
      now,
    });

  const gaps = analyseGaps(matrix);

  const relevantSlugs = new Set(
    matrix.rows
      .filter((row) => row.kind === 'skill' && row.slug && row.support === 'SUPPORTED')
      .map((row) => row.slug!),
  );

  // Roles are relevant when they evidence a skill this job actually asks for.
  const relevantExperience = input.profile.experience
    .map((role) => ({
      role,
      overlap: role.technologies.filter((slug) => relevantSlugs.has(slug)).length,
    }))
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 10)
    .map((entry) => ({
      id: entry.role.id,
      summary:
        `${entry.role.title} at ${entry.role.company}` +
        (entry.role.dates.start.year ? ` (${entry.role.dates.start.year}–${entry.role.dates.isCurrent ? 'present' : (entry.role.dates.end.year ?? '?')})` : '') +
        ` — evidences ${entry.overlap} of this job's skills.`,
    }));

  const relevantProjects = input.profile.projects
    .map((project) => ({
      project,
      overlap: project.technologies.filter((slug) => relevantSlugs.has(slug)).length,
    }))
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 10)
    .map((entry) => ({
      id: entry.project.id,
      summary: `${entry.project.name} (${entry.project.context}) — uses ${entry.project.technologies
        .filter((slug) => relevantSlugs.has(slug))
        .slice(0, 4)
        .join(', ')}.`,
    }));

  const transferable: TransferableSkill[] = matrix.rows.flatMap((row) => row.transferable).slice(0, 20);

  const resumeFits = (input.documents ?? [])
    .map((document) =>
      scoreResumeFit({ document, jobId: input.jobId, requirements: input.requirements, graph, now }),
    )
    .sort((a, b) => b.resumeFitScore - a.resumeFitScore)
    .slice(0, 10);

  const supportedRows = matrix.rows.filter((row) => row.support === 'SUPPORTED');
  const evidenceConfidence =
    supportedRows.length === 0
      ? 0
      : supportedRows.reduce((sum, row) => {
          const mean =
            row.evidence.length === 0
              ? row.strength * 0.5
              : row.evidence.reduce((inner, item) => inner + item.confidence, 0) / row.evidence.length;
          return sum + mean;
        }, 0) / supportedRows.length;

  // ── Explanation ─────────────────────────────────────────────────────────
  const sentences: string[] = [];

  const direct = matrix.rows.filter((row) => row.evidenceKind === 'direct' && row.kind === 'skill');
  if (direct.length > 0) {
    sentences.push(
      `Direct evidence for ${direct.length} of this job's skills: ${direct
        .slice(0, 5)
        .map((row) => row.requirement)
        .join(', ')}${direct.length > 5 ? `, and ${direct.length - 5} more` : ''}.`,
    );
  }

  if (gaps.transferable.length > 0) {
    sentences.push(
      `${gaps.transferable.length} requirement${gaps.transferable.length === 1 ? '' : 's'} met through related experience rather than directly: ${gaps.transferable
        .slice(0, 3)
        .map((entry) => entry.requirement)
        .join(', ')}.`,
    );
  }

  if (gaps.hardGaps.length > 0) {
    sentences.push(
      `Not met: ${gaps.hardGaps.slice(0, 4).map((entry) => entry.requirement).join(', ')}.`,
    );
  }

  if (gaps.unknowns.length > 0) {
    // The wording matters: the profile is silent, which is not the same as a no.
    sentences.push(
      `Your profile does not say either way about ${gaps.unknowns
        .slice(0, 4)
        .map((entry) => entry.requirement)
        .join(', ')}${gaps.unknowns.length > 4 ? `, and ${gaps.unknowns.length - 4} other requirements` : ''}. These are unknowns, not gaps.`,
    );
  }

  if (resumeFits.length > 1) {
    sentences.push(
      `Of your documents, "${resumeFits[0]!.label}" argues this best (${resumeFits[0]!.resumeFitScore}/100 coverage).`,
    );
  }

  return jobCandidateViewSchema.parse({
    jobId: input.jobId,
    candidateId: input.candidateId,
    matrix,
    relevantExperience,
    relevantProjects,
    relevantSkills: [...relevantSlugs].slice(0, 40),
    gaps: [
      ...gaps.hardGaps.map((entry) => entry.detail),
      ...gaps.unknowns.map((entry) => entry.question),
    ].slice(0, 20),
    transferable,
    resumeFits,
    evidenceConfidence: Math.round(evidenceConfidence * 100) / 100,
    explanation: sentences.join(' ').slice(0, 2_000),
  });
}

/**
 * A profile summary, generated from the facts (Part 38).
 *
 * Deterministic and hedged. Every clause is traceable to a field, and where the
 * evidence is thin the sentence says so rather than rounding up — this text is
 * shown to the candidate as the system's understanding of them, and it needs to
 * be recognisable rather than flattering.
 */
export function generateProfileSummary(profile: CandidateIntelligence): string {
  if (profile.experience.length === 0 && profile.skills.length === 0) {
    return 'Not enough information has been extracted yet to describe this profile.';
  }

  const parts: string[] = [];

  const months = profile.trajectory.totalExperienceMonths;
  const level = profile.seniority.estimatedLevel;

  if (months !== null && level) {
    parts.push(
      `About ${(months / 12).toFixed(1)} years of recorded experience, reading as ${level} level${
        profile.seniority.confidence < 0.5 ? ' on limited evidence' : ''
      }.`,
    );
  } else if (months !== null) {
    parts.push(`About ${(months / 12).toFixed(1)} years of recorded experience.`);
  } else if (profile.experience.length > 0) {
    parts.push(
      `${profile.experience.length} role${profile.experience.length === 1 ? '' : 's'} recorded, without dates.`,
    );
  }

  const strongest = profile.skills
    .filter((skill) => skill.strongestSource !== 'resume_skill_section')
    .slice(0, 6);

  if (strongest.length > 0) {
    parts.push(
      `Strongest evidence sits with ${strongest.map((skill) => skill.name).join(', ')}.`,
    );
  }

  const current = profile.experience.find((role) => role.dates.isCurrent);
  if (current) parts.push(`Currently ${current.title} at ${current.company}.`);

  const rising = profile.trajectory.dimensions
    .filter((entry) => entry.direction > 0.3 && entry.confidence >= 0.4)
    .map((entry) => entry.dimension.replace(/_/g, ' '));

  if (rising.length > 0) parts.push(`Trajectory shows growth in ${rising.join(' and ')}.`);

  if (profile.openConflicts > 0) {
    parts.push(
      `${profile.openConflicts} unresolved contradiction${profile.openConflicts === 1 ? '' : 's'} between documents.`,
    );
  }

  return parts.join(' ').slice(0, 2_000);
}
