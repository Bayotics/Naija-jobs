import 'server-only';
import { CandidateRepository, DiscoveryFrameworkRepository } from '@job-intel/db';
import { DomainRateLimiter, HttpClient, createDefaultRegistry } from '@job-intel/connectors';
import { DiscoveryFrameworkService } from '@job-intel/discovery';
import { getServerContext } from './db';

/**
 * Discovery-framework composition for the web process.
 *
 * Built per request rather than cached. The service reads source rows,
 * capabilities and performance on every call, and a cached instance would keep
 * answering from the connector registry it captured at boot — which is exactly
 * wrong for a page whose job is to show current state.
 */
export interface DiscoveryFrameworkContext {
  service: DiscoveryFrameworkService;
  repository: DiscoveryFrameworkRepository;
  profileId: string | null;
}

export async function getDiscoveryFrameworkContext(): Promise<DiscoveryFrameworkContext> {
  const ctx = await getServerContext();
  const profile = await ctx.profiles.getActiveProfile().catch(() => null);

  const repository = new DiscoveryFrameworkRepository(ctx.handle.db);

  const service = new DiscoveryFrameworkService({
    framework: repository,
    sources: ctx.sources,
    profiles: ctx.profiles,
    candidates: new CandidateRepository(ctx.handle.db),
    registry: createDefaultRegistry(),
    logger: ctx.logger,
    events: ctx.events,
    http: new HttpClient({
      userAgent: ctx.env.CRAWLER_USER_AGENT,
      contactEmail: ctx.env.CRAWLER_CONTACT_EMAIL,
      timeoutMs: 20_000,
      rateLimiter: new DomainRateLimiter(),
    }),
  });

  return { service, repository, profileId: profile?.profileId ?? null };
}
