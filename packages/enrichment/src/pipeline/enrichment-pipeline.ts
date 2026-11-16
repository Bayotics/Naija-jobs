import {
  jobEnrichmentSchema,
  type ExtractedSkill,
  type JobEnrichment,
  type SalaryPeriod,
} from '@job-intel/contracts';
import { cleanJobDescription, segmentSections } from '../cleaning/content-cleaner';
import { normalizeJobTitle } from '../extractors/title';
import { extractExperience } from '../extractors/experience';
import { detectSeniority } from '../extractors/seniority';
import { extractSkills } from '../extractors/skills';
import { extractLocation, extractWorkArrangement } from '../extractors/work-arrangement';
import { extractCompensation, StaticFxRateProvider, DEFAULT_FX_RATES, type FxRateProvider } from '../extractors/compensation';
import { extractWorkAuthorization } from '../extractors/work-authorization';
import { classifyJob, extractEducation } from '../extractors/education-classification';
import { analyzeQuality } from '../quality/quality-analyzer';
import {
  DEFAULT_AI_GATE,
  NullAiProvider,
  shouldUseAi,
  validateAiExtraction,
  type AiExtraction,
  type AiExtractionProvider,
  type AiGateOptions,
} from '../ai/extraction-provider';
import {
  extractUrlsFromText,
  resolveApplicationTarget,
} from '../extractors/application-url';
import { findSkill } from '../taxonomy/skills';

/**
 * The enrichment pipeline.
 *
 * Composed of small, independently testable stages rather than one large
 * function. Every stage is wrapped by `runStage`, which times it and converts a
 * throw into a recorded failure — so one broken extractor degrades a single
 * field instead of losing the whole enrichment.
 *
 * Ordering is driven by data dependencies: cleaning feeds segmentation, which
 * feeds skills and education; experience feeds seniority; compensation feeds
 * quality. Nothing reaches back.
 */

/** Bumped when extractor behaviour changes, so stale rows can be replayed. */
export const ENRICHMENT_VERSION = 1;

export interface EnrichmentInput {
  jobId: string;
  title: string;
  companyName: string;
  companyWebsite: string | null;
  description: string | null;
  descriptionHtml: string | null;
  locationText: string | null;
  remoteFlag: boolean | null;
  sourceUrl: string;
  applyUrl: string | null;
  salaryText: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: SalaryPeriod | null;
  tags: readonly string[];
  /** Hidden-content findings from normalization. */
  contentFlags?: readonly string[];
  /** Structured visa flag, where the source supplies one. */
  sourceVisaFlag?: boolean | null;
}

export interface EnrichmentOptions {
  fxProvider?: FxRateProvider | null;
  aiProvider?: AiExtractionProvider;
  aiGate?: Partial<AiGateOptions>;
  /** Shared across a batch so the AI budget is per-run, not per-job. */
  aiCallCounter?: { count: number };
  signal?: AbortSignal;
}

interface StageReport {
  stage: string;
  durationMs: number;
  ok: boolean;
  note: string | null;
}

/**
 * Runs one stage, containing its failure.
 *
 * A thrown extractor yields the supplied fallback plus a recorded report. This
 * is what makes the pipeline total: enrichment always produces a result.
 */
function runStage<T>(
  name: string,
  reports: StageReport[],
  fallback: T,
  fn: () => T,
): T {
  const started = Date.now();
  try {
    const value = fn();
    reports.push({ stage: name, durationMs: Date.now() - started, ok: true, note: null });
    return value;
  } catch (error) {
    reports.push({
      stage: name,
      durationMs: Date.now() - started,
      ok: false,
      note: (error instanceof Error ? error.message : String(error)).slice(0, 400),
    });
    return fallback;
  }
}

export async function enrichJob(
  input: EnrichmentInput,
  options: EnrichmentOptions = {},
): Promise<JobEnrichment> {
  const startedAt = Date.now();
  const reports: StageReport[] = [];
  const fx = options.fxProvider === undefined
    ? new StaticFxRateProvider(DEFAULT_FX_RATES)
    : options.fxProvider;

  // ── 1. Content cleaning ───────────────────────────────────────────────────
  const cleaning = runStage('content_cleaning', reports, { cleaned: input.description ?? '', removedChars: 0, removedBlocks: [] }, () =>
    cleanJobDescription(input.description),
  );
  const cleaned = cleaning.cleaned || null;

  // ── 2. Section segmentation ───────────────────────────────────────────────
  const sections = runStage(
    'section_segmentation',
    reports,
    { responsibilities: [], requirements: [], preferredQualifications: [], benefits: [], other: [] },
    () => segmentSections(cleaned),
  );

  // ── 3. Title normalization ────────────────────────────────────────────────
  const title = runStage(
    'title_normalization',
    reports,
    { value: { normalized: input.title, roleSlug: null, confidence: 0, strippedTokens: [] }, confidence: 0, method: 'default' as const, evidence: null },
    () => normalizeJobTitle(input.title),
  );

  // ── 4. Experience (feeds seniority) ───────────────────────────────────────
  const experience = runStage(
    'experience_extraction',
    reports,
    { minimumYears: null, maximumYears: null, confidence: 0, method: 'default' as const, rawText: null, qualitativeOnly: false },
    () => extractExperience(cleaned),
  );

  // ── 5. Seniority ──────────────────────────────────────────────────────────
  const seniority = runStage(
    'seniority_detection',
    reports,
    { value: null, confidence: 0, evidence: null, conflict: null },
    () => detectSeniority({ title: input.title, description: cleaned, experience }),
  );

  // ── 6. Skills ─────────────────────────────────────────────────────────────
  let skills = runStage('skill_extraction', reports, [] as ExtractedSkill[], () =>
    extractSkills({ title: input.title, description: cleaned, sections, tags: input.tags }),
  );

  // ── 7. Location + work arrangement ────────────────────────────────────────
  const location = runStage(
    'location_extraction',
    reports,
    { raw: input.locationText, city: null, region: null, countryCode: null, timezoneHint: null, confidence: 0, method: 'default' as const },
    () => extractLocation({ locationText: input.locationText, description: cleaned }),
  );

  const workArrangement = runStage(
    'work_arrangement',
    reports,
    { mode: 'unknown' as const, confidence: 0, method: 'default' as const, evidence: null, remoteAllowed: null, remoteRegions: [], remoteWorldwide: false, officeDaysPerWeek: null, officeLocation: null, relocationRequired: null, geographicRestriction: null, travelRequirement: null },
    () =>
      extractWorkArrangement({
        locationText: input.locationText,
        title: input.title,
        description: cleaned,
        remoteFlag: input.remoteFlag,
        tags: input.tags,
      }),
  );

  // ── 8. Compensation ───────────────────────────────────────────────────────
  const compensation = runStage(
    'compensation_extraction',
    reports,
    { stated: false, minimum: null, maximum: null, currency: null, period: null, isOpenEnded: false, isEstimated: false, rawText: null, components: [], confidence: 0, method: 'default' as const, conversion: null },
    () =>
      extractCompensation(
        {
          salaryText: input.salaryText,
          salaryMin: input.salaryMin,
          salaryMax: input.salaryMax,
          salaryCurrency: input.salaryCurrency,
          salaryPeriod: input.salaryPeriod,
          title: input.title,
          description: cleaned,
        },
        fx,
      ),
  );

  // ── 9. Work authorization ─────────────────────────────────────────────────
  const workAuthorization = runStage(
    'work_authorization',
    reports,
    { sponsorship: 'not_mentioned' as const, sponsorshipConfidence: 0.9, sponsorshipEvidence: null, workAuthorizationRequirement: null, citizenshipRequired: null, securityClearanceRequired: null, securityClearanceLevel: null, relocationSupport: 'not_mentioned' as const, relocationEvidence: null },
    () => {
      const flag = input.sourceVisaFlag;
      return extractWorkAuthorization({
        description: cleaned,
        ...(flag !== undefined ? { sourceVisaFlag: flag } : {}),
      });
    },
  );

  // ── 10. Education ─────────────────────────────────────────────────────────
  const education = runStage(
    'education_extraction',
    reports,
    { level: null, requirement: 'not_specified' as const, fields: [], certifications: [], confidence: 0, method: 'default' as const, evidence: null },
    () => extractEducation({ description: cleaned, sections }),
  );

  // ── 11. Classification ────────────────────────────────────────────────────
  const classification = runStage(
    'classification',
    reports,
    { jobFunction: 'other' as const, functionConfidence: 0, industries: [], industryConfidence: 0, method: 'default' as const, evidence: null },
    () =>
      classifyJob({
        title: input.title,
        description: cleaned,
        companyName: input.companyName,
        tags: input.tags,
      }),
  );

  // ── 12. Application URL ───────────────────────────────────────────────────
  const applicationTarget = runStage(
    'application_url',
    reports,
    { sourceUrl: input.sourceUrl, canonicalJobUrl: null, applicationUrl: null, atsVendor: null, atsSlug: null, confidence: 0, kind: 'unknown', candidates: [] },
    () =>
      resolveApplicationTarget({
        sourceUrl: input.sourceUrl,
        applyUrl: input.applyUrl,
        companyWebsite: input.companyWebsite,
        companyName: input.companyName,
        embeddedUrls: extractUrlsFromText(cleaned),
      }),
  );

  // ── 13. Selective AI ──────────────────────────────────────────────────────
  const provider = options.aiProvider ?? new NullAiProvider();
  const gate = { ...DEFAULT_AI_GATE, ...options.aiGate };
  const counter = options.aiCallCounter ?? { count: 0 };

  const ambiguous = collectAmbiguousFields({
    seniorityConfidence: seniority.confidence,
    seniorityConflict: seniority.conflict,
    workMode: workArrangement.mode,
    sponsorship: workAuthorization.sponsorship,
    experienceKnown: experience.minimumYears !== null,
    skillCount: skills.length,
  });

  let aiUsed = false;
  let aiModel: string | null = null;
  let aiInputTokens: number | null = null;
  let aiOutputTokens: number | null = null;
  let aiCostUsd: number | null = null;
  let aiError: string | null = null;

  const decision = shouldUseAi(
    { descriptionLength: cleaned?.length ?? 0, ambiguousFields: ambiguous, callsMade: counter.count },
    gate,
    provider,
  );

  if (decision.use) {
    const started = Date.now();
    try {
      counter.count += 1;
      const result = await provider.extract(
        {
          title: input.title,
          companyName: input.companyName,
          // Bound the prompt: the opening of a posting carries the signal.
          description: (cleaned ?? '').slice(0, 12_000),
          ambiguousFields: ambiguous,
        },
        options.signal,
      );

      const validated = validateAiExtraction(result.extraction);
      if (validated.ok) {
        aiUsed = true;
        aiModel = result.usage.model;
        aiInputTokens = result.usage.inputTokens;
        aiOutputTokens = result.usage.outputTokens;
        aiCostUsd = result.usage.costUsd;
        skills = mergeAiSkills(skills, validated.value.additionalSkills);
        applyAiExtraction(validated.value, {
          seniority,
          experience,
          workArrangement,
          workAuthorization,
          education,
        });
        reports.push({ stage: 'ai_extraction', durationMs: Date.now() - started, ok: true, note: decision.reason });
      } else {
        // Schema violation: discard entirely rather than partially trusting it.
        // Truncate the *final* message — the contract caps notes at 400 chars,
        // and a long validation error would otherwise fail our own schema.
        aiError = `schema validation failed: ${validated.error}`.slice(0, 400);
        reports.push({ stage: 'ai_extraction', durationMs: Date.now() - started, ok: false, note: aiError });
      }
    } catch (error) {
      // A provider failure must never destroy the deterministic result.
      aiError = (error instanceof Error ? error.message : String(error)).slice(0, 400);
      reports.push({ stage: 'ai_extraction', durationMs: Date.now() - started, ok: false, note: aiError });
    }
  } else {
    reports.push({ stage: 'ai_extraction', durationMs: 0, ok: true, note: `skipped: ${decision.reason}` });
  }

  // ── 14. Quality (last: it reads the other stages' output) ─────────────────
  const quality = runStage(
    'quality_analysis',
    reports,
    { qualityScore: 0, scamScore: 0, qualityConfidence: 0, flags: [], components: {} },
    () =>
      analyzeQuality({
        title: input.title,
        companyName: input.companyName,
        description: cleaned,
        descriptionHtml: input.descriptionHtml,
        compensation,
        applicationUrl: applicationTarget.applicationUrl,
        contentFlags: input.contentFlags,
        requirementCount: sections.requirements.length,
        responsibilityCount: sections.responsibilities.length,
        skillCount: skills.length,
      }),
  );

  const enrichment = {
    enrichmentVersion: ENRICHMENT_VERSION,
    normalizedTitle: title.value.normalized || input.title,
    titleConfidence: title.confidence,
    roleSlug: title.value.roleSlug,
    seniority: seniority.value,
    seniorityConfidence: seniority.confidence,
    seniorityEvidence: seniority.evidence,
    seniorityConflict: seniority.conflict,
    experience,
    employmentTypes: [],
    workArrangement,
    location,
    compensation,
    workAuthorization,
    education,
    classification,
    quality,
    applicationTarget,
    skills,
    responsibilities: sections.responsibilities.slice(0, 60),
    requirements: sections.requirements.slice(0, 60),
    preferredQualifications: sections.preferredQualifications.slice(0, 40),
    benefits: sections.benefits.slice(0, 40),
    cleanedDescription: cleaned,
    cleaningRemovedChars: cleaning.removedChars,
    applicationDeadline: null,
    stageReports: reports,
    aiUsed,
    aiModel,
    aiInputTokens,
    aiOutputTokens,
    aiCostUsd,
    aiError,
    totalDurationMs: Date.now() - startedAt,
  };

  // Validate our own output. An extractor that drifts out of contract should
  // fail here, in tests, rather than by writing a bad row.
  return jobEnrichmentSchema.parse(enrichment);
}

/** Fields the deterministic pass could not settle, used to gate the LLM. */
function collectAmbiguousFields(input: {
  seniorityConfidence: number;
  seniorityConflict: string | null;
  workMode: string;
  sponsorship: string;
  experienceKnown: boolean;
  skillCount: number;
}): string[] {
  const ambiguous: string[] = [];
  if (input.seniorityConfidence < 0.6 || input.seniorityConflict) ambiguous.push('seniority');
  if (input.workMode === 'unknown') ambiguous.push('work_mode');
  if (input.sponsorship === 'unclear') ambiguous.push('visa_sponsorship');
  if (!input.experienceKnown) ambiguous.push('experience');
  if (input.skillCount < 3) ambiguous.push('skills');
  return ambiguous;
}

/**
 * Applies model output, but only where the deterministic pass was weak.
 *
 * A confident pattern match beats a model guess: patterns are reproducible and
 * auditable, and overwriting a high-confidence regex result with an LLM opinion
 * would make extraction non-deterministic for no gain.
 */
function applyAiExtraction(
  ai: AiExtraction,
  targets: {
    seniority: { value: unknown; confidence: number; evidence: string | null; conflict: string | null };
    experience: { minimumYears: number | null; confidence: number; method: string; rawText: string | null };
    workArrangement: { mode: string; confidence: number; method: string; evidence: string | null; remoteRegions: string[] };
    workAuthorization: { sponsorship: string; sponsorshipConfidence: number; sponsorshipEvidence: string | null };
    education: { level: unknown; requirement: string; confidence: number; method: string };
  },
): void {
  if (ai.seniority && targets.seniority.confidence < 0.6) {
    targets.seniority.value = ai.seniority;
    targets.seniority.confidence = Math.min(0.8, ai.confidence);
    targets.seniority.evidence = ai.seniorityReason ?? 'model inference';
  }

  if (ai.minimumYearsExperience !== null && targets.experience.minimumYears === null) {
    targets.experience.minimumYears = ai.minimumYearsExperience;
    targets.experience.confidence = Math.min(0.75, ai.confidence);
    targets.experience.method = 'llm';
  }

  if (targets.workArrangement.mode === 'unknown' && ai.workMode !== 'unknown') {
    targets.workArrangement.mode = ai.workMode;
    targets.workArrangement.confidence = Math.min(0.75, ai.confidence);
    targets.workArrangement.method = 'llm';
    targets.workArrangement.evidence = ai.workModeEvidence;
  }
  if (targets.workArrangement.remoteRegions.length === 0 && ai.remoteRegions.length > 0) {
    targets.workArrangement.remoteRegions = ai.remoteRegions.slice(0, 10);
  }

  // Only upgrade *away from* ambiguity, and never to a negative the
  // deterministic pass did not see — a model inventing "not_offered" would
  // wrongly exclude jobs for a candidate who needs sponsorship.
  if (targets.workAuthorization.sponsorship === 'unclear' && ai.visaSponsorship !== 'unclear') {
    if (ai.visaSponsorship !== 'not_offered' || ai.confidence >= 0.8) {
      targets.workAuthorization.sponsorship = ai.visaSponsorship;
      targets.workAuthorization.sponsorshipConfidence = Math.min(0.75, ai.confidence);
      targets.workAuthorization.sponsorshipEvidence = ai.visaEvidence ?? 'model inference';
    }
  }

  if (targets.education.level === null && ai.educationLevel) {
    targets.education.level = ai.educationLevel;
    targets.education.requirement = ai.educationRequirement;
    targets.education.confidence = Math.min(0.7, ai.confidence);
    targets.education.method = 'llm';
  }
}

/** Adds model-suggested skills that map onto the taxonomy. */
function mergeAiSkills(
  existing: ExtractedSkill[],
  additional: Array<{ name: string; requirement: string }>,
): ExtractedSkill[] {
  const bySlug = new Map(existing.map((s) => [s.slug, s]));

  for (const suggestion of additional) {
    const slug = suggestion.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
    if (bySlug.has(slug)) continue;
    // Only accept skills already in the taxonomy: a free-text model label would
    // fragment the vocabulary that matching depends on.
    const definition = findSkill(slug);
    if (!definition) continue;

    bySlug.set(slug, {
      slug: definition.slug,
      displayName: definition.displayName,
      category: definition.category,
      requirement: (['required', 'preferred', 'optional', 'inferred'] as const).includes(
        suggestion.requirement as never,
      )
        ? (suggestion.requirement as ExtractedSkill['requirement'])
        : 'inferred',
      confidence: 0.6,
      method: 'llm',
      matchedText: suggestion.name.slice(0, 200),
      evidence: 'suggested by model',
    });
  }

  return [...bySlug.values()];
}
