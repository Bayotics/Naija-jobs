import Link from 'next/link';
import { z } from 'zod';
import { RECOMMENDATION_TIERS, TIER_ICONS } from '@job-intel/contracts';
import { getRecommendationContext } from '@/lib/recommendations';
import { Badge, Card, EmptyState, PageHeader, Stat } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The list the candidate actually reads.
 *
 * Leads with the recommendation score but always shows the match score beside
 * it, because they answer different questions and hiding one makes the other
 * look wrong. A job ranked below a lower-matching one is not a bug, and the two
 * numbers side by side are what make that legible instead of alarming.
 */
const querySchema = z.object({
  tier: z.enum(RECOMMENDATION_TIERS).optional(),
  notifiableOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const TIER_TONE: Record<string, 'ok' | 'accent' | 'neutral' | 'warn' | 'danger'> = {
  EXCEPTIONAL: 'ok',
  HIGHLY_RECOMMENDED: 'ok',
  STRONG: 'accent',
  WORTH_CONSIDERING: 'neutral',
  LOW_PRIORITY: 'neutral',
  EXCLUDED: 'danger',
  STALE: 'warn',
};

export default async function RecommendationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = querySchema.safeParse(
    Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v] as const),
    ),
  );
  const query = parsed.success ? parsed.data : querySchema.parse({});

  const { service, repository, profileId } = await getRecommendationContext();
  if (!profileId) {
    return (
      <div className="max-w-4xl">
        <PageHeader
          title="Recommendations"
          description="What to actually look at, in order, and why."
        />
        <EmptyState
          title="No candidate profile yet"
          reason="Recommendations rank matched jobs for a stored profile. Create one first."
          action={<Link href="/profile">Create a profile</Link>}
        />
      </div>
    );
  }

  const [rows, statistics] = await Promise.all([
    service.getTopRecommendations(profileId, {
      limit: query.limit,
      ...(query.tier ? { tiers: [query.tier] } : {}),
      ...(query.notifiableOnly ? { notificationEligibleOnly: true } : {}),
    }),
    repository.statistics(profileId),
  ]);

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Recommendations"
        description="Ranked across everything available — not just how well each job matches."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Ranked" value={statistics.total} />
        <Stat
          label="Notifiable"
          value={statistics.notifiable}
          hint="passes every notification rule"
        />
        <Stat label="Average score" value={statistics.averageScore} />
        <Stat
          label="Exceptional"
          value={statistics.byTier.EXCEPTIONAL ?? 0}
          hint={`${statistics.byTier.HIGHLY_RECOMMENDED ?? 0} highly recommended`}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing ranked yet"
          reason="Jobs must be discovered, enriched and matched before they can be ranked. Run a refresh once matches exist."
        />
      ) : (
        <Card
          title={`${rows.length} recommendation${rows.length === 1 ? '' : 's'}`}
          description={query.notifiableOnly ? 'Notifiable only.' : 'Including jobs held back from notification.'}
        >
          <ol className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {rows.map((row) => {
              const rec = row.recommendation;
              return (
                <li key={row.job.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex items-baseline gap-2">
                      <span
                        className="tabular text-xs"
                        style={{ color: 'var(--muted)' }}
                      >
                        #{rec.rank}
                      </span>
                      <a
                        href={row.job.applyUrl ?? row.job.canonicalUrl ?? row.job.sourceUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-sm font-semibold hover:underline"
                      >
                        {row.job.title}
                      </a>
                    </div>

                    <div className="flex items-center gap-2">
                      <Badge tone={TIER_TONE[rec.tier] ?? 'neutral'}>
                        {TIER_ICONS[rec.tier]} {rec.tier.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                      <span className="tabular text-sm font-semibold">
                        {Math.round(rec.finalScore)}
                      </span>
                      {/* Shown beside, never instead of, the recommendation score. */}
                      <span className="tabular text-xs" style={{ color: 'var(--muted)' }}>
                        match {Math.round(rec.matchScore)}
                      </span>
                    </div>
                  </div>

                  <div className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                    {row.job.companyNameRaw} · {row.job.sourceId}
                    {row.signals ? ` · ${row.signals.lifecycleStatus.toLowerCase()}` : ''}
                  </div>

                  <p className="mt-1 text-sm">{rec.rankExplanation}</p>

                  {rec.rankReasons.length > 0 && (
                    <ul className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                      {rec.rankReasons.slice(0, 5).map((reason, index) => (
                        <li
                          key={`${row.job.id}-r${index}`}
                          className="rounded border px-1.5 py-0.5"
                          style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                        >
                          {reason}
                        </li>
                      ))}
                    </ul>
                  )}

                  {!rec.notificationEligible && rec.notificationBlockers.length > 0 && (
                    <p className="mt-1.5 text-xs" style={{ color: 'var(--warn)' }}>
                      Held back: {rec.notificationBlockers.slice(0, 2).join('; ')}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </Card>
      )}
    </div>
  );
}
