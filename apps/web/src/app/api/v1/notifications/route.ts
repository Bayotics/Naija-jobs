import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/db';
import { handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Notification history.
 *
 * Schema and channel port exist; delivery lands in prompt 17. Returns the
 * configured state so a client can tell "nothing sent yet" from "notifications
 * are switched off".
 */
export function GET() {
  return handler(async () => {
    const ctx = await getServerContext();
    const config = await ctx.config.get();

    return NextResponse.json({
      items: [],
      total: 0,
      enabled: config.notifications.enabled,
      pipelineStage: 'not_implemented',
      detail: 'Notification delivery is implemented in prompt 17.',
    });
  });
}
