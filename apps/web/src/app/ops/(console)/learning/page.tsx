import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { affinityStars } from '@job-intel/discovery';
import { getLearningContext } from '@/lib/learning';
import { getOpsContext } from '@/lib/ops';
import { currentSession } from '@/lib/auth';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';
import { Metric } from '@/components/ops';

export const dynamic = 'force-dynamic';

/**
 * The feedback loop, from the operator's side.
 *
 * The candidate-facing page at `/learning` answers "what does it think of me".
 * This answers "is the loop working" — event throughput, how much has been
 * learned, whether personalisation is actually improving ranking, and which
 * queries and sources produce jobs the candidate engages with.
 *
 * The conversion metrics are the point. Personalisation that cannot be shown to
 * raise save rate or Precision@K is personalisation nobody can justify.
 */
export default async function OpsLearningPage() {
  const { service, repository, profileId } = await getLearningContext();

  if (!profileId) {
    return (
      <div className="max-w-5xl">
        <PageHeader title="Learning" />
        <EmptyState
          title="No active candidate profile"
          reason="The feedback loop is per candidate. Create a profile before it has anything to measure."
        />
      </div>
    );
  }

  const [state, counts, engagement, history, queryPerf, sourceValue, experiments] =
    await Promise.all([
      service.getLearningState(profileId),
      repository.eventCounts(profileId, 30).catch(() => []),
      repository.latestEngagement(profileId).catch(() => null),
      repository.engagementHistory(profileId, 10).catch(() => []),
      repository.listQueryPerformance(profileId).catch(() => []),
      repository.listSourceUserValue(profileId).catch(() => []),
      repository.listExperiments().catch(() => []),
    ]);

  const { config, profile, affinities, suggestions } = state;
  const totalEvents = counts.reduce((sum, row) => sum + row.count, 0);

  const quality = (engagement?.rankingQuality ?? []) as Array<{
    k: number;
    precisionAtK: number;
    saveAtK: number;
    clickAtK: number;
    applyAtK: number;
    recallOfEngaged: number;
  }>;

  async function recompute() {
    'use server';
    const { service: svc, profileId: id } = await getLearningContext();
    if (!id) return;

    // Full recompute: the path an algorithm-version bump takes. History is
    // replayed rather than migrated.
    await svc.updateBehavioralProfile(id, { full: true });
    await svc.updatePerformance(id);
    await svc.computeAnalytics(id);
    await svc.generatePreferenceSuggestions(id);

    const { repository: opsRepo } = await getOpsContext();
    await opsRepo.recordAudit({
      action: 'config.updated',
      actor: (await currentSession())?.actor ?? 'local',
      target: id,
      after: { recomputed: true },
      reason: 'behavioural profile recomputed from full history',
    });

    revalidatePath('/ops/learning');
  }

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Learning"
        description="Is the feedback loop working, and is it making recommendations better?"
        actions={
          <div className="flex items-center gap-3">
            <Link href="/learning" className="text-xs" style={{ color: 'var(--accent)' }}>
              Candidate view →
            </Link>
            <form action={recompute}>
              <button
                type="submit"
                className="rounded-md px-3 py-1.5 text-xs font-medium"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                Recompute from full history
              </button>
            </form>
          </div>
        }
      />

      {/* ── State ──────────────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <Metric label="Events (30d)" value={totalEvents} />
        <Metric label="Total events" value={profile?.totalEvents ?? 0} />
        <Metric label="Learned signals" value={affinities.length} />
        <Metric label="Distinct jobs" value={profile?.distinctJobs ?? 0} />
        <Metric
          label="Personalization"
          value={config.enabled ? (config.frozen ? 'frozen' : 'on') : 'off'}
          tone={config.enabled ? undefined : 'warn'}
        />
        <Metric label="Suggestions" value={suggestions.length} />
      </section>

      {profile && !profile.hasSufficientData && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
        >
          <strong>Cold start.</strong> {profile.coldStartReason}
        </div>
      )}

      {/* ── Event breakdown ────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Behaviour events" description="Last 30 days, by type.">
          {counts.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              No interactions recorded.
            </p>
          ) : (
            <Table head={['Event', 'Count']}>
              {counts
                .slice()
                .sort((a, b) => b.count - a.count)
                .map((row) => (
                  <tr key={row.eventType} className="border-b" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-3 py-1.5 text-xs">{row.eventType}</td>
                    <td className="tabular px-3 py-1.5 text-xs">{row.count}</td>
                  </tr>
                ))}
            </Table>
          )}
        </Card>

        <Card
          title="Conversion"
          description="Rates against recommendations actually shown."
        >
          {!engagement ? (
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              No analytics snapshot yet.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Metric label="Shown" value={engagement.recommendationsShown} />
              <Metric label="View rate" value={`${Math.round(engagement.viewRate * 100)}%`} />
              <Metric label="Click rate" value={`${Math.round(engagement.clickRate * 100)}%`} />
              <Metric label="Save rate" value={`${Math.round(engagement.saveRate * 100)}%`} />
              <Metric
                label="Apply rate"
                value={`${Math.round(engagement.applicationRate * 100)}%`}
              />
              <Metric
                label="Acceptance"
                value={`${Math.round(engagement.acceptanceRate * 100)}%`}
                tone={engagement.acceptanceRate < 0.05 ? 'warn' : 'ok'}
              />
            </div>
          )}
        </Card>
      </div>

      {/* ── Ranking quality ────────────────────────────────────────────── */}
      <Card
        title="Recommendation quality"
        description="Whether the top of the list is the useful part. Recall is measured against what you engaged with, not against every good job that exists."
      >
        {quality.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            No ranking quality computed yet.
          </p>
        ) : (
          <Table head={['K', 'Precision@K', 'Click@K', 'Save@K', 'Apply@K', 'Recall of engaged']}>
            {quality.map((row) => (
              <tr key={row.k} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-1.5 text-xs font-medium">{row.k}</td>
                <td className="tabular px-3 py-1.5 text-xs">
                  {(row.precisionAtK * 100).toFixed(1)}%
                </td>
                <td className="tabular px-3 py-1.5 text-xs">{(row.clickAtK * 100).toFixed(1)}%</td>
                <td className="tabular px-3 py-1.5 text-xs">{(row.saveAtK * 100).toFixed(1)}%</td>
                <td className="tabular px-3 py-1.5 text-xs">{(row.applyAtK * 100).toFixed(1)}%</td>
                <td className="tabular px-3 py-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                  {(row.recallOfEngaged * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
          </Table>
        )}

        {history.length > 1 && (
          <div className="mt-3">
            <h3 className="mb-1 text-xs font-semibold">Save rate over time</h3>
            <ul className="space-y-1">
              {history
                .slice()
                .reverse()
                .map((snapshot) => (
                  <li key={snapshot.id} className="flex items-center gap-2 text-[11px]">
                    <span className="tabular w-20" style={{ color: 'var(--muted)' }}>
                      {snapshot.computedAt.toISOString().slice(0, 10)}
                    </span>
                    <span
                      className="h-1.5 rounded"
                      style={{
                        width: `${Math.max(1, snapshot.saveRate * 200)}%`,
                        background: 'var(--accent)',
                      }}
                    />
                    <span className="tabular">{(snapshot.saveRate * 100).toFixed(1)}%</span>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </Card>

      {/* ── Learned signals ────────────────────────────────────────────── */}
      <Card
        title="Behavioural profile"
        description="Signals ordered by how confidently they are held."
      >
        {affinities.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Nothing learned yet.
          </p>
        ) : (
          <Table head={['Dimension', 'Value', 'Affinity', 'Confidence', 'Sample', 'Conflict']}>
            {affinities.slice(0, 25).map((affinity) => (
              <tr
                key={`${affinity.dimension}-${affinity.value}`}
                className="border-b"
                style={{ borderColor: 'var(--border)' }}
              >
                <td className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {affinity.dimension}
                </td>
                <td className="px-3 py-1.5 text-xs font-medium">{affinity.value}</td>
                <td
                  className="tabular px-3 py-1.5 text-xs"
                  style={{ color: affinity.affinity >= 0 ? 'var(--ok)' : 'var(--warn)' }}
                >
                  {affinity.affinity.toFixed(2)} ({'★'.repeat(affinityStars(affinity))})
                </td>
                <td className="tabular px-3 py-1.5 text-xs">
                  {Math.round(affinity.confidence * 100)}%
                </td>
                <td className="tabular px-3 py-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                  {affinity.sampleSize}
                </td>
                <td className="px-3 py-1.5">
                  {affinity.conflictsWithExplicit && <Badge tone="warn">contradicts explicit</Badge>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* ── Query and source learning ──────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Query value"
          description="Which discovery queries produce jobs you actually engage with."
        >
          {queryPerf.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              No query performance computed yet.
            </p>
          ) : (
            <Table head={['Query', 'Value', 'Clicks', 'Saves', 'Applies']}>
              {queryPerf.slice(0, 15).map((row) => (
                <tr key={row.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-1.5 font-mono text-[10px]">{row.queryId.slice(0, 16)}</td>
                  <td className="tabular px-3 py-1.5 text-xs">
                    <Badge tone={row.valueScore >= 40 ? 'ok' : row.valueScore > 0 ? 'warn' : 'neutral'}>
                      {Math.round(row.valueScore)}
                    </Badge>
                  </td>
                  <td className="tabular px-3 py-1.5 text-xs">{row.clicks}</td>
                  <td className="tabular px-3 py-1.5 text-xs">{row.saves}</td>
                  <td className="tabular px-3 py-1.5 text-xs">{row.applications}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card
          title="Source value to you"
          description="Distinct from technical source health — a reliable source can still be useless."
          footer={
            <Link href="/ops/discovery" className="text-[11px]" style={{ color: 'var(--accent)' }}>
              Technical source health →
            </Link>
          }
        >
          {sourceValue.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              No source value computed yet.
            </p>
          ) : (
            <Table head={['Source', 'User value', 'Jobs', 'Saves', 'Applies']}>
              {sourceValue.slice(0, 15).map((row) => (
                <tr key={row.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-1.5 text-xs">{row.sourceId}</td>
                  <td className="tabular px-3 py-1.5 text-xs">
                    <Badge
                      tone={row.userValueScore >= 40 ? 'ok' : row.userValueScore > 0 ? 'warn' : 'neutral'}
                    >
                      {Math.round(row.userValueScore)}
                    </Badge>
                  </td>
                  <td className="tabular px-3 py-1.5 text-xs">{row.jobsDiscovered}</td>
                  <td className="tabular px-3 py-1.5 text-xs">{row.saves}</td>
                  <td className="tabular px-3 py-1.5 text-xs">{row.applications}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {/* ── Suggestions and experiments ────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pending suggestions" description="Offered to the candidate. Never auto-applied.">
          {suggestions.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              None pending.
            </p>
          ) : (
            <ul className="space-y-2">
              {suggestions.map((suggestion) => (
                <li key={suggestion.id} className="text-xs">
                  <span className="font-mono text-[10px]" style={{ color: 'var(--muted)' }}>
                    {suggestion.path}
                  </span>
                  <p>{suggestion.message}</p>
                  <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                    confidence {Math.round(suggestion.confidence * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Experiments"
          description="Nobody is enrolled unless explicitly added — defining one does not start it."
        >
          {experiments.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              No experiments defined.
            </p>
          ) : (
            <Table head={['Experiment', 'Status', 'Variants', 'Enrolled']}>
              {experiments.map((experiment) => (
                <tr key={experiment.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-1.5 text-xs">{experiment.name}</td>
                  <td className="px-3 py-1.5">
                    <Badge tone={experiment.status === 'running' ? 'accent' : 'neutral'}>
                      {experiment.status}
                    </Badge>
                  </td>
                  <td className="tabular px-3 py-1.5 text-xs">{experiment.variants.length}</td>
                  <td className="tabular px-3 py-1.5 text-xs">
                    {experiment.enrolledCandidateIds.length}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
        Learned signals never override explicit preferences. Where behaviour contradicts something
        the candidate stated, the signal is suppressed in ranking and surfaced as a suggestion they
        can accept or decline. No sensitive personal characteristic is inferred or used — the
        feature model has no dimension in which one could be recorded.
      </p>
    </div>
  );
}
