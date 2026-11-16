import { NextResponse } from 'next/server';
import { getApplicationContext } from '@/lib/application';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The funnel, resume performance and calibration.
 *
 * Every rate here carries a `sufficientSample` flag. The numbers are the
 * candidate's own history so they are always shown, but below the threshold
 * they are not a finding — and the UI needs to be able to say so.
 */
export function GET() {
  return handler(async () => {
    const { service, profileId } = await getApplicationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const [analytics, resumes, calibration] = await Promise.all([
      service.analytics(profileId),
      service.resumePerformance(profileId),
      service.calibration(profileId),
    ]);

    return NextResponse.json({ analytics, resumes, calibration });
  });
}
