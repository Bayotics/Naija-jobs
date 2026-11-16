import 'server-only';
import {
  ApplicationRepository,
  CandidateRepository,
  EnrichmentRepository,
  IntelligenceRepository,
  MatchRepository,
} from '@job-intel/db';
import { ApplicationService } from '@job-intel/discovery';
import { getServerContext } from './db';

/**
 * Application-intelligence composition for the web process.
 *
 * Built per request like every other context here, for the same reason: the
 * recommendation depends on the active profile version, the candidate's
 * preferences and the acknowledged blockers, and all three change from under a
 * cached instance.
 */

export interface ApplicationContext {
  service: ApplicationService;
  repository: ApplicationRepository;
  profileId: string | null;
}

export async function getApplicationContext(): Promise<ApplicationContext> {
  const ctx = await getServerContext();
  const profile = await ctx.profiles.getActiveProfile().catch(() => null);

  const repository = new ApplicationRepository(ctx.handle.db);

  const service = new ApplicationService({
    applications: repository,
    intelligence: new IntelligenceRepository(ctx.handle.db),
    candidates: new CandidateRepository(ctx.handle.db),
    profiles: ctx.profiles,
    matches: new MatchRepository(ctx.handle.db),
    jobs: ctx.jobs,
    enrichments: new EnrichmentRepository(ctx.handle.db),
    logger: ctx.logger,
    events: ctx.events,
  });

  return { service, repository, profileId: profile?.profileId ?? null };
}
