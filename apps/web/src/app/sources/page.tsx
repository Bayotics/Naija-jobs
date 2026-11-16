import { getServerContext } from '@/lib/db';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';
import type { AccessTier, SourceHealthStatus } from '@job-intel/contracts';

export const dynamic = 'force-dynamic';

const TIER_TONE: Record<AccessTier, 'ok' | 'accent' | 'warn' | 'danger' | 'neutral'> = {
  official_api: 'ok',
  public_feed: 'ok',
  permitted_html: 'warn',
  search_discovery: 'accent',
  user_provided: 'accent',
  restricted: 'danger',
};

const HEALTH_TONE: Record<SourceHealthStatus, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  healthy: 'ok',
  degraded: 'warn',
  failing: 'danger',
  disabled: 'neutral',
  unknown: 'neutral',
};

/**
 * Source registry.
 *
 * Note the `restricted` rows: sources the system must not scrape are registered
 * with a stated reason and never fetched, so the operator can see the coverage
 * gap and how it is compensated for, rather than wondering why LinkedIn is
 * missing.
 */
export default async function SourcesPage() {
  const ctx = await getServerContext();
  const sources = await ctx.sources.list({ includeArchived: false });

  const restricted = sources.filter((s) => s.accessTier === 'restricted');
  const active = sources.filter((s) => s.accessTier !== 'restricted');

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Sources"
        description="Each row binds a connector to a configuration and a schedule. Adding a source is a database row, not a deploy."
      />

      {sources.length === 0 ? (
        <EmptyState
          title="No sources registered"
          reason="Run `pnpm db:seed` to register the example source set."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <Card title="Registered sources" description={`${active.length} available to schedule`}>
            <Table head={['Source', 'Connector', 'Tier', 'Schedule', 'Priority', 'Health', 'State']}>
              {active.map((s) => (
                <tr key={s.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{s.displayName}</div>
                    <div className="text-xs" style={{ color: 'var(--muted)' }}>
                      {s.id}
                    </div>
                  </td>
                  <td className="px-3 py-2">{s.connectorId}</td>
                  <td className="px-3 py-2">
                    <Badge tone={TIER_TONE[s.accessTier]}>{s.accessTier}</Badge>
                  </td>
                  <td className="tabular px-3 py-2 text-xs">{s.scheduleCron}</td>
                  <td className="tabular px-3 py-2">P{s.priority}</td>
                  <td className="px-3 py-2">
                    <Badge tone={HEALTH_TONE[s.healthStatus]}>{s.healthStatus}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={s.enabled ? 'ok' : 'neutral'}>
                      {s.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </Table>
            <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
              Sources are disabled until their connector is implemented (prompt 5). Enable and
              schedule them from here or via <code>PATCH /api/v1/sources/:id</code>.
            </p>
          </Card>

          {restricted.length > 0 && (
            <Card
              title="Restricted by policy"
              description="Registered so the coverage gap is visible. These are never fetched."
            >
              <ul className="flex flex-col gap-3">
                {restricted.map((s) => (
                  <li key={s.id}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{s.displayName}</span>
                      <Badge tone="danger">restricted</Badge>
                    </div>
                    <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                      {s.restrictionReason}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
