import { and, desc, eq, sql } from 'drizzle-orm';
import type { ApplicationUpsert, FeedbackAction, JobFeedback } from '@job-intel/contracts';
import type { Database } from '../client';
import { applications, jobFeedback } from '../schema/matching';
import { jobs } from '../schema/jobs';

/**
 * Feedback and application state — the candidate's side of the loop.
 *
 * Feedback is append-only and never garbage-collected: it is the only data in
 * the system that cannot be re-derived from sources, and it is the training
 * signal the learning loop consumes from prompt 18.
 */
export class EngagementRepository {
  constructor(private readonly db: Database) {}

  async recordFeedback(profileId: string, input: JobFeedback) {
    const [row] = await this.db
      .insert(jobFeedback)
      .values({
        jobId: input.jobId,
        profileId,
        action: input.action,
        reasonCodes: input.reasonCodes,
        note: input.note,
        source: input.source,
      })
      .returning();

    // Feedback that implies a pipeline position keeps `applications` in step,
    // so the board never disagrees with the feedback history.
    const implied = impliedApplicationState(input.action);
    if (implied) {
      await this.upsertApplication(profileId, { jobId: input.jobId, state: implied });
    }
    return row ?? null;
  }

  async listFeedback(jobId: string) {
    return this.db
      .select()
      .from(jobFeedback)
      .where(eq(jobFeedback.jobId, jobId))
      .orderBy(desc(jobFeedback.createdAt));
  }

  async upsertApplication(profileId: string, input: ApplicationUpsert) {
    const now = new Date();
    const [row] = await this.db
      .insert(applications)
      .values({
        jobId: input.jobId,
        profileId,
        state: input.state,
        notes: input.notes ?? null,
        appliedAt: input.appliedAt ?? (input.state === 'applied' ? now : null),
        lastTransitionAt: now,
      })
      .onConflictDoUpdate({
        target: [applications.jobId, applications.profileId],
        set: {
          state: input.state,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.state === 'applied' ? { appliedAt: input.appliedAt ?? now } : {}),
          lastTransitionAt: now,
          updatedAt: now,
        },
      })
      .returning();
    return row ?? null;
  }

  async listApplications(profileId: string, state?: ApplicationUpsert['state']) {
    const conditions = [eq(applications.profileId, profileId)];
    if (state) conditions.push(eq(applications.state, state));

    return this.db
      .select({
        id: applications.id,
        jobId: applications.jobId,
        state: applications.state,
        appliedAt: applications.appliedAt,
        notes: applications.notes,
        lastTransitionAt: applications.lastTransitionAt,
        jobTitle: jobs.title,
        companyName: jobs.companyNameRaw,
        canonicalUrl: jobs.canonicalUrl,
        sourceUrl: jobs.sourceUrl,
      })
      .from(applications)
      .innerJoin(jobs, eq(applications.jobId, jobs.id))
      .where(and(...conditions))
      .orderBy(desc(applications.lastTransitionAt));
  }

  async applicationCounts(profileId: string) {
    const rows = await this.db
      .select({ state: applications.state, count: sql<number>`count(*)::int` })
      .from(applications)
      .where(eq(applications.profileId, profileId))
      .groupBy(applications.state);
    return Object.fromEntries(rows.map((r) => [r.state, r.count]));
  }
}

/**
 * Feedback actions that also move the application board.
 * `interested`, `irrelevant` and `duplicate` are judgements about the *match*,
 * not the application, so they intentionally map to nothing here.
 */
function impliedApplicationState(action: FeedbackAction): ApplicationUpsert['state'] | null {
  switch (action) {
    case 'saved':
      return 'saved';
    case 'applied':
      return 'applied';
    case 'rejected':
      return 'rejected';
    case 'not_interested':
      return 'dismissed';
    default:
      return null;
  }
}
