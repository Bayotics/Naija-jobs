import 'server-only';
import {
  NotificationRepository,
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
    notifications: new NotificationRepository(ctx.handle.db),
    queue,
    logger: ctx.logger,
    events: ctx.events,
    checkDatabase: () => checkDatabaseHealth(ctx.handle.db),
    // Reported honestly: the in-memory provider shows as degraded, not healthy,
    // because "captured" is not "sent".
    emailProviderId: ctx.env.RESEND_API_KEY ? 'resend' : 'memory',
    aiEnabled: config.ai.enabled,
    aiModel: config.ai.triageModel,
    dailyBudgetUsd: config.ai.dailyBudgetUsd,
  });

  return { service, repository, profileId: profile?.profileId ?? null };
}
