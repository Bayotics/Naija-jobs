import Link from 'next/link';
import { redact } from '@job-intel/ops';
import { getOpsContext } from '@/lib/ops';
import { getServerContext } from '@/lib/db';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { Metric, SourceHealthRow } from '@/components/ops';

export const dynamic = 'force-dynamic';

/**
 * Source management.
 *
 * Health scores with their component breakdown expandable inline — the formula
 * is visible rather than described. Credential *names* are shown so a
 * misconfiguration is diagnosable; values never leave the server.
 */
export default async function OpsSourcesPage() {
  const [{ service, repository }, ctx] = await Promise.all([getOpsContext(), getServerContext()]);

  const [sources, scores, rateLimits] = await Promise.all([
    ctx.sources.list({ includeArchived: false }),
    service.sourceHealthScores().catch(() => []),
    repository.rateLimitSummaries(24).catch(() => []),
  ]);

  const scoreById = new Map(scores.map((s) => [s.sourceId, s]));
  const limitsById = new Map(rateLimits.map((r) => [r.sourceId, r]));
  const totalRateLimited = rateLimits.reduce((sum, r) => sum + r.rateLimited, 0);

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Sources"
        description="Health, rate limits and configuration for every connector."
        actions={
          <Link href="/ops" className="text-xs" style={{ color: 'var(--accent)' }}>
            ← Operations
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Sources" value={sources.length} />
        <Metric label="Enabled" value={sources.filter((s) => s.enabled).length} />
        <Metric
          label="Failing"
          value={scores.filter((s) => s.status === 'down').length}
          tone={scores.some((s) => s.status === 'down') ? 'danger' : undefined}
        />
        <Metric
          label="Rate limited"
          value={totalRateLimited}
          hint="last 24h"
          tone={totalRateLimited > 0 ? 'warn' : undefined}
        />
      </div>

      {sources.length === 0 ? (
        <EmptyState title="No sources registered" reason="Seed the source registry first." />
      ) : (
        <div className="space-y-2">
          {sources.map((source) => (
            <div key={source.id}>
              <SourceHealthRow
                name={`${source.displayName} (${source.id})`}
                health={scoreById.get(source.id) ?? null}
                enabled={source.enabled}
                lastError={redact(source.lastErrorMessage)}
              />
              <div
                className="mt-1 flex flex-wrap gap-x-4 gap-y-1 px-3 text-[11px]"
                style={{ color: 'var(--muted)' }}
              >
                <span>
                  {source.sourceType} · {source.accessTier}
                </span>
                <span>cron {source.scheduleCron}</span>
                <span>
                  last success{' '}
                  {source.lastSuccessfulRunAt
                    ? source.lastSuccessfulRunAt.toISOString().slice(0, 16).replace('T', ' ')
                    : 'never'}
                </span>
                {source.consecutiveFailures > 0 && (
                  <span style={{ color: 'var(--danger)' }}>
                    {source.consecutiveFailures} consecutive failure(s)
                  </span>
                )}
                {source.credentialRefs.length > 0 && (
                  <span>needs {source.credentialRefs.join(', ')}</span>
                )}
                {limitsById.get(source.id) && (
                  <span>
                    {limitsById.get(source.id)!.requests} requests ·{' '}
                    {limitsById.get(source.id)!.rateLimited} throttled
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Card title="How the score is computed">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Six weighted components — success rate, failure streak, latency, freshness, result volume
          and error rate — each shown above with its own value, weight and reason. Result volume is
          scored against that source&rsquo;s own history, so a quiet scan is only an anomaly when
          the source is normally busy.
        </p>
      </Card>
    </div>
  );
}
