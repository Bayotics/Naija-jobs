import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/db';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  sourceId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Discovery run history — powers the admin dashboard's source health view. */
export function GET(request: Request) {
  return handler(async () => {
    const ctx = await getServerContext();
    const query = parseQuery(request, querySchema);
    const runs = await ctx.sources.listRuns(query.sourceId, query.limit);

    return NextResponse.json({ items: runs, total: runs.length });
  });
}
