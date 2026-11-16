import { randomUUID } from 'node:crypto';
import {
  EVIDENCE_SOURCE_WEIGHT,
  candidateIntelligenceSchema,
  profileConflictSchema,
  profileQualitySchema,
  type AchievementRecord,
  type CandidateIntelligence,
  type CandidateSkillFact,
  type CertificationRecord,
  type ConflictKind,
  type EducationRecord,
  type ExperienceEntry,
  type FieldOverride,
  type LanguageRecord,
  type ProfileConflict,
  type ProfileQuality,
  type ProjectRecord,
  type SeniorityEstimate,
  type CareerTrajectory,
} from '@job-intel/contracts';

/**
 * Profile assembly from one or more documents.
 *
 * A candidate with three resumes — a frontend CV, a cloud CV, and one from four
 * years ago — has one career and three descriptions of it. The job here is to
 * reconstruct the career, which means merging what agrees and *surfacing* what
 * does not.
 *
 * Conflicts are never resolved silently. If one resume says a role ran to 2023
 * and another says 2024, the system does not pick the later date, average them,
 * or trust the newer document. It records both positions with their sources and
 * asks. Silently choosing is how a profile drifts away from the truth while
 * looking more confident than ever.
 */

export interface DocumentExtraction {
  documentId: string;
  label: string;
  /** When the document was uploaded. Recency breaks ties, never conflicts. */
  uploadedAt: Date;
  targetRole?: string | null;

  experience: readonly ExperienceEntry[];
  education: readonly EducationRecord[];
  certifications: readonly CertificationRecord[];
  projects: readonly ProjectRecord[];
  achievements: readonly AchievementRecord[];
  languages: readonly LanguageRecord[];
  skills: readonly CandidateSkillFact[];
  summary: string | null;
}

export interface BuildProfileInput {
  candidateId: string;
  profileVersion: number;
  documents: readonly DocumentExtraction[];
  /** Recomputed from the merged experience, not merged from documents. */
  seniority?: SeniorityEstimate;
  trajectory?: CareerTrajectory;
  overrides?: readonly FieldOverride[];
  extractionModel?: string | null;
  now?: Date;
}

/** Normalised key for deciding whether two entries describe the same thing. */
const roleKey = (role: ExperienceEntry): string =>
  `${role.company.toLowerCase().replace(/[^a-z0-9]/g, '')}|${role.dates.start.year ?? '?'}`;

const educationKey = (record: EducationRecord): string =>
  `${record.institution.toLowerCase().replace(/[^a-z0-9]/g, '')}|${record.level ?? '?'}`;

const certificationKey = (record: CertificationRecord): string =>
  record.name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Merges skill facts across documents.
 *
 * Evidence is unioned rather than overwritten: a skill evidenced in two
 * documents genuinely has more support than one evidenced in one. Duration
 * takes the maximum rather than the sum, because both documents describe the
 * same career — adding them would double-count the same years.
 */
function mergeSkills(documents: readonly DocumentExtraction[]): CandidateSkillFact[] {
  const merged = new Map<string, CandidateSkillFact>();

  for (const document of documents) {
    for (const fact of document.skills) {
      const existing = merged.get(fact.slug);
      if (!existing) {
        merged.set(fact.slug, { ...fact, evidence: [...fact.evidence] });
        continue;
      }

      const seenIds = new Set(existing.evidence.map((item) => item.id));
      const evidence = [
        ...existing.evidence,
        ...fact.evidence.filter((item) => !seenIds.has(item.id)),
      ].slice(0, 40);

      // Same career, so the longer observation wins rather than the sum.
      const totalMonths =
        existing.totalMonths === null
          ? fact.totalMonths
          : fact.totalMonths === null
            ? existing.totalMonths
            : Math.max(existing.totalMonths, fact.totalMonths);

      /*
       * The proficiency estimate must come from the same document as the
       * duration that won.
       *
       * Taking the higher-confidence estimate independently produces a fact
       * that reads "7.4 years — evidence suggests working: about 3 years of
       * evidenced use", where the number and the sentence explaining it were
       * computed from different documents. Whichever side supplied the duration
       * supplies the sentence; confidence only breaks the tie.
       */
      const durationWinner =
        existing.totalMonths === totalMonths && fact.totalMonths === totalMonths
          ? fact.proficiencyConfidence > existing.proficiencyConfidence
            ? fact
            : existing
          : existing.totalMonths === totalMonths
            ? existing
            : fact;

      const strongerProficiency = durationWinner;

      /*
       * Strongest source is recomputed across the union rather than inherited.
       *
       * Keeping the first document's value produced facts labelled "listed in a
       * skills section" that were in fact evidenced by a two-year role in
       * another document — the weakest description of the strongest evidence.
       */
      const strongestSource =
        evidence.length > 0
          ? evidence.reduce((best, item) =>
              EVIDENCE_SOURCE_WEIGHT[item.source] > EVIDENCE_SOURCE_WEIGHT[best.source] ? item : best,
            ).source
          : (existing.strongestSource ?? fact.strongestSource);

      merged.set(fact.slug, {
        ...existing,
        aliasesSeen: [...new Set([...existing.aliasesSeen, ...fact.aliasesSeen])].slice(0, 20),
        evidence,
        totalMonths,
        monthsIsEstimate: existing.monthsIsEstimate || fact.monthsIsEstimate,
        lastEvidencedAt: [existing.lastEvidencedAt, fact.lastEvidencedAt]
          .filter((date): date is Date => date instanceof Date)
          .reduce<Date | null>((max, date) => (max === null || date > max ? date : max), null),
        firstEvidencedAt: [existing.firstEvidencedAt, fact.firstEvidencedAt]
          .filter((date): date is Date => date instanceof Date)
          .reduce<Date | null>((min, date) => (min === null || date < min ? date : min), null),
        proficiency: strongerProficiency.proficiency,
        proficiencyConfidence: strongerProficiency.proficiencyConfidence,
        proficiencyRationale: strongerProficiency.proficiencyRationale,
        strongestSource,
        userVerified: existing.userVerified || fact.userVerified,
      });
    }
  }

  return [...merged.values()];
}

function mergeBy<T>(
  documents: readonly DocumentExtraction[],
  select: (document: DocumentExtraction) => readonly T[],
  key: (item: T) => string,
  /** Called when two entries share a key; returns the one to keep. */
  prefer: (a: T, b: T) => T,
): T[] {
  const merged = new Map<string, T>();

  for (const document of documents) {
    for (const item of select(document)) {
      const identity = key(item);
      const existing = merged.get(identity);
      merged.set(identity, existing ? prefer(existing, item) : item);
    }
  }

  return [...merged.values()];
}

/**
 * Assembles the profile.
 *
 * The result is a new version, never a mutation. A match computed against
 * version 3 must stay reproducible after version 4 exists, because "why did you
 * recommend this in March" is a question the system has to be able to answer.
 */
export function buildProfile(input: BuildProfileInput): CandidateIntelligence {
  const now = input.now ?? new Date();

  // Newest first, so ties break toward the most recent description.
  const documents = [...input.documents].sort(
    (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
  );

  const experience = mergeBy<ExperienceEntry>(
    documents,
    (document) => document.experience,
    roleKey,
    // The fuller description wins: a role described in four bullets in one CV
    // and twelve in another is one role, best represented by the twelve.
    (a, b) =>
      b.responsibilities.length + b.achievements.length > a.responsibilities.length + a.achievements.length
        ? b
        : a,
  ).sort((a, b) => (b.dates.start.year ?? 0) - (a.dates.start.year ?? 0));

  const education = mergeBy<EducationRecord>(
    documents,
    (document) => document.education,
    educationKey,
    (a, b) => (b.confidence > a.confidence ? b : a),
  );

  const certifications = mergeBy<CertificationRecord>(
    documents,
    (document) => document.certifications,
    certificationKey,
    (a, b) => (b.confidence > a.confidence ? b : a),
  );

  const projects = mergeBy<ProjectRecord>(
    documents,
    (document) => document.projects,
    (project) => project.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
    (a, b) => ((b.description?.length ?? 0) > (a.description?.length ?? 0) ? b : a),
  );

  const achievements = mergeBy<AchievementRecord>(
    documents,
    (document) => document.achievements,
    (achievement) => achievement.title.toLowerCase().slice(0, 60).replace(/[^a-z0-9]/g, ''),
    (a) => a,
  );

  const languages = mergeBy<LanguageRecord>(
    documents,
    (document) => document.languages,
    (language) => language.language.toLowerCase(),
    // A stated level beats an unstated one; neither overrides the other.
    (a, b) => (a.proficiency === 'UNKNOWN' && b.proficiency !== 'UNKNOWN' ? b : a),
  );

  const skills = mergeSkills(documents);

  const profile = candidateIntelligenceSchema.parse({
    candidateId: input.candidateId,
    profileVersion: input.profileVersion,
    summary: documents.find((document) => document.summary)?.summary ?? null,
    summaryGenerated: false,
    skills: skills.slice(0, 400),
    experience: experience.slice(0, 60),
    education: education.slice(0, 30),
    certifications: certifications.slice(0, 40),
    projects: projects.slice(0, 60),
    achievements: achievements.slice(0, 60),
    languages: languages.slice(0, 20),
    seniority: input.seniority ?? {},
    trajectory: input.trajectory ?? {},
    sourceDocumentIds: documents.map((document) => document.documentId).slice(0, 20),
    extractionModel: input.extractionModel ?? null,
    computedAt: now,
  });

  return input.overrides && input.overrides.length > 0
    ? applyOverrides(profile, input.overrides)
    : profile;
}

/**
 * Detects contradictions between documents.
 *
 * Every conflict is a question for the candidate, never a decision for the
 * system. The one exception is a value the candidate has already verified by
 * hand — that is not a conflict, it is an answer.
 */
export function detectConflicts(
  candidateId: string,
  documents: readonly DocumentExtraction[],
  now = new Date(),
): ProfileConflict[] {
  if (documents.length < 2) return [];

  const conflicts: ProfileConflict[] = [];

  const record = (
    kind: ConflictKind,
    subject: string,
    positions: ProfileConflict['positions'],
    detail: string,
  ): void => {
    const parsed = profileConflictSchema.safeParse({
      id: randomUUID(),
      candidateId,
      kind,
      subject,
      positions,
      detail,
      status: 'open',
      detectedAt: now,
    });
    if (parsed.success) conflicts.push(parsed.data);
  };

  // ── Employment dates ────────────────────────────────────────────────────
  const roleGroups = new Map<string, Array<{ document: DocumentExtraction; role: ExperienceEntry }>>();

  for (const document of documents) {
    for (const role of document.experience) {
      const key = roleKey(role);
      const list = roleGroups.get(key) ?? [];
      list.push({ document, role });
      roleGroups.set(key, list);
    }
  }

  for (const [, group] of roleGroups) {
    if (group.length < 2) continue;

    const describe = (role: ExperienceEntry): string =>
      `${role.dates.start.year ?? '?'}${role.dates.start.month ? `-${String(role.dates.start.month).padStart(2, '0')}` : ''} to ${
        role.dates.isCurrent ? 'present' : (role.dates.end.year ?? '?')
      }`;

    const distinct = new Set(group.map((entry) => describe(entry.role)));

    if (distinct.size > 1) {
      record(
        'employment_dates',
        `${group[0]!.role.company} — ${group[0]!.role.title}`,
        group.slice(0, 6).map((entry) => ({
          value: describe(entry.role),
          documentId: entry.document.documentId,
          documentLabel: entry.document.label,
          source: entry.role.userVerified ? ('user_verified' as const) : ('employment_responsibility' as const),
          confidence: entry.role.confidence,
        })),
        'Your documents give different dates for this role. Which is correct?',
      );
    }

    // ── Job titles ────────────────────────────────────────────────────────
    const titles = new Set(group.map((entry) => entry.role.title.toLowerCase().trim()));
    if (titles.size > 1) {
      record(
        'job_title',
        `${group[0]!.role.company}`,
        group.slice(0, 6).map((entry) => ({
          value: entry.role.title,
          documentId: entry.document.documentId,
          documentLabel: entry.document.label,
          source: entry.role.userVerified ? ('user_verified' as const) : ('employment_responsibility' as const),
          confidence: entry.role.confidence,
        })),
        'Your documents give different titles for the same role. This is often legitimate — an internal title and an external one — but the profile can only show one.',
      );
    }
  }

  // ── Skill duration ──────────────────────────────────────────────────────
  const skillGroups = new Map<string, Array<{ document: DocumentExtraction; fact: CandidateSkillFact }>>();

  for (const document of documents) {
    for (const fact of document.skills) {
      const list = skillGroups.get(fact.slug) ?? [];
      list.push({ document, fact });
      skillGroups.set(fact.slug, list);
    }
  }

  for (const [, group] of skillGroups) {
    const dated = group.filter((entry) => entry.fact.totalMonths !== null);
    if (dated.length < 2) continue;

    const months = dated.map((entry) => entry.fact.totalMonths!);
    const spread = Math.max(...months) - Math.min(...months);

    // A year's disagreement is worth asking about; three months is rounding.
    if (spread >= 12) {
      record(
        'skill_duration',
        dated[0]!.fact.name,
        dated.slice(0, 6).map((entry) => ({
          value: `${Math.round(entry.fact.totalMonths! / 12)} years`,
          documentId: entry.document.documentId,
          documentLabel: entry.document.label,
          source: entry.fact.strongestSource ?? ('inferred' as const),
          confidence: entry.fact.proficiencyConfidence,
        })),
        `Your documents imply different amounts of ${dated[0]!.fact.name} experience. The profile uses the longest, but you can correct it.`,
      );
    }
  }

  // ── Education ───────────────────────────────────────────────────────────
  const educationGroups = new Map<string, Array<{ document: DocumentExtraction; record: EducationRecord }>>();

  for (const document of documents) {
    for (const entry of document.education) {
      const key = entry.institution.toLowerCase().replace(/[^a-z0-9]/g, '');
      const list = educationGroups.get(key) ?? [];
      list.push({ document, record: entry });
      educationGroups.set(key, list);
    }
  }

  for (const [, group] of educationGroups) {
    if (group.length < 2) continue;
    const levels = new Set(group.map((entry) => entry.record.level ?? 'unknown'));

    if (levels.size > 1) {
      record(
        'education',
        group[0]!.record.institution,
        group.slice(0, 6).map((entry) => ({
          value: entry.record.degree ?? entry.record.level ?? 'unspecified',
          documentId: entry.document.documentId,
          documentLabel: entry.document.label,
          source: 'employment_responsibility' as const,
          confidence: entry.record.confidence,
        })),
        'Your documents record different qualifications from this institution.',
      );
    }
  }

  return conflicts;
}

/**
 * Applies the candidate's manual corrections.
 *
 * `user_verified` is absolute. Re-uploading a resume must not silently undo a
 * correction someone made by hand — the extractor was wrong once already, and
 * the person's own answer outranks anything a parser produces.
 */
export function applyOverrides(
  profile: CandidateIntelligence,
  overrides: readonly FieldOverride[],
): CandidateIntelligence {
  // Oldest first, so a later correction wins over an earlier one.
  const ordered = [...overrides].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const next = structuredClone(profile) as CandidateIntelligence;

  for (const override of ordered) {
    const segments = override.path.split('.');
    if (segments.length === 0) continue;

    let cursor: unknown = next;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;

      if (Array.isArray(cursor)) {
        // Array segments address by id, not index: `skills.react.proficiency`
        // must keep working after the array is reordered.
        const found = (cursor as Array<Record<string, unknown>>).find(
          (item) => item.slug === segment || item.id === segment,
        );
        if (!found) {
          cursor = null;
          break;
        }
        cursor = found;
        continue;
      }

      if (typeof cursor !== 'object' || cursor === null) {
        cursor = null;
        break;
      }

      cursor = (cursor as Record<string, unknown>)[segment];
    }

    if (cursor === null || typeof cursor !== 'object') continue;

    const leaf = segments[segments.length - 1]!;

    if (Array.isArray(cursor)) {
      const found = (cursor as Array<Record<string, unknown>>).find(
        (item) => item.slug === leaf || item.id === leaf,
      );
      if (found) Object.assign(found, override.value as object);
      continue;
    }

    (cursor as Record<string, unknown>)[leaf] = override.value;

    // Mark the touched entity as verified, so nothing downstream treats a
    // hand-corrected value as a low-confidence extraction.
    if ('userVerified' in cursor) (cursor as Record<string, unknown>).userVerified = true;
  }

  const reparsed = candidateIntelligenceSchema.safeParse(next);
  // A malformed override must not corrupt the profile: the original stands.
  return reparsed.success ? reparsed.data : profile;
}

/**
 * The three quality scores.
 *
 * They are separate because they move independently and imply different
 * actions. A profile that is complete but poorly evidenced needs a better
 * resume; one that is sparse but well evidenced needs more of it; one that is
 * complete and well evidenced but low-confidence needs the candidate to confirm
 * what the parser guessed.
 */
export function computeQuality(
  profile: CandidateIntelligence,
  now = new Date(),
): ProfileQuality {
  const gaps: ProfileQuality['materialGaps'] = [];

  // ── Completeness ────────────────────────────────────────────────────────
  const checks: Array<{ field: string; present: boolean; weight: number; impact: 'high' | 'medium' | 'low'; reason: string; action: string }> = [
    {
      field: 'experience',
      present: profile.experience.length > 0,
      weight: 25,
      impact: 'high',
      reason: 'Without employment history, seniority and years-of-experience requirements cannot be checked at all.',
      action: 'Upload a resume that includes your work history.',
    },
    {
      field: 'skills',
      present: profile.skills.length >= 5,
      weight: 25,
      impact: 'high',
      reason: 'Skill requirements are the most common thing jobs ask for, and matching cannot evidence them.',
      action: 'Add a skills section, or describe the technologies used in each role.',
    },
    {
      field: 'dated_roles',
      present: profile.experience.some((role) => role.dates.start.year !== null),
      weight: 15,
      impact: 'high',
      reason: 'Undated roles mean skill duration and total experience are unknown.',
      action: 'Add start and end dates to your roles.',
    },
    {
      field: 'education',
      present: profile.education.length > 0,
      weight: 10,
      impact: 'medium',
      reason: 'Some roles state a qualification requirement that cannot be checked.',
      action: 'Add your education, even briefly.',
    },
    {
      field: 'summary',
      present: Boolean(profile.summary),
      weight: 5,
      impact: 'low',
      reason: 'A summary gives context that improves the explanation shown with each match.',
      action: 'Add a short professional summary.',
    },
    {
      field: 'projects',
      present: profile.projects.length > 0,
      weight: 10,
      impact: 'medium',
      reason: 'Projects evidence skills that never appear in a job description.',
      action: 'Add notable projects, professional or personal.',
    },
    {
      field: 'achievements',
      present: profile.achievements.length > 0,
      weight: 10,
      impact: 'medium',
      reason: 'Achievements distinguish you from everyone with the same job title.',
      action: 'Add outcomes, not only responsibilities, to your roles.',
    },
  ];

  const completenessScore = checks.reduce((sum, check) => sum + (check.present ? check.weight : 0), 0);

  for (const check of checks) {
    if (!check.present) {
      gaps.push({
        field: check.field,
        impact: check.impact,
        reason: check.reason,
        action: check.action,
      });
    }
  }

  // ── Evidence quality ────────────────────────────────────────────────────
  const skillsWithRealEvidence = profile.skills.filter(
    (skill) => skill.strongestSource !== null && skill.strongestSource !== 'resume_skill_section',
  ).length;

  const skillEvidenceRatio =
    profile.skills.length === 0 ? 0 : skillsWithRealEvidence / profile.skills.length;

  const rolesWithDetail = profile.experience.filter(
    (role) => role.responsibilities.length + role.achievements.length >= 2,
  ).length;
  const roleDetailRatio = profile.experience.length === 0 ? 0 : rolesWithDetail / profile.experience.length;

  const datedRatio =
    profile.experience.length === 0
      ? 0
      : profile.experience.filter((role) => role.dates.start.year !== null).length / profile.experience.length;

  const evidenceQualityScore = Math.round(
    (skillEvidenceRatio * 45 + roleDetailRatio * 35 + datedRatio * 20),
  );

  if (skillEvidenceRatio < 0.5 && profile.skills.length > 0) {
    gaps.push({
      field: 'skill_evidence',
      impact: 'high',
      reason: `${profile.skills.length - skillsWithRealEvidence} of your skills appear only in a list, with no role or project behind them.`,
      action: 'Mention where you used each skill, so matching can evidence it.',
    });
  }

  // ── Confidence ──────────────────────────────────────────────────────────
  const confidences = [
    ...profile.experience.map((role) => role.confidence),
    ...profile.education.map((record) => record.confidence),
    ...profile.skills.map((skill) => skill.proficiencyConfidence),
  ];

  const meanConfidence =
    confidences.length === 0 ? 0 : confidences.reduce((sum, value) => sum + value, 0) / confidences.length;

  // Open conflicts are direct evidence that the profile is not yet settled.
  const conflictPenalty = Math.min(30, profile.openConflicts * 10);
  const confidenceScore = Math.max(0, Math.round(meanConfidence * 100) - conflictPenalty);

  if (profile.openConflicts > 0) {
    gaps.push({
      field: 'conflicts',
      impact: 'medium',
      reason: `${profile.openConflicts} contradiction${profile.openConflicts === 1 ? '' : 's'} between your documents remain unresolved.`,
      action: 'Review the conflicts and choose the correct value.',
    });
  }

  return profileQualitySchema.parse({
    completenessScore: Math.min(100, completenessScore),
    evidenceQualityScore: Math.min(100, evidenceQualityScore),
    confidenceScore: Math.min(100, confidenceScore),
    materialGaps: gaps.slice(0, 20),
    computedAt: now,
  });
}
