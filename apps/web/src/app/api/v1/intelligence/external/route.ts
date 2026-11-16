import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getResumeContext } from '@/lib/resume';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Linked public profiles.
 *
 * Only what the candidate pastes. The URL goes through the same SSRF guard as
 * every other outbound request in the system, so a link to an internal address
 * is refused by the HTTP client rather than by a check here that could be
 * forgotten.
 */
const linkSchema = z.object({
  url: z.string().trim().url().max(500),
});

export function GET() {
  return handler(async () => {
    const { repository, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const profiles = await repository.listExternalProfiles(profileId);

    return NextResponse.json({
      profiles: profiles.map((row) => ({
        provider: row.provider,
        identifier: row.identifier,
        url: row.url,
        status: row.status,
        lastFetchedAt: row.lastFetchedAt,
        lastError: row.lastError,
        skills: row.derivedSkills.length,
        payload: row.payload,
      })),
    });
  });
}

export function POST(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, linkSchema);
    const result = await service.linkExternalProfile({ candidateId: profileId, url: body.url });

    return NextResponse.json(result, { status: result.ok ? 201 : 200 });
  });
}

const unlinkSchema = z.object({
  provider: z.string().trim().max(40),
  identifier: z.string().trim().max(120),
});

export function DELETE(request: Request) {
  return handler(async () => {
    const { repository, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, unlinkSchema);
    await repository.deleteExternalProfile(profileId, body.provider, body.identifier);

    return NextResponse.json({ unlinked: true });
  });
}
