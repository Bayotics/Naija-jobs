import { getServerContext } from '@/lib/db';
import { Card, EmptyState, PageHeader, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function SavedPage() {
  const ctx = await getServerContext();
  const profile = await ctx.profiles.getActiveProfile();
  const saved = profile ? await ctx.engagement.listApplications(profile.profileId, 'saved') : [];

  return (
    <div className="max-w-5xl">
      <PageHeader title="Saved" description="Jobs you marked to revisit." />

      {saved.length === 0 ? (
        <EmptyState
          title="Nothing saved"
          reason="Saving a job from the jobs list records feedback and files it here."
        />
      ) : (
        <Card title={`${saved.length} saved`}>
          <Table head={['Job', 'Company', 'Saved at']}>
            {saved.map((a) => (
              <tr key={a.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-2">
                  <a
                    href={a.canonicalUrl ?? a.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline"
                    style={{ color: 'var(--accent)' }}
                  >
                    {a.jobTitle}
                  </a>
                </td>
                <td className="px-3 py-2">{a.companyName}</td>
                <td className="px-3 py-2 text-xs">
                  {a.lastTransitionAt.toISOString().slice(0, 16)}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
