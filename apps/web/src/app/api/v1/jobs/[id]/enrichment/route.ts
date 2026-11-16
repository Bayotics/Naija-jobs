import { NextResponse } from 'next/server';
import { z } from 'zod';
import { EnrichmentRepository } from '@job-intel/db';
import { getServerContext } from '@/lib/db';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The structured record for one job.
 *
 * Returns the enrichment alongside the source job, so the link back to the
 * original posting is always visible — a structured field is only trustworthy
 * if you can see the raw text it came from.
 */
export function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await context.params;
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', 'Job id must be a UUID');

    const ctx = await getServerContext();
    const job = await ctx.jobs.getById(parsed.data);
    if (!job) return apiError(404, 'NOT_FOUND', `Job not found: ${parsed.data}`);

    const repo = new EnrichmentRepository(ctx.handle.db);
    const [enrichment, skills] = await Promise.all([
      repo.get(parsed.data),
      repo.skillsFor(parsed.data),
    ]);

    if (!enrichment) {
      return NextResponse.json({
        jobId: parsed.data,
        status: 'pending',
        detail: 'This job has not been enriched yet. POST /api/v1/enrichment to process the queue.',
        job: { id: job.id, title: job.title, company: job.companyNameRaw, sourceUrl: job.sourceUrl },
      });
    }

    return NextResponse.json({
      jobId: parsed.data,
      status: enrichment.status,
      enrichment,
      skills,
      /** Provenance: the structured record always points back to its source. */
      source: {
        sourceId: job.sourceId,
        sourceUrl: job.sourceUrl,
        rawPostingId: job.rawPostingId,
        originalTitle: job.title,
        originalCompany: job.companyNameRaw,
        firstSeenAt: job.firstSeenAt,
      },
    });
  });
}
