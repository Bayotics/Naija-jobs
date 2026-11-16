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
  CompanyRules,
  ConfigChange,
  IndustryRules,
  KeywordRules,
  LanguageRequirement,
  LocationSpec,
  RoleTarget,
  SalaryConfig,
  SkillRequirement,
  SourceSelection,
  VisaConfig,
} from '@job-intel/contracts';
import { candidateProfiles } from './identity';
import { jobs } from './jobs';

/**
 * Search configuration storage.
 *
 * The tables here answer one question — *what am I looking for?* — and they are
 * deliberately separate from every other kind of state in this system:
 *
 *   `candidate_preference_versions`  what I want, generally     (prompt 5)
 *   `candidate_intelligence_profiles` what is true about me     (prompt 12)
 *   `behavior_events`                 what I actually click     (prompt 11)
 *   `notification_*`                  when to interrupt me      (prompt 14)
 *   `search_profiles`                 what to look for now      ← here
 *
 * Merging any two of them would make a search change able to rewrite something
 * it has no business touching. Changing "Nigeria" to "Germany" must not touch a
 * single fact on the candidate's CV, and the schema is what guarantees that
 * rather than a convention somebody remembers.
 */

// ── Search profiles (Parts 1, 2, 28) ────────────────────────────────────────

export const searchProfiles = pgTable(
  'search_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

    profileName: text('profile_name').notNull(),
    description: text('description'),
    /** `active`, `paused` or `archived`. Archived profiles keep their history. */
    state: text('state').notNull().default('active'),
    enabled: boolean('enabled').notNull().default(true),

    roles: jsonb('roles').$type<RoleTarget[]>().notNull().default([]),

    locations: jsonb('locations').$type<LocationSpec[]>().notNull().default([]),
    excludedLocations: jsonb('excluded_locations').$type<LocationSpec[]>().notNull().default([]),
    locationStrictness: text('location_strictness').notNull().default('preferred'),
    remotePreference: text('remote_preference').notNull().default('ANY'),
    remoteScope: jsonb('remote_scope').$type<Record<string, unknown>>().notNull().default({}),

    employmentTypes: jsonb('employment_types').$type<string[]>().notNull().default([]),
    seniorityLevels: jsonb('seniority_levels').$type<string[]>().notNull().default([]),

    minimumExperienceYears: real('minimum_experience_years'),
    maximumExperienceYears: real('maximum_experience_years'),

    salary: jsonb('salary').$type<SalaryConfig>().notNull(),

    skills: jsonb('skills').$type<SkillRequirement[]>().notNull().default([]),
    excludedSkills: jsonb('excluded_skills').$type<string[]>().notNull().default([]),
    skillStrictness: text('skill_strictness').notNull().default('near_hard'),
    keywords: jsonb('keywords').$type<KeywordRules>().notNull(),

    companies: jsonb('companies').$type<CompanyRules>().notNull(),
    industries: jsonb('industries').$type<IndustryRules>().notNull(),
    visa: jsonb('visa').$type<VisaConfig>().notNull(),
    languages: jsonb('languages').$type<LanguageRequirement[]>().notNull().default([]),

    sources: jsonb('sources').$type<SourceSelection[]>().notNull().default([]),
    excludedSources: jsonb('excluded_sources').$type<string[]>().notNull().default([]),

    searchFrequency: text('search_frequency').notNull().default('hourly'),
    notificationPolicy: jsonb('notification_policy')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    /** Last discovery run, so the scheduler knows when the next one is due. */
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Two profiles with the same name would be indistinguishable in the UI. */
    nameUnique: unique('search_profiles_name_unique').on(table.candidateId, table.profileName),
    candidateIdx: index('search_profiles_candidate_idx').on(table.candidateId, table.state),
    /** Drives the scheduler sweep, which runs constantly. */
    scheduleIdx: index('search_profiles_schedule_idx').on(table.enabled, table.lastRunAt),
  }),
);

// ── Global search state (Part 26) ───────────────────────────────────────────

/**
 * Pause, resume, and the version everything else watches.
 *
 * `configVersion` is the cache-invalidation mechanism for the whole layer. Any
 * write to any table here bumps it; every consumer holding a resolved
 * configuration compares its copy and reloads when it differs. One integer,
 * checked on a query that is already happening, rather than a message bus
 * nobody can debug at 3am.
 */
export const searchStates = pgTable('search_states', {
  candidateId: uuid('candidate_id')
    .primaryKey()
    .references(() => candidateProfiles.id, { onDelete: 'cascade' }),

  paused: boolean('paused').notNull().default(false),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  pauseReason: text('pause_reason'),

  configVersion: integer('config_version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Temporary overrides (Parts 32, 33) ──────────────────────────────────────

export const searchOverrides = pgTable(
  'search_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    /** Null applies the override to every active profile. */
    profileId: uuid('profile_id').references(() => searchProfiles.id, { onDelete: 'cascade' }),

    field: text('field').notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),

    startTime: timestamp('start_time', { withTimezone: true }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true }).notNull(),
    reason: text('reason'),

    /**
     * Cleared when the window closes.
     *
     * The row is kept rather than deleted so the history can say the override
     * existed and ended — one that simply vanishes leaves someone wondering why
     * their search changed twice.
     */
    active: boolean('active').notNull().default(true),
    expiredAt: timestamp('expired_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeIdx: index('search_overrides_active_idx').on(table.candidateId, table.active, table.endTime),
    profileIdx: index('search_overrides_profile_idx').on(table.profileId),
    /** The expiry sweep scans this. */
    expiryIdx: index('search_overrides_expiry_idx').on(table.active, table.endTime),
  }),
);

// ── Configuration history and undo (Parts 37, 38) ───────────────────────────

/**
 * Every change, with the whole profile as it was.
 *
 * Storing a full snapshot rather than an inverse is the decision that makes
 * undo reliable. Inverting a change set is possible and fragile — a `remove`
 * whose target was already absent has no inverse, and two edits to one list do
 * not invert independently. A JSON blob per change costs nothing next to being
 * able to say "that is exactly what it was".
 */
export const searchConfigHistory = pgTable(
  'search_config_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => searchProfiles.id, { onDelete: 'set null' }),

    operation: text('operation').notNull(),
    changes: jsonb('changes').$type<ConfigChange[]>().notNull().default([]),
    snapshotBefore: jsonb('snapshot_before'),

    /** `ui`, `api`, `natural_language`, `system_suggestion`, `override_expiry`. */
    source: text('source').notNull(),
    actor: text('actor').notNull().default('user'),
    reason: text('reason'),
    /** The instruction, when this came from the command bar. */
    instruction: text('instruction'),

    undoneAt: timestamp('undone_at', { withTimezone: true }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    candidateIdx: index('search_config_history_candidate_idx').on(
      table.candidateId,
      table.occurredAt,
    ),
    profileIdx: index('search_config_history_profile_idx').on(table.profileId, table.occurredAt),
  }),
);

// ── Profile-specific matching (Parts 29, 30, 31) ────────────────────────────

/**
 * One job, scored per profile.
 *
 * This table *is* cross-profile deduplication. There is exactly one row in
 * `jobs` however many profiles find it, and this says what each strategy makes
 * of it — 92% for "Frontend Germany" and 61% for "Cloud Europe", both correct.
 *
 * Creating a second job record per profile would break every count in the
 * system and make "have I already applied?" unanswerable.
 */
export const profileJobMatches = pgTable(
  'profile_job_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => searchProfiles.id, { onDelete: 'cascade' }),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    score: real('score').notNull().default(0),
    eligible: boolean('eligible').notNull().default(true),
    /** Shown in the notification: "Matched your 'Remote Frontend' profile." */
    reason: text('reason').notNull().default(''),
    matchedCriteria: jsonb('matched_criteria').$type<string[]>().notNull().default([]),
    failedCriteria: jsonb('failed_criteria').$type<string[]>().notNull().default([]),

    /** Which profile first surfaced this job, for attribution. */
    discoveredByProfile: boolean('discovered_by_profile').notNull().default(false),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pairUnique: unique('profile_job_matches_unique').on(table.profileId, table.jobId),
    jobIdx: index('profile_job_matches_job_idx').on(table.jobId),
    rankIdx: index('profile_job_matches_rank_idx').on(table.profileId, table.score),
  }),
);

export type SearchProfileRow = typeof searchProfiles.$inferSelect;
export type SearchOverrideRow = typeof searchOverrides.$inferSelect;
export type SearchConfigHistoryRow = typeof searchConfigHistory.$inferSelect;
export type ProfileJobMatchRow = typeof profileJobMatches.$inferSelect;
