import { NextResponse } from 'next/server';
import { jobListQuerySchema } from '@job-intel/contracts';
import { getServerContext } from '@/lib/db';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handler(async () => {
    const ctx = await getServerContext();
    const query = parseQuery(request, jobListQuerySchema);
    const { items, total } = await ctx.jobs.list(query);

    return NextResponse.json({
      items,
      total,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + items.length < total,
    });
  });
}
