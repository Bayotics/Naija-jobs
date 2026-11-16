import { NextResponse } from 'next/server';
import { z } from 'zod';
import { jobFeedbackSchema } from '@job-intel/contracts';
import { getServerContext } from '@/lib/db';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Records feedback for a job.
 *
 * Feedback is append-only: it is the training signal for the learning loop and
 * the one dataset that cannot be re-derived from sources. Actions that imply a
 * pipeline position also move the application board, in the repository.
 */
const bodySchema = jobFeedbackSchema.omit({ jobId: true });

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await context.params;
    const parsedId = z.string().uuid().safeParse(id);
    if (!parsedId.success) return apiError(400, 'VALIDATION_ERROR', 'Job id must be a UUID');

    // Validate the request before touching the database: a malformed body is
    // rejected without a round trip, and the caller gets the precise reason
    // rather than an incidental 404.
    const body = await parseBody(request, bodySchema);

    const ctx = await getServerContext();
    const profile = await ctx.profiles.getActiveProfile();
    if (!profile) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const job = await ctx.jobs.getById(parsedId.data);
    if (!job) return apiError(404, 'NOT_FOUND', `Job not found: ${parsedId.data}`);

    const recorded = await ctx.engagement.recordFeedback(profile.profileId, {
      ...body,
      jobId: parsedId.data,
    });

    await ctx.events.emit('FEEDBACK_RECORDED', {
      jobId: parsedId.data,
      message: `Feedback: ${body.action}`,
      data: { action: body.action, source: body.source },
    });

    return NextResponse.json({ feedback: recorded }, { status: 201 });
  });
}
