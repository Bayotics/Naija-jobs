import { getServerContext } from '@/lib/db';
import { Badge, Card, PageHeader, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Runtime application configuration.
 *
 * Deliberately separate from Preferences: this is *how the system behaves*,
 * not *what the candidate wants*. Both are runtime data; conflating them is
 * what makes a preference change require a deploy.
 */
export default async function SettingsPage() {
  const ctx = await getServerContext();
  const [config, overrides] = await Promise.all([ctx.config.get(), ctx.appConfig.listRaw()]);

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Settings"
        description="Application configuration: code defaults overlaid with stored overrides. Secrets live in the environment and are never shown here."
      />

      <div className="flex flex-col gap-4">
        <Card title="Stored overrides" description="Rows in `app_config`, deep-merged onto defaults.">
          {overrides.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              No overrides — the system is running entirely on code defaults.
            </p>
          ) : (
            <Table head={['Key', 'Value', 'Updated by', 'Updated']}>
              {overrides.map((row) => (
                <tr key={row.key} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-2 font-mono text-xs">{row.key}</td>
                  <td className="px-3 py-2 font-mono text-xs">{JSON.stringify(row.value)}</td>
                  <td className="px-3 py-2 text-xs">{row.updatedBy ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">
                    {row.updatedAt.toISOString().slice(0, 16)}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Effective configuration" description="What the pipeline actually reads.">
          <pre
            className="scroll-x rounded-md p-3 text-xs"
            style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
          >
            {JSON.stringify(config, null, 2)}
          </pre>
        </Card>

        <Card title="Runtime" description="Deployment topology, from validated environment.">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt style={{ color: 'var(--muted)' }}>Environment</dt>
            <dd>{ctx.env.NODE_ENV}</dd>
            <dt style={{ color: 'var(--muted)' }}>Database driver</dt>
            <dd>
              {ctx.env.DATABASE_DRIVER}{' '}
              {ctx.env.DATABASE_DRIVER === 'pglite' && <Badge tone="warn">dev only</Badge>}
            </dd>
            <dt style={{ color: 'var(--muted)' }}>Queue driver</dt>
            <dd>
              {ctx.env.QUEUE_DRIVER}{' '}
              {ctx.env.QUEUE_DRIVER === 'inmemory' && <Badge tone="warn">not durable</Badge>}
            </dd>
            <dt style={{ color: 'var(--muted)' }}>Log level</dt>
            <dd>{ctx.env.LOG_LEVEL}</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}
