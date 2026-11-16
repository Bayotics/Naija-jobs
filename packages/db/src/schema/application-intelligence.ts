import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ApplicationBlocker,
  ApplicationExplanation,
  ApplicationFriction,
  ApplicationPolicy,
  AuthorizationAssessment,
  CompensationAssessment,
  CompetitivenessAssessment,
  DimensionScore,
  EligibilityAssessment,
  ExperienceAlignment,
  LanguageAssessment,
  LegitimacyAssessment,
  LocationAssessment,
  ParsedRequirementRecord,
  PositioningAdvice,
  ResumeRecommendation,
  SeniorityAlignment,
  TimingAssessment,
  ChecklistItem,
} from '@job-intel/contracts';
import { candidateProfiles } from './identity';
import { jobs } from './jobs';
import { candidateDocuments } from './candidate-intelligence';

/**
 * Application intelligence storage.
 *
 * Three tables, three different lifetimes, and the separation matters:
 *
 *  - **`application_intelligence`** is a computed artefact. It is derived from
 *    a job, a profile version and a policy, and it is safe to throw away and
 *    recompute. It is stored so the dashboard is fast and so a recommendation
 *    can be shown next to what it said at the time.
 *
 *  - **`application_opportunities`** is the workflow. It records where a job
 *    sits between "we found this" and "you decided". Its states are advanced by
 *    the system up to RECOMMENDED and *only by a person* thereafter.
 *
 *  - **`application_records`** is the candidate's own history — what they
 *    actually sent, when, and what came back. It is the only ground truth this
 *    system has about whether any of its advice was any good, so it is never
 *    derived, never recomputed, and never deleted by a background job.
 */

// ── Computed intelligence ───────────────────────────────────────────────────

export const applicationIntelligence = pgTable(
  'application_intelligence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    overallRecommendation: text('overall_recommendation').notNull(),
    confidence: real('confidence').notNull().default(0),
    applicationValueScore: real('application_value_score').notNull().default(0),

    /** Read from the match, never written back to it. */
    matchScore: real('match_score'),
    profileVersion: integer('profile_version'),

    eligibility: jsonb('eligibility').$type<EligibilityAssessment>().notNull(),
    requirements: jsonb('requirements').$type<ParsedRequirementRecord[]>().notNull().default([]),

    qualification: jsonb('qualification').$type<DimensionScore>().notNull(),
    skillAlignment: jsonb('skill_alignment').$type<DimensionScore>().notNull(),
    experienceAlignment: jsonb('experience_alignment').$type<DimensionScore>().notNull(),
    preferenceAlignment: jsonb('preference_alignment').$type<DimensionScore>().notNull(),
    careerAlignment: jsonb('career_alignment').$type<DimensionScore>().notNull(),
    jobQuality: jsonb('job_quality').$type<DimensionScore>().notNull(),

    experience: jsonb('experience').$type<ExperienceAlignment>().notNull(),
    seniority: jsonb('seniority').$type<SeniorityAlignment>().notNull(),
    compensation: jsonb('compensation').$type<CompensationAssessment>().notNull(),
    authorization: jsonb('authorization').$type<AuthorizationAssessment>().notNull(),
    language: jsonb('language').$type<LanguageAssessment>().notNull(),
    location: jsonb('location').$type<LocationAssessment>().notNull(),
    friction: jsonb('friction').$type<ApplicationFriction>().notNull(),
    competitiveness: jsonb('competitiveness').$type<CompetitivenessAssessment>().notNull(),
    timing: jsonb('timing').$type<TimingAssessment>().notNull(),
    legitimacy: jsonb('legitimacy').$type<LegitimacyAssessment>().notNull(),

    blockers: jsonb('blockers').$type<ApplicationBlocker[]>().notNull().default([]),
    resume: jsonb('resume').$type<ResumeRecommendation>().notNull(),
    positioning: jsonb('positioning').$type<PositioningAdvice>().notNull(),
    checklist: jsonb('checklist').$type<ChecklistItem[]>().notNull().default([]),
    explanation: jsonb('explanation').$type<ApplicationExplanation>().notNull(),

    /** Denormalised for the dashboard's "common gaps" query. */
    unknownRequirements: jsonb('unknown_requirements').$type<string[]>().notNull().default([]),

    algorithmVersion: text('algorithm_version').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /*
     * One row per (candidate, job, profile version).
     *
     * Keyed on the profile version rather than just the pair so a
     * recommendation stays reproducible after the candidate uploads a new
     * resume — the old reading is still there to explain what was shown.
     */
    pairUnique: unique('application_intelligence_pair_unique').on(
      table.candidateId,
      table.jobId,
      table.profileVersion,
    ),
    rankIdx: index('application_intelligence_rank_idx').on(
      table.candidateId,
      table.applicationValueScore,
    ),
    recommendationIdx: index('application_intelligence_recommendation_idx').on(
      table.candidateId,
      table.overallRecommendation,
    ),
  }),
);

/** Blockers the candidate has said do not apply to them. */
export const acknowledgedBlockers = pgTable(
  'acknowledged_blockers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'cascade' }),

    /** Stable hash of (requirement type, subject). */
    blockerId: text('blocker_id').notNull(),
    /**
     * Null jobId means "this blocker never applies to me anywhere".
     *
     * Someone who acknowledges a US-authorisation blocker on one job usually
     * means it about their situation, not about that posting. Both scopes are
     * supported so the candidate can dismiss once rather than fifty times.
     */
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeUnique: unique('acknowledged_blockers_unique').on(
      table.candidateId,
      table.jobId,
      table.blockerId,
    ),
    lookupIdx: index('acknowledged_blockers_lookup_idx').on(table.candidateId, table.blockerId),
  }),
);

// ── Opportunity workflow ────────────────────────────────────────────────────

export const applicationOpportunities = pgTable(
  'application_opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    state: text('state').notNull().default('DISCOVERED'),
    recommendation: text('recommendation'),
    applicationValueScore: real('application_value_score'),

    /**
     * Set only when a person acts.
     *
     * The state machine has no transition into APPLIED that the system can
     * take, and this column is the evidence: a row that reaches APPROVED
     * without a `reviewedAt` would mean something advanced it automatically.
     */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pairUnique: unique('application_opportunities_pair_unique').on(table.candidateId, table.jobId),
    stateIdx: index('application_opportunities_state_idx').on(table.candidateId, table.state),
    rankIdx: index('application_opportunities_rank_idx').on(
      table.candidateId,
      table.applicationValueScore,
    ),
  }),
);

/** Every state change, so the workflow is auditable. */
export const opportunityTransitions = pgTable(
  'opportunity_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => applicationOpportunities.id, { onDelete: 'cascade' }),

    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    /** `system` or `user`. A person is required for anything past RECOMMENDED. */
    actor: text('actor').notNull().default('system'),
    reason: text('reason'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    opportunityIdx: index('opportunity_transitions_opportunity_idx').on(
      table.opportunityId,
      table.occurredAt,
    ),
  }),
);

// ── The candidate's own record ──────────────────────────────────────────────

export const applicationRecords = pgTable(
  'application_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    status: text('status').notNull().default('applied'),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
    applicationUrl: text('application_url'),

    /** Which resume was sent, so resume performance is answerable at all. */
    documentId: uuid('document_id').references(() => candidateDocuments.id, {
      onDelete: 'set null',
    }),
    coverLetterUsed: boolean('cover_letter_used').notNull().default(false),
    referral: text('referral'),
    contactName: text('contact_name'),
    notes: text('notes'),

    /**
     * What the system said at the time.
     *
     * Frozen on write rather than read back from `application_intelligence`,
     * because that row gets recomputed. Calibration needs to know what the
     * candidate was actually looking at when they decided.
     */
    recommendationAtApply: text('recommendation_at_apply'),
    valueScoreAtApply: real('value_score_at_apply'),

    firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
    lastStatusChangeAt: timestamp('last_status_change_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** One application per job. A second attempt is a status change. */
    pairUnique: unique('application_records_pair_unique').on(table.candidateId, table.jobId),
    statusIdx: index('application_records_status_idx').on(table.candidateId, table.status),
    appliedIdx: index('application_records_applied_idx').on(table.candidateId, table.appliedAt),
    documentIdx: index('application_records_document_idx').on(table.documentId),
  }),
);

/** Status history, so time-to-response is computable rather than guessed. */
export const applicationStatusEvents = pgTable(
  'application_status_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applicationRecords.id, { onDelete: 'cascade' }),

    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    note: text('note'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    applicationIdx: index('application_status_events_application_idx').on(
      table.applicationId,
      table.occurredAt,
    ),
  }),
);

// ── Policy ──────────────────────────────────────────────────────────────────

/** Per-candidate thresholds, so tuning the policy is a write and not a deploy. */
export const applicationPolicies = pgTable('application_policies', {
  candidateId: uuid('candidate_id')
    .primaryKey()
    .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
  policy: jsonb('policy').$type<ApplicationPolicy>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ApplicationIntelligenceRow = typeof applicationIntelligence.$inferSelect;
export type ApplicationOpportunityRow = typeof applicationOpportunities.$inferSelect;
export type ApplicationRecordRow = typeof applicationRecords.$inferSelect;

/** Counts for the dashboard header, computed in one pass. */
export interface OpportunityCounts {
  applyNow: number;
  apply: number;
  consider: number;
  skip: number;
  blocked: number;
  unknown: number;
  expired: number;
}

/** Placeholder used when a candidate has never had intelligence computed. */
export const EMPTY_COUNTS: OpportunityCounts = {
  applyNow: 0,
  apply: 0,
  consider: 0,
  skip: 0,
  blocked: 0,
  unknown: 0,
  expired: 0,
};

export const OPPORTUNITY_PAGE_SIZE = 25;
