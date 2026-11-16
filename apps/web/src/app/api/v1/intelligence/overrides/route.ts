import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getResumeContext } from '@/lib/resume';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Manual corrections.
 *
 * A correction outranks every extraction, permanently, and survives re-upload.
 * That is the whole contract: someone who fixes a mis-parsed job title once
 * should never have to fix it again.
 *
 * The path is constrained to a dotted identifier form rather than accepted as
 * free text — an unconstrained path into a nested object is a prototype
 * pollution vector, and `__proto__` is explicitly refused.
 */
const overrideSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'Path must be dotted identifiers'),
  value: z.unknown(),
  previousValue: z.unknown().optional(),
  note: z.string().trim().max(400).nullable().default(null),
});

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function GET() {
  return handler(async () => {
    const { repository, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    return NextResponse.json({ overrides: await repository.listOverrides(profileId) });
  });
}

export function POST(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, overrideSchema);

    if (body.path.split('.').some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
      return apiError(400, 'INVALID_PATH', 'That path is not writable.');
    }

    const override = await service.override({
      candidateId: profileId,
      path: body.path,
      value: body.value,
      previousValue: body.previousValue ?? null,
      note: body.note,
    });

    const rebuilt = await service.rebuildProfile(profileId);

    return NextResponse.json({
      override: { id: override.id, path: override.path, origin: override.origin },
      profileVersion: rebuilt.profile.profileVersion,
    });
  });
}

const deleteSchema = z.object({ path: z.string().trim().min(1).max(200) });

export function DELETE(request: Request) {
  return handler(async () => {
    const { repository, service, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, deleteSchema);
    await repository.deleteOverride(profileId, body.path);
    const rebuilt = await service.rebuildProfile(profileId);

    return NextResponse.json({
      deleted: true,
      profileVersion: rebuilt.profile.profileVersion,
    });
  });
}
