import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { CandidateProfilePayload } from '@job-intel/contracts';

/**
 * Identity, candidate profile and the canonical skill vocabulary.
 *
 * The system is single-user today, but every owned row carries `user_id` so
 * multi-tenancy is a migration rather than a rewrite.
 */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name'),
    timezone: text('timezone').notNull().default('UTC'),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete: retaining the row keeps historical jobs/feedback attributable. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
);

/**
 * Stable pointer to the candidate. Mutable content lives in versions, so this
 * row's id can be referenced permanently by matches and notifications.
 */
export const candidateProfiles = pgTable(
  'candidate_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    /** Denormalised pointer to the live version; the authority is `is_active`. */
    activeVersionId: uuid('active_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('candidate_profiles_user_unique').on(t.userId)],
);

/**
 * Append-only profile history.
 *
 * Never updated in place. Every match result records the version that produced
 * it, so a score stays interpretable after preferences change — and changing a
 * preference is a new row, which is why it needs no deploy.
 */
export const profileVersions = pgTable(
  'profile_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** Validated against `candidateProfilePayloadSchema` before every write. */
    payload: jsonb('payload').$type<CandidateProfilePayload>().notNull(),
    changeSummary: text('change_summary'),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by'),
  },
  (t) => [
    uniqueIndex('profile_versions_profile_version_unique').on(t.profileId, t.version),
    index('profile_versions_active_idx').on(t.profileId, t.isActive),
  ],
);

/**
 * Canonical skill vocabulary.
 *
 * Deliberately a table rather than a text array on jobs/profiles: without a
 * shared vocabulary, "React" / "ReactJS" / "React.js" are three unrelated
 * strings and neither matching nor the configurable synonym handling the
 * architecture calls for is expressible. Jobs additionally keep a denormalised
 * `tech_stack` array for cheap filtering.
 */
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lower-cased canonical key, e.g. "react". */
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    category: text('category'),
    /** Alternate spellings that resolve to this skill. */
    aliases: text('aliases').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('skills_slug_unique').on(t.slug), index('skills_category_idx').on(t.category)],
);

export const candidateSkills = pgTable(
  'candidate_skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    yearsOfExperience: real('years_of_experience'),
    /** 1–5. Null means "claimed, unrated". */
    proficiency: integer('proficiency'),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('candidate_skills_unique').on(t.profileId, t.skillId),
    index('candidate_skills_skill_idx').on(t.skillId),
  ],
);

export const usersRelations = relations(users, ({ one }) => ({
  profile: one(candidateProfiles, {
    fields: [users.id],
    references: [candidateProfiles.userId],
  }),
}));

export const candidateProfilesRelations = relations(candidateProfiles, ({ one, many }) => ({
  user: one(users, { fields: [candidateProfiles.userId], references: [users.id] }),
  versions: many(profileVersions),
  skills: many(candidateSkills),
}));

export const profileVersionsRelations = relations(profileVersions, ({ one }) => ({
  profile: one(candidateProfiles, {
    fields: [profileVersions.profileId],
    references: [candidateProfiles.id],
  }),
}));

export const candidateSkillsRelations = relations(candidateSkills, ({ one }) => ({
  profile: one(candidateProfiles, {
    fields: [candidateSkills.profileId],
    references: [candidateProfiles.id],
  }),
  skill: one(skills, { fields: [candidateSkills.skillId], references: [skills.id] }),
}));
