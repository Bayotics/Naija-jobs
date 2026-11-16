import {
  llmReasoningSchema,
  type ComponentScore,
  type HardConstraintResult,
  type LlmReasoning,
  type LlmUsage,
  type MatchingConfig,
  type SkillMatchDetail,
} from '@job-intel/contracts';
import type { ScorerInput } from '../types';
import { clamp, round } from '../scoring/util';

/**
 * LLM reasoning.
 *
 * The model's job is narrow and stated here so it cannot quietly widen:
 *
 *  - It sees a match that has **already been scored** structurally, and the
 *    reasons behind that score. It is not asked "is this a good match?" — that
 *    question invites it to re-derive everything from scratch and produce an
 *    unfalsifiable number.
 *  - It may move the score by at most `maxLlmAdjustment` points, from
 *    configuration. Even a model that returns +100 cannot turn a 40 into a 90.
 *  - It is **never** told to decide eligibility, and its output has no field
 *    that could express one. Hard constraints are decided in code, before this
 *    runs, and are passed in as settled facts.
 *  - Its output is parsed against a schema. Anything that fails is discarded,
 *    not coerced — a half-understood response is worse than none.
 */

export interface MatchReasoningRequest {
  title: string;
  companyName: string;
  /** Already cleaned and truncated by the caller. */
  description: string;
  candidateSummary: string;
  /** The structural verdict, so the model refines rather than reinvents. */
  structuredScore: number;
  components: ComponentScore[];
  skillMatches: SkillMatchDetail[];
  /** Settled, for context only. The model must not revisit these. */
  constraints: HardConstraintResult;
  /** The hard cap the caller will enforce on `scoreAdjustment`. */
  maxAdjustment: number;
}

export interface MatchReasoningResult {
  reasoning: LlmReasoning;
  usage: LlmUsage;
}

export interface MatchReasoningProvider {
  readonly id: string;
  /** False when unconfigured; the engine then skips the reasoning stage. */
  isAvailable(): boolean;
  reason(request: MatchReasoningRequest, signal?: AbortSignal): Promise<MatchReasoningResult>;
}

/**
 * The default: no model.
 *
 * Matching must be fully functional without one. Making that the default rather
 * than a fallback keeps the no-LLM path the one that is actually tested.
 */
export class NullMatchReasoningProvider implements MatchReasoningProvider {
  readonly id = 'null';
  isAvailable(): boolean {
    return false;
  }
  reason(): Promise<MatchReasoningResult> {
    return Promise.reject(new Error('No match reasoning provider configured'));
  }
}

/**
 * Validates and clamps a model response.
 *
 * The clamp is applied here rather than trusted from the schema because the
 * schema's bounds are the widest the type allows, while `maxAdjustment` is the
 * operator's policy for this run. Returning null on invalid output is
 * deliberate: the engine then proceeds with the structural score, which is a
 * defensible answer, instead of a partially-parsed one, which is not.
 */
export function validateReasoning(
  raw: unknown,
  maxAdjustment: number,
): { reasoning: LlmReasoning; clamped: boolean } | null {
  const parsed = llmReasoningSchema.safeParse(raw);
  if (!parsed.success) return null;

  const bound = Math.abs(maxAdjustment);
  const requested = parsed.data.scoreAdjustment;
  const adjustment = clamp(requested, -bound, bound);

  return {
    reasoning: { ...parsed.data, scoreAdjustment: round(adjustment, 2) },
    clamped: adjustment !== requested,
  };
}

/**
 * Whether a match is worth spending a model call on.
 *
 * Two gates, both necessary. Score, because reasoning about a job the candidate
 * will never see is money burned. Confidence, because a *confident* structural
 * result has nothing left to disambiguate — the LLM earns its cost precisely
 * where the deterministic layer is unsure.
 */
export function shouldUseLlm(
  input: {
    eligible: boolean;
    structuredScore: number;
    confidence: number;
    callsMade: number;
  },
  config: MatchingConfig,
): { use: boolean; reason: string } {
  if (!config.llm.enabled) return { use: false, reason: 'llm disabled by configuration' };
  // Ineligible is settled in code. Asking a model about it could only produce
  // an opinion we would have to ignore.
  if (!input.eligible) return { use: false, reason: 'ineligible — no reasoning needed' };
  if (config.maxLlmAdjustment <= 0) return { use: false, reason: 'llm adjustment budget is zero' };
  if (input.callsMade >= config.llm.maxCallsPerRun) {
    return { use: false, reason: `run call budget reached (${config.llm.maxCallsPerRun})` };
  }
  if (input.structuredScore < config.llm.minStructuredScore) {
    return {
      use: false,
      reason: `structured score ${input.structuredScore} below threshold ${config.llm.minStructuredScore}`,
    };
  }
  if (input.confidence > config.llm.maxConfidence) {
    return {
      use: false,
      reason: `structural result already confident (${input.confidence.toFixed(2)})`,
    };
  }
  return { use: true, reason: 'ambiguous and plausible — worth reviewing' };
}

/**
 * A compact description of the candidate for the prompt.
 *
 * Built from the profile rather than the raw CV so nothing the candidate did
 * not choose to structure — addresses, phone numbers, referees — is sent to a
 * third party.
 */
export function buildCandidateSummary(input: ScorerInput): string {
  const p = input.candidate.profile.professional;
  const prefs = input.candidate.preferences;
  const lines: string[] = [];

  if (p.currentTitle) lines.push(`Current title: ${p.currentTitle}`);
  if (p.yearsOfExperience !== undefined) lines.push(`Experience: ${p.yearsOfExperience} years`);
  if (p.seniority) lines.push(`Seniority: ${p.seniority}`);
  if (p.summary) lines.push(`Summary: ${p.summary}`);

  const skills = input.candidate.skills
    .filter((s) => s.importance !== 'peripheral')
    .map((s) => (s.proficiency ? `${s.name} (${s.proficiency})` : s.name));
  if (skills.length > 0) lines.push(`Key skills: ${skills.join(', ')}`);

  if (prefs.titles.length > 0) {
    lines.push(`Target titles: ${prefs.titles.map((t) => t.value).join(', ')}`);
  }
  lines.push(`Work arrangement preference: ${prefs.workArrangement}`);

  return lines.join('\n');
}

/** The instruction sent with every reasoning request. */
export const MATCH_REASONING_SYSTEM_PROMPT = [
  'You are reviewing an already-computed job match for a single candidate.',
  '',
  'A deterministic engine has already scored this match across structured',
  'dimensions and has already decided eligibility. Your task is to review the',
  'qualitative fit that structured scoring cannot see: the substance of the',
  'work, the seniority implied by the responsibilities, and whether the',
  "candidate's background transfers.",
  '',
  'Rules:',
  '- Do NOT re-decide eligibility. Hard constraints are settled; treat them as facts.',
  '- Your scoreAdjustment is a REFINEMENT, bounded by the caller. Use the full',
  '  range only when the structured score is clearly wrong about something',
  '  visible in the description.',
  '- Cite specifics from the posting. Do not invent requirements it does not state.',
  '- If the posting is too vague to judge, say so and return a low confidence',
  '  with a scoreAdjustment near zero.',
  '- Respond only with JSON matching the requested schema.',
].join('\n');
