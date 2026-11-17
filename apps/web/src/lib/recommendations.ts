import 'server-only';
import {
  CandidateRepository,
  RecommendationRepository,
} from '@job-intel/db';
import { RecommendationService } from '@job-intel/discovery';
import { apiError } from './api';
import { getServerContext } from './db';

/**
 * Recommendation composition for the web process.
 *
 * Built fresh per request, like the matching and candidate services and for the
 * same reason: ranking depends on the current pool and the current clock, and a
 * cached service is the mechanism by which yesterday's ranking quietly becomes
 * today's.
 *
 * No URL verifier is wired in here. Verification makes outbound HTTP calls that
 * must honour robots.txt and per-domain rate limits; that belongs in the worker,
 * not inside an HTTP request.
 */
export interface RecommendationContext {
  service: RecommendationService;
  repository: RecommendationRepository;
  profileId: string | null;
}

export async function getRecommendationContext(): Promise<RecommendationContext> {
  const ctx = await getServerContext();
  const config = await ctx.config.get();
  const profile = await ctx.profiles.getActiveProfile();
  const repository = new RecommendationRepository(ctx.handle.db);

  const service = new RecommendationService({
    recommendations: repository,
    candidates: new CandidateRepository(ctx.handle.db),
    profiles: ctx.profiles,
    sources: ctx.sources,
    logger: ctx.logger,
    events: ctx.events,
    config: {
      // Where the recommendation layer defers to the shared runtime config, so
      // a single "minimum score" setting means one thing, and the score the
      // dashboard prints is spaced the same way the worker spaced it.
      notification: { minimumScore: config.matching.minimumScore },
      calibration: config.recommendationCalibration,
    },
  });

  return { service, repository, profileId: profile?.profileId ?? null };
}

export async function requireRecommendationProfile(): Promise<
  | { ok: true; service: RecommendationService; repository: RecommendationRepository; profileId: string }
  | { ok: false; response: ReturnType<typeof apiError> }
> {
  const { service, repository, profileId } = await getRecommendationContext();
  if (!profileId) {
    return {
      ok: false,
      response: apiError(409, 'NO_PROFILE', 'No active candidate profile. Create one first.'),
    };
  }
  return { ok: true, service, repository, profileId };
}
