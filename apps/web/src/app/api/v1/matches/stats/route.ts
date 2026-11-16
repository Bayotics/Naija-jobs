import { NextResponse } from 'next/server';
import { MATCHING_VERSION } from '@job-intel/contracts';
import { requireMatchingProfile } from '@/lib/matching';
import { handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Match distribution.
 *
 * `pendingRecalculation` is the number that matters operationally: it says how
 * many jobs the current preferences have not yet been applied to. Without it,
 * "why is this old job still showing as a strong match?" has no answer visible
 * anywhere in the product.
 */
export function GET() {
  return handler(async () => {
    const guard = await requireMatchingProfile();
    if (!guard.ok) return guard.response;

    const [statistics, pending] = await Promise.all([
      guard.matches.statistics(guard.profileId),
      guard.matches.findJobsNeedingMatch(guard.profileId, { limit: 5000 }),
    ]);

    return NextResponse.json({
      ...statistics,
      pendingRecalculation: pending.length,
      matchingVersion: MATCHING_VERSION,
      thresholds: guard.service.config.thresholds,
    });
  });
}
