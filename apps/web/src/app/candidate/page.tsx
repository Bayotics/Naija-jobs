import { CandidateRepository } from '@job-intel/db';
import { getServerContext } from '@/lib/db';
import { getCandidateService } from '@/lib/candidate';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';
import { CandidateForm } from './candidate-form';

export const dynamic = 'force-dynamic';

/**
 * Candidate intelligence configuration.
 *
 * Everything the matching engine reads about the candidate is editable here,
 * and the page states plainly which controls create hard constraints — the
 * distinction that decides whether a mismatch ranks a job lower or removes it.
 */
export default async function CandidatePage() {
  const ctx = await getServerContext();
  const profile = await ctx.profiles.getActiveProfile();

  if (!profile) {
    return (
      <div className="max-w-5xl">
        <PageHeader title="Candidate intelligence" />
        <EmptyState
          title="No candidate profile"
          reason="Run `pnpm db:seed` for a development profile, or create one from the Candidate Profile page."
        />
      </div>
    );
  }

  const { service } = await getCandidateService();
  const repository = new CandidateRepository(ctx.handle.db);

  const [{ preferences, version }, history, signals, canonical] = await Promise.all([
    service.getPreferences(profile.profileId),
    repository.listPreferenceChanges(profile.profileId, 15),
    repository.signalCounts(profile.profileId),
    service.refreshCanonicalProfile(profile.profileId),
  ]);

  const signalTotal = Object.values(signals).reduce((sum, n) => sum + n, 0);

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Candidate intelligence"
        description="Who you are, what you want, and what is non-negotiable. Every value here is data — changing it takes effect on the next matching run with no redeploy."
      />

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="Semantic profile" description="Derived from your profile and preferences.">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt style={{ color: 'var(--muted)' }}>Embedding</dt>
            <dd>
              <Badge tone={canonical.stale ? 'warn' : 'ok'}>
                {canonical.stale ? 'regeneration queued' : 'current'}
              </Badge>
            </dd>
            <dt style={{ color: 'var(--muted)' }}>Reason</dt>
            <dd className="text-xs">{canonical.reason}</dd>
            <dt style={{ color: 'var(--muted)' }}>Content hash</dt>
            <dd className="font-mono text-xs">{canonical.hash.slice(0, 16)}…</dd>
          </dl>
          <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
            {canonical.text.slice(0, 280) || 'Nothing to embed yet — add skills and target roles.'}
          </p>
        </Card>

        <Card
          title="Behavioural signals"
          description="What your actions suggest. Never applied automatically."
        >
          {signalTotal === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              No interactions recorded yet. Saving, applying to or dismissing jobs builds this up.
            </p>
          ) : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {Object.entries(signals).map(([event, count]) => (
                <div key={event} className="contents">
                  <dt style={{ color: 'var(--muted)' }}>{event.replace(/_/g, ' ')}</dt>
                  <dd className="tabular">{count}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
            Learned signals are kept separate from your explicit preferences and are only ever
            offered as suggestions.
          </p>
        </Card>
      </div>

      <CandidateForm initial={preferences} version={version} />

      <div className="mt-4">
        <Card
          title="Preference history"
          description="Field-level record of what changed and when, so an older match can still be explained."
        >
          {history.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              No changes recorded yet.
            </p>
          ) : (
            <Table head={['When', 'Path', 'Change', 'Embedding']}>
              {history.map((change) => (
                <tr key={change.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-2 text-xs">
                    {change.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{change.path}</td>
                  <td className="px-3 py-2 text-sm">{change.summary}</td>
                  <td className="px-3 py-2">
                    {change.invalidatedEmbedding ? <Badge tone="warn">invalidated</Badge> : null}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
