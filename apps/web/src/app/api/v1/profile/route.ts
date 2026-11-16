import { NextResponse } from 'next/server';
import {
  candidateProfilePatchSchema,
  candidateProfilePayloadSchema,
} from '@job-intel/contracts';
import { getServerContext } from '@/lib/db';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Current active profile. */
export function GET() {
  return handler(async () => {
    const ctx = await getServerContext();
    const profile = await ctx.profiles.getActiveProfile();
    if (!profile) {
      return apiError(404, 'NOT_FOUND', 'No active candidate profile. Create one with POST.');
    }
    return NextResponse.json({
      profileId: profile.profileId,
      versionId: profile.versionId,
      version: profile.version,
      payload: profile.payload,
    });
  });
}

/** Creates the initial profile. Idempotent-ish: refuses if one already exists. */
export function POST(request: Request) {
  return handler(async () => {
    const ctx = await getServerContext();
    if (await ctx.profiles.getActiveProfile()) {
      return apiError(409, 'ALREADY_EXISTS', 'A candidate profile already exists. Use PATCH.');
    }
    const payload = await parseBody(request, candidateProfilePayloadSchema);
    const created = await ctx.profiles.createProfile({ payload });
    await ctx.events.emit('PROFILE_VERSION_CREATED', {
      message: 'Initial candidate profile created',
      data: { version: created.version },
    });
    return NextResponse.json({ version: created.version, payload: created.payload }, { status: 201 });
  });
}

/**
 * Applies a partial update as a new active profile version.
 *
 * This is the "change a preference without touching code" path: validate,
 * version, activate. The matching engine reads the active version on its next
 * evaluation, so the change is live immediately.
 */
export function PATCH(request: Request) {
  return handler(async () => {
    const ctx = await getServerContext();
    const patch = await parseBody(request, candidateProfilePatchSchema);
    const updated = await ctx.profiles.applyPatch(patch);

    await ctx.events.emit('PROFILE_VERSION_ACTIVATED', {
      message: patch.changeSummary ?? 'Profile updated',
      data: { version: updated.version },
    });

    return NextResponse.json({
      version: updated.version,
      versionId: updated.versionId,
      payload: updated.payload,
    });
  });
}
