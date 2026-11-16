import Link from 'next/link';
import { notFound } from 'next/navigation';
import { redact } from '@job-intel/ops';
import { getOpsContext } from '@/lib/ops';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';
import { Metric } from '@/components/ops';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'> = {
  success: 'ok',
  partial: 'warn',
  failed: 'danger',
  running: 'accent',
  cancelled: 'neutral',
};

const SEVERITY_COLOR: Record<string, string> = {
  info: 'var(--muted)',
  warn: 'var(--warn)',
  error: 'var(--danger)',
};

/**
 * One run, in full.
 *
 * The timeline is the point of this page. A run that reports `partial` is not
 * actionable; a run that reports `partial` *and* shows enrichment starting four
 * minutes after discovery finished, with two source errors in between, is.
 *
 * Every free-text field on this page — timeline detail, source errors, event
 * messages — passes through `redact` first. Connector failures carry request
 * URLs, and request URLs carry API keys.
 */
export default async function OpsRunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const { repository } = await getOpsContext();

  const run = await repository.getRun(runId);
  if (!run) notFound();

  const [sources, events] = await Promise.all([
    repository.runSourceActivity(runId).catch(() => []),
    repository.queryEvents({ runId, limit: 200, sinceHours: 24 * 90 }).catch(() => []),
  ]);

  const timeline = [...run.timeline].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
  const firstAt = timeline[0] ? new Date(timeline[0].at).getTime() : run.startedAt.getTime();

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Run detail"
        description={`${run.trigger.toLowerCase()} run started ${run.startedAt.toISOString().slice(0, 19).replace('T', ' ')} UTC`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={STATUS_TONE[run.status] ?? 'neutral'}>{run.status}</Badge>
            {run.dryRun && <Badge tone="neutral">dry run</Badge>}
            <Link href="/ops/runs" className="text-xs" style={{ color: 'var(--accent)' }}>
              ← All runs
            </Link>
          </div>
        }
      />

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Metric label="Discovered" value={run.jobsDiscovered} />
        <Metric label="Processed" value={run.jobsProcessed} />
        <Metric label="Duplicates" value={run.duplicatesDetected} />
        <Metric label="Matched" value={run.jobsMatched} />
        <Metric label="Recommended" value={run.jobsRecommended} />
        <Metric
          label="Duration"
          value={run.durationMs === null ? 'running' : `${(run.durationMs / 1000).toFixed(1)}s`}
        />
      </section>

      {(run.errorCount > 0 || run.warningCount > 0) && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: run.errorCount > 0 ? 'var(--danger)' : 'var(--warn)',
            color: run.errorCount > 0 ? 'var(--danger)' : 'var(--warn)',
          }}
        >
          {run.errorCount} error(s), {run.warningCount} warning(s) recorded during this run.
        </div>
      )}

      <Card
        title="Timeline"
        description="Every stage transition, with elapsed time from the first entry."
      >
        {timeline.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            No timeline entries were recorded. Runs write their timeline as stages complete, so an
            empty timeline on a finished run means the pass ended before any stage reported.
          </p>
        ) : (
          <ol className="space-y-0">
            {timeline.map((entry, index) => {
              const at = new Date(entry.at);
              const elapsed = Math.max(0, at.getTime() - firstAt);
              return (
                <li
                  key={`${entry.stage}-${index}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b py-1.5 last:border-0"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <span
                    className="tabular w-16 text-[11px]"
                    style={{ color: 'var(--muted)' }}
                    title={at.toISOString()}
                  >
                    +{(elapsed / 1000).toFixed(1)}s
                  </span>
                  <span className="w-28 text-xs font-semibold">{entry.stage}</span>
                  <span
                    className="text-xs"
                    style={{ color: SEVERITY_COLOR[entry.severity] ?? 'var(--text)' }}
                  >
                    {entry.event}
                  </span>
                  {entry.detail && (
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {redact(entry.detail)}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <Card
        title="Sources in this run"
        description="Source activity inside the run window, whether or not the run triggered it."
      >
        {sources.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            No source ran inside this window.
          </p>
        ) : (
          <Table head={['Source', 'Status', 'Discovered', 'Accepted', 'Rejected', 'Dupes', 'Errors']}>
            {sources.map((source, index) => (
              <tr
                key={`${source.sourceId}-${index}`}
                className="border-b"
                style={{ borderColor: 'var(--border)' }}
              >
                <td className="px-3 py-2 text-xs font-medium">{source.sourceId}</td>
                <td className="px-3 py-2">
                  <Badge tone={STATUS_TONE[source.status] ?? 'neutral'}>{source.status}</Badge>
                </td>
                <td className="tabular px-3 py-2 text-xs">{source.jobsDiscovered}</td>
                <td className="tabular px-3 py-2 text-xs">{source.jobsAccepted}</td>
                <td className="tabular px-3 py-2 text-xs">{source.jobsRejected}</td>
                <td className="tabular px-3 py-2 text-xs">{source.jobsDuplicated}</td>
                <td className="px-3 py-2 text-xs">
                  {source.errorCount === 0 ? (
                    <span style={{ color: 'var(--muted)' }}>—</span>
                  ) : (
                    <details>
                      <summary className="cursor-pointer" style={{ color: 'var(--danger)' }}>
                        {source.errorCount}
                      </summary>
                      <ul className="mt-1 space-y-0.5">
                        {(source.errors ?? []).slice(0, 5).map((error, errorIndex) => (
                          <li key={errorIndex} className="text-[11px]" style={{ color: 'var(--muted)' }}>
                            {redact(String((error as { message?: unknown }).message ?? error))}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Events" description="Structured events emitted while this run was executing.">
        {events.length === 0 ? (
          <EmptyState
            title="No events recorded for this run"
            reason="Events are correlated by run id. A run that predates event correlation, or one that failed before emitting anything, shows nothing here."
          />
        ) : (
          <ul className="space-y-0.5">
            {events.slice(0, 100).map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                <span className="tabular" style={{ color: 'var(--muted)' }}>
                  {event.createdAt.toISOString().slice(11, 19)}
                </span>
                <span
                  className="w-12 font-semibold"
                  style={{ color: SEVERITY_COLOR[event.severity] ?? 'var(--text)' }}
                >
                  {event.severity}
                </span>
                <span className="font-medium">{event.name}</span>
                <span style={{ color: 'var(--muted)' }}>{redact(event.message)}</span>
                {event.jobId && (
                  <Link href={`/ops/jobs/${event.jobId}`} style={{ color: 'var(--accent)' }}>
                    job
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
