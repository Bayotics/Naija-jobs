import 'server-only';
import {
  OpsRepository,
  RecommendationRepository,
  checkDatabaseHealth,
} from '@job-intel/db';
import { OpsService } from '@job-intel/discovery';
import { createQueueDriver } from '@job-intel/queue';
import { getServerContext } from './db';

/**
 * Operations composition for the web process.
 *
 * The queue driver is created per request rather than cached, because a driver
 * cached across a Redis outage keeps reporting the stale connection it opened
 * before the outage — and the one moment this page matters is during one.
 */
export interface OpsContext {
  service: OpsService;
  repository: OpsRepository;
  profileId: string | null;
}

export async function getOpsContext(): Promise<OpsContext> {
  const ctx = await getServerContext();
  const config = await ctx.config.get();
  const profile = await ctx.profiles.getActiveProfile().catch(() => null);

  const repository = new OpsRepository(ctx.handle.db);
  const queue = createQueueDriver(ctx.env);

  const service = new OpsService({
    ops: repository,
    sources: ctx.sources,
    profiles: ctx.profiles,
    recommendations: new RecommendationRepository(ctx.handle.db),
    queue,
    logger: ctx.logger,
    events: ctx.events,
    checkDatabase: () => checkDatabaseHealth(ctx.handle.db),
    aiEnabled: config.ai.enabled,
    aiModel: config.ai.triageModel,
    dailyBudgetUsd: config.ai.dailyBudgetUsd,
  });

  return { service, repository, profileId: profile?.profileId ?? null };
}
