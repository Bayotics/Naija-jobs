import { NextResponse } from 'next/server';
import { jobExplorerQuerySchema } from '@job-intel/contracts';
import { getOpsContext } from '@/lib/ops';
import { requireRole } from '@/lib/auth';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The job explorer.
 *
 * Filtering and pagination happen in SQL. The brief rules out loading thousands
 * of rows into the browser, and the response is capped at 100 regardless of
 * what the caller asks for — the schema enforces it, so a hand-written request
 * cannot widen it.
 */
export function GET(request: Request) {
  return handler(async () => {
    const auth = await requireRole('viewer');
    if (!auth.ok) return auth.response;

    const query = parseQuery(request, jobExplorerQuerySchema);
    const { repository, profileId } = await getOpsContext();
    const { items, total } = await repository.exploreJobs(query, profileId);

    return NextResponse.json({
      items: items.map((row) => ({
        id: row.job.id,
        title: row.job.title,
        company: row.job.companyNameRaw,
        sourceId: row.job.sourceId,
        location: [row.job.city, row.job.countryCode].filter(Boolean).join(', ') || null,
        remoteType: row.job.remoteType,
        status: row.job.status,
        salaryAnnualUsd:
          row.job.salaryNormalizedAnnualUsd === null
            ? null
            : Number(row.job.salaryNormalizedAnnualUsd),
        postedAt: row.job.postedAt,
        firstSeenAt: row.job.firstSeenAt,
        isDuplicate: row.job.jobGroupId !== null,
        lifecycle: row.signals?.lifecycleStatus ?? null,
        qualityScore: row.signals?.qualityScore ?? null,
        freshnessScore: row.signals?.freshnessScore ?? null,
        scamRisk: row.signals?.scamRisk ?? null,
        matchScore: row.match?.overallScore ?? null,
        matchEligible: row.match?.eligible ?? null,
        recommendationScore: row.recommendation?.finalScore ?? null,
        tier: row.recommendation?.tier ?? null,
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    });
  });
}
