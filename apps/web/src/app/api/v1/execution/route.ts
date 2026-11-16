import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getExecutionContext } from '@/lib/execution';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Queue depth, worker fleet, schedules, dead letters and system health. */
export function GET() {
  return handler(async () => {
    const { queue, deadLetters, workers, scheduler, health } = await getExecutionContext();

    const [report, breakdown, fleet, dl, schedules, lag] = await Promise.all([
      health.check(),
      queue.depthBreakdown(),
      workers.list(),
      deadLetters.summary(),
      scheduler.listSchedules({}),
      scheduler.lagSeconds(),
    ]);

    return NextResponse.json({
      health: { status: report.status, summary: report.summary, components: report.components },
      queue: breakdown,
      schedulerLagSeconds: lag,
      workers: fleet.map((worker) => ({
        id: worker.id,
        state: worker.state,
        concurrency: worker.concurrency,
        tasksProcessed: worker.tasksProcessed,
        tasksFailed: worker.tasksFailed,
        lastHeartbeatAt: worker.lastHeartbeatAt,
      })),
      schedules: schedules.map((entry) => ({
        scheduleId: entry.scheduleId,
        taskType: entry.taskType,
        profileId: entry.profileId,
        sourceId: entry.sourceId,
        intervalMinutes: entry.intervalMinutes,
        enabled: entry.enabled,
        nextRunAt: entry.nextRunAt,
        lastRunAt: entry.lastRunAt,
        misfirePolicy: entry.misfirePolicy,
      })),
      deadLetters: dl,
    });
  });
}

/**
 * Dead-letter administration.
 *
 * Retry and cancel only. There is deliberately no "retry everything" — replaying
 * a whole dead-letter queue against an unfixed cause is the most reliable way to
 * turn a contained failure into an outage, and the bulk path is capped in the
 * queue itself regardless of what is asked for here.
 */
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry'), id: z.string().uuid() }),
  z.object({ action: z.literal('cancel'), id: z.string().uuid() }),
  z.object({
    action: z.literal('retryMany'),
    limit: z.number().int().min(1).max(100).default(20),
    type: z.string().max(60).optional(),
    sourceId: z.string().max(120).optional(),
  }),
]);

export function POST(request: Request) {
  return handler(async () => {
    const body = await parseBody(request, actionSchema);
    const { deadLetters } = await getExecutionContext();

    if (body.action === 'retry') {
      const result = await deadLetters.retry(body.id);
      if (!result.ok) return apiError(409, 'RETRY_REFUSED', result.reason);
      return NextResponse.json(result);
    }

    if (body.action === 'cancel') {
      const cancelled = await deadLetters.cancel(body.id);
      if (!cancelled) return apiError(404, 'NOT_FOUND', 'No open dead-letter entry with that id.');
      return NextResponse.json({ ok: true });
    }

    const result = await deadLetters.retryMany(
      {
        ...(body.type ? { type: body.type as never } : {}),
        ...(body.sourceId ? { sourceId: body.sourceId } : {}),
      },
      body.limit,
    );

    return NextResponse.json(result);
  });
}
