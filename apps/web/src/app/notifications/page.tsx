import Link from 'next/link';
import { getNotificationContext } from '@/lib/notifications';
import { Badge, Card, EmptyState, PageHeader, Stat, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Notification history and the decision trace.
 *
 * Two halves, and the second is the one that matters: a system whose main
 * behaviour is *not* emailing you is only trustworthy if you can look up why it
 * stayed quiet about a particular job. The counts at the top are the summary;
 * the trace below is the answer.
 */
const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'> = {
  sent: 'ok',
  delivered: 'ok',
  queued: 'neutral',
  sending: 'accent',
  failed: 'danger',
  bounced: 'danger',
  complained: 'danger',
  cancelled: 'neutral',
};

const OUTCOME_TONE = (outcome: string): 'ok' | 'warn' | 'neutral' =>
  outcome.startsWith('SENT_') || outcome.startsWith('INCLUDED_')
    ? 'ok'
    : outcome.startsWith('DEFERRED_')
      ? 'warn'
      : 'neutral';

export default async function NotificationsPage() {
  const { repository, profileId } = await getNotificationContext();

  if (!profileId) {
    return (
      <div className="max-w-5xl">
        <PageHeader title="Notifications" />
        <EmptyState
          title="No candidate profile yet"
          reason="Notifications belong to a profile. Create one first."
        />
      </div>
    );
  }

  const since = new Date(Date.now() - 7 * 24 * 3_600_000);
  const [history, decisions, counts] = await Promise.all([
    repository.history(profileId, 25),
    repository.recentDecisions(profileId, 40),
    repository.decisionCounts(profileId, since),
  ]);

  const sent = Object.entries(counts)
    .filter(([outcome]) => outcome.startsWith('SENT_') || outcome.startsWith('INCLUDED_'))
    .reduce((sum, [, count]) => sum + count, 0);
  const suppressed = Object.entries(counts)
    .filter(([outcome]) => outcome.startsWith('SUPPRESSED_'))
    .reduce((sum, [, count]) => sum + count, 0);

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Notifications"
        description="What was sent, what was held back, and why."
        actions={
          <Link href="/settings/notifications" className="text-sm hover:underline" style={{ color: 'var(--accent)' }}>
            Settings →
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Emails" value={history.length} hint="last 25" />
        <Stat label="Notified" value={sent} hint="last 7 days" />
        <Stat label="Suppressed" value={suppressed} hint="last 7 days" />
        <Stat
          label="Failed"
          value={history.filter((h) => h.delivery?.status === 'failed').length}
        />
      </div>

      {history.length === 0 ? (
        <EmptyState
          title="Nothing sent yet"
          reason="Notifications are produced once jobs are ranked and clear your thresholds."
        />
      ) : (
        <Card title="Notification history">
          <Table head={['Type', 'Subject', 'Jobs', 'Status', 'Attempts', 'Created']}>
            {history.map((row) => (
              <tr key={row.event.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-2">
                  <Badge tone={row.event.type === 'JOB_ALERT' ? 'accent' : 'neutral'}>
                    {row.event.type.replace(/_/g, ' ').toLowerCase()}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-xs">{row.event.subject}</td>
                <td className="tabular px-3 py-2 text-xs">{row.event.jobIds.length}</td>
                <td className="px-3 py-2">
                  {row.delivery ? (
                    <Badge tone={STATUS_TONE[row.delivery.status] ?? 'neutral'}>
                      {row.delivery.status}
                    </Badge>
                  ) : (
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      no delivery
                    </span>
                  )}
                  {row.delivery?.lastError && (
                    <div className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
                      {row.delivery.lastError.slice(0, 90)}
                    </div>
                  )}
                </td>
                <td className="tabular px-3 py-2 text-xs">
                  {row.delivery ? `${row.delivery.attempts}/${row.delivery.maxAttempts}` : '—'}
                </td>
                <td className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                  {row.event.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card
        title="Decision trace"
        description="Every candidate, including the ones deliberately held back."
      >
        {decisions.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            No decisions recorded yet.
          </p>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {decisions.map((row, index) => (
              <li key={`${row.decision.id}-${index}`} className="py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={OUTCOME_TONE(row.decision.outcome)}>
                    {row.decision.outcome.replace(/^(SENT|SUPPRESSED|INCLUDED|DEFERRED|QUEUED)_/, '').replace(/_/g, ' ').toLowerCase()}
                  </Badge>
                  <span className="text-sm font-medium">{row.job?.title ?? 'Unknown job'}</span>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>
                    {row.job?.companyNameRaw ?? ''}
                  </span>
                  {row.decision.recommendationScore !== null && (
                    <span className="tabular text-xs" style={{ color: 'var(--muted)' }}>
                      {Math.round(row.decision.recommendationScore)}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                  {row.decision.reason}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
