import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { userProvidedSourceSchema } from '@job-intel/contracts';
import { getDiscoveryFrameworkContext } from '@/lib/discovery-framework';
import { getOpsContext } from '@/lib/ops';
import { currentSession } from '@/lib/auth';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';
import { Metric } from '@/components/ops';

export const dynamic = 'force-dynamic';

/**
 * Discovery coverage and control.
 *
 * The question this page exists to answer is the one the brief insists must
 * never be answered with a slogan: *how much of my search space are we actually
 * covering?* Everything here is measured — queries planned and executed,
 * sources searched, gaps named — because "we search the internet" is
 * unfalsifiable and therefore useless.
 */

const SEVERITY_TONE = { high: 'danger', medium: 'warn', low: 'neutral' } as const;
const PRIORITY_TONE = { HIGH: 'ok', MEDIUM: 'accent', LOW: 'neutral' } as const;

export default async function OpsDiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const notice = Array.isArray(params.notice) ? params.notice[0] : params.notice;

  const { repository, profileId } = await getDiscoveryFrameworkContext();

  const [queries, telemetry, byMethod, capabilities, performance, userSources, coverage] =
    await Promise.all([
      profileId ? repository.listQueries(profileId, { limit: 60 }).catch(() => []) : [],
      repository.listTelemetry({ windowHours: 24, limit: 50 }).catch(() => []),
      repository.telemetryByMethod(24).catch(() => []),
      repository.listCapabilities().catch(() => []),
      repository.listPerformance().catch(() => []),
      repository.listUserSources().catch(() => []),
      profileId ? repository.latestCoverage(profileId).catch(() => null) : null,
    ]);

  const gaps = (coverage?.gaps ?? []) as Array<{
    kind: string;
    dimension: string;
    value: string;
    severity: 'low' | 'medium' | 'high';
    detail: string;
    suggestion: string;
  }>;

  // ── Actions ───────────────────────────────────────────────────────────────

  async function replan() {
    'use server';
    const { service: svc, profileId: id } = await getDiscoveryFrameworkContext();
    if (!id) return;

    const plan = await svc.planFor(id);
    const { repository: opsRepo } = await getOpsContext();
    await opsRepo.recordAudit({
      action: 'config.updated',
      actor: (await currentSession())?.actor ?? 'local',
      target: id,
      after: { queries: plan.queries.length, dropped: plan.droppedCount },
      reason: 'discovery query plan regenerated from current preferences',
    });
    revalidatePath('/ops/discovery');
  }

  async function refreshCoverage() {
    'use server';
    const { service: svc, profileId: id } = await getDiscoveryFrameworkContext();
    if (!id) return;
    await svc.reportCoverage(id, 24);
    revalidatePath('/ops/discovery');
  }

  async function refreshCapabilities() {
    'use server';
    const { service: svc } = await getDiscoveryFrameworkContext();
    await svc.refreshCapabilities();
    await svc.refreshPerformance();
    revalidatePath('/ops/discovery');
  }

  async function submitUrl(formData: FormData) {
    'use server';
    const parsed = userProvidedSourceSchema.safeParse({
      url: String(formData.get('url') ?? ''),
      displayName: String(formData.get('displayName') ?? '') || null,
      scanFrequencyMinutes: Number(formData.get('frequency') ?? 360),
    });
    if (!parsed.success) return;

    // Submission validates and recommends. It never activates — a URL typed by
    // a person is untrusted input to a system that makes outbound requests.
    const { service: svc } = await getDiscoveryFrameworkContext();
    await svc.submitSource(parsed.data).catch(() => null);
    revalidatePath('/ops/discovery');
  }

  async function activate(formData: FormData) {
    'use server';
    const id = String(formData.get('id') ?? '');
    if (!id || formData.get('confirm') !== 'on') return;

    const { service: svc } = await getDiscoveryFrameworkContext();
    const sourceId = await svc.activateSource(id).catch(() => null);
    if (!sourceId) return;

    const { repository: opsRepo } = await getOpsContext();
    await opsRepo.recordAudit({
      action: 'source.configured',
      actor: (await currentSession())?.actor ?? 'local',
      target: sourceId,
      after: { userSourceId: id },
      reason: 'user-provided source activated after validation',
    });
    revalidatePath('/ops/discovery');
  }

  const executed = queries.filter((query) => query.lastExecutedAt !== null).length;
  const totalDiscovered = queries.reduce((sum, query) => sum + query.jobsDiscovered, 0);
  const totalMatched = queries.reduce((sum, query) => sum + query.jobsMatched, 0);

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Discovery"
        description="What the system looked for, where it looked, and what it could not reach."
        actions={
          <div className="flex gap-2">
            <form action={replan}>
              <button
                type="submit"
                className="rounded-md px-3 py-1.5 text-xs font-medium"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                Re-plan queries
              </button>
            </form>
            <form action={refreshCoverage}>
              <button
                type="submit"
                className="rounded-md px-3 py-1.5 text-xs"
                style={{ border: '1px solid var(--border)' }}
              >
                Refresh coverage
              </button>
            </form>
          </div>
        }
      />

      {notice && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
        >
          {notice}
        </div>
      )}

      {/* ── Coverage ───────────────────────────────────────────────────── */}
      <Card
        title="Search coverage"
        description="Of the titles, locations and technologies you asked for — what was actually searched."
      >
        {!profileId ? (
          <EmptyState
            title="No active candidate profile"
            reason="Coverage is measured against your stated preferences. Create a profile first."
          />
        ) : !coverage ? (
          <EmptyState
            title="No coverage snapshot yet"
            reason="Coverage is computed from executed queries. Use “Refresh coverage” once discovery has run."
          />
        ) : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-6">
              <Metric
                label="Searched"
                value={`${Math.round(coverage.searchedShare * 100)}%`}
                hint="of your preferences"
              />
              <Metric
                label="Productive"
                value={`${Math.round(coverage.productiveShare * 100)}%`}
                hint="returned a job"
                tone={coverage.productiveShare < 0.3 ? 'warn' : undefined}
              />
              <Metric label="Queries run" value={coverage.queriesExecuted} />
              <Metric label="Jobs found" value={coverage.uniqueJobsDiscovered} />
              <Metric label="Sources used" value={coverage.sourcesSearched} />
              <Metric label="Sources available" value={coverage.sourcesAvailable} />
            </div>
            <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
              This is coverage of <strong>your stated search space</strong> over the last{' '}
              {coverage.windowHours} hours — not of the web. The web is too large and too dynamic
              to search exhaustively, so what is reported here is what can be verified.
            </p>
          </>
        )}
      </Card>

      {/* ── Gaps ───────────────────────────────────────────────────────── */}
      <Card title="Coverage gaps" description="What was not searched, and what would fix it.">
        {gaps.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            No gaps recorded. Either everything you asked for was searched, or no coverage
            snapshot exists yet.
          </p>
        ) : (
          <Table head={['Severity', 'Kind', 'Preference', 'Detail', 'Suggestion']}>
            {gaps.slice(0, 25).map((gap, index) => (
              <tr key={index} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-1.5">
                  <Badge tone={SEVERITY_TONE[gap.severity]}>{gap.severity}</Badge>
                </td>
                <td className="px-3 py-1.5 text-[11px]">{gap.kind}</td>
                <td className="px-3 py-1.5 text-xs font-medium">
                  {gap.value}
                  <span className="ml-1 text-[10px]" style={{ color: 'var(--muted)' }}>
                    ({gap.dimension})
                  </span>
                </td>
                <td className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {gap.detail}
                </td>
                <td className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {gap.suggestion}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* ── Queries ────────────────────────────────────────────────────── */}
      <Card
        title="Discovery queries"
        description="Generated from your preferences. Change a preference and these change."
        footer={
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {queries.length} active · {executed} executed · {totalDiscovered} job(s) discovered ·{' '}
            {totalMatched} matched
          </span>
        }
      >
        {queries.length === 0 ? (
          <EmptyState
            title="No queries planned"
            reason="Queries are generated from candidate preferences. Use “Re-plan queries” to build them."
          />
        ) : (
          <Table head={['Priority', 'Query', 'Why', 'Runs', 'Found', 'Matched', 'Last run']}>
            {queries.slice(0, 40).map((query) => (
              <tr key={query.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-1.5">
                  <Badge tone={PRIORITY_TONE[query.priority as keyof typeof PRIORITY_TONE] ?? 'neutral'}>
                    {query.priority}
                  </Badge>
                </td>
                <td className="px-3 py-1.5 font-mono text-[11px]">{query.text}</td>
                <td className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {query.rationale}
                </td>
                <td className="tabular px-3 py-1.5 text-xs">{query.executions}</td>
                <td className="tabular px-3 py-1.5 text-xs">{query.jobsDiscovered}</td>
                <td className="tabular px-3 py-1.5 text-xs">{query.jobsMatched}</td>
                <td className="tabular px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {query.lastExecutedAt
                    ? query.lastExecutedAt.toISOString().slice(0, 16).replace('T', ' ')
                    : 'never'}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* ── Method breakdown ───────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="By discovery method"
          description="Cheapest mechanisms first. A source on a costly method may have a cheaper one available."
        >
          {byMethod.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              No discovery telemetry in the last 24 hours.
            </p>
          ) : (
            <Table head={['Method', 'Ops', 'Results', 'Unique', 'Dupes', '304s', 'Errors']}>
              {byMethod.map((row) => (
                <tr key={row.method} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-1.5 text-xs">{row.method.replace(/_/g, ' ')}</td>
                  <td className="tabular px-3 py-1.5 text-xs">{row.operations}</td>
                  <td className="tabular px-3 py-1.5 text-xs">{row.results}</td>
                  <td className="tabular px-3 py-1.5 text-xs">{row.uniqueResults}</td>
                  <td className="tabular px-3 py-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                    {row.duplicates}
                  </td>
                  <td className="tabular px-3 py-1.5 text-xs" style={{ color: 'var(--ok)' }}>
                    {row.notModified}
                  </td>
                  <td
                    className="tabular px-3 py-1.5 text-xs"
                    style={{ color: row.errors > 0 ? 'var(--danger)' : undefined }}
                  >
                    {row.errors}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card
          title="Source value"
          description="Volume alone is misleading: a redundant source scores below a smaller productive one."
          footer={
            <form action={refreshCapabilities}>
              <button
                type="submit"
                className="rounded px-2 py-1 text-[11px]"
                style={{ border: '1px solid var(--border)' }}
              >
                Recompute capabilities and value
              </button>
            </form>
          }
        >
          {performance.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              No source performance computed yet.
            </p>
          ) : (
            <Table head={['Source', 'Value', 'Jobs/run', 'Dupe rate', 'Errors']}>
              {performance.slice(0, 15).map((row) => (
                <tr key={row.sourceId} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-1.5 text-xs">{row.sourceId}</td>
                  <td className="tabular px-3 py-1.5 text-xs">
                    <Badge tone={row.valueScore >= 60 ? 'ok' : row.valueScore >= 30 ? 'warn' : 'neutral'}>
                      {Math.round(row.valueScore)}
                    </Badge>
                  </td>
                  <td className="tabular px-3 py-1.5 text-xs">{row.averageJobsPerRun.toFixed(1)}</td>
                  <td className="tabular px-3 py-1.5 text-xs">
                    {Math.round(row.duplicateRate * 100)}%
                  </td>
                  <td className="tabular px-3 py-1.5 text-xs">{Math.round(row.errorRate * 100)}%</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {/* ── Capabilities ───────────────────────────────────────────────── */}
      <Card
        title="Source capabilities"
        description="Which mechanism each source is driven by, and which it could support."
      >
        {capabilities.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Capabilities have not been detected yet.
          </p>
        ) : (
          <Table head={['Source', 'Active method', 'Available methods', 'Incremental', 'Conditional']}>
            {capabilities.map((row) => (
              <tr key={row.sourceId} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-1.5 text-xs">{row.sourceId}</td>
                <td className="px-3 py-1.5 text-xs">
                  <Badge tone="accent">{row.activeMethod ?? 'unknown'}</Badge>
                </td>
                <td className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {row.methods.join(' → ')}
                </td>
                <td className="px-3 py-1.5 text-[11px]">
                  {row.capabilities.supportsIncrementalSync ? 'yes' : 'no'}
                </td>
                <td className="px-3 py-1.5 text-[11px]">
                  {row.capabilities.supportsConditionalRequests ? 'yes' : 'no'}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* ── User-provided sources ──────────────────────────────────────── */}
      <Card
        title="Add a source"
        description="Paste a careers page or feed URL. It is inspected and recommended — never activated automatically."
      >
        <form action={submitUrl} className="mb-4 flex flex-wrap items-end gap-2">
          <label className="min-w-64 flex-1 text-xs">
            <span className="mb-1 block font-medium">URL</span>
            <input
              name="url"
              type="url"
              required
              placeholder="https://example.com/careers"
              className="w-full rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            />
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium">Name (optional)</span>
            <input
              name="displayName"
              className="rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            />
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium">Scan every</span>
            <select
              name="frequency"
              defaultValue="360"
              className="rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            >
              <option value="60">1 hour</option>
              <option value="360">6 hours</option>
              <option value="720">12 hours</option>
              <option value="1440">24 hours</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-xs font-medium"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            Inspect
          </button>
        </form>

        {userSources.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            No URLs submitted yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {userSources.slice(0, 20).map((row) => {
              const detection = row.detection as
                | { recommendedConnectorId?: string | null; recommendation?: string; signals?: unknown[] }
                | null;

              return (
                <li
                  key={row.id}
                  className="rounded-md border px-3 py-2"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        row.status === 'active'
                          ? 'ok'
                          : row.status === 'validated'
                            ? 'accent'
                            : row.status === 'rejected'
                              ? 'danger'
                              : 'neutral'
                      }
                    >
                      {row.status}
                    </Badge>
                    <span className="font-mono text-[11px]">{row.url}</span>
                    {row.sourceId && (
                      <Link
                        href="/ops/sources"
                        className="text-[11px]"
                        style={{ color: 'var(--accent)' }}
                      >
                        {row.sourceId}
                      </Link>
                    )}
                  </div>

                  {detection?.recommendation && (
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--muted)' }}>
                      {detection.recommendation}
                    </p>
                  )}
                  {row.rejectionReason && (
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
                      {row.rejectionReason}
                    </p>
                  )}

                  {row.status === 'validated' && (
                    <form action={activate} className="mt-2 flex items-center gap-2">
                      <input type="hidden" name="id" value={row.id} />
                      <label className="flex items-center gap-1.5 text-[11px]">
                        <input type="checkbox" name="confirm" />
                        <span>
                          Activate with the {detection?.recommendedConnectorId} connector
                        </span>
                      </label>
                      <button
                        type="submit"
                        className="rounded px-2 py-0.5 text-[10px]"
                        style={{ border: '1px solid var(--accent)', color: 'var(--accent)' }}
                      >
                        Activate
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ── Recent operations ──────────────────────────────────────────── */}
      <Card title="Recent discovery operations" description="Per-query and per-source telemetry.">
        {telemetry.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            No discovery operations recorded in the last 24 hours.
          </p>
        ) : (
          <Table head={['Started', 'Source', 'Method', 'Query', 'Results', 'Unique', 'Status']}>
            {telemetry.slice(0, 30).map((row) => (
              <tr key={row.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="tabular px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {row.startedAt.toISOString().slice(11, 19)}
                </td>
                <td className="px-3 py-1.5 text-xs">{row.sourceId ?? '—'}</td>
                <td className="px-3 py-1.5 text-[11px]">{row.method}</td>
                <td className="px-3 py-1.5 font-mono text-[10px]" style={{ color: 'var(--muted)' }}>
                  {row.queryText ?? '—'}
                </td>
                <td className="tabular px-3 py-1.5 text-xs">{row.results}</td>
                <td className="tabular px-3 py-1.5 text-xs">{row.uniqueResults}</td>
                <td className="px-3 py-1.5">
                  <Badge tone={row.status === 'success' ? 'ok' : row.status === 'failed' ? 'danger' : 'neutral'}>
                    {row.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
        This system performs <strong>broad multi-source discovery with measurable coverage</strong>.
        It does not search the entire internet, and no part of it is designed to bypass
        authentication, CAPTCHAs, paywalls or other access controls. Sources that cannot be reached
        legitimately are marked unavailable with the reason stated.
      </p>
    </div>
  );
}
