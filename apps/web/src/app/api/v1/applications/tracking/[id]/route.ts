import { NextResponse } from 'next/server';
import { z } from 'zod';
import { APPLICATION_STATUSES } from '@job-intel/contracts';
import { getApplicationContext } from '@/lib/application';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

const patchSchema = z.object({
  status: z.enum(APPLICATION_STATUSES),
  note: z.string().max(600).nullish(),
  occurredAt: z.coerce.date().optional(),
});

/** Records what happened next — a reply, an interview, a rejection. */
export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const params = paramsSchema.safeParse(await context.params);
    if (!params.success) return apiError(400, 'BAD_REQUEST', 'Invalid application id');

    const { service, profileId } = await getApplicationContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const body = await parseBody(request, patchSchema);

    const record = await service.updateStatus({
      applicationId: params.data.id,
      status: body.status,
      note: body.note ?? null,
      ...(body.occurredAt ? { occurredAt: body.occurredAt } : {}),
    });

    if (!record) return apiError(404, 'NOT_FOUND', 'No such application');

    return NextResponse.json(record);
  });
}
