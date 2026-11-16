import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getResumeContext } from '@/lib/resume';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Conflicts between documents, and their resolution.
 *
 * The system never picks a side. This endpoint exists so the candidate can, and
 * the resolution writes an override as well as closing the conflict — otherwise
 * the next re-extraction would surface the same question again.
 */
export function GET() {
  return handler(async () => {
    const { service, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    return NextResponse.json({ conflicts: await service.listConflicts(profileId) });
  });
}

const resolveSchema = z.object({
  conflictId: z.string().uuid(),
  chosenValue: z.string().trim().max(400).nullable(),
  /** Dotted profile path the choice should be written to, when there is one. */
  path: z.string().trim().max(200).nullable().default(null),
  status: z.enum(['resolved', 'ignored']).default('resolved'),
});

export function POST(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, resolveSchema);

    const conflicts = await service.listConflicts(profileId);
    if (!conflicts.some((conflict) => conflict.id === body.conflictId)) {
      return apiError(404, 'NOT_FOUND', 'No such open conflict');
    }

    await service.resolveConflict({
      candidateId: profileId,
      conflictId: body.conflictId,
      chosenValue: body.chosenValue,
      path: body.path,
      status: body.status,
    });

    const rebuilt = await service.rebuildProfile(profileId);

    return NextResponse.json({
      resolved: true,
      profileVersion: rebuilt.profile.profileVersion,
      openConflicts: rebuilt.profile.openConflicts,
    });
  });
}
