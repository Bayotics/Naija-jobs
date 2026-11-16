import Link from 'next/link';
import type { AcquisitionSourceState } from '@job-intel/contracts';
import { getAcquisitionContext } from '@/lib/acquisition';
import { Badge, Card, EmptyState, PageHeader, Stat, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Source intelligence.
 *
 * The question this page exists to answer is "why is this source not producing
 * jobs", and the reason it is a separate page from Sources is that the answer
 * is almost never "it is broken". It is far more often a missing environment
 * variable, a platform whose terms forbid automated access, or a source that is
 * working perfectly and simply publishes three roles a month.
 *
 * So state is shown before score, the blocking reason is shown before the
 * metrics, and a restricted source is rendered as a decision with alternatives
 * rather than as a fault with a red badge. Credential *names* appear; values
 * cannot, because the service that builds this data only ever learns whether a
 * name resolves.
 */

const STATE_TONE: Readonly<Record<AcquisitionSourceState, 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'>> = {
  HEALTHY: 'ok',
  DEGRADED: 'warn',
  FAILING: 'danger',
  DISABLED: 'neutral',
  NOT_CONFIGURED: 'warn',
  AUTH_REQUIRED: 'warn',
  RESTRICTED: 'neutral',
};

const percent = (value: number): string => `${Math.round(value * 100)}%`;

export default async function AcquisitionPage() {
  const { service } = await getAcquisitionContext();

  const [sources, summary] = await Promise.all([service.describeAll(), service.summary()]);

  if (sources.length === 0) {
    return (
      <div className="max-w-5xl space-y-5">
        <PageHeader title="Source intelligence" description="Where jobs come from, and why." />
        <EmptyState title="No sources registered" reason="Add a source to begin discovery." />
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Source intelligence"
        description="Every source, how it is reached, and what is stopping the ones that are stopped."
        actions={
          <Link href="/ops" className="text-xs" style={{ color: 'var(--accent)' }}>
            ← Operations
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Sources" value={summary.total} hint={`${summary.schedulable} will run`} />
        <Stat label="Healthy" value={summary.byState.HEALTHY} />
        <Stat
          label="Need attention"
          value={summary.needingAttention.length}
          hint="failing, unconfigured or awaiting credentials"
        />
        <Stat
          label="Awaiting credentials"
          value={summary.byState.AUTH_REQUIRED}
          hint="set an environment variable"
        />
        <Stat
          label="Restricted"
          value={summary.byState.RESTRICTED}
          hint="not fetched, by design"
        />
      </div>

      {/* ── What needs doing ───────────────────────────────────────────── */}
      {summary.needingAttention.length > 0 && (
        <Card
          title="Needs attention"
          description="Sources that could be producing jobs and are not. Restricted and disabled sources are excluded — those are decisions, not faults."
        >
          <ul className="space-y-2 text-sm">
            {summary.needingAttention.map((source) => (
              <li key={source.entry.sourceId}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={STATE_TONE[source.entry.state]}>{source.entry.state}</Badge>
                  <span className="font-medium">{source.entry.sourceName}</span>
                </div>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                  {source.blockedReason ?? 'No reason recorded.'}
                </p>
                {source.entry.auth.credentialRefs.length > 0 && (
                  <p className="mt-0.5 font-mono text-xs" style={{ color: 'var(--muted)' }}>
                    needs: {source.entry.auth.credentialRefs.join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ── Every source ───────────────────────────────────────────────── */}
      <Card
        title="All sources"
        description="Health is scored from observed requests, parse rate, freshness against the source's own cadence, and yield."
      >
        <Table
          head={['Source', 'State', 'Method', 'Health', 'Requests', 'Parsed', 'Jobs', 'Dupes', 'Latency']}
        >
          {sources.map((source) => (
            <tr key={source.entry.sourceId}>
              <td className="py-1">
                <div className="font-medium">{source.entry.sourceName}</div>
                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  {source.entry.sourceType.replace(/_/g, ' ').toLowerCase()}
                </div>
              </td>
              <td className="py-1">
                <Badge tone={STATE_TONE[source.entry.state]}>{source.entry.state}</Badge>
              </td>
              <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                {source.method?.replace(/_/g, ' ').toLowerCase() ?? '—'}
              </td>
              <td className="tabular py-1">{source.entry.healthScore}</td>
              <td className="tabular py-1 text-xs">
                {source.metrics.requestsSucceeded}/{source.metrics.requestsAttempted}
              </td>
              <td className="tabular py-1 text-xs">
                {source.metrics.itemsSeen === 0 ? '—' : percent(source.metrics.parseSuccessRate)}
              </td>
              <td className="tabular py-1 text-xs">{source.metrics.jobsYielded}</td>
              <td className="tabular py-1 text-xs">
                {source.metrics.jobsYielded === 0 ? '—' : percent(source.metrics.duplicateRate)}
              </td>
              <td className="tabular py-1 text-xs">
                {source.metrics.averageLatencyMs > 0
                  ? `${Math.round(source.metrics.averageLatencyMs)}ms`
                  : '—'}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      {/* ── Restricted platforms ───────────────────────────────────────── */}
      {sources.some((source) => source.entry.state === 'RESTRICTED') && (
        <Card
          title="Not fetched, by design"
          description="These platforms forbid automated collection. Nothing here is broken and nothing here will be retried — the alternatives cover the same roles through routes that are open."
        >
          <ul className="space-y-3 text-sm">
            {sources
              .filter((source) => source.entry.state === 'RESTRICTED')
              .map((source) => (
                <li key={source.entry.sourceId}>
                  <div className="font-medium">{source.entry.sourceName}</div>
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                    {source.blockedReason}
                  </p>
                  {source.alternatives.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs" style={{ color: 'var(--muted)' }}>
                      {source.alternatives.map((alternative) => (
                        <li key={alternative}>{alternative}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
          </ul>
        </Card>
      )}

      {/* ── Incremental state ──────────────────────────────────────────── */}
      <Card
        title="Incremental progress"
        description="Where each source's last scan reached. A source with a watermark asks only for what is new."
      >
        <Table head={['Source', 'Last success', 'Watermark', 'Empty scans', 'Rate limited', 'Timeouts']}>
          {sources.map((source) => (
            <tr key={source.entry.sourceId}>
              <td className="py-1">{source.entry.sourceName}</td>
              <td className="tabular py-1 text-xs">
                {source.watermark.lastSuccessfulScanAt
                  ? source.watermark.lastSuccessfulScanAt.toISOString().slice(0, 16).replace('T', ' ')
                  : 'never'}
              </td>
              <td className="py-1 font-mono text-xs" style={{ color: 'var(--muted)' }}>
                {source.watermark.lastCursor
                  ? `cursor ${source.watermark.lastCursor.slice(0, 24)}`
                  : source.watermark.lastSeenPublishedAt
                    ? `since ${source.watermark.lastSeenPublishedAt.toISOString().slice(0, 10)}`
                    : '—'}
              </td>
              <td className="tabular py-1 text-xs">{source.watermark.emptyScans}</td>
              <td className="tabular py-1 text-xs">{source.metrics.rateLimitHits}</td>
              <td className="tabular py-1 text-xs">{source.metrics.timeouts}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Credential names are shown so a misconfiguration is diagnosable. Values are read from the
        environment on the server and never reach this page.
      </p>
    </div>
  );
}
