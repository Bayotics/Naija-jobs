import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireNotificationProfile } from '@/lib/notifications';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Notification history.
 *
 * Returns the delivery state alongside the event, so "was it sent?" and "did it
 * bounce?" are answerable in one request. The rendered HTML is deliberately
 * omitted — it is large, and the detail endpoint serves it when asked.
 */
export function GET(request: Request) {
  return handler(async () => {
    const guard = await requireNotificationProfile();
    if (!guard.ok) return guard.response;

    const { limit } = parseQuery(request, querySchema);
    const rows = await guard.repository.history(guard.profileId, limit);

    return NextResponse.json({
      items: rows.map((row) => ({
        eventId: row.event.id,
        type: row.event.type,
        priority: row.event.priority,
        subject: row.event.subject,
        jobCount: row.event.jobIds.length,
        jobIds: row.event.jobIds,
        createdAt: row.event.createdAt,
        delivery: row.delivery
          ? {
              id: row.delivery.id,
              status: row.delivery.status,
              recipient: row.delivery.recipient,
              attempts: row.delivery.attempts,
              maxAttempts: row.delivery.maxAttempts,
              providerId: row.delivery.providerId,
              providerMessageId: row.delivery.providerMessageId,
              sentAt: row.delivery.sentAt,
              deliveredAt: row.delivery.deliveredAt,
              failedAt: row.delivery.failedAt,
              lastError: row.delivery.lastError,
              nextAttemptAt: row.delivery.nextAttemptAt,
            }
          : null,
      })),
      total: rows.length,
    });
  });
}
