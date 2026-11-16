import { NextResponse } from 'next/server';
import { requireProfile } from '@/lib/candidate';
import { handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Preference history.
 *
 * Returns both the version list and the field-level change log: the first
 * answers "what were my preferences in August", the second "what exactly did I
 * change and when". Explaining an old match needs both.
 */
export function GET() {
  return handler(async () => {
    const guard = await requireProfile();
    if (!guard.ok) return guard.response;

    const [versions, changes] = await Promise.all([
      guard.repository.listPreferenceVersions(guard.profileId),
      guard.repository.listPreferenceChanges(guard.profileId),
    ]);

    return NextResponse.json({
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        isActive: v.isActive,
        changeSummary: v.changeSummary,
        createdAt: v.createdAt,
      })),
      changes,
    });
  });
}
