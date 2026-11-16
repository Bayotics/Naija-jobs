import { NextResponse } from 'next/server';
import { z } from 'zod';
import { LIFECYCLE_STATUSES, RECOMMENDATION_TIERS, TIER_ICONS } from '@job-intel/contracts';
import { requireRecommendationProfile } from '@/lib/recommendations';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * `getTopRecommendations(candidateId, options)` over HTTP.
 *
 * Every option is an enum, a uuid or a bounded number, and each maps to an
 * indexed column. Nothing here becomes a SQL fragment, so a caller cannot widen
 * the query past what the repository intends to expose.
 */
const csv = <S extends z.ZodTypeAny>(schema: S) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(schema.optional());

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  minimumScore: z.coerce.number().min(0).max(100).optional(),
  minimumConfidence: z.coerce.number().min(0).max(1).optional(),
  freshnessWindowHours: z.coerce.number().int().min(1).max(8760).optional(),
  tiers: csv(z.array(z.enum(RECOMMENDATION_TIERS))),
  lifecycleStatuses: csv(z.array(z.enum(LIFECYCLE_STATUSES))),
  countries: csv(z.array(z.string().trim().length(2))),
  sourceIds: csv(z.array(z.string().trim().max(120))),
  companyIds: csv(z.array(z.string().uuid())),
  notificationEligibleOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export function GET(request: Request) {
  return handler(async () => {
    const guard = await requireRecommendationProfile();
    if (!guard.ok) return guard.response;

    const query = parseQuery(request, querySchema);
    const rows = await guard.service.getTopRecommendations(guard.profileId, query);
    const statistics = await guard.repository.statistics(guard.profileId);

    return NextResponse.json({
      items: rows.map((row) => ({
        jobId: row.job.id,
        rank: row.recommendation.rank,
        title: row.job.title,
        company: row.job.companyNameRaw,
        sourceId: row.job.sourceId,
        applyUrl: row.job.applyUrl ?? row.job.canonicalUrl ?? row.job.sourceUrl,
        postedAt: row.job.postedAt,

        // The two numbers, side by side and never conflated.
        recommendationScore: row.recommendation.finalScore,
        matchScore: row.recommendation.matchScore,
        matchConfidence: row.recommendation.matchConfidence,

        tier: row.recommendation.tier,
        icon: TIER_ICONS[row.recommendation.tier],
        lifecycle: row.signals?.lifecycleStatus ?? 'UNKNOWN',
        qualityScore: row.signals?.qualityScore ?? null,
        freshnessScore: row.signals?.freshnessScore ?? null,
        scamRisk: row.signals?.scamRisk ?? null,

        why: row.recommendation.rankReasons.slice(0, 6),
        explanation: row.recommendation.rankExplanation,
        notificationEligible: row.recommendation.notificationEligible,
        notificationBlockers: row.recommendation.notificationBlockers,
        computedAt: row.recommendation.computedAt,
      })),
      total: statistics.total,
      notifiable: statistics.notifiable,
      byTier: statistics.byTier,
      limit: query.limit,
      offset: query.offset,
    });
  });
}
