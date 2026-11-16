import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOpsContext } from '@/lib/ops';
import { requireRole } from '@/lib/auth';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  /** Funnel window. Everything else is fixed-window by definition. */
  funnelHours: z.coerce.number().int().min(1).max(720).default(24),
});

/**
 * The dashboard's single request.
 *
 * Overview, pipeline stages and the funnel together, because the page polls and
 * three round trips per poll is three times the load for no extra information.
 * Each section resolves independently — a failing sub-query yields an empty
 * section rather than a failed response.
 */
export function GET(request: Request) {
  return handler(async () => {
    const auth = await requireRole('viewer');
    if (!auth.ok) return auth.response;

    const { funnelHours } = parseQuery(request, querySchema);
    const { service } = await getOpsContext();

    const [overview, stages, funnel] = await Promise.all([
      service.overview(),
      service.pipelineStages().catch(() => []),
      service.funnel(funnelHours).catch(() => null),
    ]);

    return NextResponse.json({ overview, stages, funnel, actor: auth.session?.actor ?? null });
  });
}
