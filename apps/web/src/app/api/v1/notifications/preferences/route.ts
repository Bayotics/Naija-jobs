import { NextResponse } from 'next/server';
import { notificationPreferencesSchema } from '@job-intel/contracts';
import { requireNotificationProfile } from '@/lib/notifications';
import { handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Notification preferences.
 *
 * `GET` reads, `PATCH` writes. A GET never mutates anything — the preference
 * link in every email is pre-fetched by mail scanners and corporate proxies,
 * and an unsubscribe that fired on GET would silence people who never clicked.
 */
export function GET() {
  return handler(async () => {
    const guard = await requireNotificationProfile();
    if (!guard.ok) return guard.response;

    const { preferences, lastDigestAt, lastWeeklySummaryAt } =
      await guard.repository.getPreferences(guard.profileId);

    return NextResponse.json({ preferences, lastDigestAt, lastWeeklySummaryAt });
  });
}

/**
 * Merged rather than replaced, so a UI that only knows about four fields cannot
 * silently reset the rest to their defaults.
 */
export function PATCH(request: Request) {
  return handler(async () => {
    const guard = await requireNotificationProfile();
    if (!guard.ok) return guard.response;

    const patch = await parseBody(request, notificationPreferencesSchema.partial());
    const { preferences } = await guard.repository.getPreferences(guard.profileId);

    const merged = notificationPreferencesSchema.parse({
      ...preferences,
      ...patch,
      // Nested objects merge one level: a partial `quietHours` must not drop
      // the fields it did not mention.
      quietHours: { ...preferences.quietHours, ...(patch.quietHours ?? {}) },
    });

    const saved = await guard.repository.savePreferences(guard.profileId, merged);
    return NextResponse.json({ preferences: saved });
  });
}
