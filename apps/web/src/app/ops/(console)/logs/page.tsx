import Link from 'next/link';
import { SYSTEM_EVENTS, SYSTEM_EVENT_SEVERITIES } from '@job-intel/contracts';
import { redact } from '@job-intel/ops';
import { getOpsContext } from '@/lib/ops';
import { Card, EmptyState, PageHeader, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

const SEVERITY_COLOR: Record<string, string> = {
  info: 'var(--muted)',
  warn: 'var(--warn)',
  error: 'var(--danger)',
};

/**
 * The structured log viewer.
 *
 * Backed by `system_events`, filtered on indexed columns. The brief rules out a
 * raw-text viewer and it is right: "show me every event for this job" is a
 * query, not a grep, and a grep cannot answer it at all once the pipeline runs
 * on more than one machine.
 *
 * Every message is redacted on the way out. Events are emitted by code that
 * routinely embeds request URLs in their message.
 */
export default async function OpsLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    const raw = Array.isArray(value) ? value[0] : value;
    return raw === '' || raw === undefined ? undefined : raw;
  };

  const severity = single('severity');
  const name = single('name');
  const sinceHours = Math.min(24 * 90, Math.max(1, Number(single('sinceHours') ?? 24) || 24));
  const limit = Math.min(500, Math.max(25, Number(single('limit') ?? 100) || 100));
  const traceId = single('traceId');
  const sourceId = single('sourceId');

  const { repository } = await getOpsContext();
  const [events, sources] = await Promise.all([
    repository
      .queryEvents({
        severity: severity ? [severity] : undefined,
        name: name ? [name] : undefined,
        sourceId,
        traceId,
        sinceHours,
        limit,
      })
      .catch(() => []),
    repository.sourceOverview().catch(() => []),
  ]);

  const bySeverity = events.reduce<Record<string, number>>((acc, event) => {
    acc[event.severity] = (acc[event.severity] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="max-w-7xl space-y-5">
      <PageHeader
        title="Logs"
        description="Structured events, filtered on indexed columns rather than searched as text."
        actions={
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {SYSTEM_EVENT_SEVERITIES.map((s) => `${bySeverity[s] ?? 0} ${s}`).join(' · ')}
          </span>
        }
      />

      <Card title="Filters">
        <form className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" method="get">
          <label className="text-xs">
            <span className="mb-1 block font-medium">Severity</span>
            <select
              name="severity"
              defaultValue={severity ?? ''}
              className="w-full rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            >
              <option value="">Any</option>
              {SYSTEM_EVENT_SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs">
            <span className="mb-1 block font-medium">Event</span>
            <select
              name="name"
              defaultValue={name ?? ''}
              className="w-full rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            >
              <option value="">Any</option>
              {SYSTEM_EVENTS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs">
            <span className="mb-1 block font-medium">Source</span>
            <select
              name="sourceId"
              defaultValue={sourceId ?? ''}
              className="w-full rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            >
              <option value="">Any</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.displayName}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs">
            <span className="mb-1 block font-medium">Trace id</span>
            <input
              name="traceId"
              defaultValue={traceId ?? ''}
              placeholder="correlate one pass"
              className="w-full rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            />
          </label>

          <label className="text-xs">
            <span className="mb-1 block font-medium">Window (hours)</span>
            <input
              name="sinceHours"
              type="number"
              defaultValue={sinceHours}
              className="w-full rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            />
          </label>

          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="rounded-md px-3 py-1.5 text-xs font-medium"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              Apply
            </button>
            <Link
              href="/ops/logs"
              className="rounded-md px-3 py-1.5 text-xs"
              style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
            >
              Reset
            </Link>
          </div>
        </form>
      </Card>

      {events.length === 0 ? (
        <EmptyState
          title="No events match these filters"
          reason={`Nothing was emitted in the last ${sinceHours} hour(s) matching this filter set. Events are written as the pipeline runs; a system that has not run yet emits none.`}
        />
      ) : (
        <Card
          title={`${events.length} event(s)`}
          description={`Newest first. Capped at ${limit} — narrow the window rather than raising the cap.`}
        >
          <Table head={['Time', 'Severity', 'Event', 'Message', 'Correlation']}>
            {events.map((event) => (
              <tr key={event.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="tabular whitespace-nowrap px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {event.createdAt.toISOString().slice(0, 19).replace('T', ' ')}
                </td>
                <td className="px-3 py-1.5">
                  <span
                    className="text-[11px] font-semibold"
                    style={{ color: SEVERITY_COLOR[event.severity] ?? 'var(--text)' }}
                  >
                    {event.severity}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-[11px] font-medium">{event.name}</td>
                <td className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {redact(event.message)}
                </td>
                <td className="px-3 py-1.5 text-[10px]">
                  <div className="flex flex-wrap gap-2">
                    {event.jobId && (
                      <Link href={`/ops/jobs/${event.jobId}`} style={{ color: 'var(--accent)' }}>
                        job
                      </Link>
                    )}
                    {event.runId && (
                      <Link href={`/ops/runs/${event.runId}`} style={{ color: 'var(--accent)' }}>
                        run
                      </Link>
                    )}
                    {event.sourceId && <span style={{ color: 'var(--muted)' }}>{event.sourceId}</span>}
                    {event.traceId && (
                      <Link
                        href={`/ops/logs?traceId=${encodeURIComponent(event.traceId)}&sinceHours=${sinceHours}`}
                        style={{ color: 'var(--accent)' }}
                        title="Every event sharing this trace"
                      >
                        {event.traceId.slice(0, 8)}
                      </Link>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
