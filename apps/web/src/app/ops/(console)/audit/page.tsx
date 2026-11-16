import Link from 'next/link';
import { AUDIT_ACTIONS, type AuditAction } from '@job-intel/contracts';
import { getOpsContext } from '@/lib/ops';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/**
 * The audit log.
 *
 * The useful half of "who changed this" is *what it was before*. A log that
 * records only the new value tells you a source is disabled, which you could
 * already see; recording the prior value tells you whether disabling it was the
 * change that broke the run.
 *
 * Read-only by construction. Entries are written by the code paths that mutate
 * state and there is no edit or delete anywhere in the console — an audit trail
 * that its own operator can rewrite is decoration.
 */
export default async function OpsAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const single = (key: string) => {
    const value = params[key];
    const raw = Array.isArray(value) ? value[0] : value;
    return raw === '' || raw === undefined ? undefined : raw;
  };

  const actionParam = single('action');
  const action = AUDIT_ACTIONS.includes(actionParam as AuditAction)
    ? (actionParam as AuditAction)
    : undefined;
  const offset = Math.max(0, Number(single('offset') ?? 0) || 0);

  const { repository } = await getOpsContext();
  const entries = await repository
    .listAudit({ limit: PAGE_SIZE + 1, offset, action })
    .catch(() => []);

  const hasMore = entries.length > PAGE_SIZE;
  const page = entries.slice(0, PAGE_SIZE);

  const href = (nextOffset: number) => {
    const search = new URLSearchParams();
    if (action) search.set('action', action);
    if (nextOffset > 0) search.set('offset', String(nextOffset));
    const query = search.toString();
    return query ? `/ops/audit?${query}` : '/ops/audit';
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Audit log"
        description="Every manual change, with what it was before. Read-only."
      />

      <Card title="Filter">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="mb-1 block font-medium">Action</span>
            <select
              name="action"
              defaultValue={action ?? ''}
              className="rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            >
              <option value="">Any</option>
              {AUDIT_ACTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-xs font-medium"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            Apply
          </button>
          <Link
            href="/ops/audit"
            className="rounded-md px-3 py-1.5 text-xs"
            style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
          >
            Reset
          </Link>
        </form>
      </Card>

      {page.length === 0 ? (
        <EmptyState
          title="No audit entries"
          reason={
            action
              ? `Nothing matching ${action} has been recorded.`
              : 'Nothing has been changed through the console yet. Entries appear the moment a manual action runs.'
          }
        />
      ) : (
        <Card
          title={`${page.length} entr${page.length === 1 ? 'y' : 'ies'}`}
          footer={
            <div className="flex items-center justify-between text-xs">
              <Link
                href={href(Math.max(0, offset - PAGE_SIZE))}
                style={{
                  color: offset === 0 ? 'var(--muted)' : 'var(--accent)',
                  pointerEvents: offset === 0 ? 'none' : undefined,
                }}
              >
                ← Newer
              </Link>
              <span style={{ color: 'var(--muted)' }}>from {offset + 1}</span>
              <Link
                href={href(offset + PAGE_SIZE)}
                style={{
                  color: hasMore ? 'var(--accent)' : 'var(--muted)',
                  pointerEvents: hasMore ? undefined : 'none',
                }}
              >
                Older →
              </Link>
            </div>
          }
        >
          <ol className="space-y-2">
            {page.map((entry) => (
              <li
                key={entry.id}
                className="rounded-md border px-3 py-2"
                style={{ borderColor: 'var(--border)' }}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="tabular text-[11px]" style={{ color: 'var(--muted)' }}>
                    {entry.occurredAt.toISOString().slice(0, 19).replace('T', ' ')}
                  </span>
                  <Badge tone="accent">{entry.action}</Badge>
                  <span className="text-xs font-medium">{entry.target ?? '—'}</span>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>
                    by {entry.actor}
                  </span>
                  {entry.requestId && (
                    <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                      req {entry.requestId}
                    </span>
                  )}
                </div>

                {entry.reason && (
                  <p className="mt-1 text-[11px]" style={{ color: 'var(--muted)' }}>
                    {entry.reason}
                  </p>
                )}

                {(entry.before !== null || entry.after !== null) && (
                  <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                    <StateBlock label="Before" value={entry.before} />
                    <StateBlock label="After" value={entry.after} />
                  </div>
                )}
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}

function StateBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        {label}
      </div>
      <pre
        className="scroll-x mt-0.5 rounded p-1.5 text-[10px]"
        style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
      >
        {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2).slice(0, 800)}
      </pre>
    </div>
  );
}
