import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOpsContext } from '@/lib/ops';
import { requireRole } from '@/lib/auth';
import { buildJobInspection } from '@/lib/job-inspection';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ jobId: z.string().uuid() });

/**
 * The job debugger.
 *
 * Everything known about one posting, with every field labelled by origin. The
 * view model is shared with `/ops/jobs/[jobId]` so the JSON and the screen can
 * never disagree about what a model produced and what was parsed.
 */
export function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  return handler(async () => {
    const auth = await requireRole('viewer');
    if (!auth.ok) return auth.response;

    const { jobId } = paramsSchema.parse(await context.params);
    const { repository, profileId } = await getOpsContext();

    const inspection = await repository.inspectJob(jobId, profileId);
    if (!inspection) return apiError(404, 'NOT_FOUND', `Job not found: ${jobId}`);

    return NextResponse.json(buildJobInspection(inspection));
  });
}
