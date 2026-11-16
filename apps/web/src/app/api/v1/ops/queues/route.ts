import { NextResponse } from 'next/server';
import { getOpsContext } from '@/lib/ops';
import { requireRole } from '@/lib/auth';
import { handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Queue depths.
 *
 * A queue whose counts cannot be read is reported as `unavailable` rather than
 * omitted: a missing row reads as "no work", which is the opposite of what an
 * unreachable Redis means.
 */
export function GET() {
  return handler(async () => {
    const auth = await requireRole('viewer');
    if (!auth.ok) return auth.response;

    const { service } = await getOpsContext();
    const counts = await service.queueCounts();

    const items = [...counts.entries()].map(([name, value]) => ({
      name,
      ...value,
      backlog: value.waiting + value.delayed,
      status: value.failed > 0 ? 'degraded' : value.waiting > 1000 ? 'degraded' : 'healthy',
    }));

    return NextResponse.json({
      items,
      totalBacklog: items.reduce((sum, item) => sum + item.backlog, 0),
      totalFailed: items.reduce((sum, item) => sum + item.failed, 0),
    });
  });
}
