import Link from 'next/link';
import { getServerContext } from '@/lib/db';
import { WorkerStatus } from '@/components/worker-status';
import { Badge, Card, EmptyState, PageHeader, Stat, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Dashboard.
 *
 * A server component reading real repository data. Counts are whatever the
 * database actually holds, zero included — never a plausible-looking
 * placeholder.
 */
export default async function DashboardPage() {
  const ctx = await getServerContext();

  const [profile, sources, jobCounts, runs, config] = await Promise.all([
    ctx.profiles.getActiveProfile(),
    ctx.sources.list(),
    ctx.jobs.countsByStatus(),
    ctx.sources.listRuns(undefined, 5),
    ctx.config.get(),
  ]);

  const enabled = sources.filter((s) => s.enabled);
  const restricted = sources.filter((s) => s.accessTier === 'restricted');
  const totalJobs = Object.values(jobCounts).reduce((sum, n) => sum + n, 0);

  return (
    <>
      <WorkerStatus />

      <PageHeader
        title="Dashboard"
        description="Discovery pipeline status and system health."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Jobs discovered" value={totalJobs} hint={`${jobCounts.active ?? 0} active`} />
        <Stat
          label="Sources"
          value={`${enabled.length}/${sources.length}`}
          hint={`${restricted.length} restricted by policy`}
        />
        <Stat label="Discovery runs" value={runs.length} hint="most recent" />
        <Stat
          label="Profile version"
          value={profile ? `v${profile.version}` : '—'}
          hint={profile ? 'active' : 'not configured'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Pipeline status"
          description="Where the corpus currently sits."
        >
          {totalJobs === 0 ? (
            <EmptyState
              title="No jobs discovered yet"
              reason="The worker checks every enabled source once an hour. If this stays at zero, the Sources page will say which source is failing and why."
              action={
                <Link
                  href="/sources"
                  className="text-sm underline"
                  style={{ color: 'var(--accent)' }}
                >
                  Review sources
                </Link>
              }
            />
          ) : (
            <Table head={['Status', 'Count']}>
              {Object.entries(jobCounts).map(([status, count]) => (
                <tr key={status} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-2">{status}</td>
                  <td className="tabular px-3 py-2">{count}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Effective configuration" description="Resolved defaults plus stored overrides.">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt style={{ color: 'var(--muted)' }}>Minimum match score</dt>
            <dd className="tabular">{config.matching.minimumScore}</dd>
            <dt style={{ color: 'var(--muted)' }}>Exceptional at</dt>
            <dd className="tabular">{config.matching.exceptionalScore}</dd>
            <dt style={{ color: 'var(--muted)' }}>AI matching</dt>
            <dd>
              <Badge tone={config.ai.enabled ? 'ok' : 'neutral'}>
                {config.ai.enabled ? 'enabled' : 'disabled'}
              </Badge>
            </dd>
            <dt style={{ color: 'var(--muted)' }}>Database driver</dt>
            <dd>{ctx.handle.driver}</dd>
          </dl>
        </Card>

        <Card title="Recent discovery runs" description="Every run is recorded, including failures.">
          {runs.length === 0 ? (
            <EmptyState
              title="No runs recorded"
              reason="Runs appear once the scheduler and connectors are active."
            />
          ) : (
            <Table head={['Source', 'Status', 'Discovered', 'Started']}>
              {runs.map((run) => (
                <tr key={run.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-2">{run.sourceId}</td>
                  <td className="px-3 py-2">
                    <Badge tone={run.status === 'success' ? 'ok' : 'warn'}>{run.status}</Badge>
                  </td>
                  <td className="tabular px-3 py-2">{run.jobsDiscovered}</td>
                  <td className="px-3 py-2">{run.startedAt.toISOString().slice(0, 16)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Candidate profile" description="The only source of matching preferences.">
          {!profile ? (
            <EmptyState
              title="No candidate profile"
              reason="Run `pnpm db:seed` for a development profile, or create one from the Profile page."
            />
          ) : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt style={{ color: 'var(--muted)' }}>Name</dt>
              <dd>{profile.payload.identity.fullName}</dd>
              <dt style={{ color: 'var(--muted)' }}>Current title</dt>
              <dd>{profile.payload.professional.currentTitle ?? '—'}</dd>
              <dt style={{ color: 'var(--muted)' }}>Work arrangements</dt>
              <dd>
                {profile.payload.preferences.location.remoteTypes.join(', ') || 'no constraint'}
              </dd>
              <dt style={{ color: 'var(--muted)' }}>Countries</dt>
              <dd>{profile.payload.preferences.location.countries.join(', ') || 'no constraint'}</dd>
              <dt style={{ color: 'var(--muted)' }}>Minimum salary</dt>
              <dd className="tabular">
                {profile.payload.preferences.salary.minimum
                  ? `${profile.payload.preferences.salary.minimum.toLocaleString()} ${profile.payload.preferences.salary.currency}`
                  : 'not set'}
              </dd>
            </dl>
          )}
        </Card>
      </div>
    </>
  );
}
