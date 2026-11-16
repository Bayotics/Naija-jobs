import { NextResponse } from 'next/server';
import { getResumeContext } from '@/lib/resume';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The assembled candidate intelligence profile.
 *
 * Returns the *active* version with overrides applied, plus the version history
 * so the editor can show what changed and when. Nothing here is cached: a
 * profile that changes on upload and on every correction must not be served
 * from a snapshot taken at boot.
 */
export function GET() {
  return handler(async () => {
    const { service, repository, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const profile = await service.getProfile(profileId);
    if (!profile) {
      return NextResponse.json({
        profile: null,
        versions: [],
        message: 'No documents have been processed yet.',
      });
    }

    const versions = await repository.listProfileVersions(profileId);

    return NextResponse.json({ profile, versions });
  });
}

/** Forces a rebuild — used after resolving conflicts or linking a portfolio. */
export function POST() {
  return handler(async () => {
    const { service, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const result = await service.rebuildProfile(profileId);

    return NextResponse.json({
      profileVersion: result.profile.profileVersion,
      conflictsDetected: result.conflictsDetected,
      skills: result.profile.skills.length,
      experience: result.profile.experience.length,
      quality: result.profile.quality,
    });
  });
}
