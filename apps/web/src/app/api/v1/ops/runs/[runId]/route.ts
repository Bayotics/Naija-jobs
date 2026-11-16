import { NextResponse } from 'next/server';
import { z } from 'zod';
import { redact } from '@job-intel/ops';
import { getOpsContext } from '@/lib/ops';
import { requireRole } from '@/lib/auth';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ runId: z.string().uuid() });

/**
 * One run, in full: timeline, per-source activity and errors.
 *
 * Every error string is redacted before it leaves the server. Connector
 * failures routinely carry URLs with credentials in them, and this response
 * renders in a browser.
 */
export function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  return handler(async () => {
    const auth = await requireRole('viewer');
    if (!auth.ok) return auth.response;

    const { runId } = paramsSchema.parse(await context.params);
    const { repository } = await getOpsContext();

    const run = await repository.getRun(runId);
    if (!run) return apiError(404, 'NOT_FOUND', `Run not found: ${runId}`);

    const [sources, events] = await Promise.all([
      repository.runSourceActivity(runId),
      repository.queryEvents({ runId, limit: 200, sinceHours: 24 * 30 }),
    ]);

    return NextResponse.json({
      run: {
        ...run,
        timeline: run.timeline.map((entry) => ({ ...entry, detail: redact(entry.detail) })),
      },
      sources: sources.map((source) => ({
        ...source,
        errors: (source.errors ?? []).map((error) => ({
          ...error,
          message: redact(String((error as { message?: string }).message ?? '')),
        })),
      })),
      events: events.map((event) => ({
        id: event.id,
        name: event.name,
        severity: event.severity,
        message: redact(event.message),
        sourceId: event.sourceId,
        jobId: event.jobId,
        createdAt: event.createdAt,
      })),
    });
  });
}
