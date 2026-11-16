import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PIPELINE_RUN_STATUSES } from '@job-intel/contracts';
import { getOpsContext } from '@/lib/ops';
import { requireRole } from '@/lib/auth';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(PIPELINE_RUN_STATUSES).optional(),
});

/** Pipeline run history. Paginated; the timeline is on the detail endpoint. */
export function GET(request: Request) {
  return handler(async () => {
    const auth = await requireRole('viewer');
    if (!auth.ok) return auth.response;

    const query = parseQuery(request, querySchema);
    const { repository } = await getOpsContext();
    const runs = await repository.listRuns(query);

    return NextResponse.json({
      items: runs.map((run) => ({
        id: run.id,
        trigger: run.trigger,
        status: run.status,
        dryRun: run.dryRun,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: run.durationMs,
        jobsDiscovered: run.jobsDiscovered,
        jobsProcessed: run.jobsProcessed,
        jobsMatched: run.jobsMatched,
        jobsRecommended: run.jobsRecommended,
        errorCount: run.errorCount,
        warningCount: run.warningCount,
        triggeredBy: run.triggeredBy,
      })),
      total: runs.length,
      limit: query.limit,
      offset: query.offset,
    });
  });
}
