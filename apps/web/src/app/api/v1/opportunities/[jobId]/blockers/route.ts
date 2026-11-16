import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getApplicationContext } from '@/lib/application';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ jobId: z.string().uuid() });

/**
 * Acknowledging or restoring a blocker.
 *
 * `scope: 'global'` records that the blocker never applies to this candidate
 * anywhere — someone confirming they hold US work authorisation is telling us
 * about themselves, not about one posting, and making them repeat it on every
 * job trains them to ignore the control.
 */
const bodySchema = z.object({
  blockerId: z.string().min(1).max(80),
  acknowledged: z.boolean(),
  scope: z.enum(['job', 'global']).default('job'),
  note: z.string().max(300).nullish(),
});

export function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  return handler(async () => {
    const params = paramsSchema.safeParse(await context.params);
    if (!params.success) return apiError(400, 'BAD_REQUEST', 'Invalid job id');

    const { service, repository, profileId } = await getApplicationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, bodySchema);
    const jobId = body.scope === 'global' ? null : params.data.jobId;

    if (body.acknowledged) {
      await repository.acknowledgeBlocker({
        candidateId: profileId,
        jobId,
        blockerId: body.blockerId,
        note: body.note ?? null,
      });
    } else {
      await repository.unacknowledgeBlocker({
        candidateId: profileId,
        jobId,
        blockerId: body.blockerId,
      });
    }

    // Recompute immediately: the whole point is to see the verdict change.
    const { intelligence } = await service.analyse(profileId, params.data.jobId);
    return NextResponse.json(intelligence);
  });
}
