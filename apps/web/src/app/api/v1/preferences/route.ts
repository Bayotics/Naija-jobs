import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  exclusionPreferencesSchema,
  jobPreferencesSchema,
  locationPreferenceSchema,
  salaryExpectationSchema,
} from '@job-intel/contracts';
import { getServerContext } from '@/lib/db';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Preferences-only view of the profile.
 *
 * A narrower surface than /profile on purpose: this is the endpoint an
 * automation or script uses to flip a single setting, and it should not require
 * sending identity data to do so.
 */
const preferencesPatchSchema = z
  .object({
    preferences: jobPreferencesSchema
      .omit({ location: true, salary: true })
      .partial()
      .extend({
        location: locationPreferenceSchema.partial().optional(),
        salary: salaryExpectationSchema.partial().optional(),
      })
      .optional(),
    exclusions: exclusionPreferencesSchema.partial().optional(),
    changeSummary: z.string().trim().max(500).optional(),
  })
  .refine((v) => Boolean(v.preferences ?? v.exclusions), {
    message: 'Provide at least one of: preferences, exclusions',
  });

export function GET() {
  return handler(async () => {
    const ctx = await getServerContext();
    const profile = await ctx.profiles.getActiveProfile();
    if (!profile) return apiError(404, 'NOT_FOUND', 'No active candidate profile');

    return NextResponse.json({
      version: profile.version,
      preferences: profile.payload.preferences,
      exclusions: profile.payload.exclusions,
      custom: profile.payload.custom,
    });
  });
}

/**
 * Example — no code change, no redeploy:
 *   curl -X PATCH localhost:3000/api/v1/preferences \
 *     -H 'content-type: application/json' \
 *     -d '{"preferences":{"salary":{"minimum":90000}}}'
 */
export function PATCH(request: Request) {
  return handler(async () => {
    const ctx = await getServerContext();
    const patch = await parseBody(request, preferencesPatchSchema);
    const updated = await ctx.profiles.applyPatch(patch);

    await ctx.events.emit('PROFILE_VERSION_ACTIVATED', {
      message: patch.changeSummary ?? 'Preferences updated',
      data: { version: updated.version },
    });

    return NextResponse.json({
      version: updated.version,
      preferences: updated.payload.preferences,
      exclusions: updated.payload.exclusions,
    });
  });
}
