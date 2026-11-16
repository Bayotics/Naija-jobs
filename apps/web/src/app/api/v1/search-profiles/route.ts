import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSearchConfigContext } from '@/lib/search-config';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Every search profile, with its resolved configuration. */
export function GET() {
  return handler(async () => {
    const { service, profileId } = await getSearchConfigContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const [profiles, configs, overrides] = await Promise.all([
      service.listProfiles(profileId),
      service.allEffectiveConfigurations(profileId),
      service.listOverrides(profileId, true),
    ]);

    return NextResponse.json({ profiles, configs, overrides });
  });
}

const createSchema = z.object({
  profileName: z.string().trim().min(1).max(120),
  description: z.string().max(400).nullish(),
});

export function POST(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getSearchConfigContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, createSchema);

    const result = await service.createProfile({
      candidateId: profileId,
      profileName: body.profileName,
      ...(body.description ? { seed: { description: body.description } } : {}),
    });

    if (!result.ok) {
      return apiError(422, 'INVALID_PROFILE', result.validation.issues[0]?.message ?? 'Invalid.');
    }

    return NextResponse.json(result.profile, { status: 201 });
  });
}
