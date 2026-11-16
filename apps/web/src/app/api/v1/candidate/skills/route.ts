import { NextResponse } from 'next/server';
import { candidateSkillEntrySchema } from '@job-intel/contracts';
import { requireProfile } from '@/lib/candidate';
import { handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

const bodySchema = candidateSkillEntrySchema.array().max(300);

export function GET() {
  return handler(async () => {
    const guard = await requireProfile();
    if (!guard.ok) return guard.response;
    const skills = await guard.repository.listSkills(guard.profileId);
    return NextResponse.json({ skills, total: skills.length });
  });
}

/**
 * Replaces the skill set.
 *
 * Whole-set replacement rather than merge: a skill the candidate deleted must
 * disappear, and a merge would silently keep it.
 */
export function PUT(request: Request) {
  return handler(async () => {
    const guard = await requireProfile();
    if (!guard.ok) return guard.response;

    const entries = await parseBody(request, bodySchema);
    const count = await guard.repository.replaceSkills(guard.profileId, entries);

    // Skills feed the canonical profile text, so the embedding is now stale.
    const canonical = await guard.service.refreshCanonicalProfile(guard.profileId);

    return NextResponse.json({
      saved: count,
      embedding: { stale: canonical.stale, reason: canonical.reason, hash: canonical.hash },
    });
  });
}
