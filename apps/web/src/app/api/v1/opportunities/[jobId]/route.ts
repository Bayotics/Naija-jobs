import { NextResponse } from 'next/server';
import { z } from 'zod';
import { OPPORTUNITY_STATES } from '@job-intel/contracts';
import { getApplicationContext } from '@/lib/application';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ jobId: z.string().uuid() });

/**
 * The full analysis for one job.
 *
 * Recomputed on demand when nothing is stored, so the page is never blank
 * because a background run has not caught up yet.
 */
export function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  return handler(async () => {
    const params = paramsSchema.safeParse(await context.params);
    if (!params.success) return apiError(400, 'BAD_REQUEST', 'Invalid job id');

    const { service, profileId } = await getApplicationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const stored = await service.intelligenceFor(profileId, params.data.jobId);
    if (stored) return NextResponse.json(stored);

    const { intelligence } = await service.analyse(profileId, params.data.jobId);
    return NextResponse.json(intelligence);
  });
}

/**
 * A person's decision about an opportunity.
 *
 * The only route that advances the workflow past RECOMMENDED. It never records
 * that an application was submitted on the candidate's behalf — moving to
 * APPLIED means "I applied", which the candidate is asserting, not the system.
 */
const decisionSchema = z.object({
  state: z.enum(OPPORTUNITY_STATES),
  note: z.string().max(600).nullish(),
});

export function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  return handler(async () => {
    const params = paramsSchema.safeParse(await context.params);
    if (!params.success) return apiError(400, 'BAD_REQUEST', 'Invalid job id');

    const { service, profileId } = await getApplicationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, decisionSchema);

    const result = await service.decide({
      candidateId: profileId,
      jobId: params.data.jobId,
      to: body.state,
      note: body.note ?? null,
    });

    if (!result.ok) return apiError(409, 'INVALID_TRANSITION', result.error);

    return NextResponse.json(result.opportunity);
  });
}
