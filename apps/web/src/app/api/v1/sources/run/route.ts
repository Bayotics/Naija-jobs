import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/db';
import { getDiscoveryContext } from '@/lib/discovery';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const bodySchema = z
  .object({
    /** Specific sources to run. Omit (or set `all`) to run every enabled one. */
    sourceIds: z.array(z.string().min(1)).optional(),
    all: z.boolean().default(false),
    maxItems: z.number().int().min(1).max(5000).optional(),
    timeBudgetMs: z.number().int().min(1_000).max(600_000).optional(),
    async: z.boolean().default(false),
  })
  .refine((v) => v.all || (v.sourceIds && v.sourceIds.length > 0), {
    message: 'Provide sourceIds, or set all=true',
  });

/**
 * Runs multiple sources, or every enabled one (Part 17).
 *
 * The runner isolates each source, so a batch always returns a result per
 * source — including failures — rather than aborting on the first problem.
 */
export function POST(request: Request) {
  return handler(async () => {
    const ctx = await getServerContext();
    const body = await parseBody(request, bodySchema);
    const { runner } = await getDiscoveryContext();

    let sourceIds = body.sourceIds ?? [];
    if (body.all) {
      const enabled = await ctx.sources.list({ enabledOnly: true });
      sourceIds = enabled.map((s) => s.id);
    } else {
      const missing: string[] = [];
      for (const id of sourceIds) {
        if (!(await ctx.sources.get(id))) missing.push(id);
      }
      if (missing.length > 0) {
        return apiError(404, 'NOT_FOUND', `Unknown source(s): ${missing.join(', ')}`);
      }
    }

    if (sourceIds.length === 0) {
      return NextResponse.json({ results: [], detail: 'No enabled sources to run.' });
    }

    const options = {
      trigger: 'manual' as const,
      ...(body.maxItems !== undefined ? { maxItems: body.maxItems } : {}),
      ...(body.timeBudgetMs !== undefined ? { timeBudgetMs: body.timeBudgetMs } : {}),
    };

    if (body.async) {
      void runner.runMany(sourceIds, options).catch((error: unknown) => {
        ctx.logger.error('Background batch run failed', { err: error });
      });
      return NextResponse.json({ status: 'started', sourceIds }, { status: 202 });
    }

    const results = await runner.runMany(sourceIds, options);
    const totals = results.reduce(
      (acc, r) => ({
        discovered: acc.discovered + r.stats.jobsDiscovered,
        created: acc.created + r.stats.jobsAccepted,
        updated: acc.updated + r.stats.jobsUpdated,
        duplicates: acc.duplicates + r.stats.jobsDuplicated,
        rejected: acc.rejected + r.stats.jobsRejected,
      }),
      { discovered: 0, created: 0, updated: 0, duplicates: 0, rejected: 0 },
    );

    return NextResponse.json({ results, totals });
  });
}
