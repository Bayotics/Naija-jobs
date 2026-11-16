import 'server-only';
import { CandidateRepository } from '@job-intel/db';
import { CandidateIntelligenceService } from '@job-intel/discovery';
import { apiError } from './api';
import { getServerContext } from './db';

/**
 * Candidate intelligence composition for the web process.
 *
 * Deliberately builds a fresh service per request rather than caching it: the
 * service holds no preference state, and any cache here would be the mechanism
 * by which a preference change failed to take effect on the next matching run.
 */
export async function getCandidateService(): Promise<{
  service: CandidateIntelligenceService;
  repository: CandidateRepository;
  profileId: string | null;
}> {
  const ctx = await getServerContext();
  const repository = new CandidateRepository(ctx.handle.db);
  const config = await ctx.config.get();
  const profile = await ctx.profiles.getActiveProfile();

  const service = new CandidateIntelligenceService({
    candidates: repository,
    profiles: ctx.profiles,
    logger: ctx.logger,
    events: ctx.events,
    // Model identity comes from runtime config, so a model change invalidates
    // embeddings without a code edit.
    embeddingModel: config.ai.embeddingModel,
    embeddingDimensions: config.ai.embeddingDimensions,
  });

  return { service, repository, profileId: profile?.profileId ?? null };
}

/** Shared guard: every candidate endpoint needs a profile to act on. */
export async function requireProfile(): Promise<
  | { ok: true; service: CandidateIntelligenceService; repository: CandidateRepository; profileId: string }
  | { ok: false; response: ReturnType<typeof apiError> }
> {
  const { service, repository, profileId } = await getCandidateService();
  if (!profileId) {
    return {
      ok: false,
      response: apiError(409, 'NO_PROFILE', 'No active candidate profile. Create one first.'),
    };
  }
  return { ok: true, service, repository, profileId };
}
