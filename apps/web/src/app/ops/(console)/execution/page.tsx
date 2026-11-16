import Link from 'next/link';
import { getExecutionContext } from '@/lib/execution';
import { Badge, Card, EmptyState, PageHeader, Stat, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The execution engine, observed.
 *
 * The layout answers the questions in the order an operator actually asks them:
 * is the system healthy, is anything stuck, what is queued, who is working, and
 * what failed permanently. Health goes first because it is usually the only
 * thing anyone needs — the rest of the page exists for the times it says
 * something is wrong.
 */

const TONE: Readonly<Record<string, 'ok' | 'warn' | 'danger' | 'neutral'>> = {
  healthy: 'ok',
  degraded: 'warn',
  down: 'danger',
  unknown: 'neutral',
  disabled: 'neutral',
};

const WORKER_TONE: Readonly<Record<string, 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'>> = {
  IDLE: 'ok',
  BUSY: 'accent',
  STARTING: 'neutral',
  DRAINING: 'warn',
  UNHEALTHY: 'danger',
  STOPPED: 'neutral',
};

export default async function ExecutionPage() {
  const { queue, deadLetters, workers, scheduler, health } = await getExecutionContext();

  const [report, breakdown, fleet, dlSummary, schedules, lag, stuck] = await Promise.all([
    health.check(),
    queue.depthBreakdown(),
    workers.list(),
    deadLetters.summary(),
    scheduler.listSchedules({}),
    scheduler.lagSeconds(),
    queue.stuckTasks(new Date(), 20),
  ]);

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Execution engine"
        description="Scheduler, queue and workers. This is what keeps the system running when nobody is watching."
        actions={
          <Link href="/ops" className="text-xs" style={{ color: 'var(--accent)' }}>
            ← Operations
          </Link>
        }
      />

      {/* ── Health first ───────────────────────────────────────────────── */}
      <Card title="System health" description={report.summary}>
        <Table head={['Component', 'Status', 'Detail', 'Latency']}>
          {report.components.map((component) => (
            <tr key={component.component}>
              <td className="py-1 font-medium">{component.component}</td>
              <td className="py-1">
                <Badge tone={TONE[component.status] ?? 'neutral'}>{component.status}</Badge>
              </td>
              <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                {component.detail}
              </td>
              <td className="tabular py-1 text-xs">
                {component.latencyMs === null ? '—' : `${Math.round(component.latencyMs)}ms`}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Queued" value={breakdown.total} hint="waiting to run" />
        <Stat label="In flight" value={breakdown.processing} hint="claimed by a worker" />
        <Stat label="Workers" value={fleet.length} />
        <Stat label="Schedules" value={schedules.length} hint={`${schedules.filter((s) => s.enabled).length} enabled`} />
        <Stat label="Scheduler lag" value={`${lag}s`} hint="oldest overdue schedule" />
        <Stat label="Dead letters" value={dlSummary.open} hint="awaiting a decision" />
      </div>

      {/* ── Anything stuck ─────────────────────────────────────────────── */}
      {stuck.length > 0 && (
        <Card
          title="Running longer than expected"
          description="These have passed their timeout but still hold a lease. They are reported rather than requeued — a task that may still be running must not be started twice."
        >
          <Table head={['Task', 'Type', 'Worker', 'Started', 'Attempts']}>
            {stuck.map((task) => (
              <tr key={task.taskId}>
                <td className="py-1 font-mono text-xs">{task.taskId.slice(0, 8)}</td>
                <td className="py-1 text-xs">{task.type}</td>
                <td className="py-1 font-mono text-xs">{task.lockedBy ?? '—'}</td>
                <td className="tabular py-1 text-xs">
                  {task.startedAt?.toISOString().slice(11, 19) ?? '—'}
                </td>
                <td className="tabular py-1 text-xs">{task.attempts}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {/* ── Queue depth ────────────────────────────────────────────────── */}
      <Card
        title="Queue depth"
        description="By type and priority. Background analytics should never be sitting ahead of urgent discovery."
      >
        {breakdown.total === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Nothing queued. The engine is keeping up.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                By type
              </div>
              <ul className="space-y-0.5 text-sm">
                {Object.entries(breakdown.byType)
                  .sort((a, b) => b[1] - a[1])
                  .map(([type, count]) => (
                    <li key={type} className="flex justify-between">
                      <span>{type}</span>
                      <span className="tabular">{count}</span>
                    </li>
                  ))}
              </ul>
            </div>

            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                By priority
              </div>
              <ul className="space-y-0.5 text-sm">
                {Object.entries(breakdown.byPriority).map(([priority, count]) => (
                  <li key={priority} className="flex justify-between">
                    <span>{priority}</span>
                    <span className="tabular">{count}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Card>

      {/* ── Workers ────────────────────────────────────────────────────── */}
      <Card
        title="Workers"
        description="A worker silent for three heartbeats is presumed unhealthy. Its tasks are not taken from it — only an expired lease can do that."
      >
        {fleet.length === 0 ? (
          <EmptyState
            title="No workers registered"
            reason="Start the worker process; until then nothing will be executed."
          />
        ) : (
          <Table head={['Worker', 'State', 'Concurrency', 'Processed', 'Failed', 'Last heartbeat']}>
            {fleet.map((worker) => (
              <tr key={worker.id}>
                <td className="py-1 font-mono text-xs">{worker.id.slice(0, 32)}</td>
                <td className="py-1">
                  <Badge tone={WORKER_TONE[worker.state] ?? 'neutral'}>{worker.state}</Badge>
                </td>
                <td className="tabular py-1 text-xs">{worker.concurrency}</td>
                <td className="tabular py-1 text-xs">{worker.tasksProcessed}</td>
                <td className="tabular py-1 text-xs">{worker.tasksFailed}</td>
                <td className="tabular py-1 text-xs">
                  {worker.lastHeartbeatAt.toISOString().slice(11, 19)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* ── Schedules ──────────────────────────────────────────────────── */}
      <Card
        title="Schedules"
        description="Every recurring job, as a row. A restart resumes these rather than forgetting them."
      >
        {schedules.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Nothing scheduled yet.
          </p>
        ) : (
          <Table head={['Type', 'Target', 'Every', 'Next run', 'Last run', 'Misfire']}>
            {schedules.slice(0, 25).map((entry) => (
              <tr key={entry.scheduleId}>
                <td className="py-1 text-xs">{entry.taskType}</td>
                <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {entry.sourceId ?? entry.profileId?.slice(0, 8) ?? 'system'}
                </td>
                <td className="tabular py-1 text-xs">
                  {entry.intervalMinutes < 60
                    ? `${entry.intervalMinutes}m`
                    : `${Math.round(entry.intervalMinutes / 60)}h`}
                </td>
                <td className="tabular py-1 text-xs">
                  {entry.enabled
                    ? (entry.nextRunAt?.toISOString().slice(5, 16).replace('T', ' ') ?? '—')
                    : 'paused'}
                </td>
                <td className="tabular py-1 text-xs">
                  {entry.lastRunAt?.toISOString().slice(5, 16).replace('T', ' ') ?? 'never'}
                </td>
                <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {entry.misfirePolicy}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* ── Dead letters ───────────────────────────────────────────────── */}
      {dlSummary.open > 0 && (
        <Card
          title="Dead letters"
          description="Work that failed permanently or exhausted its retries. Grouped, because the pattern is the diagnosis."
        >
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ['By type', dlSummary.byType],
              ['By failure', dlSummary.byFailureClass],
              ['By source', dlSummary.bySource],
            ].map(([label, group]) => (
              <div key={label as string}>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                  {label as string}
                </div>
                <ul className="space-y-0.5 text-sm">
                  {Object.entries(group as Record<string, number>)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 6)
                    .map(([key, count]) => (
                      <li key={key} className="flex justify-between gap-2">
                        <span className="truncate">{key}</span>
                        <span className="tabular">{count}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      )}

      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Execution is at-least-once: a task can run twice if a worker dies after finishing but before
        reporting. Every handler is idempotent, which is what makes that safe.
      </p>
    </div>
  );
}
