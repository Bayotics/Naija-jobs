import 'server-only';
import {
  ApplicationRepository,
  CandidateRepository,
  EnrichmentRepository,
  MatchRepository,
  NotificationIntelligenceRepository,
} from '@job-intel/db';
import { NotificationIntelligenceService } from '@job-intel/discovery';
import { getServerContext } from './db';

/**
 * Notification-intelligence composition for the web process.
 *
 * Built per request like the other contexts. No link probe is wired here: the
 * web process should not be making outbound requests to arbitrary employer
 * sites on a page render, so links are validated structurally and the worker
 * does the reachability checks where a slow response costs nobody a page load.
 */

export interface NotificationIntelligenceContext {
  service: NotificationIntelligenceService;
  repository: NotificationIntelligenceRepository;
  profileId: string | null;
}

export async function getNotificationContext(): Promise<NotificationIntelligenceContext> {
  const ctx = await getServerContext();
  const profile = await ctx.profiles.getActiveProfile().catch(() => null);

  const repository = new NotificationIntelligenceRepository(ctx.handle.db);

  const service = new NotificationIntelligenceService({
    notifications: repository,
    applications: new ApplicationRepository(ctx.handle.db),
    matches: new MatchRepository(ctx.handle.db),
    jobs: ctx.jobs,
    enrichments: new EnrichmentRepository(ctx.handle.db),
    candidates: new CandidateRepository(ctx.handle.db),
    logger: ctx.logger,
    events: ctx.events,
  });

  return { service, repository, profileId: profile?.profileId ?? null };
}
