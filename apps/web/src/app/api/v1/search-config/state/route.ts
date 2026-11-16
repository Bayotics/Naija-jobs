import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSearchConfigContext } from '@/lib/search-config';
import { apiError, handler, parseBody, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Pause state, history and active overrides. */
export function GET() {
  return handler(async () => {
    const { service, repository, profileId } = await getSearchConfigContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const [state, history, overrides] = await Promise.all([
      repository.getState(profileId),
      service.history(profileId, 50),
      service.listOverrides(profileId),
    ]);

    return NextResponse.json({ state, history, overrides });
  });
}

/** Pause or resume discovery. Existing jobs are untouched either way. */
const pauseSchema = z.object({
  paused: z.boolean(),
  reason: z.string().max(300).nullish(),
});

export function PUT(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getSearchConfigContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, pauseSchema);
    const state = await service.setPaused(profileId, body.paused, body.reason ?? null);

    return NextResponse.json(state);
  });
}

/** Undo the last configuration change. */
const undoSchema = z.object({ profileId: z.string().uuid().optional() });

export function POST(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getSearchConfigContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const { profileId: target } = parseQuery(request, undoSchema);
    const result = await service.undoLast(profileId, target);

    if (!result.ok) return apiError(409, 'NOTHING_TO_UNDO', result.error);

    return NextResponse.json(result);
  });
}
