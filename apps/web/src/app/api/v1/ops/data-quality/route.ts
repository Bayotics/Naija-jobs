import { NextResponse } from 'next/server';
import { concerningMetrics } from '@job-intel/ops';
import { getOpsContext } from '@/lib/ops';
import { requireRole } from '@/lib/auth';
import { handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Data quality.
 *
 * `concerning` is separated from the full list on purpose: 78% of postings
 * having no salary is the world, not a defect, and a dashboard that paints it
 * red teaches its reader to ignore red.
 */
export function GET() {
  return handler(async () => {
    const auth = await requireRole('viewer');
    if (!auth.ok) return auth.response;

    const { service } = await getOpsContext();
    const metrics = await service.dataQuality();

    return NextResponse.json({ metrics, concerning: concerningMetrics(metrics) });
  });
}
