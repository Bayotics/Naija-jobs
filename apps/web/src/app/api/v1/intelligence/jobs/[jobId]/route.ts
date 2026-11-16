import { NextResponse } from 'next/server';
import { getResumeContext } from '@/lib/resume';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The candidate seen through one job.
 *
 * The requirement matrix, which experience is relevant here, what transfers,
 * what is genuinely absent, what the profile is simply silent about, and which
 * of the candidate's documents argues this role best.
 */

interface Params {
  params: Promise<{ jobId: string }>;
}

export function GET(_request: Request, { params }: Params) {
  return handler(async () => {
    const { jobId } = await params;
    const { service, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const view = await service.jobView({ candidateId: profileId, jobId });
    if (!view) {
      return apiError(
        409,
        'NO_INTELLIGENCE',
        'No candidate intelligence profile exists yet. Upload a resume first.',
      );
    }

    return NextResponse.json({ view });
  });
}
