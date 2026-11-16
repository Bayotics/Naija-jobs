import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRecommendationProfile } from '@/lib/recommendations';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ jobId: z.string().uuid() });

/**
 * One recommendation, in full.
 *
 * Returns the whole factor breakdown, every derived signal and the notification
 * verdict. "Why is this ranked #1?" is a question about arithmetic, and it
 * cannot be answered from a score — it needs the factors, their weights, the
 * diversity penalty and the caveats that survived into the explanation.
 */
export function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  return handler(async () => {
    const guard = await requireRecommendationProfile();
    if (!guard.ok) return guard.response;

    const { jobId } = paramsSchema.parse(await context.params);
    const row = await guard.repository.getRecommendation(guard.profileId, jobId);
    if (!row) {
      return apiError(
        404,
        'NOT_RANKED',
        'This job has not been ranked for you yet. Trigger a refresh first.',
      );
    }

    const [canonical, verification] = await Promise.all([
      guard.repository.getCanonicalFor(jobId),
      guard.repository.latestVerification(jobId),
    ]);

    return NextResponse.json({
      job: {
        id: row.job.id,
        title: row.job.title,
        company: row.job.companyNameRaw,
        sourceId: row.job.sourceId,
        sourceUrl: row.job.sourceUrl,
        applyUrl: row.job.applyUrl,
        postedAt: row.job.postedAt,
        firstSeenAt: row.job.firstSeenAt,
        lastSeenAt: row.job.lastSeenAt,
      },
      recommendation: {
        rank: row.recommendation.rank,
        tier: row.recommendation.tier,
        finalScore: row.recommendation.finalScore,
        rawScore: row.recommendation.rawScore,
        calibratedScore: row.recommendation.calibratedScore,
        diversityPenalty: row.recommendation.diversityPenalty,
        // Copied from the match and never modified by ranking.
        matchScore: row.recommendation.matchScore,
        matchConfidence: row.recommendation.matchConfidence,
        factors: row.recommendation.score.factors,
        weightsUsed: row.recommendation.score.weightsUsed,
        explanation: row.recommendation.rankExplanation,
        reasons: row.recommendation.rankReasons,
        notificationEligible: row.recommendation.notificationEligible,
        notificationBlockers: row.recommendation.notificationBlockers,
        exposure: row.recommendation.exposure,
        computedAt: row.recommendation.computedAt,
      },
      signals: row.signals
        ? {
            quality: row.signals.quality,
            freshness: row.signals.freshness,
            lifecycle: row.signals.lifecycle,
            scam: row.signals.scam,
            repost: row.signals.repost,
            sourceAuthority: row.signals.sourceAuthority,
            computedAt: row.signals.computedAt,
          }
        : null,
      duplicateOf: canonical,
      lastVerification: verification,
    });
  });
}
