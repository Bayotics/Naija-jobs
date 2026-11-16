import 'server-only';
import { CandidateRepository, LearningRepository } from '@job-intel/db';
import { LearningService } from '@job-intel/discovery';
import { getServerContext } from './db';

/**
 * Learning composition for the web process.
 *
 * Built per request. The service reads learning settings on every call, and a
 * cached instance would keep applying the configuration it captured at boot —
 * which is exactly wrong for a feature whose whole point is that the candidate
 * can switch it off.
 */
export interface LearningContext {
  service: LearningService;
  repository: LearningRepository;
  profileId: string | null;
}

export async function getLearningContext(): Promise<LearningContext> {
  const ctx = await getServerContext();
  const profile = await ctx.profiles.getActiveProfile().catch(() => null);

  const repository = new LearningRepository(ctx.handle.db);

  const service = new LearningService({
    learning: repository,
    candidates: new CandidateRepository(ctx.handle.db),
    logger: ctx.logger,
    events: ctx.events,
  });

  return { service, repository, profileId: profile?.profileId ?? null };
}
