import { z } from 'zod';

/**
 * Selective AI extraction.
 *
 * The strategy is deterministic-first: patterns, taxonomy lookup and heuristics
 * run on every job and cost nothing. The LLM is consulted **only for the fields
 * that remain ambiguous after all of that**, and only when the job looks worth
 * the money. Sending every raw posting to a model would be both expensive and
 * mostly wasted — the deterministic layer already answers the majority.
 *
 * Two invariants:
 *
 *  1. **Never trust raw output.** Everything returned is parsed against a Zod
 *     schema; anything that fails validation is discarded, not coerced.
 *  2. **Never let AI failure destroy ingestion.** A provider outage, timeout or
 *     malformed response degrades the job to its deterministic extraction and
 *     records the error. Enrichment continues.
 */

/** The subset of fields worth asking a model about. */
export const aiExtractionSchema = z.object({
  seniority: z
    .enum(['intern', 'entry', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'executive'])
    .nullable(),
  seniorityReason: z.string().max(300).nullable(),

  minimumYearsExperience: z.number().min(0).max(50).nullable(),

  visaSponsorship: z.enum(['offered', 'not_offered', 'unclear', 'not_mentioned']),
  visaEvidence: z.string().max(300).nullable(),

  workMode: z.enum(['remote', 'hybrid', 'onsite', 'unknown']),
  workModeEvidence: z.string().max(300).nullable(),
  remoteRegions: z.array(z.string().max(60)).max(10),

  /** Canonical skill slugs the deterministic pass missed. */
  additionalSkills: z
    .array(
      z.object({
        name: z.string().max(80),
        requirement: z.enum(['required', 'preferred', 'optional', 'inferred']),
      }),
    )
    .max(25),

  educationLevel: z
    .enum(['none', 'high_school', 'diploma', 'bachelors', 'masters', 'doctorate'])
    .nullable(),
  educationRequirement: z.enum(['required', 'preferred', 'not_specified']),

  /** 0-1. The model's own confidence in this extraction. */
  confidence: z.number().min(0).max(1),
});

export type AiExtraction = z.infer<typeof aiExtractionSchema>;

export interface AiUsage {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface AiExtractionRequest {
  title: string;
  companyName: string;
  /** Already cleaned and truncated by the caller. */
  description: string;
  /** Which fields the deterministic pass could not resolve. */
  ambiguousFields: string[];
}

export interface AiExtractionResult {
  extraction: AiExtraction;
  usage: AiUsage;
}

/**
 * Provider port.
 *
 * The pipeline depends on this interface, never on a vendor SDK, so switching
 * or disabling the model is configuration rather than a refactor.
 */
export interface AiExtractionProvider {
  readonly id: string;
  /** False when unconfigured; the pipeline then skips the AI stage entirely. */
  isAvailable(): boolean;
  extract(request: AiExtractionRequest, signal?: AbortSignal): Promise<AiExtractionResult>;
}

/**
 * The default: no AI at all.
 *
 * Enrichment must be fully functional without a model. This provider makes that
 * the tested default path rather than an untested fallback, so a missing API key
 * is an ordinary state and not an outage.
 */
export class NullAiProvider implements AiExtractionProvider {
  readonly id = 'null';
  isAvailable(): boolean {
    return false;
  }
  extract(): Promise<AiExtractionResult> {
    return Promise.reject(new Error('No AI provider configured'));
  }
}

/**
 * Decides whether a job is worth an LLM call.
 *
 * Gated on genuine ambiguity *and* the job being substantial enough for a model
 * to have anything to work with. A 40-word posting will not become clearer by
 * being read more expensively.
 */
export interface AiGateOptions {
  enabled: boolean;
  minDescriptionLength: number;
  minAmbiguousFields: number;
  /** Stop calling once this many calls have been made in one run. */
  maxCallsPerRun: number;
}

export const DEFAULT_AI_GATE: AiGateOptions = {
  enabled: false,
  minDescriptionLength: 400,
  minAmbiguousFields: 2,
  maxCallsPerRun: 50,
};

export function shouldUseAi(
  input: { descriptionLength: number; ambiguousFields: string[]; callsMade: number },
  options: AiGateOptions,
  provider: AiExtractionProvider,
): { use: boolean; reason: string } {
  if (!options.enabled) return { use: false, reason: 'ai disabled by configuration' };
  if (!provider.isAvailable()) return { use: false, reason: 'no ai provider configured' };
  if (input.callsMade >= options.maxCallsPerRun) {
    return { use: false, reason: `ai call budget exhausted (${options.maxCallsPerRun})` };
  }
  if (input.descriptionLength < options.minDescriptionLength) {
    return {
      use: false,
      reason: `description too short for ai (${input.descriptionLength} < ${options.minDescriptionLength})`,
    };
  }
  if (input.ambiguousFields.length < options.minAmbiguousFields) {
    return {
      use: false,
      reason: `deterministic extraction resolved enough fields (${input.ambiguousFields.length} ambiguous)`,
    };
  }
  return { use: true, reason: `ambiguous: ${input.ambiguousFields.join(', ')}` };
}

/**
 * Validates a raw provider response.
 *
 * Returns a typed result rather than throwing: a malformed model response is an
 * expected event, not an exception, and must leave the deterministic extraction
 * untouched.
 */
export function validateAiExtraction(
  raw: unknown,
): { ok: true; value: AiExtraction } | { ok: false; error: string } {
  const parsed = aiExtractionSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
      .slice(0, 400),
  };
}
