import { revalidatePath } from 'next/cache';
import type { QueueName } from '@job-intel/queue';
import { QUEUE_NAMES } from '@job-intel/queue';
import { getOpsContext } from '@/lib/ops';
import { currentSession } from '@/lib/auth';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';
import { Metric, StatusDot } from '@/components/ops';
import { OpsAutoRefresh } from '../auto-refresh';

export const dynamic = 'force-dynamic';

/**
 * Queue depths and the dead-letter queue.
 *
 * Two things this page is careful about:
 *
 *  - A queue whose counts cannot be read shows as **unavailable**, not as
 *    zero. A missing row reads as "no work", which is the exact opposite of
 *    what an unreachable Redis means, and that misreading costs an hour during
 *    an incident.
 *  - A failed job shows its actual reason, redacted. A dead-letter view that
 *    only reports a count tells an operator that something is wrong and
 *    nothing about what.
 */
export default async function OpsQueuesPage() {
  const { service, repository } = await getOpsContext();

  const [counts, failed] = await Promise.all([
    service.queueCounts().catch(() => new Map()),
    service.failedJobs(50).catch(() => []),
  ]);

  const rows = QUEUE_NAMES.map((name) => ({ name, counts: counts.get(name) ?? null }));
  const monitored = rows.filter((row) => row.counts !== null);
  const unavailable = rows.filter((row) => row.counts === null);

  const totals = monitored.reduce(
    (acc, row) => ({
      waiting: acc.waiting + (row.counts?.waiting ?? 0),
      active: acc.active + (row.counts?.active ?? 0),
      completed: acc.completed + (row.counts?.completed ?? 0),
      failed: acc.failed + (row.counts?.failed ?? 0),
      delayed: acc.delayed + (row.counts?.delayed ?? 0),
    }),
    { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
  );

  async function actOnJob(formData: FormData) {
    'use server';
    const queue = String(formData.get('queue') ?? '') as QueueName;
    const jobId = String(formData.get('jobId') ?? '');
    const operation = formData.get('operation') === 'discard' ? 'discard' : 'retry';
    if (!QUEUE_NAMES.includes(queue) || !jobId) return;

    const { service: svc, repository: repo } = await getOpsContext();
    const who = (await currentSession())?.actor ?? 'local';

    const applied = await svc.actOnFailedJob(queue, jobId, operation);
    if (!applied) return;

    await repo.recordAudit({
      action: operation === 'retry' ? 'queue.job_retried' : 'queue.job_discarded',
      actor: who,
      target: `${queue}:${jobId}`,
      after: { operation },
      reason: null,
    });
    revalidatePath('/ops/queues');
  }

  const recentQueueAudit = await repository
    .listAudit({ limit: 8, action: 'queue.job_retried' })
    .catch(() => []);

  return (
    <div className="max-w-6xl space-y-5">
      <OpsAutoRefresh intervalMs={15_000} />

      <PageHeader
        title="Queues"
        description="Depth per queue, and every job that exhausted its retries."
        actions={
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            driver: {monitored.length > 0 ? 'reachable' : 'unreachable'}
          </span>
        }
      />

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Metric label="Waiting" value={totals.waiting} tone={totals.waiting > 1000 ? 'warn' : undefined} />
        <Metric label="Active" value={totals.active} />
        <Metric label="Delayed" value={totals.delayed} />
        <Metric label="Completed" value={totals.completed} />
        <Metric label="Failed" value={totals.failed} tone={totals.failed > 0 ? 'danger' : undefined} />
      </section>

      {unavailable.length > 0 && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
        >
          {unavailable.length} queue(s) could not be read: {unavailable.map((r) => r.name).join(', ')}.
          These are reported as unavailable rather than as empty — a queue that cannot be counted is
          not a queue with nothing in it.
        </div>
      )}

      <Card title="Per queue">
        <Table head={['Queue', 'Status', 'Waiting', 'Active', 'Delayed', 'Completed', 'Failed']}>
          {rows.map((row) => (
            <tr key={row.name} className="border-b" style={{ borderColor: 'var(--border)' }}>
              <td className="px-3 py-2 text-xs font-medium">{row.name}</td>
              <td className="px-3 py-2">
                {row.counts === null ? (
                  <StatusDot status="unknown" label="unavailable" />
                ) : (row.counts.failed ?? 0) > 0 ? (
                  <StatusDot status="degraded" label="failures" />
                ) : (row.counts.waiting ?? 0) > 1000 ? (
                  <StatusDot status="degraded" label="backing up" />
                ) : (
                  <StatusDot status="healthy" label="ok" />
                )}
              </td>
              <td className="tabular px-3 py-2 text-xs">{row.counts?.waiting ?? '—'}</td>
              <td className="tabular px-3 py-2 text-xs">{row.counts?.active ?? '—'}</td>
              <td className="tabular px-3 py-2 text-xs">{row.counts?.delayed ?? '—'}</td>
              <td className="tabular px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                {row.counts?.completed ?? '—'}
              </td>
              <td className="tabular px-3 py-2 text-xs">
                {row.counts === null ? (
                  '—'
                ) : row.counts.failed > 0 ? (
                  <span style={{ color: 'var(--danger)' }}>{row.counts.failed}</span>
                ) : (
                  0
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card
        title="Failed jobs"
        description="Jobs that exhausted their retries. Reasons are redacted before display."
      >
        {failed.length === 0 ? (
          <EmptyState
            title="No failed jobs"
            reason="Nothing has exhausted its retries in the retained window. The in-memory driver keeps failures only for the life of the process; BullMQ retains them for seven days."
          />
        ) : (
          <Table head={['Failed at', 'Queue', 'Attempts', 'Reason', 'Trace', '']}>
            {failed.map((job) => (
              <tr key={`${job.queue}-${job.id}`} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="tabular px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                  {job.failedAt ? job.failedAt.toISOString().slice(0, 19).replace('T', ' ') : '—'}
                </td>
                <td className="px-3 py-2 text-xs">
                  <Badge tone="neutral">{job.queue}</Badge>
                </td>
                <td className="tabular px-3 py-2 text-xs">{job.attemptsMade}</td>
                <td className="px-3 py-2 text-xs" style={{ color: 'var(--danger)' }}>
                  {job.failedReason}
                  {job.stack && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[10px]" style={{ color: 'var(--muted)' }}>
                        stack
                      </summary>
                      <pre className="scroll-x mt-1 text-[10px]" style={{ color: 'var(--muted)' }}>
                        {job.stack.slice(0, 1500)}
                      </pre>
                    </details>
                  )}
                </td>
                <td className="px-3 py-2 text-[10px]" style={{ color: 'var(--muted)' }}>
                  {job.traceId?.slice(0, 8) ?? '—'}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    <form action={actOnJob}>
                      <input type="hidden" name="queue" value={job.queue} />
                      <input type="hidden" name="jobId" value={job.id} />
                      <input type="hidden" name="operation" value="retry" />
                      <button
                        type="submit"
                        className="rounded px-2 py-0.5 text-[10px]"
                        style={{ border: '1px solid var(--accent)', color: 'var(--accent)' }}
                      >
                        retry
                      </button>
                    </form>
                    <form action={actOnJob}>
                      <input type="hidden" name="queue" value={job.queue} />
                      <input type="hidden" name="jobId" value={job.id} />
                      <input type="hidden" name="operation" value="discard" />
                      <button
                        type="submit"
                        className="rounded px-2 py-0.5 text-[10px]"
                        style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                      >
                        discard
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {recentQueueAudit.length > 0 && (
        <Card title="Recent queue interventions">
          <ul className="space-y-1 text-xs">
            {recentQueueAudit.map((entry) => (
              <li key={entry.id} className="flex flex-wrap gap-2">
                <span className="tabular" style={{ color: 'var(--muted)' }}>
                  {entry.occurredAt.toISOString().slice(5, 16).replace('T', ' ')}
                </span>
                <span className="font-medium">{entry.action}</span>
                <span style={{ color: 'var(--muted)' }}>
                  {entry.target} by {entry.actor}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
