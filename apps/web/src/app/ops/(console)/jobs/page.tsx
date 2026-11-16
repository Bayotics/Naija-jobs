import Link from 'next/link';
import { jobExplorerQuerySchema } from '@job-intel/contracts';
import { getOpsContext } from '@/lib/ops';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The job explorer.
 *
 * Server-side filtering and server-side pagination, always. The brief rules out
 * loading thousands of records into the browser, and it is right for a reason
 * beyond memory: a client-side filter silently operates on the page you have
 * rather than the corpus you asked about, so "no results" starts meaning two
 * different things.
 *
 * Filters are URL state, so a useful view is a link an operator can keep.
 * Every one of them is parsed through the contract schema — a value that is not
 * an enum, a bounded number or a short string never reaches the query builder.
 */
const SORTS = [
  { value: 'discovered', label: 'Newest discovered' },
  { value: 'posted', label: 'Newest posted' },
  { value: 'match', label: 'Match score' },
  { value: 'recommendation', label: 'Recommendation score' },
  { value: 'quality', label: 'Quality score' },
] as const;

function scoreTone(score: number | null): 'ok' | 'warn' | 'neutral' {
  if (score === null) return 'neutral';
  if (score >= 70) return 'ok';
  if (score >= 40) return 'warn';
  return 'neutral';
}

export default async function OpsJobsPage({
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

  // Unparseable input falls back to defaults rather than erroring: a stale
  // bookmark should show the corpus, not a stack trace.
  const parsed = jobExplorerQuerySchema.safeParse({
    q: single('q'),
    company: single('company'),
    sourceId: single('sourceId'),
    countryCode: single('countryCode'),
    remoteType: single('remoteType'),
    status: single('status'),
    lifecycle: single('lifecycle'),
    minSalaryUsd: single('minSalaryUsd'),
    minMatchScore: single('minMatchScore'),
    minQualityScore: single('minQualityScore'),
    discoveredWithinHours: single('discoveredWithinHours'),
    duplicatesOnly: single('duplicatesOnly') === 'on',
    limit: single('limit'),
    offset: single('offset'),
    sort: single('sort'),
  });

  const query = parsed.success ? parsed.data : jobExplorerQuerySchema.parse({});

  const { repository, profileId } = await getOpsContext();
  const [{ items, total }, sources] = await Promise.all([
    repository.exploreJobs(query, profileId),
    repository.sourceOverview().catch(() => []),
  ]);

  const page = Math.floor(query.offset / query.limit) + 1;
  const pages = Math.max(1, Math.ceil(total / query.limit));

  const pageHref = (offset: number) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      const raw = Array.isArray(value) ? value[0] : value;
      if (raw) next.set(key, raw);
    }
    next.set('offset', String(Math.max(0, offset)));
    return `/ops/jobs?${next.toString()}`;
  };

  return (
    <div className="max-w-7xl space-y-5">
      <PageHeader
        title="Job explorer"
        description="Every posting in the corpus, filtered server-side and paginated."
      />

      <Card title="Filters" description="Filters are URL state — a useful view is a link.">
        <form className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4" method="get">
          <Field label="Title or company" name="q" defaultValue={query.q} />
          <Select label="Source" name="sourceId" defaultValue={query.sourceId}>
            <option value="">Any</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.displayName}
              </option>
            ))}
          </Select>
          <Field label="Country (ISO-2)" name="countryCode" defaultValue={query.countryCode} maxLength={2} />
          <Select label="Remote type" name="remoteType" defaultValue={query.remoteType}>
            <option value="">Any</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="onsite">Onsite</option>
            <option value="unknown">Unknown</option>
          </Select>
          <Select label="Lifecycle" name="lifecycle" defaultValue={query.lifecycle}>
            <option value="">Any</option>
            <option value="ACTIVE">Active</option>
            <option value="STALE">Stale</option>
            <option value="EXPIRED">Expired</option>
            <option value="CLOSED">Closed</option>
            <option value="UNKNOWN">Unknown</option>
          </Select>
          <Field
            label="Min salary (USD)"
            name="minSalaryUsd"
            type="number"
            defaultValue={query.minSalaryUsd?.toString()}
          />
          <Field
            label="Min match score"
            name="minMatchScore"
            type="number"
            defaultValue={query.minMatchScore?.toString()}
          />
          <Field
            label="Discovered within (hours)"
            name="discoveredWithinHours"
            type="number"
            defaultValue={query.discoveredWithinHours?.toString()}
          />
          <Select label="Sort by" name="sort" defaultValue={query.sort}>
            {SORTS.map((sort) => (
              <option key={sort.value} value={sort.value}>
                {sort.label}
              </option>
            ))}
          </Select>
          <Select label="Per page" name="limit" defaultValue={String(query.limit)}>
            {['25', '50', '100'].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>

          <label className="flex items-end gap-2 text-xs">
            <input type="checkbox" name="duplicatesOnly" defaultChecked={query.duplicatesOnly} />
            <span>Duplicates only</span>
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
              href="/ops/jobs"
              className="rounded-md px-3 py-1.5 text-xs"
              style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
            >
              Reset
            </Link>
          </div>
        </form>
      </Card>

      {!parsed.success && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
        >
          Some filters could not be parsed and were ignored. Showing the unfiltered corpus.
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          title="No jobs match these filters"
          reason={
            total === 0
              ? 'The corpus is empty for this filter set. Widen the filters, or run discovery from the controls page.'
              : 'This page is past the end of the result set.'
          }
          action={
            <Link href="/ops/jobs" className="text-xs" style={{ color: 'var(--accent)' }}>
              Clear filters
            </Link>
          }
        />
      ) : (
        <Card
          title={`${total.toLocaleString()} job(s)`}
          description={`Page ${page} of ${pages}. Showing ${items.length}.`}
          footer={
            <div className="flex items-center justify-between text-xs">
              <Link
                href={pageHref(query.offset - query.limit)}
                aria-disabled={query.offset === 0}
                style={{
                  color: query.offset === 0 ? 'var(--muted)' : 'var(--accent)',
                  pointerEvents: query.offset === 0 ? 'none' : undefined,
                }}
              >
                ← Previous
              </Link>
              <span style={{ color: 'var(--muted)' }}>
                {query.offset + 1}–{query.offset + items.length} of {total.toLocaleString()}
              </span>
              <Link
                href={pageHref(query.offset + query.limit)}
                aria-disabled={page >= pages}
                style={{
                  color: page >= pages ? 'var(--muted)' : 'var(--accent)',
                  pointerEvents: page >= pages ? 'none' : undefined,
                }}
              >
                Next →
              </Link>
            </div>
          }
        >
          <Table
            head={['Title', 'Company', 'Location', 'Source', 'Quality', 'Match', 'Rec', 'Discovered', '']}
          >
            {items.map((row) => (
              <tr key={row.job.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-2 text-xs">
                  <span className="font-medium">{row.job.title}</span>
                  {row.job.jobGroupId && (
                    <span className="ml-2">
                      <Badge tone="neutral">dupe group</Badge>
                    </span>
                  )}
                  {row.signals?.lifecycleStatus && row.signals.lifecycleStatus !== 'ACTIVE' && (
                    <span className="ml-2">
                      <Badge tone="warn">{row.signals.lifecycleStatus.toLowerCase()}</Badge>
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">{row.job.companyNameRaw ?? '—'}</td>
                <td className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                  {[row.job.city, row.job.countryCode].filter(Boolean).join(', ') || '—'}
                  {row.job.remoteType && row.job.remoteType !== 'unknown' && (
                    <span> · {row.job.remoteType}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                  {row.job.sourceId}
                </td>
                <td className="tabular px-3 py-2 text-xs">
                  {row.signals ? (
                    <Badge tone={scoreTone(row.signals.qualityScore)}>
                      {Math.round(row.signals.qualityScore)}
                    </Badge>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>—</span>
                  )}
                </td>
                <td className="tabular px-3 py-2 text-xs">
                  {row.match ? (
                    <Badge tone={row.match.eligible ? scoreTone(row.match.overallScore) : 'danger'}>
                      {row.match.eligible ? Math.round(row.match.overallScore) : 'ineligible'}
                    </Badge>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>—</span>
                  )}
                </td>
                <td className="tabular px-3 py-2 text-xs">
                  {row.recommendation ? (
                    <span title={row.recommendation.tier}>
                      {Math.round(row.recommendation.finalScore)}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>—</span>
                  )}
                </td>
                <td className="tabular px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                  {row.job.firstSeenAt.toISOString().slice(0, 16).replace('T', ' ')}
                </td>
                <td className="px-3 py-2 text-xs">
                  <Link href={`/ops/jobs/${row.job.id}`} style={{ color: 'var(--accent)' }}>
                    debug
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

function Field({
  label,
  name,
  defaultValue,
  type = 'text',
  maxLength,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  type?: string;
  maxLength?: number;
}) {
  return (
    <label className="text-xs">
      <span className="mb-1 block font-medium">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue ?? ''}
        maxLength={maxLength}
        className="w-full rounded border px-2 py-1 text-xs"
        style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
      />
    </label>
  );
}

function Select({
  label,
  name,
  defaultValue,
  children,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="text-xs">
      <span className="mb-1 block font-medium">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue ?? ''}
        className="w-full rounded border px-2 py-1 text-xs"
        style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
      >
        {children}
      </select>
    </label>
  );
}
