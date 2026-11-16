import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDiscoveryContext } from '@/lib/discovery';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(720).default(24),
});

/** Source health for the dashboard (Part 18). */
export function GET(request: Request) {
  return handler(async () => {
    const { windowHours } = parseQuery(request, querySchema);
    const { health, registry } = await getDiscoveryContext();
    const reports = await health.report({ windowHours });

    return NextResponse.json({
      windowHours,
      sources: reports,
      summary: {
        total: reports.length,
        enabled: reports.filter((r) => r.enabled).length,
        healthy: reports.filter((r) => r.status === 'healthy').length,
        failing: reports.filter((r) => r.status === 'failing').length,
        // The highest-value alert: requests succeed but nothing is extracted.
        yieldWarnings: reports.filter((r) => r.yieldWarning).map((r) => r.sourceId),
      },
      registeredConnectors: registry.describe(),
    });
  });
}
