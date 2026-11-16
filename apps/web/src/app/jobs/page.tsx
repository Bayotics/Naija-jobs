import { getServerContext } from '@/lib/db';
import { jobListQuerySchema } from '@job-intel/contracts';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getServerContext();
  const raw = await searchParams;

  // Query params are user input: validate before they reach a repository.
  const parsed = jobListQuerySchema.safeParse(
    Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v] as const),
    ),
  );
  const query = parsed.success ? parsed.data : jobListQuerySchema.parse({});
  const { items, total } = await ctx.jobs.list(query);

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Jobs"
        description="Every normalized posting the system has discovered, before matching."
      />

      {!parsed.success && (
        <div className="mb-4">
          <Badge tone="warn">Invalid filters ignored</Badge>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          title="No jobs discovered yet"
          reason="Nothing has been discovered yet. The worker scans the job boards hourly — check the Sources page to see whether any of them are reporting a problem."
        />
      ) : (
        <Card title={rangeLabel(query.offset, items.length, total)}>
          <Table head={['Title', 'Company', 'Location', 'Arrangement', 'Source', 'First seen']}>
            {items.map((job) => (
              <tr key={job.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-2">
                  <a
                    href={job.canonicalUrl ?? job.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline"
                    style={{ color: 'var(--accent)' }}
                  >
                    {job.title}
                  </a>
                </td>
                <td className="px-3 py-2">{job.companyName}</td>
                <td className="px-3 py-2">{job.locationRaw ?? job.countryCode ?? '—'}</td>
                <td className="px-3 py-2">
                  <Badge tone={job.remoteType === 'remote' ? 'ok' : 'neutral'}>
                    {job.remoteType}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-xs">{job.sourceName ?? job.sourceId}</td>
                <td className="px-3 py-2 text-xs">
                  {job.firstSeenAt.toISOString().slice(0, 10)}
                </td>
              </tr>
            ))}
          </Table>

          {/*
            Paging is links rather than state.

            The page is a server component reading `offset` from the query
            string, so a plain anchor is the whole mechanism: it survives a
            refresh, it can be bookmarked and shared, and it needs no client
            bundle. Without this the page silently showed the first 50 of 259
            and gave no indication the other 209 existed.
          */}
          {total > items.length && (
            <div
              className="flex items-center justify-between border-t px-3 py-3 text-sm"
              style={{ borderColor: 'var(--border)' }}
            >
              <PageLink
                params={raw}
                offset={query.offset - query.limit}
                disabled={query.offset <= 0}
              >
                ← Previous
              </PageLink>

              <span style={{ color: 'var(--muted)' }}>
                Page {Math.floor(query.offset / query.limit) + 1} of{' '}
                {Math.max(1, Math.ceil(total / query.limit))}
              </span>

              <PageLink
                params={raw}
                offset={query.offset + query.limit}
                disabled={query.offset + items.length >= total}
              >
                Next →
              </PageLink>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function rangeLabel(offset: number, shown: number, total: number): string {
  if (total === 0) return 'No jobs';
  if (shown >= total) return `${total} job${total === 1 ? '' : 's'}`;
  return `Showing ${offset + 1}–${offset + shown} of ${total} jobs`;
}

/**
 * One paging control.
 *
 * Every other query parameter is carried through, so paging never silently
 * discards a filter the user set.
 */
function PageLink({
  params,
  offset,
  disabled,
  children,
}: {
  params: Record<string, string | string[] | undefined>;
  offset: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span style={{ color: 'var(--muted)', opacity: 0.4 }} aria-disabled>
        {children}
      </span>
    );
  }

  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'offset' || value === undefined) continue;
    next.set(key, Array.isArray(value) ? (value[0] ?? '') : value);
  }
  next.set('offset', String(Math.max(0, offset)));

  return (
    <a href={`/jobs?${next.toString()}`} className="underline" style={{ color: 'var(--accent)' }}>
      {children}
    </a>
  );
}
