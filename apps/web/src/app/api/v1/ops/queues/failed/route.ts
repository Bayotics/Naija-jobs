import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOpsContext } from '@/lib/ops';
import { requireRole } from '@/lib/auth';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The dead-letter queue.
 *
 * Separate from `/queues` because it answers a different question: that route
 * says how much work is stuck, this one says why. Failure reasons and stacks
 * are redacted by the service before they leave the process.
 */
export function GET(request: Request) {
  return handler(async () => {
    const auth = await requireRole('viewer');
    if (!auth.ok) return auth.response;

    const { limit } = parseQuery(request, querySchema);
    const { service } = await getOpsContext();
    const items = await service.failedJobs(limit);

    return NextResponse.json({
      items,
      total: items.length,
      note:
        'Retention is driver-dependent: BullMQ keeps failures for seven days, the in-memory driver only for the life of the process.',
    });
  });
}
