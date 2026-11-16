import { NextResponse } from 'next/server';
import { z } from 'zod';
import { EnrichmentRepository } from '@job-intel/db';
import { explainExclusion, explainMatch } from '@job-intel/candidate';
import { getServerContext } from '@/lib/db';
import { requireProfile } from '@/lib/candidate';
import { apiError, handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  jobId: z.string().uuid(),
});

/**
 * Evaluates one job against the candidate's current preferences.
 *
 * This is the endpoint that demonstrates the whole layer: it loads the *active*
 * preference version on every call, so changing a preference and re-requesting
 * the same job returns a different verdict with no restart and no deploy.
 *
 * Exposes the eligibility verdict alone. The full hybrid score lives at
 * `/api/v1/matches/[jobId]`; this endpoint stays deliberately narrow because
 * it is the one that answers "would this job be excluded, and why?" without
 * needing a stored match to exist.
 */
export function GET(request: Request) {
  return handler(async () => {
    const guard = await requireProfile();
    if (!guard.ok) return guard.response;

    const { jobId } = parseQuery(request, querySchema);
    const ctx = await getServerContext();

    const job = await ctx.jobs.getById(jobId);
    if (!job) return apiError(404, 'NOT_FOUND', `Job not found: ${jobId}`);

    // Reassembled and re-validated by the repository, so this route cannot
    // drift from the canonical enrichment shape — an earlier hand-rolled copy
    // here silently dropped the job's skills and employment types.
    const enrichment = await new EnrichmentRepository(ctx.handle.db).getEnrichment(jobId);
    if (!enrichment) {
      return apiError(
        409,
        'NOT_ENRICHED',
        'This job has not been enriched yet. Run enrichment before evaluating it.',
      );
    }

    const evaluation = await guard.service.evaluate(guard.profileId, {
      enrichment,
      job: {
        title: job.title,
        companyName: job.companyNameRaw,
        description: job.description,
      },
    });

    return NextResponse.json({
      jobId,
      title: job.title,
      company: job.companyNameRaw,
      eligible: evaluation.eligible,
      softScore: evaluation.softScore,
      profileVersion: evaluation.profileVersion,
      exclusionReasons: explainExclusion(evaluation),
      matchReasons: explainMatch(evaluation),
      /** Every dimension, so the UI can show hard vs soft explicitly. */
      outcomes: evaluation.outcomes,
    });
  });
}
