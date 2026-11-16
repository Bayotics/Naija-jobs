import Link from 'next/link';
import { getOpsContext } from '@/lib/ops';
import { authConfigured } from '@/lib/auth';
import { Card, PageHeader } from '@/components/ui';
import {
  FunnelView,
  HealthCard,
  Metric,
  PipelineView,
  StatusDot,
} from '@/components/ops';
import { OpsAutoRefresh } from './auto-refresh';

export const dynamic = 'force-dynamic';

/**
 * The operations control centre.
 *
 * Server-rendered and refreshed by polling. The brief says not to add
 * complexity where polling suffices, and it does: this is one operator on one
 * screen, and a WebSocket would add a connection to manage, a reconnect path to
 * get wrong and a second code path for the same data.
 *
 * Every section degrades independently. If the queue is unreachable the queue
 * card says so and the rest of the page still renders — this page matters most
 * when something is broken.
 */
export default async function OpsPage() {
  const [{ service }, protectedConsole] = await Promise.all([getOpsContext(), authConfigured()]);

  const [overview, stages, funnel] = await Promise.all([
    service.overview(),
    service.pipelineStages().catch(() => []),
    service.funnel(24).catch(() => null),
  ]);

  const { health, pipeline, recommendations, sources, scheduler } = overview;

  return (
    <div className="max-w-6xl space-y-5">
      <OpsAutoRefresh intervalMs={30_000} />

      <PageHeader
        title="Operations"
        description="Everything the pipeline is doing, and why."
        actions={
          <div className="flex items-center gap-3 text-xs">
            <StatusDot status={health.status} label={`system ${health.status}`} />
            <span style={{ color: 'var(--muted)' }}>
              {overview.generatedAt.toISOString().slice(11, 19)} UTC
            </span>
          </div>
        }
      />

      {!protectedConsole && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
        >
          <strong>This console is unauthenticated.</strong> No <code>AUTH_SECRET</code> is
          configured, so anyone who can reach this URL can disable sources and trigger runs. Set one
          before exposing it beyond localhost.
        </div>
      )}

      {/* The worst thing currently wrong, stated first. */}
      {health.status !== 'healthy' && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: health.status === 'down' ? 'var(--danger)' : 'var(--warn)',
            color: health.status === 'down' ? 'var(--danger)' : 'var(--warn)',
          }}
        >
          {health.summary}
        </div>
      )}

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
          System status
        </h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {health.components.map((component) => (
            <HealthCard
              key={component.component}
              component={component.component}
              status={component.status}
              detail={component.detail}
              latencyMs={component.latencyMs}
            />
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
            Job pipeline
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Today" value={pipeline.discoveredToday} hint="discovered" />
            <Metric label="This hour" value={pipeline.discoveredThisHour} hint="discovered" />
            <Metric label="Enriched" value={pipeline.enriched} />
            <Metric label="Matched" value={pipeline.matched} />
            <Metric label="Recommended" value={pipeline.recommended} />
            <Metric label="Duplicates" value={pipeline.duplicates} />
            <Metric
              label="Stale"
              value={pipeline.stale}
              tone={pipeline.stale > pipeline.enriched * 0.3 ? 'warn' : undefined}
            />
          </div>

          <h2 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
            Recommendations
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Exceptional" value={recommendations.exceptional} tone="ok" />
            <Metric label="Strong" value={recommendations.strong} />
            <Metric label="Avg match" value={recommendations.averageScore} />
            <Metric
              label="Avg confidence"
              value={`${Math.round(recommendations.averageConfidence * 100)}%`}
            />
          </div>

          <h2 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
            Sources
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Healthy" value={sources.healthy} tone="ok" />
            <Metric
              label="Degraded"
              value={sources.degraded}
              tone={sources.degraded > 0 ? 'warn' : undefined}
            />
            <Metric
              label="Failing"
              value={sources.failing}
              tone={sources.failing > 0 ? 'danger' : undefined}
            />
            <Metric label="Disabled" value={sources.disabled} />
          </div>
        </div>

        <div className="space-y-4">
          <Card
            title="Scheduler"
            description={
              scheduler.currentRunId
                ? 'A run is in progress.'
                : scheduler.lastRunAt
                  ? `Last run ${scheduler.lastRunAt.toISOString().slice(0, 16).replace('T', ' ')} (${scheduler.lastRunStatus}).`
                  : 'No pipeline run recorded yet.'
            }
          >
            <div className="grid grid-cols-2 gap-2">
              <Metric
                label="Queue backlog"
                value={scheduler.queueBacklog}
                tone={scheduler.queueBacklog > 1000 ? 'warn' : undefined}
              />
              <Metric
                label="Current run"
                value={scheduler.currentRunId ? 'running' : 'idle'}
                hint={scheduler.currentRunId?.slice(0, 8) ?? undefined}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              <Link href="/ops/runs" style={{ color: 'var(--accent)' }}>
                Run history →
              </Link>
              <Link href="/ops/sources" style={{ color: 'var(--accent)' }}>
                Sources →
              </Link>
              <Link href="/ops/jobs" style={{ color: 'var(--accent)' }}>
                Job explorer →
              </Link>
              <Link href="/ops/control" style={{ color: 'var(--accent)' }}>
                Controls →
              </Link>
            </div>
          </Card>

          <Card title="Pipeline" description="Stage by stage.">
            <PipelineView stages={stages} />
          </Card>
        </div>
      </section>

      {funnel && (
        <Card
          title="Discovery → notification"
          description={`Last ${funnel.windowHours} hours. Percentages are retention from the previous step.`}
        >
          <FunnelView funnel={funnel} />
        </Card>
      )}
    </div>
  );
}
