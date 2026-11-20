import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/db';
import { getDiscoveryContext } from '@/lib/discovery';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';
/** Discovery is slow by nature; allow the platform's maximum. */
export const maxDuration = 300;

const bodySchema = z
  .object({
    /** Caps items processed, for a quick smoke test. */
    maxItems: z.number().int().min(1).max(5000).optional(),
    timeBudgetMs: z.number().int().min(1_000).max(600_000).optional(),
    /** Returns immediately with a run id instead of waiting. */
    async: z.boolean().default(false),
  })
  .prefault({});

/**
 * Manually triggers one source (Part 17).
 *
 * Synchronous by default because that is what makes this useful during
 * development — you get the statistics back in the response. `async: true`
 * starts the run and returns immediately for long crawls.
 */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await context.params;
    const ctx = await getServerContext();

    const source = await ctx.sources.get(id);
    if (!source) return apiError(404, 'NOT_FOUND', `Source not found: ${id}`);

    const body = await parseBody(request, bodySchema);
    const { runner } = await getDiscoveryContext();

    const options = {
      trigger: 'manual' as const,
      ...(body.maxItems !== undefined ? { maxItems: body.maxItems } : {}),
      ...(body.timeBudgetMs !== undefined ? { timeBudgetMs: body.timeBudgetMs } : {}),
    };

    if (body.async) {
      // Deliberately not awaited. The run records its own outcome, so nothing
      // is lost if the request has already returned.
      void runner.run(id, options).catch((error: unknown) => {
        ctx.logger.error('Background source run failed', { err: error, sourceId: id });
      });
      return NextResponse.json(
        { sourceId: id, status: 'started', detail: 'Poll /api/v1/source-runs?sourceId=… for the outcome.' },
        { status: 202 },
      );
    }

    const result = await runner.run(id, options);
    return NextResponse.json(result, { status: result.status === 'failed' ? 207 : 200 });
  });
}
