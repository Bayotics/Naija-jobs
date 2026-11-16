import { NextResponse } from 'next/server';
import { jobSourceUpdateSchema } from '@job-intel/contracts';
import { getServerContext } from '@/lib/db';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

export function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await context.params;
    const ctx = await getServerContext();
    const source = await ctx.sources.get(id);
    if (!source) return apiError(404, 'NOT_FOUND', `Source not found: ${id}`);

    const runs = await ctx.sources.listRuns(id, 20);
    return NextResponse.json({ source, runs });
  });
}

/**
 * Updates schedule, enablement, limits or connector config.
 *
 * This is how a source is calmed down or re-scheduled at 3am without a release.
 */
export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await context.params;
    const ctx = await getServerContext();
    if (!(await ctx.sources.get(id))) return apiError(404, 'NOT_FOUND', `Source not found: ${id}`);

    const patch = await parseBody(request, jobSourceUpdateSchema);
    const source = await ctx.sources.update(id, patch);

    await ctx.events.emit('SOURCE_UPDATED', {
      sourceId: id,
      message: 'Source configuration updated',
      data: { fields: Object.keys(patch) },
    });

    return NextResponse.json({ source });
  });
}

/** Soft delete: run history and discovered jobs must outlive the source. */
export function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await context.params;
    const ctx = await getServerContext();
    const source = await ctx.sources.archive(id);
    if (!source) return apiError(404, 'NOT_FOUND', `Source not found: ${id}`);

    await ctx.events.emit('SOURCE_DISABLED', {
      sourceId: id,
      severity: 'warn',
      message: 'Source archived',
    });

    return NextResponse.json({ source });
  });
}
