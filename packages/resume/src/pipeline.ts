import {
  type CandidateSkillFact,
  type CareerTrajectory,
  type CertificationRecord,
  type DocumentSection,
  type DocumentValidation,
  type EducationRecord,
  type ExperienceEntry,
  type LanguageRecord,
  type ProjectRecord,
  type AchievementRecord,
  type SeniorityEstimate,
} from '@job-intel/contracts';
import { buildSkillFacts } from './analyse/skill-facts';
import { estimateSeniority } from './analyse/seniority';
import { analyseTrajectory } from './analyse/trajectory';
import { extractText, type ExtractionResult } from './extract/text-extraction';
import { extractAll } from './parse/entities';
import { detectSections, sectionText, type HeadingClassifier } from './parse/sections';
import { collectSkillMentions, technologiesFor, type SkillMention } from './parse/skills';
import { hashDocument, validateDocument } from './validate/file-validation';

/**
 * The document pipeline.
 *
 * The brief is explicit that a raw PDF must not be handed to a model and asked
 * for a profile, and the reason is worth stating: it produces an answer that
 * cannot be checked. There is no way to tell which parts came from the document
 * and which the model supplied, no way to show the candidate where a claim came
 * from, and no way to reproduce the result.
 *
 * So the pipeline is staged, and every stage is independently inspectable:
 *
 *   UPLOAD → VALIDATE → EXTRACT → SECTIONS → ENTITIES → NORMALISE → EVIDENCE
 *
 * Each stage records what it did, how long it took, and whether it succeeded.
 * A failure at any stage stops the pipeline and reports which stage failed —
 * "we could not read your PDF" is a far better message than a profile silently
 * missing half its content.
 *
 * The only optional model call is heading classification, and only for headings
 * the deterministic vocabulary could not place. Everything else here is rules.
 */

export const PIPELINE_STAGES = [
  'validate',
  'extract',
  'sections',
  'entities',
  'normalise',
  'evidence',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface StageResult {
  stage: PipelineStage;
  ok: boolean;
  durationMs: number;
  detail: string;
  warnings: string[];
}

export interface PipelineInput {
  bytes: Uint8Array;
  filename: string;
  declaredMimeType: string | null;
  documentId?: string | null;
  /** Optional model for headings the vocabulary cannot place. */
  headingClassifier?: HeadingClassifier | null;
  now?: Date;
  maxBytes?: number;
}

export interface PipelineOutput {
  ok: boolean;
  failedStage: PipelineStage | null;
  /** Phrased for the candidate, never a stack trace. */
  error: string | null;
  stages: StageResult[];

  contentHash: string;
  validation: DocumentValidation;
  extraction: ExtractionResult | null;
  sections: DocumentSection[];

  experience: ExperienceEntry[];
  education: EducationRecord[];
  certifications: CertificationRecord[];
  projects: ProjectRecord[];
  achievements: AchievementRecord[];
  languages: LanguageRecord[];
  summary: string | null;

  skills: CandidateSkillFact[];
  skillMentions: SkillMention[];
  seniority: SeniorityEstimate | null;
  trajectory: CareerTrajectory | null;

  /** Characters of text extracted. Never the text itself — see the note below. */
  textLength: number;
}

const empty = (
  contentHash: string,
  validation: DocumentValidation,
  stages: StageResult[],
  failedStage: PipelineStage,
  error: string,
): PipelineOutput => ({
  ok: false,
  failedStage,
  error,
  stages,
  contentHash,
  validation,
  extraction: null,
  sections: [],
  experience: [],
  education: [],
  certifications: [],
  projects: [],
  achievements: [],
  languages: [],
  summary: null,
  skills: [],
  skillMentions: [],
  seniority: null,
  trajectory: null,
  textLength: 0,
});

/**
 * Runs a document through every stage.
 *
 * Note what this function never does: log the document text. Resume contents
 * are the most sensitive data in the system — full name, address, phone number,
 * employment history — and the brief forbids placing them in ordinary
 * application logs. Stage details carry counts and section kinds, never
 * content.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const now = input.now ?? new Date();
  const stages: StageResult[] = [];
  const documentId = input.documentId ?? null;

  const contentHash = hashDocument(input.bytes);

  const time = async <T>(
    stage: PipelineStage,
    fn: () => Promise<T> | T,
  ): Promise<{ value: T; record: (ok: boolean, detail: string, warnings?: string[]) => void }> => {
    const started = Date.now();
    const value = await fn();
    return {
      value,
      record: (ok, detail, warnings = []) => {
        stages.push({ stage, ok, durationMs: Date.now() - started, detail, warnings });
      },
    };
  };

  // ── VALIDATE ────────────────────────────────────────────────────────────
  const validationStep = await time('validate', () =>
    validateDocument({
      bytes: input.bytes,
      filename: input.filename,
      declaredMimeType: input.declaredMimeType,
      maxBytes: input.maxBytes,
    }),
  );
  const validation = validationStep.value;

  validationStep.record(
    validation.accepted,
    validation.accepted
      ? `Accepted as ${validation.detectedMimeType} (${validation.sizeBytes} bytes).`
      : (validation.rejectionReason ?? 'Rejected.'),
  );

  if (!validation.accepted || !validation.detectedMimeType) {
    return empty(
      contentHash,
      validation,
      stages,
      'validate',
      validation.rejectionReason ?? 'The file could not be accepted.',
    );
  }

  // ── EXTRACT ─────────────────────────────────────────────────────────────
  const extractionStep = await time('extract', () =>
    extractText(input.bytes, validation.detectedMimeType!),
  );
  const extraction = extractionStep.value;

  extractionStep.record(
    extraction.ok,
    extraction.ok
      ? `Extracted ${extraction.text.length} characters from ${extraction.blocks} block(s) via ${extraction.extractor}.`
      : (extraction.error ?? 'Extraction failed.'),
    extraction.warnings,
  );

  if (!extraction.ok) {
    const output = empty(
      contentHash,
      validation,
      stages,
      'extract',
      extraction.error ?? 'No text could be read from this document.',
    );
    return { ...output, extraction };
  }

  // ── SECTIONS ────────────────────────────────────────────────────────────
  const sectionStep = await time('sections', () =>
    detectSections(extraction.text, { classifier: input.headingClassifier ?? null }),
  );
  const sections = sectionStep.value;

  const hasStructure = sections.some(
    (section) => section.kind !== 'contact' && section.kind !== 'unknown',
  );

  const aiSections = sections.filter((section) => section.aiClassified).length;
  sectionStep.record(
    sections.length > 0,
    `Found ${sections.length} section(s): ${sections.map((section) => section.kind).join(', ')}.` +
      (aiSections > 0 ? ` ${aiSections} classified by model.` : ''),
    hasStructure
      ? []
      : ['No section headings were recognised; every extractor was given the whole document.'],
  );

  /*
   * A document with no recognisable structure is unusual but not fatal — some
   * resumes are a single prose block, and some are a PDF whose layout survived
   * extraction badly. Rather than return nothing, the whole text is offered to
   * every structural extractor: without headings the system genuinely does not
   * know which part is which, and letting each extractor look everywhere finds
   * far more than letting none of them look anywhere.
   */
  const wholeDocument = (kind: DocumentSection['kind']): DocumentSection => ({
    kind,
    heading: '(document)',
    startOffset: 0,
    endOffset: extraction.text.length,
    text: extraction.text.slice(0, 100_000),
    confidence: 0.1,
    aiClassified: false,
  });

  const workingSections: DocumentSection[] = hasStructure
    ? sections
    : [
        ...sections,
        wholeDocument('experience'),
        wholeDocument('skills'),
        wholeDocument('education'),
      ];

  // ── ENTITIES ────────────────────────────────────────────────────────────
  const entityStep = await time('entities', () =>
    extractAll(workingSections, { documentId, now }),
  );
  const entities = entityStep.value;

  entityStep.record(
    true,
    `${entities.experience.length} role(s), ${entities.education.length} education record(s), ` +
      `${entities.certifications.length} certification(s), ${entities.projects.length} project(s), ` +
      `${entities.achievements.length} achievement(s), ${entities.languages.length} language(s).`,
    entities.experience.length === 0
      ? ['No employment history was identified. Seniority and trajectory will be unavailable.']
      : [],
  );

  // ── NORMALISE ───────────────────────────────────────────────────────────
  // Technologies are attached to their roles and projects here rather than at
  // extraction, so the skill taxonomy stays in one place.
  const normaliseStep = await time('normalise', () => {
    const experience = entities.experience.map((role) => ({
      ...role,
      technologies: technologiesFor(
        [role.description ?? '', ...role.responsibilities, ...role.achievements].join('\n'),
      ).slice(0, 40),
    }));

    const projects = entities.projects.map((project) => ({
      ...project,
      technologies: technologiesFor(
        [project.name, project.description ?? '', project.outcome ?? ''].join('\n'),
      ).slice(0, 40),
    }));

    return { experience, projects };
  });

  const { experience, projects } = normaliseStep.value;
  const technologyCount = new Set([
    ...experience.flatMap((role) => role.technologies),
    ...projects.flatMap((project) => project.technologies),
  ]).size;

  normaliseStep.record(
    true,
    `Normalised ${technologyCount} distinct technolog${technologyCount === 1 ? 'y' : 'ies'} across roles and projects.`,
  );

  // ── EVIDENCE ────────────────────────────────────────────────────────────
  const evidenceStep = await time('evidence', () => {
    const mentions = collectSkillMentions({
      documentId,
      skillSection: sectionText(workingSections, 'skills'),
      experience,
      projects,
      certifications: entities.certifications.map((record) => ({
        name: record.name,
        issuer: record.issuer,
      })),
      educationCoursework: entities.education.flatMap((record) => record.coursework),
    });

    const skills = buildSkillFacts(mentions, { now });
    const seniority = estimateSeniority({ experience, now });
    const trajectory = analyseTrajectory({
      experience,
      education: entities.education,
      certifications: entities.certifications,
      projects,
      now,
    });

    return { mentions, skills, seniority, trajectory };
  });

  const { mentions, skills, seniority, trajectory } = evidenceStep.value;

  const unevidenced = skills.filter((skill) => skill.strongestSource === 'resume_skill_section').length;
  evidenceStep.record(
    true,
    `${skills.length} skill(s) from ${mentions.length} evidence item(s). ` +
      `Seniority: ${seniority.estimatedLevel ?? 'unknown'} (confidence ${seniority.confidence.toFixed(2)}).`,
    unevidenced > 0
      ? [
          `${unevidenced} skill(s) appear only in the skills section with no supporting role, project or certification.`,
        ]
      : [],
  );

  return {
    ok: true,
    failedStage: null,
    error: null,
    stages,
    contentHash,
    validation,
    extraction,
    sections,
    experience,
    education: entities.education,
    certifications: entities.certifications,
    projects,
    achievements: entities.achievements,
    languages: entities.languages,
    summary: entities.summary,
    skills,
    skillMentions: mentions,
    seniority,
    trajectory,
    textLength: extraction.text.length,
  };
}
