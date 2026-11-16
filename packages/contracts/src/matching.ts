import { z } from 'zod';
import {
  APPLICATION_STATES,
  FEEDBACK_ACTIONS,
  MATCH_STAGES,
  RECOMMENDATIONS,
  REJECTION_REASONS,
} from './common';

/**
 * Match results, feedback and applications.
 *
 * The scoring *engine* arrives in prompts 14–16; what is fixed here is the
 * shape it must produce, because the dashboard, the notification templates and
 * the learning loop all read it.
 */

export const matchReasonSchema = z.object({
  factor: z.enum([
    'skills',
    'experience',
    'seniority',
    'location',
    'remote_policy',
    'salary',
    'visa',
    'employment_type',
    'education',
    'industry',
    'tech_stack',
    'title',
    'preferences',
    'exclusions',
  ]),
  direction: z.enum(['positive', 'negative']),
  weight: z.number().min(0).max(1),
  /** Must quote the posting. Grounding the rationale in source text measurably
   *  reduces fabricated justifications and renders directly in the UI/email. */
  evidence: z.string().trim().min(1).max(500),
});
export type MatchReason = z.infer<typeof matchReasonSchema>;

export const matchResultSchema = z.object({
  jobId: z.string().uuid(),
  profileVersionId: z.string().uuid(),
  stage: z.enum(MATCH_STAGES),
  matchScore: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  recommendation: z.enum(RECOMMENDATIONS),
  ruleScore: z.number().min(0).max(100).nullable().default(null),
  vectorSimilarity: z.number().min(-1).max(1).nullable().default(null),
  llmScore: z.number().min(0).max(100).nullable().default(null),
  reasons: z.array(matchReasonSchema).default([]),
  matchedRequirements: z.array(z.string()).default([]),
  missingRequirements: z.array(z.string()).default([]),
  concerns: z.array(z.string()).default([]),
  /** Provenance. A score is meaningless without knowing what produced it. */
  modelId: z.string().max(120).nullable().default(null),
  promptVersion: z.string().max(60).nullable().default(null),
  inputTokens: z.number().int().min(0).nullable().default(null),
  outputTokens: z.number().int().min(0).nullable().default(null),
  costUsd: z.number().min(0).nullable().default(null),
  latencyMs: z.number().int().min(0).nullable().default(null),
});
export type MatchResult = z.infer<typeof matchResultSchema>;

/**
 * Outcome of evaluating the candidate's hard constraints against a job.
 * Produced by `PreferenceEngine` — deterministic, free, and fully explainable.
 */
export const constraintEvaluationSchema = z.object({
  passed: z.boolean(),
  rejectionReason: z.enum(REJECTION_REASONS).nullable(),
  /** Every constraint that was evaluated, including the ones that passed. */
  checks: z.array(
    z.object({
      constraint: z.string(),
      passed: z.boolean(),
      /** True when the posting simply lacked the data to decide. */
      skipped: z.boolean(),
      detail: z.string(),
    }),
  ),
  score: z.number().min(0).max(100),
});
export type ConstraintEvaluation = z.infer<typeof constraintEvaluationSchema>;

export const jobFeedbackSchema = z.object({
  jobId: z.string().uuid(),
  action: z.enum(FEEDBACK_ACTIONS),
  reasonCodes: z.array(z.string().trim().max(80)).default([]),
  note: z.string().trim().max(2000).nullable().default(null),
  source: z.enum(['dashboard', 'email_link', 'api']).default('dashboard'),
});
export type JobFeedback = z.infer<typeof jobFeedbackSchema>;

export const applicationSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  state: z.enum(APPLICATION_STATES),
  appliedAt: z.date().nullable(),
  notes: z.string().max(4000).nullable(),
  lastTransitionAt: z.date(),
});
export type Application = z.infer<typeof applicationSchema>;

export const applicationUpsertSchema = z.object({
  jobId: z.string().uuid(),
  state: z.enum(APPLICATION_STATES),
  notes: z.string().trim().max(4000).optional(),
  appliedAt: z.coerce.date().optional(),
});
export type ApplicationUpsert = z.infer<typeof applicationUpsertSchema>;
