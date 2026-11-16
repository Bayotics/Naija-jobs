import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireMatchingProfile } from '@/lib/matching';
import { handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  /** Omit to rescore everything for the candidate. */
  jobId: z.string().uuid().optional(),
  reason: z.string().trim().max(200).default('manual recalculation'),
  /** Rescore even matches whose recorded input versions are still current. */
  force: z.boolean().default(false),
  limit: z.number().int().min(1).max(2000).optional(),
});

/**
 * Recomputes matches.
 *
 * Runs inline with a bounded limit rather than enqueueing, because this
 * deployment's web and worker processes share a database and the operator
 * triggering a rescore wants to see the result. The bound is the safety valve:
 * an unbounded rescore of a growing corpus is exactly the request that would
 * time out halfway and leave the candidate with a half-updated list.
 *
 * The durable path for large or automatic recalculation is
 * `MatchingQueue.recalculateCandidateMatches`, which the worker consumes.
 */
export function POST(request: Request) {
  return handler(async () => {
    const guard = await requireMatchingProfile();
    if (!guard.ok) return guard.response;

    const body = await parseBody(request, bodySchema);

    if (body.jobId) {
      const match = await guard.service.matchJob(guard.profileId, body.jobId, body.reason);
      return NextResponse.json({
        scope: 'job',
        jobId: body.jobId,
        score: match.overallScore,
        confidence: match.confidence,
        recommendation: match.recommendation,
        eligible: match.eligible,
        explanation: match.explanation,
      });
    }

    const result = await guard.service.matchAll(guard.profileId, {
      force: body.force,
      reason: body.reason,
      limit: body.limit ?? 500,
    });

    return NextResponse.json({ scope: 'candidate', ...result });
  });
}
