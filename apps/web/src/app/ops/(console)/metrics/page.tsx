import {
  DEFAULT_MODEL_PRICES,
  OPERATION_STAGE,
  budgetStatus,
  concerningMetrics,
} from '@job-intel/ops';
import type { AiOperation } from '@job-intel/contracts';
import { getOpsContext } from '@/lib/ops';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';
import { Metric } from '@/components/ops';

export const dynamic = 'force-dynamic';

/**
 * Observability: latency, AI spend, rate limits and data quality.
 *
 * Percentiles rather than averages, everywhere. A mean enrichment latency of
 * 300 ms is compatible with one job in fifty taking twelve seconds, and the
 * one in fifty is the thing that makes a nightly run miss its window.
 *
 * Cost is computed from stored per-call usage against dated prices. Any model
 * with no configured price is reported separately as *unpriced* rather than
 * folded in at zero: a dashboard that silently counts an unknown model as free
 * understates spend precisely when a new model has just been introduced.
 */
export default async function OpsMetricsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.window) ? params.window[0] : params.window;
  const windowHours = Math.min(24 * 90, Math.max(1, Number(raw ?? 24) || 24));

  const { service, repository } = await getOpsContext();

  const [latencies, cost, quality, rateLimits, unpriced] = await Promise.all([
    service.latencies(windowHours).catch(() => []),
    service.aiCost(windowHours).catch(() => null),
    service.dataQuality().catch(() => []),
    repository.rateLimitSummaries(windowHours).catch(() => []),
    repository.unpricedModels().catch((): string[] => []),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const spentToday = cost?.byDay.find((day) => day.day === today)?.costUsd ?? 0;
  const budget = budgetStatus(spentToday, cost?.dailyBudgetUsd ?? null);
  const concerns = concerningMetrics(quality);

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Metrics"
        description="Latency, AI spend, request budgets and data quality."
        actions={
          <form method="get" className="flex items-center gap-2 text-xs">
            <label>
              <span className="mr-1" style={{ color: 'var(--muted)' }}>
                Window
              </span>
              <select
                name="window"
                defaultValue={String(windowHours)}
                className="rounded border px-2 py-1 text-xs"
                style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
              >
                <option value="1">1h</option>
                <option value="24">24h</option>
                <option value="168">7d</option>
                <option value="720">30d</option>
              </select>
            </label>
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

      {/* ── Latency ───────────────────────────────────────────────────────── */}
      <Card
        title="Latency"
        description="Nearest-rank percentiles over raw samples. Averages are not shown alone — they hide the tail."
      >
        {latencies.length === 0 ? (
          <EmptyState
            title="No latency samples recorded"
            reason={`Nothing was sampled in the last ${windowHours} hour(s). Samples are written as operations complete, so an idle system records none.`}
          />
        ) : (
          <Table head={['Operation', 'Samples', 'P50', 'P95', 'P99', 'Max', 'Mean']}>
            {latencies
              .slice()
              .sort((a, b) => b.p95 - a.p95)
              .map((latency) => (
                <tr
                  key={latency.operation}
                  className="border-b"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <td className="px-3 py-2 text-xs font-medium">
                    {latency.operation.replace(/_/g, ' ')}
                  </td>
                  <td className="tabular px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {latency.count.toLocaleString()}
                  </td>
                  <td className="tabular px-3 py-2 text-xs">{Math.round(latency.p50)} ms</td>
                  <td className="tabular px-3 py-2 text-xs">{Math.round(latency.p95)} ms</td>
                  <td
                    className="tabular px-3 py-2 text-xs"
                    style={{ color: latency.p99 > latency.p50 * 10 ? 'var(--warn)' : undefined }}
                  >
                    {Math.round(latency.p99)} ms
                  </td>
                  <td className="tabular px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {Math.round(latency.max)} ms
                  </td>
                  <td className="tabular px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {Math.round(latency.mean)} ms
                  </td>
                </tr>
              ))}
          </Table>
        )}
      </Card>

      {/* ── AI cost ───────────────────────────────────────────────────────── */}
      <Card
        title="AI cost"
        description="Per-call usage costed against dated prices. Prices are configuration, not code."
      >
        {!cost || cost.totalCalls === 0 ? (
          <EmptyState
            title="No AI calls recorded"
            reason={`No model call was made in the last ${windowHours} hour(s). The pipeline runs deterministically when AI is disabled, so zero here can be entirely correct.`}
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Metric label="Calls" value={cost.totalCalls.toLocaleString()} />
              <Metric label="Input tokens" value={cost.totalInputTokens.toLocaleString()} />
              <Metric label="Output tokens" value={cost.totalOutputTokens.toLocaleString()} />
              <Metric label="Total" value={`$${cost.totalCostUsd.toFixed(4)}`} />
              <Metric
                label="Today"
                value={`$${spentToday.toFixed(4)}`}
                hint={budget.detail}
                tone={
                  budget.status === 'exceeded'
                    ? 'danger'
                    : budget.status === 'warning'
                      ? 'warn'
                      : undefined
                }
              />
            </div>

            {unpriced.length > 0 && (
              <div
                className="rounded-md border px-3 py-2 text-xs"
                style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
              >
                No price configured for {unpriced.join(', ')}. Those calls are counted but their cost
                is reported as zero, so the total above is a <strong>lower bound</strong>.
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="mb-1 text-xs font-semibold">By operation</h3>
                <Table head={['Operation', 'Stage', 'Cost']}>
                  {Object.entries(cost.byOperation)
                    .sort((a, b) => b[1] - a[1])
                    .map(([operation, value]) => (
                      <tr key={operation} className="border-b" style={{ borderColor: 'var(--border)' }}>
                        <td className="px-3 py-1.5 text-xs">{operation.replace(/_/g, ' ')}</td>
                        <td className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                          {OPERATION_STAGE[operation as AiOperation] ?? 'other'}
                        </td>
                        <td className="tabular px-3 py-1.5 text-xs">${value.toFixed(4)}</td>
                      </tr>
                    ))}
                </Table>
              </div>

              <div>
                <h3 className="mb-1 text-xs font-semibold">By model</h3>
                <Table head={['Model', 'Cost', 'Priced']}>
                  {Object.entries(cost.byModel)
                    .sort((a, b) => b[1] - a[1])
                    .map(([model, value]) => (
                      <tr key={model} className="border-b" style={{ borderColor: 'var(--border)' }}>
                        <td className="px-3 py-1.5 text-xs">{model}</td>
                        <td className="tabular px-3 py-1.5 text-xs">${value.toFixed(4)}</td>
                        <td className="px-3 py-1.5">
                          <Badge tone={unpriced.includes(model) ? 'warn' : 'ok'}>
                            {unpriced.includes(model) ? 'no price' : 'priced'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                </Table>
              </div>
            </div>

            {cost.byDay.length > 1 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold">By day</h3>
                <ul className="space-y-1">
                  {cost.byDay.map((day) => {
                    const max = Math.max(...cost.byDay.map((d) => d.costUsd), 0.0001);
                    return (
                      <li key={day.day} className="flex items-center gap-2 text-[11px]">
                        <span className="tabular w-20" style={{ color: 'var(--muted)' }}>
                          {day.day}
                        </span>
                        <span
                          className="h-1.5 rounded"
                          style={{
                            width: `${Math.max(1, (day.costUsd / max) * 60)}%`,
                            background: 'var(--accent)',
                          }}
                        />
                        <span className="tabular">${day.costUsd.toFixed(4)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-semibold">
            Configured prices ({DEFAULT_MODEL_PRICES.length})
          </summary>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--muted)' }}>
            Seed defaults, dated and overridable from configuration. Each is applied against the
            moment a call was made, so a price change does not rewrite past spend.
          </p>
          <Table head={['Model', 'Provider', 'Input /M', 'Output /M', 'Effective from']}>
            {DEFAULT_MODEL_PRICES.map((price) => (
              <tr key={price.model} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-1.5 text-xs">{price.model}</td>
                <td className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {price.provider}
                </td>
                <td className="tabular px-3 py-1.5 text-xs">${price.inputPerMillion}</td>
                <td className="tabular px-3 py-1.5 text-xs">${price.outputPerMillion}</td>
                <td className="tabular px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {price.effectiveFrom.toISOString().slice(0, 10)}
                </td>
              </tr>
            ))}
          </Table>
        </details>
      </Card>

      {/* ── Rate limits ───────────────────────────────────────────────────── */}
      <Card
        title="Request budgets"
        description="Per source, over the selected window. A rate-limited source is throttled, not broken."
      >
        {rateLimits.length === 0 ? (
          <EmptyState
            title="No HTTP activity recorded"
            reason={`No source made a request in the last ${windowHours} hour(s).`}
          />
        ) : (
          <Table head={['Source', 'Requests', 'Succeeded', 'Failed', 'Rate limited', 'Backoff']}>
            {rateLimits.map((limit) => (
              <tr key={limit.sourceId} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-2 text-xs font-medium">{limit.sourceId}</td>
                <td className="tabular px-3 py-2 text-xs">{limit.requests.toLocaleString()}</td>
                <td className="tabular px-3 py-2 text-xs">{limit.succeeded.toLocaleString()}</td>
                <td
                  className="tabular px-3 py-2 text-xs"
                  style={{ color: limit.failed > 0 ? 'var(--danger)' : undefined }}
                >
                  {limit.failed.toLocaleString()}
                </td>
                <td
                  className="tabular px-3 py-2 text-xs"
                  style={{ color: limit.rateLimited > 0 ? 'var(--warn)' : undefined }}
                >
                  {limit.rateLimited.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-xs">
                  {limit.backoffUntil && limit.backoffUntil.getTime() > Date.now() ? (
                    <Badge tone="warn">
                      until {limit.backoffUntil.toISOString().slice(11, 19)}
                    </Badge>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* ── Data quality ──────────────────────────────────────────────────── */}
      <Card
        title="Data quality"
        description="Share of the corpus with each weakness. Thresholds differ per metric — missing salary is normal, failed enrichment is not."
      >
        {quality.length === 0 || quality.every((metric) => metric.total === 0) ? (
          <EmptyState
            title="No jobs to measure"
            reason="Data quality is computed over the stored corpus. An empty corpus produces no metrics rather than a perfect score."
          />
        ) : (
          <>
            {concerns.length > 0 && (
              <div
                className="mb-3 rounded-md border px-3 py-2 text-xs"
                style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
              >
                {concerns.length} metric(s) past their threshold:{' '}
                {concerns.map((metric) => metric.label).join(', ')}.
              </div>
            )}
            <Table head={['Metric', 'Stage', 'Count', 'Share', '']}>
              {quality.map((metric) => {
                const concerning = concerns.some((c) => c.key === metric.key);
                return (
                  <tr key={metric.key} className="border-b" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-3 py-2 text-xs">
                      <span className="font-medium">{metric.label}</span>
                      <div className="text-[10px]" style={{ color: 'var(--muted)' }}>
                        {metric.detail}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[11px]" style={{ color: 'var(--muted)' }}>
                      {metric.stage}
                    </td>
                    <td className="tabular px-3 py-2 text-xs">
                      {metric.count.toLocaleString()} / {metric.total.toLocaleString()}
                    </td>
                    <td className="tabular px-3 py-2 text-xs">
                      {(metric.share * 100).toFixed(1)}%
                    </td>
                    <td className="px-3 py-2">
                      <div
                        className="h-1.5 w-24 overflow-hidden rounded"
                        style={{ background: 'var(--border)' }}
                      >
                        <div
                          className="h-full rounded"
                          style={{
                            width: `${Math.max(1, metric.share * 100)}%`,
                            background: concerning ? 'var(--warn)' : 'var(--accent)',
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </Table>
          </>
        )}
      </Card>
    </div>
  );
}
