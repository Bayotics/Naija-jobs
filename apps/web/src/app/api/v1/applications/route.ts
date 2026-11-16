import { NextResponse } from 'next/server';
import { z } from 'zod';
import { APPLICATION_STATES, applicationUpsertSchema } from '@job-intel/contracts';
import { getServerContext } from '@/lib/db';
import { apiError, handler, parseBody, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ state: z.enum(APPLICATION_STATES).optional() });

export function GET(request: Request) {
  return handler(async () => {
    const ctx = await getServerContext();
    const profile = await ctx.profiles.getActiveProfile();
    if (!profile) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const { state } = parseQuery(request, querySchema);
    const [items, counts] = await Promise.all([
      ctx.engagement.listApplications(profile.profileId, state),
      ctx.engagement.applicationCounts(profile.profileId),
    ]);

    return NextResponse.json({ items, counts, total: items.length });
  });
}

/** Upserts application state for a job — idempotent on (job, profile). */
export function PUT(request: Request) {
  return handler(async () => {
    const ctx = await getServerContext();
    const profile = await ctx.profiles.getActiveProfile();
    if (!profile) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const input = await parseBody(request, applicationUpsertSchema);
    if (!(await ctx.jobs.getById(input.jobId))) {
      return apiError(404, 'NOT_FOUND', `Job not found: ${input.jobId}`);
    }

    const application = await ctx.engagement.upsertApplication(profile.profileId, input);
    await ctx.events.emit('APPLICATION_STATE_CHANGED', {
      jobId: input.jobId,
      message: `Application state: ${input.state}`,
      data: { state: input.state },
    });

    return NextResponse.json({ application });
  });
}
