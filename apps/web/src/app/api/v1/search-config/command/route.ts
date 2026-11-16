import { NextResponse } from 'next/server';
import { z } from 'zod';
import { configIntentSchema } from '@job-intel/contracts';
import { getSearchConfigContext } from '@/lib/search-config';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The natural-language command bar.
 *
 * Two calls by design, and the separation is the security model.
 *
 * `POST` **previews**: it parses an instruction into structured changes and
 * returns them with a preview of the resulting profile. Nothing is written.
 *
 * `PUT` **applies** an intent the user has seen and confirmed. The intent is
 * re-validated against the same allowlist here, so a client that fabricated one
 * gets no further than a client that typed it.
 *
 * Merging the two into one call would mean a misheard sentence silently
 * changing what someone's job search looks for, which is exactly what Part 34's
 * pipeline exists to prevent.
 */
const previewSchema = z.object({
  profileId: z.string().uuid(),
  instruction: z.string().trim().min(3).max(2000),
});

export function POST(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getSearchConfigContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, previewSchema);

    const preview = await service.previewInstruction({
      candidateId: profileId,
      profileId: body.profileId,
      instruction: body.instruction,
    });

    if (!preview) return apiError(404, 'NOT_FOUND', 'No such search profile');

    return NextResponse.json(preview);
  });
}

const applySchema = z.object({
  intent: configIntentSchema,
  instruction: z.string().max(2000).nullish(),
});

export function PUT(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getSearchConfigContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, applySchema);

    const result = await service.applyIntent({
      candidateId: profileId,
      intent: body.intent,
      instruction: body.instruction ?? null,
    });

    if (!result.ok) return apiError(422, 'APPLY_FAILED', result.error);

    return NextResponse.json(result);
  });
}
