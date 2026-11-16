import Link from 'next/link';
import { getOpsContext } from '@/lib/ops';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'> = {
  success: 'ok',
  partial: 'warn',
  failed: 'danger',
  running: 'accent',
  cancelled: 'neutral',
};

/** Pipeline run history. Every scheduled or manual pass leaves a record. */
export default async function OpsRunsPage() {
  const { repository } = await getOpsContext();
  const runs = await repository.listRuns({ limit: 50 });

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Run history"
        description="Every pipeline execution, scheduled or manual."
        actions={
          <Link href="/ops" className="text-xs" style={{ color: 'var(--accent)' }}>
            ← Operations
          </Link>
        }
      />

      {runs.length === 0 ? (
        <EmptyState
          title="No runs recorded yet"
          reason="A run record is created whenever the pipeline executes. Trigger one from the controls page."
        />
      ) : (
        <Card title={`${runs.length} run(s)`}>
          <Table
            head={[
              'Started',
              'Trigger',
              'Status',
              'Discovered',
              'Matched',
              'Recommended',
              'Notified',
              'Duration',
              '',
            ]}
          >
            {runs.map((run) => (
              <tr key={run.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-2 text-xs">
                  {run.startedAt.toISOString().slice(0, 16).replace('T', ' ')}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={run.dryRun ? 'neutral' : 'accent'}>
                    {run.dryRun ? 'dry run' : run.trigger.toLowerCase()}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={STATUS_TONE[run.status] ?? 'neutral'}>{run.status}</Badge>
                  {run.errorCount > 0 && (
                    <span className="ml-2 text-[11px]" style={{ color: 'var(--danger)' }}>
                      {run.errorCount} error(s)
                    </span>
                  )}
                </td>
                <td className="tabular px-3 py-2 text-xs">{run.jobsDiscovered}</td>
                <td className="tabular px-3 py-2 text-xs">{run.jobsMatched}</td>
                <td className="tabular px-3 py-2 text-xs">{run.jobsRecommended}</td>
                <td className="tabular px-3 py-2 text-xs">{run.notificationsGenerated}</td>
                <td className="tabular px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                  {run.durationMs === null ? '—' : `${Math.round(run.durationMs / 1000)}s`}
                </td>
                <td className="px-3 py-2 text-xs">
                  <Link href={`/ops/runs/${run.id}`} style={{ color: 'var(--accent)' }}>
                    detail
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
