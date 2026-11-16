import 'server-only';
import { AcquisitionRepository, DiscoveryRepository } from '@job-intel/db';
import { EnvSecretProvider } from '@job-intel/config';
import { HttpClient, createDefaultRegistry, DomainRateLimiter } from '@job-intel/connectors';
import { SourceHealthService, SourceRunner } from '@job-intel/discovery';
import type { JobSource } from '@job-intel/contracts';
import { getServerContext } from './db';

/**
 * Discovery composition root for the web process.
 *
 * The rate limiter is shared across every source deliberately: limits are
 * per-domain, and several sources can point at one host. A limiter per source
 * would let them collectively exceed what that host expects.
 */
export interface DiscoveryContext {
  runner: SourceRunner;
  health: SourceHealthService;
  registry: ReturnType<typeof createDefaultRegistry>;
}

declare global {
  var __jobIntelDiscovery: Promise<DiscoveryContext> | undefined;
}

async function build(): Promise<DiscoveryContext> {
  const ctx = await getServerContext();
  const registry = createDefaultRegistry();
  const discovery = new DiscoveryRepository(ctx.handle.db);
  const acquisition = new AcquisitionRepository(ctx.handle.db);
  const secrets = new EnvSecretProvider();
  const rateLimiter = new DomainRateLimiter();

  const runner = new SourceRunner({
    registry,
    sources: ctx.sources,
    discovery,
    logger: ctx.logger,
    events: ctx.events,
    getSecret: (name) => secrets.get(name),
    acquisition,
    createHttpClient: (source: JobSource) =>
      new HttpClient({
        userAgent: ctx.env.CRAWLER_USER_AGENT,
        contactEmail: ctx.env.CRAWLER_CONTACT_EMAIL,
        timeoutMs: source.limits.timeoutMs,
        rateLimiter,
      }),
  });

  return {
    runner,
    health: new SourceHealthService({ sources: ctx.sources, discovery }),
    registry,
  };
}

export function getDiscoveryContext(): Promise<DiscoveryContext> {
  globalThis.__jobIntelDiscovery ??= build();
  return globalThis.__jobIntelDiscovery;
}
