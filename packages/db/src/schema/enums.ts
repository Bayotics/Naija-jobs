import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ACCESS_TIERS,
  APPLICATION_STATES,
  CIRCUIT_STATES,
  EDUCATION_LEVELS,
  EMPLOYMENT_TYPES,
  FEEDBACK_ACTIONS,
  JOB_STATUSES,
  MATCH_STAGES,
  RECOMMENDATIONS,
  RECOMMENDATION_CATEGORIES,
  DUPLICATE_TIERS,
  EXPOSURE_STATES,
  LIFECYCLE_STATUSES,
  RECOMMENDATION_TIERS,
  SOURCE_AUTHORITY_LEVELS,
  VERIFICATION_OUTCOMES,
  AI_OPERATIONS,
  AUDIT_ACTIONS,
  PIPELINE_RUN_STATUSES,
  PIPELINE_RUN_TRIGGERS,
  REJECTION_REASONS,
  REMOTE_TYPES,
  RUN_STATUSES,
  RUN_TRIGGERS,
  SALARY_PERIODS,
  SENIORITY_LEVELS,
  SOURCE_HEALTH_STATUSES,
  SOURCE_TYPES,
  SYSTEM_EVENTS,
  SYSTEM_EVENT_SEVERITIES,
  VISA_SPONSORSHIP_STATES,
} from '@job-intel/contracts';

/**
 * Postgres enums are derived from the same tuples the Zod validators use.
 *
 * This is the mechanism that prevents the classic drift where the API accepts a
 * value the database rejects (or worse, a database value the API cannot parse).
 * Adding an enum member is a one-line change in `contracts` plus a migration.
 */
export const remoteTypeEnum = pgEnum('remote_type', REMOTE_TYPES);
export const employmentTypeEnum = pgEnum('employment_type', EMPLOYMENT_TYPES);
export const seniorityLevelEnum = pgEnum('seniority_level', SENIORITY_LEVELS);
export const visaSponsorshipEnum = pgEnum('visa_sponsorship', VISA_SPONSORSHIP_STATES);
export const educationLevelEnum = pgEnum('education_level', EDUCATION_LEVELS);
export const salaryPeriodEnum = pgEnum('salary_period', SALARY_PERIODS);
export const jobStatusEnum = pgEnum('job_status', JOB_STATUSES);

export const sourceTypeEnum = pgEnum('source_type', SOURCE_TYPES);
export const accessTierEnum = pgEnum('access_tier', ACCESS_TIERS);
export const sourceHealthEnum = pgEnum('source_health_status', SOURCE_HEALTH_STATUSES);
export const circuitStateEnum = pgEnum('circuit_state', CIRCUIT_STATES);
export const runTriggerEnum = pgEnum('run_trigger', RUN_TRIGGERS);
export const runStatusEnum = pgEnum('run_status', RUN_STATUSES);

export const matchStageEnum = pgEnum('match_stage', MATCH_STAGES);
export const recommendationEnum = pgEnum('recommendation', RECOMMENDATIONS);
/**
 * The matching engine's own verdict scale.
 *
 * Separate from `recommendation` (an action: apply / maybe / skip) because a
 * category answers a different question — how good the fit is and whether we
 * know enough to say. `UNCERTAIN` and `INELIGIBLE` have no equivalent in an
 * action scale and are the two the candidate most needs to see.
 */
export const recommendationCategoryEnum = pgEnum(
  'recommendation_category',
  RECOMMENDATION_CATEGORIES,
);
export const rejectionReasonEnum = pgEnum('rejection_reason', REJECTION_REASONS);
export const feedbackActionEnum = pgEnum('feedback_action', FEEDBACK_ACTIONS);
export const applicationStateEnum = pgEnum('application_state', APPLICATION_STATES);


export const systemEventNameEnum = pgEnum('system_event_name', SYSTEM_EVENTS);
export const systemEventSeverityEnum = pgEnum('system_event_severity', SYSTEM_EVENT_SEVERITIES);

// ── Recommendation layer ────────────────────────────────────────────────────

/** How sure the system is that two records describe one opening. */
export const duplicateTierEnum = pgEnum('duplicate_tier', DUPLICATE_TIERS);
/** Where a posting is in its life. `UNKNOWN` is a real state, not a default. */
export const lifecycleStatusEnum = pgEnum('lifecycle_status', LIFECYCLE_STATUSES);
export const sourceAuthorityEnum = pgEnum('source_authority', SOURCE_AUTHORITY_LEVELS);
export const verificationOutcomeEnum = pgEnum('verification_outcome', VERIFICATION_OUTCOMES);
export const exposureStateEnum = pgEnum('exposure_state', EXPOSURE_STATES);
/**
 * The recommendation verdict scale, distinct from both `recommendation`
 * (apply/maybe/skip) and `recommendation_category` (how well it matches).
 * This one answers "should we show it, and how loudly".
 */
export const recommendationTierEnum = pgEnum('recommendation_tier', RECOMMENDATION_TIERS);

// ── Notification engine ─────────────────────────────────────────────────────

/** Extensible by adding a member here plus a template. No pipeline change. */
/**
 * Every outcome a notification candidate can reach, suppressions included.
 * Stored as an enum rather than free text so "show me everything suppressed by
 * quiet hours" is an indexed query, not a LIKE scan.
 */

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * A pipeline run spans discovery through notification, unlike `run_trigger`
 * which describes one connector's execution. Kept separate so the two can
 * diverge — a manual single-source run is not a manual pipeline run.
 */
export const pipelineRunTriggerEnum = pgEnum('pipeline_run_trigger', PIPELINE_RUN_TRIGGERS);
export const pipelineRunStatusEnum = pgEnum('pipeline_run_status', PIPELINE_RUN_STATUSES);
export const aiOperationEnum = pgEnum('ai_operation', AI_OPERATIONS);
/** Enumerated rather than free text so "show me every source I disabled" is indexed. */
export const auditActionEnum = pgEnum('audit_action', AUDIT_ACTIONS);
