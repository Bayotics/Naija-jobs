import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOpsContext } from '@/lib/ops';
import { requireRole } from '@/lib/auth';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(24 * 30).default(24),
});

/** Latency percentiles per operation. Empty until samples exist — never faked. */
export function GET(request: Request) {
  return handler(async () => {
    const auth = await requireRole('viewer');
    if (!auth.ok) return auth.response;

    const { windowHours } = parseQuery(request, querySchema);
    const { service } = await getOpsContext();
    const latencies = await service.latencies(windowHours);

    return NextResponse.json({
      items: latencies.sort((a, b) => b.count - a.count),
      windowHours,
    });
  });
}
