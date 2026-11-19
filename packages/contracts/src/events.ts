import { z } from 'zod';

/**
 * The system event taxonomy.
 *
 * Every meaningful state change emits one of these names. Keeping them in a
 * closed union rather than free-text strings means: the logger is type-checked,
 * the `system_events` table is queryable by a known vocabulary, and adding an
 * event is a deliberate act that shows up in review.
 */
export const SYSTEM_EVENTS = [
  // Lifecycle
  'SYSTEM_STARTED',
  /*
   * The worker tried to boot and could not.
   *
   * Recorded by the process that failed, into the database it could still
   * reach, because the alternative is a stack trace in a hosting platform's
   * log viewer that nobody is looking at. A worker that dies on startup writes
   * no heartbeat, runs no stage and produces no other evidence of itself: the
   * dashboard shows a system that is merely quiet.
   */
  'SYSTEM_START_FAILED',
  'SYSTEM_SHUTDOWN',
  'CONFIG_LOADED',
  'CONFIG_CHANGED',

  // Discovery
  'SOURCE_REGISTERED',
  'SOURCE_UPDATED',
  'SOURCE_DISABLED',
  'SOURCE_RUN_STARTED',
  'SOURCE_RUN_COMPLETED',
  'SOURCE_RUN_FAILED',
  'SOURCE_RUN_SKIPPED',
  'SOURCE_HEALTH_CHANGED',
  'SOURCE_CIRCUIT_OPENED',
  'SOURCE_CIRCUIT_CLOSED',

  // Pipeline
  'JOB_DISCOVERED',
  'JOB_NORMALIZED',
  'JOB_DUPLICATE',
  'JOB_UPDATED',
  'JOB_REJECTED',
  'JOB_EXPIRED',
  'JOB_QUARANTINED',

  // Matching
  'JOB_MATCHED',
  'JOB_BELOW_THRESHOLD',
  'MATCH_RECOMPUTE_REQUESTED',
  'MATCH_RUN_COMPLETED',
  'MATCH_RUN_FAILED',
  'EMBEDDING_GENERATED',
  'RECOMMENDATIONS_RANKED',
  'JOB_DEDUPLICATED',
  'JOB_LIFECYCLE_CHANGED',

  // Profile
  'PROFILE_VERSION_CREATED',
  'PROFILE_VERSION_ACTIVATED',

  // Candidate documents and intelligence
  'DOCUMENT_UPLOADED',
  'DOCUMENT_REJECTED',
  'DOCUMENT_EXTRACTED',
  'DOCUMENT_DELETED',
  'INTELLIGENCE_PROFILE_REBUILT',
  'PROFILE_CONFLICT_DETECTED',
  'PROFILE_FIELD_OVERRIDDEN',
  'EXTERNAL_PROFILE_LINKED',

  // Feedback
  'FEEDBACK_RECORDED',
  'APPLICATION_STATE_CHANGED',

  // Notification
  'NOTIFICATIONS_PROCESSED',
  'NOTIFICATION_SUPPRESSED',
  'NOTIFICATION_QUEUED',
  'NOTIFICATION_SENT',
  'NOTIFICATION_FAILED',
  'NOTIFICATION_DELIVERED',

  // Queue
  'QUEUE_JOB_ENQUEUED',
  'QUEUE_JOB_FAILED',
  'QUEUE_JOB_DEAD_LETTERED',

  // Application intelligence
  'APPLICATION_ANALYSIS_COMPLETED',
  'APPLICATION_OPPORTUNITY_UPDATED',
  'APPLICATION_RECORDED',
  'APPLICATION_STATUS_CHANGED',

  // Notification intelligence
  'NOTIFICATION_SCORING_COMPLETED',
  'NOTIFICATION_SUPPRESSED',
  'NOTIFICATION_DIGEST_PLANNED',
  'NOTIFICATION_ADDRESS_SUPPRESSED',

  // Search configuration
  'SEARCH_CONFIG_CHANGED',
  'SEARCH_PROFILE_CREATED',
  'SEARCH_PAUSED',
  'SEARCH_RESUMED',
  'SEARCH_OVERRIDE_EXPIRED',
] as const;

export type SystemEventName = (typeof SYSTEM_EVENTS)[number];

export const SYSTEM_EVENT_SEVERITIES = ['info', 'warn', 'error'] as const;
export type SystemEventSeverity = (typeof SYSTEM_EVENT_SEVERITIES)[number];

export const systemEventSchema = z.object({
  name: z.enum(SYSTEM_EVENTS),
  severity: z.enum(SYSTEM_EVENT_SEVERITIES).default('info'),
  message: z.string().max(2000).nullable().default(null),
  /** Correlates every stage a single posting passed through. */
  traceId: z.string().max(100).nullable().default(null),
  sourceId: z.string().max(100).nullable().default(null),
  jobId: z.string().uuid().nullable().default(null),
  runId: z.string().uuid().nullable().default(null),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type SystemEventInput = z.infer<typeof systemEventSchema>;
