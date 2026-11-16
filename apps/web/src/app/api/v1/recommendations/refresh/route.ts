import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRecommendationProfile } from '@/lib/recommendations';
import { handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  /** Run deduplication over recently-changed jobs first. */
  deduplicate: z.boolean().default(false),
  /** Recompute the per-job signals ranking reads. */
  refreshSignals: z.boolean().default(true),
  signalLimit: z.number().int().min(1).max(5000).default(1000),
  reason: z.string().trim().max(200).default('manual refresh'),
});

/**
 * Runs the pipeline stages and republishes the ranking.
 *
 * Bounded and inline: this deployment's web and worker share a database and the
 * operator triggering a refresh wants the result. The bound is the safety
 * valve — an unbounded pass over a growing corpus is exactly the request that
 * times out halfway and leaves a half-updated list.
 *
 * URL verification is deliberately absent; it makes outbound requests that must
 * honour robots.txt and per-domain rate limits, which belongs in the worker
 * (`reverifyHighValueJob`), not inside an HTTP request.
 */
export function POST(request: Request) {
  return handler(async () => {
    const guard = await requireRecommendationProfile();
    if (!guard.ok) return guard.response;

    const body = await parseBody(request, bodySchema);
    const stages: Record<string, unknown> = {};

    if (body.deduplicate) {
      const pending = await guard.repository.findJobsNeedingSignals({ limit: body.signalLimit });
      stages.deduplication = await guard.service.deduplicate(pending);
    }

    if (body.refreshSignals) {
      stages.signals = await guard.service.refreshSignals({
        limit: body.signalLimit,
        staleAfterHours: 0,
      });
    }

    const ranking = await guard.service.rank(guard.profileId);
    return NextResponse.json({ reason: body.reason, stages, ranking });
  });
}
