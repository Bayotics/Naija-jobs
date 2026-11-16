import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getApplicationContext } from '@/lib/application';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Applications the candidate has recorded. */
export function GET() {
  return handler(async () => {
    const { service, profileId } = await getApplicationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const items = await service.applications(profileId);
    return NextResponse.json({ items, total: items.length });
  });
}

/**
 * Records an application the candidate made.
 *
 * The candidate is the author of this record. The system did not submit
 * anything and does not claim to have — this endpoint exists so that outcomes
 * can be tracked and the recommendations calibrated against them.
 */
const recordSchema = z.object({
  jobId: z.string().uuid(),
  appliedAt: z.coerce.date(),
  documentId: z.string().uuid().nullish(),
  applicationUrl: z.string().url().max(2000).nullish(),
  coverLetterUsed: z.boolean().default(false),
  referral: z.string().max(200).nullish(),
  contactName: z.string().max(200).nullish(),
  notes: z.string().max(4000).nullish(),
});

export function POST(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getApplicationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, recordSchema);

    const record = await service.recordApplication({
      candidateId: profileId,
      jobId: body.jobId,
      appliedAt: body.appliedAt,
      documentId: body.documentId ?? null,
      applicationUrl: body.applicationUrl ?? null,
      coverLetterUsed: body.coverLetterUsed,
      referral: body.referral ?? null,
      contactName: body.contactName ?? null,
      notes: body.notes ?? null,
    });

    return NextResponse.json(record, { status: 201 });
  });
}
