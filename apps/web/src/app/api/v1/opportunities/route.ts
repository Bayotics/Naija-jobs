import { NextResponse } from 'next/server';
import { z } from 'zod';
import { APPLICATION_RECOMMENDATIONS } from '@job-intel/contracts';
import { getApplicationContext } from '@/lib/application';
import { apiError, handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  recommendation: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((entry) => entry.trim().toUpperCase())
            .filter((entry): entry is (typeof APPLICATION_RECOMMENDATIONS)[number] =>
              (APPLICATION_RECOMMENDATIONS as readonly string[]).includes(entry),
            )
        : undefined,
    ),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Ranked opportunities, with the counts the dashboard header needs. */
export function GET(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getApplicationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const query = parseQuery(request, querySchema);

    const [items, counts, gaps] = await Promise.all([
      service.opportunities(profileId, {
        ...(query.recommendation ? { recommendations: query.recommendation } : {}),
        limit: query.limit,
      }),
      service.counts(profileId),
      service.commonGaps(profileId, 10),
    ]);

    return NextResponse.json({ items, counts, gaps, total: items.length });
  });
}
