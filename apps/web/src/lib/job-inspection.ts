import 'server-only';
import type { InspectedField } from '@job-intel/contracts';
import type { OpsRepository } from '@job-intel/db';
import { redact } from '@job-intel/ops';

/**
 * The job debugger's view model.
 *
 * Lives here rather than in the API route because the debugger page and the
 * API render the same thing, and a provenance label that is right in JSON and
 * wrong on screen is worse than no label at all.
 *
 * The organising rule is the one the brief insists on: every displayed value
 * carries where it came from. `raw` is exactly what the source sent,
 * `normalized` is deterministic parsing, `ai_extracted` came out of a model,
 * `system_derived` is our own scoring. Nothing is grouped by *topic* — a screen
 * that puts "seniority" next to "city" without saying that one was inferred and
 * the other was parsed is how a hallucination gets trusted.
 */

type Inspection = NonNullable<Awaited<ReturnType<OpsRepository['inspectJob']>>>;

/**
 * Inferred rather than hand-declared.
 *
 * A duplicated shape here would be a second source of truth for what a match
 * record contains, and the two drift the first time a field is renamed — the
 * kind of drift that ends with a screen confidently labelling a stale field.
 */
export type JobInspectionView = ReturnType<typeof buildJobInspection>;
export type JobInspectionMatch = NonNullable<JobInspectionView['match']>;
export type JobInspectionRecommendation = NonNullable<JobInspectionView['recommendation']>;

function field(
  label: string,
  value: unknown,
  origin: InspectedField['origin'],
  extra: Partial<InspectedField> = {},
): InspectedField {
  return {
    label,
    value: value === null || value === undefined ? null : String(value).slice(0, 2000),
    origin,
    confidence: extra.confidence ?? null,
    method: extra.method ?? null,
    evidence: extra.evidence ?? null,
  };
}

export function buildJobInspection(inspection: Inspection) {
  const { job, enrichment, signals, duplicates, match, recommendation, events } = inspection;

  // ── Raw: exactly what the source gave us ──────────────────────────────────
  const raw: InspectedField[] = [
    field('Title', job.title, 'raw'),
    field('Company', job.companyNameRaw, 'raw'),
    field('Location', job.locationRaw, 'raw'),
    field('Source', job.sourceId, 'raw'),
    field('Source URL', job.sourceUrl, 'raw'),
    field('Apply URL', job.applyUrl, 'raw'),
    field('External id', job.externalId, 'raw'),
    field('Posted at', job.postedAt?.toISOString() ?? null, 'raw'),
    field('Description length', `${job.description?.length ?? 0} characters`, 'raw'),
  ];

  // ── Normalized: deterministic parsing, no model involved ──────────────────
  const normalized: InspectedField[] = [
    field('Normalized title', job.titleNormalized, 'normalized'),
    field('City', job.city, 'normalized'),
    field('Country', job.countryCode, 'normalized'),
    field('Remote type', job.remoteType, 'normalized'),
    field('Employment types', job.employmentTypes.join(', ') || null, 'normalized'),
    field(
      'Salary',
      job.salaryMin || job.salaryMax
        ? `${job.salaryCurrency ?? ''} ${job.salaryMin ?? ''}–${job.salaryMax ?? ''} / ${job.salaryPeriod ?? ''}`
        : null,
      'normalized',
    ),
    field('Salary (annual USD)', job.salaryNormalizedAnnualUsd, 'normalized'),
    field('Fingerprint', job.fingerprint.slice(0, 16), 'normalized'),
    field('SimHash', job.simhash?.toString() ?? null, 'normalized'),
  ];

  // ── Extracted: the enrichment layer, deterministic-first with optional AI ──
  const extracted: InspectedField[] = enrichment
    ? [
        field('Role title', enrichment.normalizedTitle, 'ai_extracted', {
          confidence: enrichment.titleConfidence,
        }),
        field('Seniority', enrichment.seniority, 'ai_extracted', {
          confidence: enrichment.seniorityConfidence,
          evidence: enrichment.seniorityConflict,
        }),
        field('Work arrangement', enrichment.workMode, 'ai_extracted', {
          confidence: enrichment.workModeConfidence,
        }),
        field('Visa sponsorship', enrichment.visaSponsorship, 'ai_extracted', {
          confidence: enrichment.visaConfidence,
        }),
        field('Job function', enrichment.jobFunction, 'ai_extracted'),
        field(
          'Experience',
          enrichment.minYearsExperience === null
            ? null
            : `${enrichment.minYearsExperience}–${enrichment.maxYearsExperience ?? '?'} years`,
          'ai_extracted',
        ),
        field('Requirements extracted', enrichment.requirements.length, 'ai_extracted'),
        // Says plainly whether a model was involved at all, so nothing is
        // mislabelled as AI-extracted when it was pattern-matched.
        field(
          'AI used',
          enrichment.aiUsed ? (enrichment.aiModel ?? 'yes') : 'no — deterministic only',
          'system_derived',
        ),
        field('AI error', redact(enrichment.aiError), 'system_derived'),
      ]
    : [];

  // ── Derived: our own scoring ──────────────────────────────────────────────
  const derived: InspectedField[] = signals
    ? [
        field('Quality score', signals.qualityScore, 'system_derived', {
          confidence: signals.qualityConfidence,
          evidence: signals.quality.explanation,
        }),
        field('Freshness', signals.freshnessScore, 'system_derived', {
          evidence: signals.freshness.explanation,
        }),
        field('Lifecycle', signals.lifecycleStatus, 'system_derived', {
          evidence: signals.lifecycle.explanation,
        }),
        field('Scam risk', signals.scamRisk, 'system_derived', {
          evidence: signals.scam.explanation,
        }),
        field('Repost', signals.repostKind, 'system_derived', {
          evidence: signals.repost.explanation,
        }),
        field('Source authority', signals.sourceAuthority, 'system_derived'),
      ]
    : [];

  return {
    job: {
      id: job.id,
      title: job.title,
      company: job.companyNameRaw,
      status: job.status,
    },
    fields: { raw, normalized, extracted, derived },

    duplicates: duplicates.map((duplicate) => ({
      jobId: duplicate.jobId,
      duplicateOfJobId: duplicate.duplicateOfJobId,
      tier: duplicate.tier,
      confidence: duplicate.duplicateConfidence,
      reason: duplicate.duplicateReason,
      merged: duplicate.merged,
      signals: duplicate.signals,
      conflicts: duplicate.conflicts,
    })),

    // The match debugger: components, weights and every version that shaped it.
    match: match
      ? {
          overallScore: match.overallScore,
          confidence: match.confidence,
          recommendation: match.recommendation,
          eligible: match.eligible,
          structuredScore: match.structuredScore,
          semanticScore: match.semanticScore,
          behavioralAdjustment: match.behavioralAdjustment,
          llmAdjustment: match.llmAdjustment,
          componentScores: match.componentScores,
          skillMatches: match.skillMatches,
          hardConstraints: match.hardConstraintResult,
          matchedRequirements: match.matchedRequirements,
          missingRequirements: match.missingRequirements,
          concerns: match.concerns,
          explanation: match.explanation,
          // Structured reasoning only. No chain-of-thought is stored, and none
          // is exposed.
          weightsUsed: match.trace.weightsUsed,
          versions: {
            matchingVersion: match.trace.matchingVersion,
            profileVersion: match.trace.profileVersion,
            preferenceVersion: match.trace.preferenceVersion,
            enrichmentVersion: match.trace.enrichmentVersion,
            embeddingModel: match.trace.embeddingModel,
            llmModel: match.trace.llmModel,
          },
          llmDecision: match.trace.llmDecision,
          notes: match.trace.notes,
          computedAt: match.computedAt,
        }
      : null,

    recommendation: recommendation
      ? {
          rank: recommendation.rank,
          tier: recommendation.tier,
          finalScore: recommendation.finalScore,
          rawScore: recommendation.rawScore,
          calibratedScore: recommendation.calibratedScore,
          diversityPenalty: recommendation.diversityPenalty,
          factors: recommendation.score.factors,
          explanation: recommendation.rankExplanation,
          reasons: recommendation.rankReasons,
          notificationEligible: recommendation.notificationEligible,
          notificationBlockers: recommendation.notificationBlockers,
        }
      : null,


    events: events.map((event) => ({
      name: event.name,
      severity: event.severity,
      message: redact(event.message),
      createdAt: event.createdAt,
    })),
  };
}
