import { NextResponse } from 'next/server';
import { notificationIntelligenceConfigSchema } from '@job-intel/contracts';
import { getNotificationContext } from '@/lib/notification-intelligence';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** The candidate's notification configuration, plus what it is producing. */
export function GET() {
  return handler(async () => {
    const { service, profileId } = await getNotificationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const [config, overrides, counts, analytics, fatigue, quality, advice] = await Promise.all([
      service.getConfig(profileId),
      service.listOverrides(profileId),
      service.suppressionCounts(profileId),
      service.analytics(profileId).catch(() => null),
      service.fatigue(profileId).catch(() => null),
      service.alertQuality(profileId).catch(() => null),
      service.thresholdAdvice(profileId).catch(() => null),
    ]);

    return NextResponse.json({
      config,
      overrides,
      suppressionCounts: counts,
      analytics,
      fatigue,
      quality,
      thresholdAdvice: advice,
    });
  });
}

/**
 * Replaces the configuration.
 *
 * The whole object rather than a patch: partial updates to a nested config are
 * where "I turned one thing off and something else changed" comes from, and the
 * settings page holds the full object anyway.
 */
export function PUT(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getNotificationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const config = await parseBody(request, notificationIntelligenceConfigSchema);
    const saved = await service.setConfig(profileId, config);

    return NextResponse.json(saved);
  });
}
