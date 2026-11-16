import { z } from 'zod';
import { SALARY_PERIODS } from './common';

/**
 * The discovery contract: what a connector hands to the pipeline.
 *
 * This is the "RAW RESULT" stage. It is deliberately a *lightly structured*
 * shape rather than the final domain model, because it draws the one boundary
 * that keeps the system extensible:
 *
 *   - The **connector** knows that Remotive calls it `candidate_required_location`
 *     and Arbeitnow calls it `location`. It extracts fields. It does not
 *     interpret them.
 *   - The **normalizer** knows that "WFH", "100% remote" and "Remote-first" are
 *     all `remote`. It interprets. It does not know which source it came from.
 *
 * Every text field stays a string here. Enum mapping, salary parsing and
 * location parsing happen once, centrally, so a new connector inherits all of
 * it for free and cannot invent its own interpretation of "full-time".
 */
export const sourceJobDraftSchema = z.object({
  /** The source's own stable identifier, when it has one. */
  externalId: z.string().trim().max(500).nullable().default(null),

  title: z.string().trim().min(1).max(500),
  companyName: z.string().trim().min(1).max(300),
  companyWebsite: z.string().trim().max(2000).nullable().default(null),

  /** Description as supplied. `descriptionFormat` says how to read it. */
  description: z.string().max(500_000).nullable().default(null),
  descriptionFormat: z.enum(['html', 'text', 'markdown']).default('text'),

  /** Free-text location, exactly as the source worded it. */
  locationText: z.string().trim().max(500).nullable().default(null),
  /** A structured remote flag, when the source provides one. */
  remoteFlag: z.boolean().nullable().default(null),

  /** Raw employment-type strings ("Full Time", "Permanent", "Vollzeit"). */
  employmentTypeTexts: z.array(z.string().trim().min(1).max(120)).default([]),

  /** Free-text salary, e.g. "$120 - $170 /hour". */
  salaryText: z.string().trim().max(500).nullable().default(null),
  /** Structured salary when the source supplies numbers directly. */
  salaryMin: z.number().nonnegative().nullable().default(null),
  salaryMax: z.number().nonnegative().nullable().default(null),
  salaryCurrency: z.string().trim().max(10).nullable().default(null),
  salaryPeriod: z.enum(SALARY_PERIODS).nullable().default(null),

  tags: z.array(z.string().trim().min(1).max(120)).default([]),

  postedAt: z.date().nullable().default(null),
  validThrough: z.date().nullable().default(null),

  /** Where the posting was found. Required — a job with no URL is unusable. */
  url: z.string().trim().url(),
  /** A more direct application URL, when the source distinguishes them. */
  applyUrl: z.string().trim().max(2000).nullable().default(null),

  /**
   * The source payload, verbatim. Persisted to `raw_postings` so a failed
   * normalization can be investigated against what the source actually sent,
   * and so an improved normalizer can be replayed over history.
   *
   * Nothing downstream of normalization may read this.
   */
  raw: z.unknown(),

  /** Source-specific context worth surfacing (subreddit, feed category, …). */
  sourceMetadata: z.record(z.string(), z.unknown()).default({}),
});

export type SourceJobDraft = z.infer<typeof sourceJobDraftSchema>;

/** Input accepted by connectors before defaults are applied. */
export type SourceJobDraftInput = z.input<typeof sourceJobDraftSchema>;

/**
 * Outcome of a single posting passing through the pipeline.
 * `unchanged` is distinct from `updated`: re-crawling an unmodified posting
 * must be free and must not create a version record.
 */
export const DISCOVERY_OUTCOMES = [
  'created',
  'updated',
  'unchanged',
  'duplicate',
  'rejected',
  'failed',
] as const;
export type DiscoveryOutcome = (typeof DISCOVERY_OUTCOMES)[number];

export interface DiscoveryItemResult {
  outcome: DiscoveryOutcome;
  jobId: string | null;
  /** Populated for `rejected` / `failed`. */
  reason: string | null;
  /** Field names that changed, for `updated`. */
  changedFields: string[];
}
