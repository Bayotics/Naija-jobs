import { NextResponse } from 'next/server';
import { z } from 'zod';
import { configChangeSchema } from '@job-intel/contracts';
import { getSearchConfigContext } from '@/lib/search-config';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

export function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const params = paramsSchema.safeParse(await context.params);
    if (!params.success) return apiError(400, 'BAD_REQUEST', 'Invalid profile id');

    const { service, repository, profileId } = await getSearchConfigContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const profile = await repository.getProfile(params.data.id);
    if (!profile || profile.candidateId !== profileId) {
      return apiError(404, 'NOT_FOUND', 'No such search profile');
    }

    const [config, validation, queries] = await Promise.all([
      service.getEffectiveSearchConfiguration(profileId, params.data.id),
      service.validate(params.data.id),
      service.queriesFor(profileId, params.data.id),
    ]);

    return NextResponse.json({ profile, config, validation, queries });
  });
}

/**
 * Applies changes to a profile.
 *
 * Takes a change list rather than a whole profile, so every write goes through
 * the same allowlist, validation and history path the command bar uses. A route
 * that accepted a raw profile would be a second way in, and a guard that exists
 * on only one path is one that will eventually be bypassed.
 */
const patchSchema = z.object({
  changes: z.array(configChangeSchema).min(1).max(30),
  reason: z.string().max(400).nullish(),
});

export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const params = paramsSchema.safeParse(await context.params);
    if (!params.success) return apiError(400, 'BAD_REQUEST', 'Invalid profile id');

    const { service, profileId } = await getSearchConfigContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, patchSchema);

    const result = await service.applyToProfile({
      candidateId: profileId,
      profileId: params.data.id,
      changes: body.changes,
      source: 'api',
      reason: body.reason ?? null,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_FAILED', message: 'The changes were refused.' }, validation: result.validation, rejected: result.rejected },
        { status: 422 },
      );
    }

    return NextResponse.json({ profile: result.profile, validation: result.validation });
  });
}

const stateSchema = z.object({ state: z.enum(['active', 'paused', 'archived']) });

export function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const params = paramsSchema.safeParse(await context.params);
    if (!params.success) return apiError(400, 'BAD_REQUEST', 'Invalid profile id');

    const { service, profileId } = await getSearchConfigContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, stateSchema);
    await service.setProfileState(profileId, params.data.id, body.state);

    return NextResponse.json({ ok: true, state: body.state });
  });
}
