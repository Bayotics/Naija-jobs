import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getNotificationContext } from '@/lib/notification-intelligence';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ jobId: z.string().uuid() });

/**
 * "Why didn't I get an alert for this job?"
 *
 * The Part 32 endpoint. A notification system that mostly stays quiet is only
 * trustworthy if each silence has an answer, and the answer has to name the
 * setting responsible — a reason without a remedy is only half of one.
 */
export function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  return handler(async () => {
    const params = paramsSchema.safeParse(await context.params);
    if (!params.success) return apiError(400, 'BAD_REQUEST', 'Invalid job id');

    const { service, profileId } = await getNotificationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    return NextResponse.json(await service.whyNoAlert(profileId, params.data.jobId));
  });
}
