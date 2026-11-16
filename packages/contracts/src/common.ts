import { z } from 'zod';

/**
 * Enum value tuples are declared exactly once, here.
 *
 * Both the Zod validators in this package and the Postgres `pgEnum` definitions
 * in `@job-intel/db` are derived from these arrays, so a value can never exist
 * in the database that the API layer would reject (or vice versa).
 */

export const REMOTE_TYPES = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
export const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'internship',
  'temporary',
  'freelance',
  'apprenticeship',
] as const;
export const SENIORITY_LEVELS = [
  'intern',
  'entry',
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
  'executive',
] as const;
export const VISA_SPONSORSHIP_STATES = ['offered', 'not_offered', 'unknown'] as const;
export const EDUCATION_LEVELS = [
  'none',
  'high_school',
  'diploma',
  'bachelors',
  'masters',
  'doctorate',
] as const;

export const JOB_STATUSES = ['active', 'expired', 'closed', 'quarantined'] as const;

export const SOURCE_TYPES = [
  'ats',
  'job_api',
  'rss_feed',
  'mailbox',
  'search_discovery',
  'social',
  'html_page',
  'manual',
] as const;

/**
 * Legal/technical posture of a source. `restricted` sources are registered so
 * they are visible in the UI with a stated reason, but are never fetched.
 */
export const ACCESS_TIERS = [
  'official_api',
  'public_feed',
  'permitted_html',
  'search_discovery',
  'user_provided',
  'restricted',
] as const;

export const SOURCE_HEALTH_STATUSES = [
  'unknown',
  'healthy',
  'degraded',
  'failing',
  'disabled',
] as const;
export const CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const;

export const RUN_TRIGGERS = ['schedule', 'manual', 'retry', 'backfill'] as const;
export const RUN_STATUSES = ['running', 'success', 'partial', 'failed', 'skipped'] as const;

export const MATCH_STAGES = ['rule', 'vector', 'triage', 'deep'] as const;
export const RECOMMENDATIONS = ['strong_apply', 'apply', 'maybe', 'skip'] as const;

export const FEEDBACK_ACTIONS = [
  'interested',
  'not_interested',
  'applied',
  'rejected',
  'saved',
  'irrelevant',
  'duplicate',
] as const;

export const APPLICATION_STATES = [
  'new',
  'saved',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
  'dismissed',
] as const;

export const NOTIFICATION_CHANNELS = ['email', 'telegram', 'slack', 'webhook', 'web_push'] as const;
export const NOTIFICATION_KINDS = ['instant', 'digest'] as const;
export const NOTIFICATION_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'cancelled',
] as const;

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export const SALARY_PERIODS = ['hour', 'day', 'week', 'month', 'year'] as const;

/**
 * Why a posting did not progress. Recording the cause (rather than only a
 * count) is what makes "how many were rejected" an actionable number.
 */
export const REJECTION_REASONS = [
  'duplicate',
  'hard_rule',
  'expired',
  'scam',
  'low_quality',
  'below_threshold',
  'budget_capped',
  'extraction_failed',
  'validation_failed',
] as const;

export type RemoteType = (typeof REMOTE_TYPES)[number];
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];
export type VisaSponsorshipState = (typeof VISA_SPONSORSHIP_STATES)[number];
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type SourceType = (typeof SOURCE_TYPES)[number];
export type AccessTier = (typeof ACCESS_TIERS)[number];
export type SourceHealthStatus = (typeof SOURCE_HEALTH_STATUSES)[number];
export type CircuitState = (typeof CIRCUIT_STATES)[number];
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type MatchStage = (typeof MATCH_STAGES)[number];
export type Recommendation = (typeof RECOMMENDATIONS)[number];
export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number];
export type ApplicationState = (typeof APPLICATION_STATES)[number];
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];
export type RejectionReason = (typeof REJECTION_REASONS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

// ── Primitive validators ────────────────────────────────────────────────────

/** ISO 3166-1 alpha-2, always upper-cased. */
export const countryCodeSchema = z
  .string()
  .trim()
  .length(2)
  .regex(/^[A-Za-z]{2}$/, 'Must be a 2-letter ISO country code')
  .transform((v) => v.toUpperCase());

/** ISO 4217, always upper-cased. */
export const currencyCodeSchema = z
  .string()
  .trim()
  .length(3)
  .regex(/^[A-Za-z]{3}$/, 'Must be a 3-letter ISO currency code')
  .transform((v) => v.toUpperCase());

export const uuidSchema = z.string().uuid();
export const isoDateTimeSchema = z.union([z.string().datetime({ offset: true }), z.date()]);

/** IANA timezone. Validated against the host ICU database rather than a regex. */
export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Must be a valid IANA timezone (e.g. Africa/Lagos)');

/** A 5-field cron expression. Full parsing belongs to the scheduler (prompt 10). */
export const cronExpressionSchema = z
  .string()
  .trim()
  .regex(
    /^(\S+\s+){4}\S+$/,
    'Must be a 5-field cron expression (minute hour day-of-month month day-of-week)',
  );

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Non-throwing result type for domain operations whose failure is an expected
 * outcome rather than an exception (validation, rule evaluation, parsing).
 */
export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
