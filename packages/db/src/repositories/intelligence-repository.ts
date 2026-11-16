import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  candidateDocumentSchema,
  candidateIntelligenceSchema,
  documentSectionSchema,
  profileConflictSchema,
  requirementMatrixSchema,
  type CandidateDocument,
  type CandidateIntelligence,
  type CandidateSkillFact,
  type DocumentSection,
  type DocumentStatus,
  type FieldOverride,
  type ProfileConflict,
  type RequirementMatrix,
} from '@job-intel/contracts';
import type { Database } from '../client';
import {
  candidateDocuments,
  candidateIntelligenceProfiles,
  candidateSkillFacts,
  documentExtractions,
  documentSections,
  externalProfiles,
  profileConflicts,
  profileFieldOverrides,
  requirementMatrices,
} from '../schema/candidate-intelligence';

/**
 * Candidate intelligence persistence.
 *
 * Three invariants live here rather than in the service:
 *
 *  - **Activation is atomic.** Publishing a profile version deactivates the
 *    previous one and activates the new one in one transaction, so a reader
 *    never sees two active versions or none.
 *
 *  - **Overrides survive re-extraction.** They live in their own table and are
 *    applied when a profile is read, never folded into the stored row.
 *
 *  - **Conflicts are idempotent.** The same contradiction detected on two runs
 *    upserts one row, because a candidate who re-uploads should not be asked
 *    the same question three times.
 */
export class IntelligenceRepository {
  constructor(private readonly db: Database) {}

  // ── Documents ─────────────────────────────────────────────────────────────

  /**
   * Records an upload.
   *
   * Returns the existing row when the same bytes were already uploaded: the
   * unique index on (candidate, hash) makes a duplicate a no-op rather than a
   * second document, and re-uploading an identical file is a common accident.
   */
  async createDocument(input: {
    candidateId: string;
    label: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentHash: string;
    storageKey: string | null;
    kind?: string;
    targetRole?: string | null;
  }): Promise<{ document: CandidateDocument; duplicate: boolean }> {
    const inserted = await this.db
      .insert(candidateDocuments)
      .values({
        candidateId: input.candidateId,
        kind: input.kind ?? 'resume',
        label: input.label,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        contentHash: input.contentHash,
        storageKey: input.storageKey,
        targetRole: input.targetRole ?? null,
        status: 'uploaded',
      })
      .onConflictDoNothing({
        target: [candidateDocuments.candidateId, candidateDocuments.contentHash],
      })
      .returning();

    if (inserted[0]) {
      return { document: this.toDocument(inserted[0]), duplicate: false };
    }

    const existing = await this.db
      .select()
      .from(candidateDocuments)
      .where(
        and(
          eq(candidateDocuments.candidateId, input.candidateId),
          eq(candidateDocuments.contentHash, input.contentHash),
        ),
      )
      .limit(1);

    if (!existing[0]) throw new Error('Document insert conflicted but no existing row was found.');
    return { document: this.toDocument(existing[0]), duplicate: true };
  }

  async updateDocumentStatus(
    documentId: string,
    status: DocumentStatus,
    detail: {
      rejectionReason?: string | null;
      pipelineStages?: unknown[];
      textLength?: number;
      warnings?: string[];
      extractedAt?: Date | null;
    } = {},
  ): Promise<void> {
    await this.db
      .update(candidateDocuments)
      .set({
        status,
        rejectionReason: detail.rejectionReason ?? null,
        ...(detail.pipelineStages ? { pipelineStages: detail.pipelineStages } : {}),
        ...(detail.textLength !== undefined ? { textLength: detail.textLength } : {}),
        ...(detail.warnings ? { extractorWarnings: detail.warnings } : {}),
        ...(detail.extractedAt !== undefined ? { extractedAt: detail.extractedAt } : {}),
      })
      .where(eq(candidateDocuments.id, documentId));
  }

  async listDocuments(candidateId: string, includeDeleted = false): Promise<CandidateDocument[]> {
    const rows = await this.db
      .select()
      .from(candidateDocuments)
      .where(
        includeDeleted
          ? eq(candidateDocuments.candidateId, candidateId)
          : and(
              eq(candidateDocuments.candidateId, candidateId),
              isNull(candidateDocuments.deletedAt),
            ),
      )
      .orderBy(desc(candidateDocuments.uploadedAt));

    return rows.map((row) => this.toDocument(row));
  }

  async getDocument(documentId: string): Promise<CandidateDocument | null> {
    const rows = await this.db
      .select()
      .from(candidateDocuments)
      .where(eq(candidateDocuments.id, documentId))
      .limit(1);

    return rows[0] ? this.toDocument(rows[0]) : null;
  }

  /**
   * Soft delete.
   *
   * The row stays so that matches and notifications referencing this document
   * remain resolvable — "we recommended this because of your Cloud CV" must not
   * become a dangling id. The stored bytes are a separate deletion, handled by
   * the service against object storage.
   */
  async deleteDocument(documentId: string, now = new Date()): Promise<void> {
    await this.db
      .update(candidateDocuments)
      .set({ deletedAt: now, storageKey: null })
      .where(eq(candidateDocuments.id, documentId));
  }

  private toDocument(row: typeof candidateDocuments.$inferSelect): CandidateDocument {
    return candidateDocumentSchema.parse({
      id: row.id,
      candidateId: row.candidateId,
      kind: row.kind,
      label: row.label,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      contentHash: row.contentHash,
      status: row.status,
      rejectionReason: row.rejectionReason,
      targetRole: row.targetRole,
      uploadedAt: row.uploadedAt,
      extractedAt: row.extractedAt,
      deletedAt: row.deletedAt,
    });
  }

  // ── Sections and per-document extraction ──────────────────────────────────

  async replaceSections(documentId: string, sections: readonly DocumentSection[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(documentSections).where(eq(documentSections.documentId, documentId));
      if (sections.length === 0) return;

      await tx.insert(documentSections).values(
        sections.map((section) => ({
          documentId,
          kind: section.kind,
          heading: section.heading,
          startOffset: section.startOffset,
          endOffset: section.endOffset,
          text: section.text,
          confidence: section.confidence,
          aiClassified: section.aiClassified,
        })),
      );
    });
  }

  async getSections(documentId: string): Promise<DocumentSection[]> {
    const rows = await this.db
      .select()
      .from(documentSections)
      .where(eq(documentSections.documentId, documentId))
      .orderBy(documentSections.startOffset);

    return rows.map((row) =>
      documentSectionSchema.parse({
        kind: row.kind,
        heading: row.heading,
        startOffset: row.startOffset,
        endOffset: row.endOffset,
        text: row.text,
        confidence: row.confidence,
        aiClassified: row.aiClassified,
      }),
    );
  }

  async saveExtraction(input: {
    documentId: string;
    candidateId: string;
    experience: unknown[];
    education: unknown[];
    certifications: unknown[];
    projects: unknown[];
    achievements: unknown[];
    languages: unknown[];
    skills: CandidateSkillFact[];
    summary: string | null;
    extractionVersion: string;
    taxonomyVersion: string;
    extractionModel: string | null;
  }): Promise<void> {
    await this.db
      .insert(documentExtractions)
      .values({
        documentId: input.documentId,
        candidateId: input.candidateId,
        experience: input.experience as never,
        education: input.education as never,
        certifications: input.certifications as never,
        projects: input.projects as never,
        achievements: input.achievements as never,
        languages: input.languages as never,
        skills: input.skills,
        summary: input.summary,
        extractionVersion: input.extractionVersion,
        taxonomyVersion: input.taxonomyVersion,
        extractionModel: input.extractionModel,
      })
      .onConflictDoUpdate({
        target: documentExtractions.documentId,
        set: {
          experience: input.experience as never,
          education: input.education as never,
          certifications: input.certifications as never,
          projects: input.projects as never,
          achievements: input.achievements as never,
          languages: input.languages as never,
          skills: input.skills,
          summary: input.summary,
          extractionVersion: input.extractionVersion,
          taxonomyVersion: input.taxonomyVersion,
          extractionModel: input.extractionModel,
        },
      });
  }

  async listExtractions(candidateId: string): Promise<
    Array<typeof documentExtractions.$inferSelect & { label: string; uploadedAt: Date; targetRole: string | null }>
  > {
    const rows = await this.db
      .select({
        extraction: documentExtractions,
        label: candidateDocuments.label,
        uploadedAt: candidateDocuments.uploadedAt,
        targetRole: candidateDocuments.targetRole,
      })
      .from(documentExtractions)
      .innerJoin(candidateDocuments, eq(candidateDocuments.id, documentExtractions.documentId))
      .where(
        and(
          eq(documentExtractions.candidateId, candidateId),
          isNull(candidateDocuments.deletedAt),
        ),
      )
      .orderBy(desc(candidateDocuments.uploadedAt));

    return rows.map((row) => ({
      ...row.extraction,
      label: row.label,
      uploadedAt: row.uploadedAt,
      targetRole: row.targetRole,
    }));
  }

  // ── Versioned profiles ────────────────────────────────────────────────────

  async nextProfileVersion(candidateId: string): Promise<number> {
    const rows = await this.db
      .select({ max: sql<number>`coalesce(max(${candidateIntelligenceProfiles.profileVersion}), 0)` })
      .from(candidateIntelligenceProfiles)
      .where(eq(candidateIntelligenceProfiles.candidateId, candidateId));

    return (rows[0]?.max ?? 0) + 1;
  }

  /**
   * Stores a version and makes it the active one.
   *
   * Both halves happen in one transaction. A crash between deactivating the old
   * version and activating the new one would leave the candidate with no active
   * profile, which reads downstream as "this person has no skills".
   */
  async publishProfile(profile: CandidateIntelligence): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(candidateIntelligenceProfiles)
        .set({ isActive: false })
        .where(eq(candidateIntelligenceProfiles.candidateId, profile.candidateId));

      await tx
        .insert(candidateIntelligenceProfiles)
        .values({
          candidateId: profile.candidateId,
          profileVersion: profile.profileVersion,
          summary: profile.summary,
          summaryGenerated: profile.summaryGenerated,
          skills: profile.skills,
          experience: profile.experience,
          education: profile.education,
          certifications: profile.certifications,
          projects: profile.projects,
          achievements: profile.achievements,
          languages: profile.languages,
          seniority: profile.seniority,
          trajectory: profile.trajectory,
          quality: profile.quality,
          sourceDocumentIds: profile.sourceDocumentIds,
          openConflicts: profile.openConflicts,
          extractionVersion: profile.extractionVersion,
          taxonomyVersion: profile.taxonomyVersion,
          extractionModel: profile.extractionModel,
          isActive: true,
          computedAt: profile.computedAt,
        })
        .onConflictDoUpdate({
          target: [
            candidateIntelligenceProfiles.candidateId,
            candidateIntelligenceProfiles.profileVersion,
          ],
          set: {
            skills: profile.skills,
            experience: profile.experience,
            education: profile.education,
            certifications: profile.certifications,
            projects: profile.projects,
            achievements: profile.achievements,
            languages: profile.languages,
            seniority: profile.seniority,
            trajectory: profile.trajectory,
            quality: profile.quality,
            summary: profile.summary,
            summaryGenerated: profile.summaryGenerated,
            sourceDocumentIds: profile.sourceDocumentIds,
            openConflicts: profile.openConflicts,
            isActive: true,
            computedAt: profile.computedAt,
          },
        });

      // Rebuild the denormalised skill index for this version.
      await tx
        .delete(candidateSkillFacts)
        .where(
          and(
            eq(candidateSkillFacts.candidateId, profile.candidateId),
            eq(candidateSkillFacts.profileVersion, profile.profileVersion),
          ),
        );

      if (profile.skills.length > 0) {
        await tx.insert(candidateSkillFacts).values(
          profile.skills.map((fact) => ({
            candidateId: profile.candidateId,
            profileVersion: profile.profileVersion,
            slug: fact.slug,
            name: fact.name,
            category: fact.category,
            proficiency: fact.proficiency,
            proficiencyConfidence: fact.proficiencyConfidence,
            proficiencyRationale: fact.proficiencyRationale,
            totalMonths: fact.totalMonths,
            monthsIsEstimate: fact.monthsIsEstimate,
            lastEvidencedAt: fact.lastEvidencedAt,
            firstEvidencedAt: fact.firstEvidencedAt,
            evidence: fact.evidence,
            strongestSource: fact.strongestSource,
            userVerified: fact.userVerified,
          })),
        );
      }
    });
  }

  async getActiveProfile(candidateId: string): Promise<CandidateIntelligence | null> {
    const rows = await this.db
      .select()
      .from(candidateIntelligenceProfiles)
      .where(
        and(
          eq(candidateIntelligenceProfiles.candidateId, candidateId),
          eq(candidateIntelligenceProfiles.isActive, true),
        ),
      )
      .limit(1);

    return rows[0] ? this.toProfile(rows[0]) : null;
  }

  async getProfileVersion(
    candidateId: string,
    profileVersion: number,
  ): Promise<CandidateIntelligence | null> {
    const rows = await this.db
      .select()
      .from(candidateIntelligenceProfiles)
      .where(
        and(
          eq(candidateIntelligenceProfiles.candidateId, candidateId),
          eq(candidateIntelligenceProfiles.profileVersion, profileVersion),
        ),
      )
      .limit(1);

    return rows[0] ? this.toProfile(rows[0]) : null;
  }

  async listProfileVersions(
    candidateId: string,
    limit = 20,
  ): Promise<Array<{ profileVersion: number; computedAt: Date; skillCount: number; isActive: boolean }>> {
    const rows = await this.db
      .select({
        profileVersion: candidateIntelligenceProfiles.profileVersion,
        computedAt: candidateIntelligenceProfiles.computedAt,
        skills: candidateIntelligenceProfiles.skills,
        isActive: candidateIntelligenceProfiles.isActive,
      })
      .from(candidateIntelligenceProfiles)
      .where(eq(candidateIntelligenceProfiles.candidateId, candidateId))
      .orderBy(desc(candidateIntelligenceProfiles.profileVersion))
      .limit(limit);

    return rows.map((row) => ({
      profileVersion: row.profileVersion,
      computedAt: row.computedAt,
      skillCount: row.skills.length,
      isActive: row.isActive,
    }));
  }

  private toProfile(row: typeof candidateIntelligenceProfiles.$inferSelect): CandidateIntelligence {
    return candidateIntelligenceSchema.parse({
      candidateId: row.candidateId,
      profileVersion: row.profileVersion,
      summary: row.summary,
      summaryGenerated: row.summaryGenerated,
      skills: row.skills,
      experience: row.experience,
      education: row.education,
      certifications: row.certifications,
      projects: row.projects,
      achievements: row.achievements,
      languages: row.languages,
      seniority: row.seniority,
      trajectory: row.trajectory,
      quality: row.quality,
      sourceDocumentIds: row.sourceDocumentIds,
      openConflicts: row.openConflicts,
      extractionVersion: row.extractionVersion,
      taxonomyVersion: row.taxonomyVersion,
      extractionModel: row.extractionModel,
      computedAt: row.computedAt,
    });
  }

  // ── Conflicts ─────────────────────────────────────────────────────────────

  /** Upserts by (candidate, kind, subject) so re-detection does not duplicate. */
  async recordConflicts(conflicts: readonly ProfileConflict[]): Promise<number> {
    if (conflicts.length === 0) return 0;

    const result = await this.db
      .insert(profileConflicts)
      .values(
        conflicts.map((conflict) => ({
          id: conflict.id,
          candidateId: conflict.candidateId,
          kind: conflict.kind,
          subject: conflict.subject,
          positions: conflict.positions,
          detail: conflict.detail,
          status: conflict.status,
          detectedAt: conflict.detectedAt,
        })),
      )
      .onConflictDoNothing({
        target: [profileConflicts.candidateId, profileConflicts.kind, profileConflicts.subject],
      })
      .returning({ id: profileConflicts.id });

    return result.length;
  }

  async listConflicts(candidateId: string, status = 'open'): Promise<ProfileConflict[]> {
    const rows = await this.db
      .select()
      .from(profileConflicts)
      .where(
        and(eq(profileConflicts.candidateId, candidateId), eq(profileConflicts.status, status)),
      )
      .orderBy(desc(profileConflicts.detectedAt));

    return rows.map((row) =>
      profileConflictSchema.parse({
        id: row.id,
        candidateId: row.candidateId,
        kind: row.kind,
        subject: row.subject,
        positions: row.positions,
        detail: row.detail,
        status: row.status,
        resolvedValue: row.resolvedValue,
        resolvedAt: row.resolvedAt,
        detectedAt: row.detectedAt,
      }),
    );
  }

  async countOpenConflicts(candidateId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(profileConflicts)
      .where(
        and(eq(profileConflicts.candidateId, candidateId), eq(profileConflicts.status, 'open')),
      );

    return rows[0]?.count ?? 0;
  }

  async resolveConflict(
    conflictId: string,
    resolvedValue: string | null,
    status: 'resolved' | 'ignored' = 'resolved',
    now = new Date(),
  ): Promise<void> {
    await this.db
      .update(profileConflicts)
      .set({ status, resolvedValue, resolvedAt: now })
      .where(eq(profileConflicts.id, conflictId));
  }

  // ── Overrides ─────────────────────────────────────────────────────────────

  /** One override per path: a new correction replaces the previous one. */
  async saveOverride(override: FieldOverride): Promise<void> {
    await this.db
      .insert(profileFieldOverrides)
      .values({
        id: override.id,
        candidateId: override.candidateId,
        path: override.path,
        value: override.value as never,
        previousValue: override.previousValue as never,
        origin: override.origin,
        note: override.note,
        createdAt: override.createdAt,
      })
      .onConflictDoUpdate({
        target: [profileFieldOverrides.candidateId, profileFieldOverrides.path],
        set: {
          value: override.value as never,
          previousValue: override.previousValue as never,
          origin: override.origin,
          note: override.note,
          createdAt: override.createdAt,
        },
      });
  }

  async listOverrides(candidateId: string): Promise<FieldOverride[]> {
    const rows = await this.db
      .select()
      .from(profileFieldOverrides)
      .where(eq(profileFieldOverrides.candidateId, candidateId))
      .orderBy(profileFieldOverrides.createdAt);

    return rows.map((row) => ({
      id: row.id,
      candidateId: row.candidateId,
      path: row.path,
      value: row.value,
      previousValue: row.previousValue,
      origin: row.origin as FieldOverride['origin'],
      note: row.note,
      createdAt: row.createdAt,
    }));
  }

  async deleteOverride(candidateId: string, path: string): Promise<void> {
    await this.db
      .delete(profileFieldOverrides)
      .where(
        and(
          eq(profileFieldOverrides.candidateId, candidateId),
          eq(profileFieldOverrides.path, path),
        ),
      );
  }

  // ── Requirement matrices ──────────────────────────────────────────────────

  async saveMatrix(matrix: RequirementMatrix): Promise<void> {
    await this.db
      .insert(requirementMatrices)
      .values({
        candidateId: matrix.candidateId,
        jobId: matrix.jobId,
        rows: matrix.rows,
        directMatches: matrix.directMatches,
        transferableMatches: matrix.transferableMatches,
        unknowns: matrix.unknowns,
        missing: matrix.missing,
        coverageScore: matrix.coverageScore,
        profileVersion: matrix.profileVersion,
        computedAt: matrix.computedAt,
      })
      .onConflictDoUpdate({
        target: [
          requirementMatrices.candidateId,
          requirementMatrices.jobId,
          requirementMatrices.profileVersion,
        ],
        set: {
          rows: matrix.rows,
          directMatches: matrix.directMatches,
          transferableMatches: matrix.transferableMatches,
          unknowns: matrix.unknowns,
          missing: matrix.missing,
          coverageScore: matrix.coverageScore,
          computedAt: matrix.computedAt,
        },
      });
  }

  /**
   * Reads a stored matrix.
   *
   * Returns null when the stored matrix was computed against an older profile
   * version: a stale matrix is worse than none, because it looks authoritative
   * while describing a person the profile no longer reflects.
   */
  async getMatrix(
    candidateId: string,
    jobId: string,
    profileVersion: number,
  ): Promise<RequirementMatrix | null> {
    const rows = await this.db
      .select()
      .from(requirementMatrices)
      .where(
        and(
          eq(requirementMatrices.candidateId, candidateId),
          eq(requirementMatrices.jobId, jobId),
          eq(requirementMatrices.profileVersion, profileVersion),
        ),
      )
      .limit(1);

    if (!rows[0]) return null;

    return requirementMatrixSchema.parse({
      jobId: rows[0].jobId,
      candidateId: rows[0].candidateId,
      rows: rows[0].rows,
      directMatches: rows[0].directMatches,
      transferableMatches: rows[0].transferableMatches,
      unknowns: rows[0].unknowns,
      missing: rows[0].missing,
      coverageScore: rows[0].coverageScore,
      profileVersion: rows[0].profileVersion,
      computedAt: rows[0].computedAt,
    });
  }

  // ── External profiles ─────────────────────────────────────────────────────

  async upsertExternalProfile(input: {
    candidateId: string;
    provider: string;
    identifier: string;
    url: string;
    status?: string;
    payload?: Record<string, unknown>;
    derivedSkills?: CandidateSkillFact[];
    lastError?: string | null;
    lastFetchedAt?: Date | null;
  }): Promise<void> {
    await this.db
      .insert(externalProfiles)
      .values({
        candidateId: input.candidateId,
        provider: input.provider,
        identifier: input.identifier,
        url: input.url,
        status: input.status ?? 'pending',
        payload: input.payload ?? {},
        derivedSkills: input.derivedSkills ?? [],
        lastError: input.lastError ?? null,
        lastFetchedAt: input.lastFetchedAt ?? null,
      })
      .onConflictDoUpdate({
        target: [externalProfiles.candidateId, externalProfiles.provider, externalProfiles.identifier],
        set: {
          url: input.url,
          status: input.status ?? 'pending',
          payload: input.payload ?? {},
          derivedSkills: input.derivedSkills ?? [],
          lastError: input.lastError ?? null,
          lastFetchedAt: input.lastFetchedAt ?? null,
        },
      });
  }

  async listExternalProfiles(candidateId: string): Promise<Array<typeof externalProfiles.$inferSelect>> {
    return this.db
      .select()
      .from(externalProfiles)
      .where(eq(externalProfiles.candidateId, candidateId));
  }

  async deleteExternalProfile(candidateId: string, provider: string, identifier: string): Promise<void> {
    await this.db
      .delete(externalProfiles)
      .where(
        and(
          eq(externalProfiles.candidateId, candidateId),
          eq(externalProfiles.provider, provider),
          eq(externalProfiles.identifier, identifier),
        ),
      );
  }

  /** Candidates evidencing a skill, for ops-side questions about coverage. */
  async candidatesWithSkill(slug: string, limit = 50): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ candidateId: candidateSkillFacts.candidateId })
      .from(candidateSkillFacts)
      .where(eq(candidateSkillFacts.slug, slug))
      .limit(limit);

    return rows.map((row) => row.candidateId);
  }

  /** Bulk read used by the matching pipeline. */
  async getActiveProfiles(candidateIds: readonly string[]): Promise<Map<string, CandidateIntelligence>> {
    if (candidateIds.length === 0) return new Map();

    const rows = await this.db
      .select()
      .from(candidateIntelligenceProfiles)
      .where(
        and(
          inArray(candidateIntelligenceProfiles.candidateId, [...candidateIds]),
          eq(candidateIntelligenceProfiles.isActive, true),
        ),
      );

    return new Map(rows.map((row) => [row.candidateId, this.toProfile(row)]));
  }
}
