import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireNotificationProfile } from '@/lib/notifications';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  /** Ask about one job specifically: "why wasn't I told about this?" */
  jobId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  sinceHours: z.coerce.number().int().min(1).max(8760).default(168),
});

/**
 * The notification decision trace.
 *
 * The endpoint that makes a deliberately-quiet system debuggable. Every
 * candidate has an outcome and a reason, so a job that never arrived can be
 * looked up rather than guessed about.
 */
export function GET(request: Request) {
  return handler(async () => {
    const guard = await requireNotificationProfile();
    if (!guard.ok) return guard.response;

    const query = parseQuery(request, querySchema);

    if (query.jobId) {
      const decisions = await guard.repository.decisionsForJob(
        guard.profileId,
        query.jobId,
        query.limit,
      );
      return NextResponse.json({
        jobId: query.jobId,
        items: decisions.map((decision) => ({
          outcome: decision.outcome,
          reason: decision.reason,
          priority: decision.priority,
          recommendationScore: decision.recommendationScore,
          matchScore: decision.matchScore,
          confidence: decision.confidence,
          deferredUntil: decision.deferredUntil,
          decidedAt: decision.decidedAt,
        })),
      });
    }

    const since = new Date(Date.now() - query.sinceHours * 3_600_000);
    const [recent, counts] = await Promise.all([
      guard.repository.recentDecisions(guard.profileId, query.limit),
      guard.repository.decisionCounts(guard.profileId, since),
    ]);

    return NextResponse.json({
      counts,
      items: recent.map((row) => ({
        jobId: row.decision.jobId,
        title: row.job?.title ?? null,
        company: row.job?.companyNameRaw ?? null,
        outcome: row.decision.outcome,
        reason: row.decision.reason,
        priority: row.decision.priority,
        recommendationScore: row.decision.recommendationScore,
        decidedAt: row.decision.decidedAt,
      })),
      windowHours: query.sinceHours,
    });
  });
}
