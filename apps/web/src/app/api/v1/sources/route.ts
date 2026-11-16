import { NextResponse } from 'next/server';
import { jobSourceCreateSchema } from '@job-intel/contracts';
import { getServerContext } from '@/lib/db';
import { handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

export function GET() {
  return handler(async () => {
    const ctx = await getServerContext();
    const sources = await ctx.sources.list({ includeArchived: false });

    // Report which declared credentials are missing — by NAME only, never value.
    const withReadiness = sources.map((source) => ({
      ...source,
      missingCredentials: source.credentialRefs.filter(
        (name) => !process.env[name] || process.env[name]?.trim() === '',
      ),
    }));

    return NextResponse.json({ items: withReadiness, total: withReadiness.length });
  });
}

/** Registers a source. Adding a source is a database row, never a deploy. */
export function POST(request: Request) {
  return handler(async () => {
    const ctx = await getServerContext();
    const input = await parseBody(request, jobSourceCreateSchema);
    const source = await ctx.sources.upsert(input);

    await ctx.events.emit('SOURCE_REGISTERED', {
      sourceId: input.id,
      message: `Source registered: ${input.displayName}`,
      data: { connectorId: input.connectorId, accessTier: input.accessTier },
    });

    return NextResponse.json({ source }, { status: 201 });
  });
}
