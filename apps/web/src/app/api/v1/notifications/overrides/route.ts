import { NextResponse } from 'next/server';
import { z } from 'zod';
import { OVERRIDE_ACTIONS, OVERRIDE_SUBJECTS } from '@job-intel/contracts';
import { getNotificationContext } from '@/lib/notification-intelligence';
import { apiError, handler, parseBody, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

export function GET() {
  return handler(async () => {
    const { service, profileId } = await getNotificationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    return NextResponse.json({ items: await service.listOverrides(profileId) });
  });
}

/**
 * Adds an explicit alert rule.
 *
 * "Never alert me about Company X" and "always alert me about Senior React
 * jobs" both land here. Precedence is resolved at scoring time, where a block
 * beats an allow — a mute that silently stops working is how people learn to
 * distrust every other switch.
 */
const createSchema = z.object({
  subject: z.enum(OVERRIDE_SUBJECTS),
  value: z.string().trim().min(1).max(200),
  action: z.enum(OVERRIDE_ACTIONS),
  note: z.string().max(300).nullish(),
});

export function POST(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getNotificationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, createSchema);

    await service.addOverride({
      candidateId: profileId,
      subject: body.subject,
      value: body.value,
      action: body.action,
      note: body.note ?? null,
    });

    return NextResponse.json({ items: await service.listOverrides(profileId) }, { status: 201 });
  });
}

const deleteSchema = z.object({ id: z.string().uuid() });

export function DELETE(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getNotificationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const { id } = parseQuery(request, deleteSchema);
    await service.removeOverride(profileId, id);

    return NextResponse.json({ items: await service.listOverrides(profileId) });
  });
}
