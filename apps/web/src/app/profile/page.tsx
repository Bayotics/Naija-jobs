import { getServerContext } from '@/lib/db';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';
import { ProfileForm } from './profile-form';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const ctx = await getServerContext();
  const profile = await ctx.profiles.getActiveProfile();
  const versions = profile ? await ctx.profiles.listVersions(profile.profileId, 10) : [];

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Candidate Profile"
        description="Identity and professional background. Stored as an append-only version history so past match scores stay interpretable."
      />

      {!profile ? (
        <EmptyState
          title="No candidate profile"
          reason="Run `pnpm db:seed` to create a development profile, or POST to /api/v1/profile to create one."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <ProfileForm payload={profile.payload} />

          <Card
            title="Version history"
            description="Every change is a new immutable version; exactly one is active."
          >
            <Table head={['Version', 'Summary', 'Created', 'Active']}>
              {versions.map((v) => (
                <tr key={v.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="tabular px-3 py-2">v{v.version}</td>
                  <td className="px-3 py-2">{v.changeSummary ?? '—'}</td>
                  <td className="px-3 py-2">{v.createdAt.toISOString().slice(0, 16)}</td>
                  <td className="px-3 py-2">
                    {v.isActive ? <Badge tone="ok">active</Badge> : null}
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </div>
  );
}
