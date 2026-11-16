import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/db';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

export function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await context.params;
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', 'Job id must be a UUID');

    const ctx = await getServerContext();
    const job = await ctx.jobs.getById(parsed.data);
    if (!job) return apiError(404, 'NOT_FOUND', `Job not found: ${parsed.data}`);

    const feedback = await ctx.engagement.listFeedback(parsed.data);
    return NextResponse.json({ job, feedback });
  });
}
