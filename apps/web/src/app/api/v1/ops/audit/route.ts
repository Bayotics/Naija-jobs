import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AUDIT_ACTIONS } from '@job-intel/contracts';
import { getOpsContext } from '@/lib/ops';
import { requireRole } from '@/lib/auth';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.enum(AUDIT_ACTIONS).optional(),
});

/** The audit log. Admin-only: it records who did what, which is itself sensitive. */
export function GET(request: Request) {
  return handler(async () => {
    const auth = await requireRole('admin');
    if (!auth.ok) return auth.response;

    const query = parseQuery(request, querySchema);
    const { repository } = await getOpsContext();
    const entries = await repository.listAudit(query);

    return NextResponse.json({
      items: entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        actor: entry.actor,
        target: entry.target,
        before: entry.before,
        after: entry.after,
        reason: entry.reason,
        requestId: entry.requestId,
        occurredAt: entry.occurredAt,
      })),
      total: entries.length,
    });
  });
}
