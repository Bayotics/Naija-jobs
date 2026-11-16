import { NextResponse } from 'next/server';
import { z } from 'zod';
import { EnrichmentRepository } from '@job-intel/db';
import { EnrichmentRunner } from '@job-intel/discovery';
import { ENRICHMENT_VERSION } from '@job-intel/enrichment';
import { getServerContext } from '@/lib/db';
import { handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const runSchema = z
  .object({
    limit: z.number().int().min(1).max(1000).default(100),
    jobIds: z.array(z.string().uuid()).optional(),
    /** Re-enrich even jobs already at the current extractor version. */
    force: z.boolean().default(false),
    async: z.boolean().default(false),
    ai: z
      .object({
        enabled: z.boolean().default(false),
        minDescriptionLength: z.number().int().min(0).max(50_000).optional(),
        maxCallsPerRun: z.number().int().min(0).max(1000).optional(),
      })
      .optional(),
  })
  .default({});

/** Enrichment status and throughput (Part 24). */
export function GET() {
  return handler(async () => {
    const ctx = await getServerContext();
    const repo = new EnrichmentRepository(ctx.handle.db);
    const [stats, topSkills] = await Promise.all([
      repo.stats(ENRICHMENT_VERSION),
      repo.topSkills(15),
    ]);

    return NextResponse.json({
      enrichmentVersion: ENRICHMENT_VERSION,
      stats: {
        ...stats,
        // Jobs never enriched, or enriched by a superseded extractor version.
        pending: Math.max(0, stats.jobs - stats.enriched) + stats.stale,
      },
      topSkills,
    });
  });
}

/**
 * Triggers enrichment (Part 21).
 *
 * Runs off the discovery path so crawling stays fast. `async: true` returns
 * immediately for large backfills; the batch records its own outcome.
 */
export function POST(request: Request) {
  return handler(async () => {
    const ctx = await getServerContext();
    const body = await parseBody(request, runSchema);

    const runner = new EnrichmentRunner({
      enrichment: new EnrichmentRepository(ctx.handle.db),
      logger: ctx.logger,
      events: ctx.events,
    });

    const options = {
      limit: body.limit,
      force: body.force,
      ...(body.jobIds ? { jobIds: body.jobIds } : {}),
      ...(body.ai ? { aiGate: body.ai } : {}),
    };

    if (body.async) {
      void runner.run(options).catch((error: unknown) => {
        ctx.logger.error('Background enrichment failed', { err: error });
      });
      return NextResponse.json({ status: 'started', limit: body.limit }, { status: 202 });
    }

    const result = await runner.run(options);
    return NextResponse.json(result);
  });
}
