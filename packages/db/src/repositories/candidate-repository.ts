import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  behavioralSignalSchema,
  candidatePreferencesSchema,
  candidateSkillEntrySchema,
  skillRelationSchema,
  type BehavioralSignalInput,
  type CandidatePreferences,
  type CandidateSkillEntry,
  type CvExtraction,
  type SkillRelation,
} from '@job-intel/contracts';
import type { Database } from '../client';
import {
  behavioralSignals,
  candidateEmbeddings,
  candidatePreferenceVersions,
  candidateSkillProfiles,
  cvImports,
  preferenceChanges,
  skillRelations,
} from '../schema/candidate';
import { skills } from '../schema/identity';
import { jobs } from '../schema/jobs';
import { jobEnrichments } from '../schema/enrichment';

/**
 * Candidate intelligence persistence.
 *
 * The invariants this class exists to hold:
 *
 *  - A preference change is a **new version plus one active flag**, written in
 *    a single transaction. A crash leaves the previous version active rather
 *    than a profile with none.
 *  - Every change writes a field-level row to `preference_changes`, so history
 *    is a record of what changed rather than a pile of full snapshots.
 *  - Behavioural signals are append-only and never touch preferences.
 */
export class CandidateRepository {
  constructor(private readonly db: Database) {}

  // ── Preferences ───────────────────────────────────────────────────────────

  /**
   * The live preference payload.
   *
   * Re-validated on read: a payload written by an older schema must upgrade
   * cleanly or fail loudly, never half-apply.
   */
  async getActivePreferences(
    profileId: string,
  ): Promise<{ versionId: string; version: number; preferences: CandidatePreferences } | null> {
    const rows = await this.db
      .select()
      .from(candidatePreferenceVersions)
      .where(
        and(
          eq(candidatePreferenceVersions.profileId, profileId),
          eq(candidatePreferenceVersions.isActive, true),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      versionId: row.id,
      version: row.version,
      preferences: candidatePreferencesSchema.parse(row.payload),
    };
  }

  /** Creates version 1. Used on first run and by seeding. */
  async initialisePreferences(
    profileId: string,
    preferences: unknown = {},
  ): Promise<{ versionId: string; version: number; preferences: CandidatePreferences }> {
    const payload = candidatePreferencesSchema.parse(preferences);
    const [row] = await this.db
      .insert(candidatePreferenceVersions)
      .values({
        profileId,
        version: 1,
        payload,
        isActive: true,
        changeSummary: 'Initial preferences',
      })
      .returning();
    if (!row) throw new Error('Failed to create initial preferences');
    return { versionId: row.id, version: row.version, preferences: payload };
  }

  /**
   * Persists a new active version plus its change log.
   *
   * Returns the new version so the caller can queue embedding regeneration
   * against a known version rather than racing another writer.
   */
  async savePreferenceVersion(input: {
    profileId: string;
    preferences: CandidatePreferences;
    changes: Array<{ path: string; before: unknown; after: unknown; summary: string }>;
    embeddingStale: boolean;
    changedBy?: string;
    summary?: string;
  }): Promise<{ versionId: string; version: number }> {
    const payload = candidatePreferencesSchema.parse(input.preferences);

    return this.db.transaction(async (tx) => {
      const current = await tx
        .select({ version: candidatePreferenceVersions.version })
        .from(candidatePreferenceVersions)
        .where(eq(candidatePreferenceVersions.profileId, input.profileId))
        .orderBy(desc(candidatePreferenceVersions.version))
        .limit(1);

      const nextVersion = (current[0]?.version ?? 0) + 1;

      await tx
        .update(candidatePreferenceVersions)
        .set({ isActive: false })
        .where(
          and(
            eq(candidatePreferenceVersions.profileId, input.profileId),
            eq(candidatePreferenceVersions.isActive, true),
          ),
        );

      const [version] = await tx
        .insert(candidatePreferenceVersions)
        .values({
          profileId: input.profileId,
          version: nextVersion,
          payload,
          isActive: true,
          changeSummary: input.summary ?? summarise(input.changes),
          createdBy: input.changedBy ?? null,
        })
        .returning();
      if (!version) throw new Error('Failed to create preference version');

      if (input.changes.length > 0) {
        await tx.insert(preferenceChanges).values(
          input.changes.map((change) => ({
            profileId: input.profileId,
            versionId: version.id,
            path: change.path,
            beforeValue: change.before as object,
            afterValue: change.after as object,
            summary: change.summary,
            invalidatedEmbedding: input.embeddingStale,
            changedBy: input.changedBy ?? null,
          })),
        );
      }

      return { versionId: version.id, version: nextVersion };
    });
  }

  async listPreferenceVersions(profileId: string, limit = 30) {
    return this.db
      .select()
      .from(candidatePreferenceVersions)
      .where(eq(candidatePreferenceVersions.profileId, profileId))
      .orderBy(desc(candidatePreferenceVersions.version))
      .limit(limit);
  }

  async listPreferenceChanges(profileId: string, limit = 100) {
    return this.db
      .select()
      .from(preferenceChanges)
      .where(eq(preferenceChanges.profileId, profileId))
      .orderBy(desc(preferenceChanges.createdAt))
      .limit(limit);
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  async listSkills(profileId: string): Promise<CandidateSkillEntry[]> {
    const rows = await this.db
      .select()
      .from(candidateSkillProfiles)
      .where(eq(candidateSkillProfiles.profileId, profileId))
      .orderBy(candidateSkillProfiles.importance, desc(candidateSkillProfiles.yearsOfExperience));

    return rows.map((row) =>
      candidateSkillEntrySchema.parse({
        name: row.name,
        slug: row.slug,
        category: row.category,
        proficiency: row.proficiency,
        yearsOfExperience: row.yearsOfExperience,
        lastUsedYear: row.lastUsedYear,
        importance: row.importance,
        evidence: row.evidence,
        source: row.source,
      }),
    );
  }

  /** Replaces the whole skill set, reconciling slugs with the vocabulary. */
  async replaceSkills(profileId: string, entries: unknown): Promise<number> {
    const parsed = candidateSkillEntrySchema.array().parse(entries);

    await this.db.transaction(async (tx) => {
      await tx.delete(candidateSkillProfiles).where(eq(candidateSkillProfiles.profileId, profileId));
      if (parsed.length === 0) return;

      const slugs = parsed.map((s) => s.slug).filter((s): s is string => Boolean(s));
      const known =
        slugs.length > 0
          ? await tx
              .select({ id: skills.id, slug: skills.slug })
              .from(skills)
              .where(inArray(skills.slug, slugs))
          : [];
      const idBySlug = new Map(known.map((k) => [k.slug, k.id]));

      await tx.insert(candidateSkillProfiles).values(
        parsed.map((entry) => ({
          profileId,
          skillId: entry.slug ? (idBySlug.get(entry.slug) ?? null) : null,
          name: entry.name,
          slug: entry.slug,
          category: entry.category,
          proficiency: entry.proficiency,
          yearsOfExperience: entry.yearsOfExperience,
          lastUsedYear: entry.lastUsedYear,
          importance: entry.importance,
          evidence: entry.evidence,
          source: entry.source,
        })),
      );
    });

    return parsed.length;
  }

  // ── Skill graph ───────────────────────────────────────────────────────────

  async listSkillRelations(): Promise<SkillRelation[]> {
    const rows = await this.db.select().from(skillRelations);
    return rows.map((row) =>
      skillRelationSchema.parse({
        fromSlug: row.fromSlug,
        toSlug: row.toSlug,
        type: row.type,
        weight: row.weight,
      }),
    );
  }

  async upsertSkillRelations(relations: readonly SkillRelation[]): Promise<number> {
    if (relations.length === 0) return 0;
    const parsed = relations.map((r) => skillRelationSchema.parse(r));
    await this.db
      .insert(skillRelations)
      .values(parsed)
      .onConflictDoUpdate({
        target: [skillRelations.fromSlug, skillRelations.toSlug, skillRelations.type],
        set: { weight: sql`excluded.weight` },
      });
    return parsed.length;
  }

  // ── Behavioural signals ───────────────────────────────────────────────────

  /** Append-only. Never writes to preferences — that separation is the point. */
  async recordSignal(profileId: string, input: BehavioralSignalInput): Promise<void> {
    const parsed = behavioralSignalSchema.parse(input);
    await this.db.insert(behavioralSignals).values({
      profileId,
      jobId: parsed.jobId,
      event: parsed.event,
      context: parsed.context,
    });
  }

  /**
   * Signals joined to the job attributes needed for aggregation.
   *
   * Reads the enrichment rather than the raw job so learned signals are
   * computed over the same structured view the matcher uses.
   */
  async listSignalsWithAttributes(profileId: string, limit = 1000) {
    return this.db
      .select({
        // Included so the recommendation layer can attribute a signal to the
        // job it was about, not merely to its attributes.
        jobId: behavioralSignals.jobId,
        event: behavioralSignals.event,
        occurredAt: behavioralSignals.occurredAt,
        countryCode: jobEnrichments.countryCode,
        workMode: jobEnrichments.workMode,
        jobFunction: jobEnrichments.jobFunction,
        seniority: jobEnrichments.seniority,
        companyName: jobs.companyNameRaw,
        techStack: jobs.techStack,
        classification: jobEnrichments.classification,
      })
      .from(behavioralSignals)
      .innerJoin(jobs, eq(behavioralSignals.jobId, jobs.id))
      .leftJoin(jobEnrichments, eq(jobEnrichments.jobId, jobs.id))
      .where(eq(behavioralSignals.profileId, profileId))
      .orderBy(desc(behavioralSignals.occurredAt))
      .limit(limit);
  }

  async signalCounts(profileId: string) {
    const rows = await this.db
      .select({ event: behavioralSignals.event, count: sql<number>`count(*)::int` })
      .from(behavioralSignals)
      .where(eq(behavioralSignals.profileId, profileId))
      .groupBy(behavioralSignals.event);
    return Object.fromEntries(rows.map((r) => [r.event, r.count]));
  }

  // ── Embedding ─────────────────────────────────────────────────────────────

  async getEmbeddingState(profileId: string, model: string) {
    const rows = await this.db
      .select()
      .from(candidateEmbeddings)
      .where(
        and(eq(candidateEmbeddings.profileId, profileId), eq(candidateEmbeddings.model, model)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Records the canonical text and marks the vector stale.
   *
   * Deliberately does *not* generate the embedding: that belongs to the worker.
   * This is the invalidation half, called synchronously on every preference
   * change so a stale vector is never silently used.
   */
  async markEmbeddingStale(input: {
    profileId: string;
    model: string;
    dimensions: number;
    canonicalHash: string;
    canonicalText: string;
    reason: string;
  }): Promise<void> {
    await this.db
      .insert(candidateEmbeddings)
      .values({
        profileId: input.profileId,
        model: input.model,
        dimensions: input.dimensions,
        canonicalHash: input.canonicalHash,
        canonicalText: input.canonicalText,
        isStale: true,
        staleReason: input.reason,
      })
      .onConflictDoUpdate({
        target: [candidateEmbeddings.profileId, candidateEmbeddings.model],
        set: {
          canonicalHash: input.canonicalHash,
          canonicalText: input.canonicalText,
          isStale: true,
          staleReason: input.reason,
          updatedAt: new Date(),
        },
      });
  }

  /** Stores a generated vector and clears the stale flag. */
  async saveEmbedding(input: {
    profileId: string;
    model: string;
    embedding: number[];
    canonicalHash: string;
  }): Promise<void> {
    await this.db
      .update(candidateEmbeddings)
      .set({
        embedding: input.embedding,
        isStale: false,
        staleReason: null,
        generatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(candidateEmbeddings.profileId, input.profileId),
          eq(candidateEmbeddings.model, input.model),
          eq(candidateEmbeddings.canonicalHash, input.canonicalHash),
        ),
      );
  }

  async listStaleEmbeddings(limit = 50) {
    return this.db
      .select()
      .from(candidateEmbeddings)
      .where(eq(candidateEmbeddings.isStale, true))
      .limit(limit);
  }

  // ── CV imports ────────────────────────────────────────────────────────────

  async createCvImport(input: {
    profileId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    rawText: string | null;
  }): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(cvImports)
      .values({ ...input, status: 'uploaded' })
      .returning({ id: cvImports.id });
    if (!row) throw new Error('Failed to create CV import');
    return row;
  }

  /**
   * Stores an extraction as `needs_review`.
   *
   * Never `applied`: extracted data becomes authoritative only when a human
   * accepts it, which is a separate explicit call.
   */
  async saveCvExtraction(id: string, extraction: CvExtraction | null, error?: string): Promise<void> {
    await this.db
      .update(cvImports)
      .set({
        extraction,
        status: error ? 'failed' : 'needs_review',
        extractionError: error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(cvImports.id, id));
  }

  async listCvImports(profileId: string, limit = 20) {
    return this.db
      .select({
        id: cvImports.id,
        filename: cvImports.filename,
        mimeType: cvImports.mimeType,
        sizeBytes: cvImports.sizeBytes,
        status: cvImports.status,
        extraction: cvImports.extraction,
        extractionError: cvImports.extractionError,
        acceptedSections: cvImports.acceptedSections,
        createdAt: cvImports.createdAt,
      })
      .from(cvImports)
      .where(eq(cvImports.profileId, profileId))
      .orderBy(desc(cvImports.createdAt))
      .limit(limit);
  }

  async markCvApplied(id: string, acceptedSections: string[]): Promise<void> {
    await this.db
      .update(cvImports)
      .set({ status: 'applied', acceptedSections, reviewedAt: new Date(), updatedAt: new Date() })
      .where(eq(cvImports.id, id));
  }
}

function summarise(changes: Array<{ summary: string }>): string {
  if (changes.length === 0) return 'No field changes';
  if (changes.length === 1) return changes[0]?.summary ?? 'Updated';
  return `${changes.length} preference changes: ${changes
    .slice(0, 3)
    .map((c) => c.summary)
    .join('; ')}${changes.length > 3 ? '…' : ''}`;
}
