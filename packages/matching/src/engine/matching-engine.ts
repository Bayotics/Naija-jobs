import type { z } from 'zod';
import {
  MATCHING_VERSION,
  matchingConfigSchema,
  type ComponentScore,
  type JobMatch,
  type LlmReasoning,
  type LlmUsage,
  type MatchTrace,
  type MatchingConfig,
  type SkillMatchDetail,
} from '@job-intel/contracts';
import type { Logger } from '@job-intel/observability';
import { evaluateHardConstraints } from '../constraints/hard-constraints';
import { scoreSkills } from '../scoring/skills';
import { scoreEducation, scoreExperience, scoreSeniority } from '../scoring/experience';
import { scoreCompany, scoreEmploymentType, scoreIndustry, scoreTitle } from '../scoring/role';
import { scoreLocation, scoreWorkArrangement } from '../scoring/place';
import { scoreSalary, scoreVisa } from '../scoring/compensation';
import { scoreQuality } from '../scoring/quality';
import { scoreSemantic } from '../semantic/similarity';
import { scoreBehavioral } from '../behavioral/behavioral-adjustment';
import { aggregate, normalize } from '../weights/weight-normalizer';
import { estimateConfidence, extractionConfidenceOf } from '../confidence/confidence';
import { explain, type CandidateEvidence } from '../explanation/explainer';
import { classify } from './recommendation';
import { clamp, round } from '../scoring/util';
import {
  NullMatchReasoningProvider,
  buildCandidateSummary,
  shouldUseLlm,
  type MatchReasoningProvider,
} from '../llm/match-reasoning-provider';
import type { MatchCandidateContext, MatchJobContext, ScorerInput } from '../types';

/**
 * The matching engine.
 *
 * Six stages, in a fixed order, each of which can only do what the previous one
 * permits:
 *
 *   1. **Hard constraints** — deterministic, in code. Decides eligibility.
 *   2. **Structured scoring** — twelve independent dimension scorers.
 *   3. **Semantic similarity** — one more weighted dimension.
 *   4. **Weighted aggregation** — using the candidate's stored weights.
 *   5. **Behavioural adjustment** — small, bounded, and suppressed where it
 *      contradicts anything the candidate stated explicitly.
 *   6. **LLM refinement** — optional, gated, bounded, schema-validated.
 *
 * The ordering is the safety property. Stages 3-6 never run for an ineligible
 * job, so there is no code path by which a similarity score, a behavioural
 * affinity or a model opinion can rescue one. `assertEligibilityRespected`
 * checks that at the end rather than trusting it.
 */

/**
 * `config` is the schema's *input* type, not `Partial<MatchingConfig>`.
 *
 * They are not the same: every field has a default, so the output type has all
 * of them required while a caller legitimately supplies `{ llm: { enabled:
 * true } }`. Typing this as a partial of the output would reject that and force
 * callers to spell out fields they have no opinion about.
 */
export interface MatchingEngineDependencies {
  logger: Logger;
  config?: z.input<typeof matchingConfigSchema>;
  reasoning?: MatchReasoningProvider;
}

export interface MatchRunState {
  /** Model calls made so far, so the per-run budget is enforceable. */
  llmCallsMade: number;
}

export class MatchingEngine {
  readonly config: MatchingConfig;
  private readonly reasoning: MatchReasoningProvider;
  private readonly logger: Logger;

  constructor(deps: MatchingEngineDependencies) {
    this.config = matchingConfigSchema.parse(deps.config ?? {});
    this.reasoning = deps.reasoning ?? new NullMatchReasoningProvider();
    this.logger = deps.logger;
  }

  async match(
    candidate: MatchCandidateContext,
    job: MatchJobContext,
    state: MatchRunState = { llmCallsMade: 0 },
    /**
     * Evidence from the candidate intelligence layer, when a profile exists.
     *
     * Optional on purpose. Matching predates this layer and must keep working
     * for someone who has uploaded nothing; supplying it makes the explanation
     * traceable to a document rather than only to a score.
     */
    evidence: CandidateEvidence | null = null,
  ): Promise<JobMatch> {
    const startedAt = Date.now();
    const input: ScorerInput = { candidate, job };
    const notes: string[] = [];

    // ── Stage 1: eligibility ────────────────────────────────────────────────
    const constraints = evaluateHardConstraints(input);

    // ── Stage 2: structured dimensions ──────────────────────────────────────
    const skills = scoreSkills(input);
    const skillMatches: SkillMatchDetail[] = skills.matches;

    const components: ComponentScore[] = [
      skills.component,
      scoreExperience(input),
      scoreSeniority(input),
      scoreTitle(input),
      scoreLocation(input),
      scoreWorkArrangement(input),
      scoreSalary(input),
      scoreVisa(input),
      scoreEducation(input),
      scoreIndustry(input),
      scoreEmploymentType(input),
      scoreCompany(input),
      scoreQuality(input),
    ];

    // ── Stage 3: semantic ───────────────────────────────────────────────────
    // Skipped for ineligible jobs: not an optimisation but the enforcement
    // point. There is no branch in which similarity can influence eligibility.
    if (constraints.eligible) {
      const semantic = scoreSemantic(input);
      components.push(semantic);
      if (!semantic.applicable) notes.push(semantic.explanation);
    } else {
      notes.push('semantic: skipped, job is ineligible');
    }

    // ── Stage 4: weighted aggregation ───────────────────────────────────────
    const weights = candidate.preferences.weights;
    const aggregated = aggregate(components, weights);
    const structuredScore = aggregated.score;
    if (aggregated.skipped.length > 0) {
      notes.push(`not applicable: ${aggregated.skipped.join(', ')}`);
    }

    // ── Stage 5: behavioural adjustment ─────────────────────────────────────
    const behavioral = constraints.eligible
      ? scoreBehavioral(input, this.config.maxBehavioralAdjustment)
      : { component: null, adjustment: 0, suppressed: [] };
    if (behavioral.component) components.push(behavioral.component);
    if (behavioral.suppressed.length > 0) {
      notes.push(
        `behavioural: ${behavioral.suppressed.length} signal(s) suppressed for contradicting explicit preferences`,
      );
    }

    const extractionConfidence = extractionConfidenceOf(job.enrichment);
    const preLlmConfidence = estimateConfidence({
      components,
      constraints,
      weights,
      extractionConfidence,
      llmConfidence: null,
    });

    // ── Stage 6: LLM refinement ─────────────────────────────────────────────
    let reasoning: LlmReasoning | null = null;
    let usage: LlmUsage | null = null;

    const gate = shouldUseLlm(
      {
        eligible: constraints.eligible,
        structuredScore,
        confidence: preLlmConfidence.confidence,
        callsMade: state.llmCallsMade,
      },
      this.config,
    );

    if (gate.use && this.reasoning.isAvailable()) {
      const result = await this.runReasoning(input, {
        structuredScore,
        components,
        skillMatches,
        constraints,
      });
      state.llmCallsMade += 1;
      if (result) {
        reasoning = result.reasoning;
        usage = result.usage;
      } else {
        notes.push('llm: response discarded or call failed; using structural score');
      }
    } else if (gate.use && !this.reasoning.isAvailable()) {
      notes.push('llm: no provider configured');
    }

    // ── Final assembly ──────────────────────────────────────────────────────
    const llmAdjustment = reasoning?.scoreAdjustment ?? 0;
    const finalScore = constraints.eligible
      ? round(clamp(structuredScore + behavioral.adjustment + llmAdjustment), 2)
      : 0;

    const confidence = reasoning
      ? estimateConfidence({
          components,
          constraints,
          weights,
          extractionConfidence,
          llmConfidence: reasoning.confidence,
        })
      : preLlmConfidence;

    const recommendation = classify(
      { eligible: constraints.eligible, score: finalScore, confidence: confidence.confidence },
      this.config.thresholds,
    );

    const explanation = explain({
      jobTitle: job.enrichment.normalizedTitle || job.title,
      companyName: job.companyName,
      recommendation,
      score: finalScore,
      confidence: confidence.confidence,
      constraints,
      components,
      skillMatches,
      reasoning,
      evidence,
    });

    const trace: MatchTrace = {
      matchingVersion: MATCHING_VERSION,
      profileVersion: candidate.profileVersion,
      preferenceVersion: candidate.preferenceVersion,
      jobVersion: job.jobVersion,
      enrichmentVersion: job.enrichment.enrichmentVersion,
      embeddingModel: candidate.embedding?.model ?? null,
      llmModel: usage?.model ?? null,
      weightsUsed: { ...aggregated.weightsUsed, ...normalize(weights) },
      componentScores: components,
      structuredScore,
      semanticScore: components.find((c) => c.dimension === 'semantic' && c.applicable)?.score ?? null,
      behavioralAdjustment: behavioral.adjustment,
      llmAdjustment,
      finalScore,
      llmDecision: gate.reason,
      durationMs: Date.now() - startedAt,
      notes: [...notes, ...confidence.notes],
    };

    const match: JobMatch = {
      jobId: job.jobId,
      candidateProfileId: candidate.profileId,
      overallScore: finalScore,
      confidence: confidence.confidence,
      recommendation,
      eligible: constraints.eligible,
      hardConstraintResult: constraints,
      componentScores: components,
      skillMatches,
      matchedRequirements: explanation.matchedRequirements,
      missingRequirements: explanation.missingRequirements,
      concerns: explanation.concerns,
      positiveSignals: explanation.positiveSignals,
      negativeSignals: explanation.negativeSignals,
      explanation: explanation.explanation,
      trace,
      llmUsage: usage,
    };

    assertEligibilityRespected(match);
    return match;
  }

  /**
   * Calls the provider and validates the response.
   *
   * Every failure mode — network error, timeout, malformed JSON, a schema the
   * response does not satisfy — resolves to null. Matching then completes on
   * the structural score, which is a defensible answer. Throwing here would let
   * one flaky provider call take down a whole run of thousands of jobs.
   */
  private async runReasoning(
    input: ScorerInput,
    context: {
      structuredScore: number;
      components: ComponentScore[];
      skillMatches: SkillMatchDetail[];
      constraints: ReturnType<typeof evaluateHardConstraints>;
    },
  ): Promise<{ reasoning: LlmReasoning; usage: LlmUsage } | null> {
    try {
      const result = await this.reasoning.reason({
        title: input.job.title,
        companyName: input.job.companyName,
        description: (input.job.enrichment.cleanedDescription ?? input.job.description ?? '').slice(
          0,
          12_000,
        ),
        candidateSummary: buildCandidateSummary(input),
        structuredScore: context.structuredScore,
        components: context.components,
        skillMatches: context.skillMatches,
        constraints: context.constraints,
        maxAdjustment: this.config.maxLlmAdjustment,
      });

      // The provider is responsible for schema-validating and clamping via
      // `validateReasoning`; this is the belt to that braces, because a
      // provider is a replaceable component and this bound is not optional.
      const bound = this.config.maxLlmAdjustment;
      return {
        reasoning: {
          ...result.reasoning,
          scoreAdjustment: round(clamp(result.reasoning.scoreAdjustment, -bound, bound), 2),
        },
        usage: result.usage,
      };
    } catch (error) {
      this.logger.warn('Match reasoning failed; falling back to structural score', {
        jobId: input.job.jobId,
        err: error,
      });
      return null;
    }
  }
}

/**
 * Invariant check, run on every match.
 *
 * States in code the rule that matters most: **semantic similarity, behavioural
 * affinity and model opinion never override eligibility.** A future refactor
 * that reorders the stages, or a scorer that starts writing to a shared object,
 * fails here loudly instead of silently recommending a job the candidate cannot
 * take.
 */
export function assertEligibilityRespected(match: JobMatch): void {
  if (match.eligible) return;

  if (match.recommendation !== 'INELIGIBLE') {
    throw new Error(
      `Matching invariant violated: ineligible job ${match.jobId} was recommended as ${match.recommendation}`,
    );
  }
  if (match.overallScore !== 0) {
    throw new Error(
      `Matching invariant violated: ineligible job ${match.jobId} scored ${match.overallScore}`,
    );
  }
  if (match.trace.semanticScore !== null || match.trace.llmAdjustment !== 0) {
    throw new Error(
      `Matching invariant violated: ineligible job ${match.jobId} was influenced by semantic or LLM scoring`,
    );
  }
}
