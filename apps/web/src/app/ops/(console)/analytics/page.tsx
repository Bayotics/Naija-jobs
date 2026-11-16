import { biggestDrop } from '@job-intel/ops';
import { getOpsContext } from '@/lib/ops';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';
import { FunnelView, Metric } from '@/components/ops';

export const dynamic = 'force-dynamic';

/**
 * Search performance and recommendation analytics.
 *
 * Two questions, on one page:
 *
 *  - **Where does the corpus go?** The funnel, with the biggest unexpected drop
 *    named. Selection stages are excluded from that calculation: notification is
 *    deliberately the narrowest thing in the system, so reporting it as "the
 *    biggest drop" every single time is noise dressed as a finding.
 *  - **Is the score still discriminating?** The distribution histogram. If
 *    everything piles into 90–99 the score has stopped ranking and started
 *    agreeing, and the histogram shows that before any individual job is
 *    argued about.
 */
export default async function OpsAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.window) ? params.window[0] : params.window;
  const windowHours = Math.min(24 * 90, Math.max(1, Number(raw ?? 24) || 24));

  const { service, repository, profileId } = await getOpsContext();

  const [funnel, analytics] = await Promise.all([
    service.funnel(windowHours).catch(() => null),
    profileId ? repository.recommendationAnalytics(profileId).catch(() => null) : null,
  ]);

  const drop = funnel ? biggestDrop(funnel) : null;
  const totalRecommended = analytics?.buckets.reduce((sum, b) => sum + b.count, 0) ?? 0;
  const maxBucket = Math.max(1, ...(analytics?.buckets.map((b) => b.count) ?? [1]));
  const topDecile = analytics?.buckets.slice(9).reduce((sum, b) => sum + b.count, 0) ?? 0;

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Analytics"
        description="Where the corpus goes, and whether the ranking still discriminates."
        actions={
          <form method="get" className="flex items-center gap-2 text-xs">
            <select
              name="window"
              defaultValue={String(windowHours)}
              className="rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            >
              <option value="24">24h</option>
              <option value="168">7d</option>
              <option value="720">30d</option>
            </select>
            <button
              type="submit"
              className="rounded-md px-2 py-1 text-xs"
              style={{ border: '1px solid var(--border)' }}
            >
              Apply
            </button>
          </form>
        }
      />

      {funnel && (
        <Card
          title="Discovery → notification"
          description={`Last ${funnel.windowHours} hours. Percentages are retention from the previous step.`}
          footer={
            drop ? (
              <p className="text-xs">
                <strong>Biggest processing drop:</strong> {drop.step.label} removed{' '}
                {(drop.lost * 100).toFixed(0)}% of what reached it.{' '}
                <span style={{ color: 'var(--muted)' }}>
                  Selection stages (ranking, notification) are excluded — they are supposed to be
                  narrow.
                </span>
              </p>
            ) : (
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                No processing stage lost volume in this window.
              </p>
            )
          }
        >
          <FunnelView funnel={funnel} />
        </Card>
      )}

      {!profileId ? (
        <EmptyState
          title="No active candidate profile"
          reason="Recommendation analytics are per candidate. Create a profile before this section can report anything."
        />
      ) : !analytics || totalRecommended === 0 ? (
        <EmptyState
          title="Nothing has been ranked yet"
          reason="Recommendations are produced by the ranking pass. Run it from the controls page, then return here."
        />
      ) : (
        <>
          <Card
            title="Score distribution"
            description="Ten equal buckets over the final recommendation score."
          >
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="Ranked" value={totalRecommended.toLocaleString()} />
              <Metric
                label="90–100"
                value={topDecile}
                hint={`${((topDecile / totalRecommended) * 100).toFixed(1)}% of the corpus`}
                tone={topDecile / totalRecommended > 0.25 ? 'warn' : undefined}
              />
              <Metric
                label="Notification-eligible"
                value={analytics.tiers.reduce((sum, tier) => sum + tier.notifiable, 0)}
              />
              <Metric label="Tiers in use" value={analytics.tiers.length} />
            </div>

            {topDecile / totalRecommended > 0.25 && (
              <div
                className="mb-3 rounded-md border px-3 py-2 text-xs"
                style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
              >
                Over a quarter of ranked jobs score above 90. Calibration exists to prevent exactly
                this: when everything is exceptional, nothing is ranked.
              </div>
            )}

            <ul className="space-y-1">
              {analytics.buckets
                .slice()
                .reverse()
                .map((bucket) => (
                  <li key={bucket.from} className="flex items-center gap-2 text-[11px]">
                    <span className="tabular w-14" style={{ color: 'var(--muted)' }}>
                      {bucket.from}–{bucket.to}
                    </span>
                    <span
                      className="h-2 rounded"
                      style={{
                        width: `${Math.max(0.5, (bucket.count / maxBucket) * 70)}%`,
                        background: bucket.from >= 90 ? 'var(--warn)' : 'var(--accent)',
                      }}
                    />
                    <span className="tabular">{bucket.count}</span>
                  </li>
                ))}
            </ul>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="By tier">
              <Table head={['Tier', 'Count', 'Avg score', 'Notifiable']}>
                {analytics.tiers
                  .slice()
                  .sort((a, b) => b.avgScore - a.avgScore)
                  .map((tier) => (
                    <tr key={tier.tier} className="border-b" style={{ borderColor: 'var(--border)' }}>
                      <td className="px-3 py-1.5 text-xs">
                        <Badge tone={tier.tier === 'EXCEPTIONAL' ? 'ok' : 'neutral'}>
                          {tier.tier}
                        </Badge>
                      </td>
                      <td className="tabular px-3 py-1.5 text-xs">{tier.count}</td>
                      <td className="tabular px-3 py-1.5 text-xs">{tier.avgScore.toFixed(1)}</td>
                      <td className="tabular px-3 py-1.5 text-xs">{tier.notifiable}</td>
                    </tr>
                  ))}
              </Table>
            </Card>

            <Card
              title="By source"
              description="Which sources actually produce recommendations, not just volume."
            >
              <Table head={['Source', 'Ranked', 'Avg score', 'Notifiable']}>
                {analytics.sources.map((source) => (
                  <tr key={source.sourceId} className="border-b" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-3 py-1.5 text-xs">{source.sourceId}</td>
                    <td className="tabular px-3 py-1.5 text-xs">{source.count}</td>
                    <td className="tabular px-3 py-1.5 text-xs">{source.avgScore.toFixed(1)}</td>
                    <td
                      className="tabular px-3 py-1.5 text-xs"
                      style={{ color: source.notifiable === 0 ? 'var(--muted)' : 'var(--ok)' }}
                    >
                      {source.notifiable}
                    </td>
                  </tr>
                ))}
              </Table>
            </Card>

            <Card title="Companies appearing most">
              <Table head={['Company', 'Jobs ranked', 'Best score']}>
                {analytics.companies.map((company, index) => (
                  <tr key={index} className="border-b" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-3 py-1.5 text-xs">{company.company ?? 'not stated'}</td>
                    <td className="tabular px-3 py-1.5 text-xs">{company.count}</td>
                    <td className="tabular px-3 py-1.5 text-xs">{company.bestScore.toFixed(1)}</td>
                  </tr>
                ))}
              </Table>
            </Card>

          </div>
        </>
      )}
    </div>
  );
}
