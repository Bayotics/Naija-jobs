import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/db';
import { requireMatchingProfile } from '@/lib/matching';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ jobId: z.string().uuid() });

/**
 * One match, in full.
 *
 * Returns the whole trace deliberately. "Why did this score 72?" is the
 * question the candidate will actually ask, and it cannot be answered from a
 * number — it needs the per-dimension scores, the weights that were in force,
 * the constraint results including the unresolved ones, and which versions of
 * the profile, preferences and enrichment produced it.
 */
export function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  return handler(async () => {
    const guard = await requireMatchingProfile();
    if (!guard.ok) return guard.response;

    const { jobId } = paramsSchema.parse(await context.params);
    const match = await guard.matches.get(jobId, guard.profileId);
    if (!match) {
      return apiError(
        404,
        'NOT_MATCHED',
        'This job has not been matched for you yet. Trigger a recalculation first.',
      );
    }

    const ctx = await getServerContext();
    const job = await ctx.jobs.getById(jobId);
    const history = await guard.matches.history(jobId, guard.profileId, 10);

    return NextResponse.json({
      job: job
        ? {
            id: job.id,
            title: job.title,
            company: job.company?.canonicalName ?? job.companyNameRaw,
            sourceUrl: job.sourceUrl,
            applyUrl: job.applyUrl,
            postedAt: job.postedAt,
          }
        : null,
      match: {
        score: match.overallScore,
        confidence: match.confidence,
        recommendation: match.recommendation,
        eligible: match.eligible,
        explanation: match.explanation,
        constraints: match.hardConstraintResult,
        componentScores: match.componentScores,
        skillMatches: match.skillMatches,
        matchedRequirements: match.matchedRequirements,
        missingRequirements: match.missingRequirements,
        concerns: match.concerns,
        positiveSignals: match.positiveSignals,
        negativeSignals: match.negativeSignals,
        computedAt: match.computedAt,
      },
      trace: match.trace,
      /** So "this used to be a strong match" is answerable, not just felt. */
      history,
      llmUsage: match.llmUsage,
    });
  });
}
