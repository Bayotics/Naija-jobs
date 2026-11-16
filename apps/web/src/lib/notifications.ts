import 'server-only';
import {
  CandidateRepository,
  NotificationRepository,
  RecommendationRepository,
} from '@job-intel/db';
import { NotificationService } from '@job-intel/discovery';
import { createEmailProvider } from '@job-intel/notifications';
import { apiError } from './api';
import { getServerContext } from './db';

/**
 * Notification composition for the web process.
 *
 * The provider is chosen from the environment, never from source. Without a key
 * the in-memory provider is used, which captures messages instead of sending
 * them — an unconfigured deployment cannot accidentally email anyone, and that
 * is the safe default rather than an untested fallback.
 */
export interface NotificationContext {
  service: NotificationService;
  repository: NotificationRepository;
  profileId: string | null;
}

export async function getNotificationContext(): Promise<NotificationContext> {
  const ctx = await getServerContext();
  const config = await ctx.config.get();
  const profile = await ctx.profiles.getActiveProfile();
  const repository = new NotificationRepository(ctx.handle.db);

  const apiKey = ctx.env.RESEND_API_KEY;
  /*
   * One place decides. A dry run exercises everything except delivery, and no
   * caller has to remember which provider means "actually send".
   */
  const provider = createEmailProvider({ apiKey, dryRun: ctx.env.NOTIFICATION_DRY_RUN });

  const service = new NotificationService({
    notifications: repository,
    recommendations: new RecommendationRepository(ctx.handle.db),
    candidates: new CandidateRepository(ctx.handle.db),
    profiles: ctx.profiles,
    sources: ctx.sources,
    logger: ctx.logger,
    events: ctx.events,
    provider,
    config: {
      // The global switch, independent of any candidate's preferences: a
      // deployment can be fully configured and still deliberately silent.
      enabled: config.notifications.enabled,
      appUrl: ctx.env.APP_URL,
    },
    preferenceSecret: ctx.env.FEEDBACK_TOKEN_SECRET ?? null,
    fromEmail: ctx.env.NOTIFICATION_FROM_EMAIL ?? null,
  });

  return { service, repository, profileId: profile?.profileId ?? null };
}

export async function requireNotificationProfile(): Promise<
  | { ok: true; service: NotificationService; repository: NotificationRepository; profileId: string }
  | { ok: false; response: ReturnType<typeof apiError> }
> {
  const { service, repository, profileId } = await getNotificationContext();
  if (!profileId) {
    return {
      ok: false,
      response: apiError(409, 'NO_PROFILE', 'No active candidate profile. Create one first.'),
    };
  }
  return { ok: true, service, repository, profileId };
}
