import { randomUUID } from 'node:crypto';
import {
  EXTRACTION_VERSION,
  TAXONOMY_VERSION,
  fieldOverrideSchema,
  type CandidateDocument,
  type CandidateIntelligence,
  type DocumentValidation,
  type FieldOverride,
  type JobCandidateView,
  type ProfileConflict,
  type RequirementMatrix,
  type ResumeComparison,
} from '@job-intel/contracts';
import type { IntelligenceRepository, JobRepository, EnrichmentRepository } from '@job-intel/db';
import type { EventRecorder, Logger } from '@job-intel/observability';
import {
  SkillGraph,
  applyOverrides,
  buildJobCandidateView,
  buildProfile,
  buildRequirementMatrix,
  compareResumes,
  computeQuality,
  detectConflicts,
  generateProfileSummary,
  requirementsFromEnrichment,
  type DocumentExtraction,
  type ParsedRequirement,
} from '@job-intel/candidate';
import {
  analyseTrajectory,
  buildSkillFacts,
  estimateSeniority,
  mentionsFromExternalProfile,
  runPipeline,
  type HeadingClassifier,
  type PipelineOutput,
} from '@job-intel/resume';
import {
  selectPortfolioConnector,
  type PortfolioConnector,
} from '@job-intel/connectors';

/**
 * Resume and candidate-intelligence orchestration.
 *
 * Binds the pure extraction pipeline to persistence and enforces the sequence
 * an upload must follow:
 *
 *   1. validate    (signature, size, structure — before anything reads the file)
 *   2. extract     (staged pipeline, each stage recorded)
 *   3. persist     (per-document extraction, kept separate from the profile)
 *   4. rebuild     (merge every document into a new profile version)
 *   5. reconcile   (detect conflicts, apply overrides, score quality)
 *   6. publish     (activate the new version atomically)
 *
 * Two rules the brief states and this service holds to:
 *
 *  - **Resume contents never reach ordinary logs.** Every log line here carries
 *    counts, ids and stage names. Not one carries document text, and the
 *    `redactedSummary` helper exists so a caller cannot accidentally do it
 *    either.
 *
 *  - **Nothing here submits an application.** The service produces evidence and
 *    explanations; acting on them is the candidate's decision.
 */

export interface ResumeServiceDependencies {
  intelligence: IntelligenceRepository;
  jobs: JobRepository;
  enrichments: EnrichmentRepository;
  logger: Logger;
  events: EventRecorder;
  /** Optional model, used only for section headings the vocabulary misses. */
  headingClassifier?: HeadingClassifier | null;
  /** Object storage. Absent in tests and local runs; uploads still work. */
  storage?: DocumentStorage | null;
  skillGraph?: SkillGraph;
  /** Public portfolio readers. Only used for links the candidate supplies. */
  portfolioConnectors?: readonly PortfolioConnector[];
}

/**
 * Object storage for the raw bytes.
 *
 * Deliberately an interface: the bytes must not live in the database, and the
 * system must not care whether that means S3, R2 or a local directory.
 */
export interface DocumentStorage {
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** Short-lived signed URL. Never a public one. */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export interface UploadResult {
  document: CandidateDocument;
  duplicate: boolean;
  validation: DocumentValidation;
  accepted: boolean;
  /** Present when extraction ran. */
  pipeline: PipelineOutput | null;
  profile: CandidateIntelligence | null;
  conflictsDetected: number;
}

export class ResumeService {
  private readonly graph: SkillGraph;

  constructor(private readonly deps: ResumeServiceDependencies) {
    this.graph = deps.skillGraph ?? new SkillGraph();
  }

  /**
   * Ingests a document end to end.
   *
   * Validation failures are a normal outcome, not an exception: the document is
   * recorded as rejected with a reason the candidate can act on, and the
   * function returns rather than throwing.
   */
  async upload(input: {
    candidateId: string;
    bytes: Uint8Array;
    filename: string;
    declaredMimeType: string | null;
    label?: string;
    targetRole?: string | null;
    kind?: string;
    now?: Date;
  }): Promise<UploadResult> {
    const now = input.now ?? new Date();
    const label = input.label?.trim() || input.filename.replace(/\.[^.]+$/, '').slice(0, 120);

    /*
     * Extraction runs *before* the row is created so a malicious or unreadable
     * file never produces a document record that looks real. The pipeline is
     * pure and touches nothing outside itself.
     */
    const pipeline = await runPipeline({
      bytes: input.bytes,
      filename: input.filename,
      declaredMimeType: input.declaredMimeType,
      headingClassifier: this.deps.headingClassifier ?? null,
      now,
    });

    const { document, duplicate } = await this.deps.intelligence.createDocument({
      candidateId: input.candidateId,
      label,
      filename: input.filename.slice(0, 255),
      mimeType: pipeline.validation.detectedMimeType ?? input.declaredMimeType ?? 'application/octet-stream',
      sizeBytes: input.bytes.length,
      contentHash: pipeline.contentHash,
      storageKey: null,
      kind: input.kind,
      targetRole: input.targetRole ?? null,
    });

    this.deps.logger.info('resume.upload.received', {
      documentId: document.id,
      candidateId: input.candidateId,
      sizeBytes: input.bytes.length,
      duplicate,
      accepted: pipeline.validation.accepted,
      // Filename only — never content.
      filename: input.filename.slice(0, 120),
    });

    if (!pipeline.ok) {
      await this.deps.intelligence.updateDocumentStatus(document.id, 'rejected', {
        rejectionReason: pipeline.error,
        pipelineStages: pipeline.stages,
      });

      await this.deps.events.emit('DOCUMENT_REJECTED', {
        severity: 'warn',
        message: `Document rejected at the ${pipeline.failedStage} stage.`,
        data: {
          documentId: document.id,
          stage: pipeline.failedStage,
          reason: pipeline.error,
        },
      });

      return {
        document: { ...document, status: 'rejected', rejectionReason: pipeline.error },
        duplicate,
        validation: pipeline.validation,
        accepted: false,
        pipeline,
        profile: null,
        conflictsDetected: 0,
      };
    }

    // Bytes go to object storage, never to the database.
    if (this.deps.storage) {
      const key = `resumes/${input.candidateId}/${document.id}`;
      try {
        await this.deps.storage.put(key, input.bytes, document.mimeType);
        await this.deps.intelligence.updateDocumentStatus(document.id, 'extracting', {});
      } catch (error) {
        this.deps.logger.warn('resume.storage.failed', {
          documentId: document.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.deps.intelligence.replaceSections(document.id, pipeline.sections);

    await this.deps.intelligence.saveExtraction({
      documentId: document.id,
      candidateId: input.candidateId,
      experience: pipeline.experience,
      education: pipeline.education,
      certifications: pipeline.certifications,
      projects: pipeline.projects,
      achievements: pipeline.achievements,
      languages: pipeline.languages,
      skills: pipeline.skills,
      summary: pipeline.summary,
      extractionVersion: EXTRACTION_VERSION,
      taxonomyVersion: TAXONOMY_VERSION,
      extractionModel: this.deps.headingClassifier?.model ?? null,
    });

    await this.deps.intelligence.updateDocumentStatus(document.id, 'extracted', {
      pipelineStages: pipeline.stages,
      textLength: pipeline.textLength,
      warnings: pipeline.stages.flatMap((stage) => stage.warnings).slice(0, 20),
      extractedAt: now,
    });

    const rebuild = await this.rebuildProfile(input.candidateId, now);

    await this.deps.events.emit('DOCUMENT_EXTRACTED', {
      message: `Extracted ${pipeline.experience.length} roles and ${pipeline.skills.length} skills.`,
      data: {
        documentId: document.id,
        roles: pipeline.experience.length,
        skills: pipeline.skills.length,
        profileVersion: rebuild.profile.profileVersion,
        conflicts: rebuild.conflictsDetected,
      },
    });

    return {
      document: { ...document, status: 'extracted', extractedAt: now },
      duplicate,
      validation: pipeline.validation,
      accepted: true,
      pipeline,
      profile: rebuild.profile,
      conflictsDetected: rebuild.conflictsDetected,
    };
  }

  /**
   * Rebuilds the merged profile from every document the candidate has.
   *
   * Always a new version. Overrides are re-applied on top, which is what makes
   * a hand correction survive a re-upload — the extraction is redone from
   * scratch, and the person's answer is layered back over it.
   */
  async rebuildProfile(
    candidateId: string,
    now = new Date(),
  ): Promise<{ profile: CandidateIntelligence; conflictsDetected: number }> {
    const stored = await this.deps.intelligence.listExtractions(candidateId);

    const documents: DocumentExtraction[] = stored.map((row) => ({
      documentId: row.documentId,
      label: row.label,
      uploadedAt: row.uploadedAt,
      targetRole: row.targetRole,
      experience: row.experience,
      education: row.education,
      certifications: row.certifications,
      projects: row.projects,
      achievements: row.achievements,
      languages: row.languages,
      skills: row.skills,
      summary: row.summary,
    }));

    const conflicts = detectConflicts(candidateId, documents, now);
    const conflictsDetected = await this.deps.intelligence.recordConflicts(conflicts);
    const openConflicts = await this.deps.intelligence.countOpenConflicts(candidateId);

    const overrides = await this.deps.intelligence.listOverrides(candidateId);
    const version = await this.deps.intelligence.nextProfileVersion(candidateId);

    // Merge first, then derive: seniority and trajectory must be computed from
    // the *merged* career, not averaged across documents.
    const merged = buildProfile({
      candidateId,
      profileVersion: version,
      documents,
      overrides,
      now,
    });

    const seniority = estimateSeniority({ experience: merged.experience, now });
    const trajectory = analyseTrajectory({
      experience: merged.experience,
      education: merged.education,
      certifications: merged.certifications,
      projects: merged.projects,
      now,
    });

    let profile: CandidateIntelligence = {
      ...merged,
      seniority,
      trajectory,
      openConflicts,
    };

    profile = { ...profile, quality: computeQuality(profile, now) };

    if (!profile.summary) {
      profile = { ...profile, summary: generateProfileSummary(profile), summaryGenerated: true };
    }

    await this.deps.intelligence.publishProfile(profile);

    this.deps.logger.info('resume.profile.rebuilt', {
      candidateId,
      profileVersion: profile.profileVersion,
      documents: documents.length,
      skills: profile.skills.length,
      roles: profile.experience.length,
      openConflicts,
      completeness: profile.quality?.completenessScore ?? 0,
      evidenceQuality: profile.quality?.evidenceQualityScore ?? 0,
      confidence: profile.quality?.confidenceScore ?? 0,
    });

    return { profile, conflictsDetected };
  }

  async getProfile(candidateId: string): Promise<CandidateIntelligence | null> {
    const profile = await this.deps.intelligence.getActiveProfile(candidateId);
    if (!profile) return null;

    // Overrides are applied on read, so a correction made after the last
    // rebuild takes effect immediately rather than at the next upload.
    const overrides = await this.deps.intelligence.listOverrides(candidateId);
    return overrides.length > 0 ? applyOverrides(profile, overrides) : profile;
  }

  /**
   * Records a manual correction.
   *
   * The previous value is stored alongside so the editor can show what changed
   * and offer to revert. `user_verified` origin means every downstream consumer
   * treats this as the strongest evidence available.
   */
  async override(input: {
    candidateId: string;
    path: string;
    value: unknown;
    previousValue?: unknown;
    note?: string | null;
    origin?: FieldOverride['origin'];
    now?: Date;
  }): Promise<FieldOverride> {
    const override = fieldOverrideSchema.parse({
      id: randomUUID(),
      candidateId: input.candidateId,
      path: input.path,
      value: input.value,
      previousValue: input.previousValue ?? null,
      origin: input.origin ?? 'user_verified',
      note: input.note ?? null,
      createdAt: input.now ?? new Date(),
    });

    await this.deps.intelligence.saveOverride(override);

    this.deps.logger.info('resume.override.saved', {
      candidateId: input.candidateId,
      path: input.path,
      origin: override.origin,
    });

    return override;
  }

  /**
   * Links a public portfolio the candidate supplied.
   *
   * Only what they paste, only public data, only through documented APIs. The
   * derived skills are stored against the external profile rather than merged
   * into the resume extraction, so the candidate can see exactly which claims
   * came from their GitHub and remove them by unlinking.
   */
  async linkExternalProfile(input: {
    candidateId: string;
    url: string;
    now?: Date;
  }): Promise<{ ok: boolean; provider: string; skills: number; error: string | null; limitations: string[] }> {
    if (!this.deps.portfolioConnectors || this.deps.portfolioConnectors.length === 0) {
      return {
        ok: false,
        provider: 'none',
        skills: 0,
        error: 'No portfolio connectors are configured.',
        limitations: [],
      };
    }

    const connector = selectPortfolioConnector(input.url, this.deps.portfolioConnectors);
    if (!connector) {
      return {
        ok: false,
        provider: 'none',
        skills: 0,
        error: 'That link is not one this system can read.',
        limitations: [],
      };
    }

    const identifier = connector.identifierFrom(input.url);
    if (!identifier) {
      return {
        ok: false,
        provider: connector.provider,
        skills: 0,
        error: 'That link does not name an account this system can read.',
        limitations: [],
      };
    }

    const result = await connector.fetch(identifier);
    const now = input.now ?? new Date();

    const mentions = result.ok
      ? mentionsFromExternalProfile({
          provider: result.provider,
          url: result.url,
          items: result.evidence,
        })
      : [];

    const derived = buildSkillFacts(mentions, { now });

    await this.deps.intelligence.upsertExternalProfile({
      candidateId: input.candidateId,
      provider: connector.provider,
      identifier,
      url: result.url,
      status: result.ok ? 'linked' : 'failed',
      payload: { ...result.payload, limitations: result.limitations },
      derivedSkills: derived,
      lastError: result.error,
      lastFetchedAt: now,
    });

    if (result.ok) {
      await this.deps.events.emit('EXTERNAL_PROFILE_LINKED', {
        message: `Linked ${connector.provider} profile with ${derived.length} evidenced skills.`,
        data: { candidateId: input.candidateId, provider: connector.provider, skills: derived.length },
      });
    }

    this.deps.logger.info('resume.external.linked', {
      candidateId: input.candidateId,
      provider: connector.provider,
      ok: result.ok,
      skills: derived.length,
    });

    return {
      ok: result.ok,
      provider: connector.provider,
      skills: derived.length,
      error: result.error,
      limitations: result.limitations,
    };
  }

  async listConflicts(candidateId: string): Promise<ProfileConflict[]> {
    return this.deps.intelligence.listConflicts(candidateId);
  }

  /**
   * Resolves a conflict with the candidate's answer.
   *
   * Resolution writes an override as well as closing the conflict: the answer
   * has to survive the next rebuild, and closing the conflict alone would let
   * re-extraction reopen it with the same two positions.
   */
  async resolveConflict(input: {
    candidateId: string;
    conflictId: string;
    chosenValue: string | null;
    path?: string | null;
    status?: 'resolved' | 'ignored';
    now?: Date;
  }): Promise<void> {
    await this.deps.intelligence.resolveConflict(
      input.conflictId,
      input.chosenValue,
      input.status ?? 'resolved',
      input.now ?? new Date(),
    );

    if (input.path && input.chosenValue !== null && input.status !== 'ignored') {
      await this.override({
        candidateId: input.candidateId,
        path: input.path,
        value: input.chosenValue,
        note: 'Chosen while resolving a conflict between documents.',
        now: input.now,
      });
    }
  }

  async compareDocuments(candidateId: string): Promise<ResumeComparison> {
    const stored = await this.deps.intelligence.listExtractions(candidateId);

    return compareResumes(
      candidateId,
      stored.map((row) => ({
        documentId: row.documentId,
        label: row.label,
        uploadedAt: row.uploadedAt,
        targetRole: row.targetRole,
        experience: row.experience,
        education: row.education,
        certifications: row.certifications,
        projects: row.projects,
        achievements: row.achievements,
        languages: row.languages,
        skills: row.skills,
        summary: row.summary,
      })),
    );
  }

  /**
   * The requirement matrix for one job.
   *
   * Cached by (candidate, job, profileVersion): a matrix computed against an
   * older profile is not reused, because it would describe a person the profile
   * no longer reflects.
   */
  async matrixFor(input: {
    candidateId: string;
    jobId: string;
    requirements?: readonly ParsedRequirement[];
    force?: boolean;
    now?: Date;
  }): Promise<RequirementMatrix | null> {
    const profile = await this.getProfile(input.candidateId);
    if (!profile) return null;

    if (!input.force) {
      const cached = await this.deps.intelligence.getMatrix(
        input.candidateId,
        input.jobId,
        profile.profileVersion,
      );
      if (cached) return cached;
    }

    const requirements = input.requirements ?? (await this.requirementsFor(input.jobId));

    const matrix = buildRequirementMatrix({
      jobId: input.jobId,
      candidateId: input.candidateId,
      profile,
      requirements,
      graph: this.graph,
      now: input.now,
    });

    await this.deps.intelligence.saveMatrix(matrix);
    return matrix;
  }

  /** The full job-specific view, including which document argues it best. */
  async jobView(input: {
    candidateId: string;
    jobId: string;
    now?: Date;
  }): Promise<JobCandidateView | null> {
    const profile = await this.getProfile(input.candidateId);
    if (!profile) return null;

    const requirements = await this.requirementsFor(input.jobId);
    const matrix = await this.matrixFor({ ...input, requirements });

    const stored = await this.deps.intelligence.listExtractions(input.candidateId);

    return buildJobCandidateView({
      jobId: input.jobId,
      candidateId: input.candidateId,
      profile,
      requirements,
      matrix: matrix ?? undefined,
      graph: this.graph,
      documents: stored.map((row) => ({
        documentId: row.documentId,
        label: row.label,
        uploadedAt: row.uploadedAt,
        targetRole: row.targetRole,
        experience: row.experience,
        education: row.education,
        certifications: row.certifications,
        projects: row.projects,
        achievements: row.achievements,
        languages: row.languages,
        skills: row.skills,
        summary: row.summary,
      })),
      now: input.now,
    });
  }

  /** Requirements from the job's enrichment, or an empty list when unenriched. */
  async requirementsFor(jobId: string): Promise<ParsedRequirement[]> {
    const enrichment = await this.deps.enrichments.getEnrichment(jobId);
    return enrichment ? requirementsFromEnrichment(enrichment) : [];
  }

  /**
   * A signed, expiring URL for the original file.
   *
   * The only way to reach a stored document. Nothing in the system exposes a
   * document through a public or guessable URL, and the URL is minted per
   * request rather than stored.
   */
  async downloadUrl(documentId: string, expiresInSeconds = 300): Promise<string | null> {
    if (!this.deps.storage) return null;

    const document = await this.deps.intelligence.getDocument(documentId);
    if (!document || document.deletedAt) return null;

    return this.deps.storage.signedUrl(`resumes/${document.candidateId}/${document.id}`, expiresInSeconds);
  }

  /**
   * Deletes a document and its stored bytes.
   *
   * The row is soft-deleted so historical matches stay explainable; the bytes
   * are removed for real, because keeping a resume nobody asked to keep is the
   * kind of thing that is only noticed after a breach.
   */
  async deleteDocument(candidateId: string, documentId: string, now = new Date()): Promise<void> {
    const document = await this.deps.intelligence.getDocument(documentId);
    if (!document || document.candidateId !== candidateId) return;

    if (this.deps.storage) {
      try {
        await this.deps.storage.delete(`resumes/${candidateId}/${documentId}`);
      } catch (error) {
        this.deps.logger.warn('resume.storage.delete_failed', {
          documentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.deps.intelligence.deleteDocument(documentId, now);
    await this.rebuildProfile(candidateId, now);

    this.deps.logger.info('resume.document.deleted', { candidateId, documentId });
  }
}

/**
 * A log-safe description of an extraction.
 *
 * Exists so that "let me just log the parsed roles to debug this" produces
 * counts rather than someone's employment history.
 */
export function redactedSummary(pipeline: PipelineOutput): Record<string, unknown> {
  return {
    ok: pipeline.ok,
    failedStage: pipeline.failedStage,
    sections: pipeline.sections.map((section) => section.kind),
    roles: pipeline.experience.length,
    skills: pipeline.skills.length,
    education: pipeline.education.length,
    certifications: pipeline.certifications.length,
    projects: pipeline.projects.length,
    textLength: pipeline.textLength,
    stages: pipeline.stages.map((stage) => ({
      stage: stage.stage,
      ok: stage.ok,
      durationMs: stage.durationMs,
    })),
  };
}
