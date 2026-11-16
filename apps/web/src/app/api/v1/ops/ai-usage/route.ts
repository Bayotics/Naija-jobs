import { NextResponse } from 'next/server';
import { z } from 'zod';
import { budgetStatus } from '@job-intel/ops';
import { getOpsContext } from '@/lib/ops';
import { requireRole } from '@/lib/auth';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
});

/**
 * AI usage and cost.
 *
 * `unpricedModels` is returned alongside the totals: a model with no configured
 * rate contributes zero to the cost, and a dashboard that showed the total
 * without saying so would be quietly understating the bill.
 */
export function GET(request: Request) {
  return handler(async () => {
    const auth = await requireRole('viewer');
    if (!auth.ok) return auth.response;

    const { windowHours } = parseQuery(request, querySchema);
    const { service, repository } = await getOpsContext();

    const [summary, unpriced] = await Promise.all([
      service.aiCost(windowHours),
      repository.unpricedModels().catch(() => [] as string[]),
    ]);

    const today = summary.byDay[summary.byDay.length - 1]?.costUsd ?? 0;

    return NextResponse.json({
      summary,
      budget: budgetStatus(today, summary.dailyBudgetUsd),
      unpricedModels: unpriced,
      windowHours,
    });
  });
}
