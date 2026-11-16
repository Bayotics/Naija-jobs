import { NextResponse } from 'next/server';
import { z } from 'zod';
import { SYSTEM_EVENTS, SYSTEM_EVENT_SEVERITIES } from '@job-intel/contracts';
import { redact } from '@job-intel/ops';
import { getOpsContext } from '@/lib/ops';
import { requireRole } from '@/lib/auth';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const csv = <S extends z.ZodTypeAny>(schema: S) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(schema.optional());

/**
 * Structured log query.
 *
 * Filters map to indexed columns on `system_events`. The brief rules out a raw
 * text viewer, and "every event for this job" needs an index rather than a grep
 * over a file that may not even be on this machine.
 */
const querySchema = z.object({
  severity: csv(z.array(z.enum(SYSTEM_EVENT_SEVERITIES))),
  name: csv(z.array(z.enum(SYSTEM_EVENTS))),
  sourceId: z.string().trim().max(120).optional(),
  jobId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  traceId: z.string().trim().max(80).optional(),
  sinceHours: z.coerce.number().int().min(1).max(24 * 90).default(24),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export function GET(request: Request) {
  return handler(async () => {
    const auth = await requireRole('viewer');
    if (!auth.ok) return auth.response;

    const query = parseQuery(request, querySchema);
    const { repository } = await getOpsContext();
    const events = await repository.queryEvents(query);

    return NextResponse.json({
      items: events.map((event) => ({
        id: event.id,
        name: event.name,
        severity: event.severity,
        message: redact(event.message),
        traceId: event.traceId,
        sourceId: event.sourceId,
        jobId: event.jobId,
        runId: event.runId,
        createdAt: event.createdAt,
      })),
      total: events.length,
      limit: query.limit,
      offset: query.offset,
    });
  });
}
