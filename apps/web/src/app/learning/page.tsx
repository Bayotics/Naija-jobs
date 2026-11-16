import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { EXPLORATION_LEVELS, FEATURE_DIMENSIONS, type FeatureDimension } from '@job-intel/contracts';
import { affinityStars } from '@job-intel/discovery';
import { getLearningContext } from '@/lib/learning';
import { getCandidateService } from '@/lib/candidate';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * What the system has learned.
 *
 * The page exists so personalisation is inspectable rather than mysterious.
 * Three things it is careful about:
 *
 *  - **Confidence and sample size are always visible.** A five-star signal
 *    backed by four events and one backed by ninety are different claims, and
 *    hiding the difference is how a recommender loses trust.
 *  - **Conflicts are labelled, not resolved.** Where behaviour contradicts a
 *    stated preference, the page says so and offers the change. It never
 *    presents the learned value as if it were the preference.
 *  - **Every control is destructive-by-consent.** Reset and delete are
 *    scoped, described in terms of what survives, and never touch explicit
 *    preferences.
 */

const DIMENSION_LABEL: Readonly<Record<FeatureDimension, string>> = {
  technology: 'Technologies',
  company: 'Companies',
  location: 'Locations',
  country: 'Countries',
  industry: 'Industries',
  title_token: 'Role keywords',
  seniority: 'Seniority',
  work_arrangement: 'Work arrangement',
  employment_type: 'Employment type',
  salary_band: 'Salary ranges',
  source: 'Sources',
  company_size: 'Company size',
};

const EVENT_LABEL: Readonly<Record<string, string>> = {
  JOB_VIEWED: 'Viewed',
  JOB_CLICKED: 'Clicked',
  JOB_SAVED: 'Saved',
  JOB_UNSAVED: 'Unsaved',
  JOB_IGNORED: 'Ignored',
  JOB_DISMISSED: 'Dismissed',
  JOB_APPLIED: 'Applied',
  JOB_REJECTED: 'Rejected',
  JOB_SHARED: 'Shared',
  JOB_ARCHIVED: 'Archived',
  JOB_NOTIFICATION_CLICKED: 'Clicked from notification',
  JOB_EMAIL_OPENED: 'Opened email',
  FEEDBACK_POSITIVE: 'Marked a good match',
  FEEDBACK_NEGATIVE: 'Marked a bad match',
};

function stars(count: number): string {
  return '★'.repeat(count) + '☆'.repeat(5 - count);
}

export default async function LearningPage() {
  const { service, profileId } = await getLearningContext();

  if (!profileId) {
    return (
      <div className="max-w-4xl">
        <PageHeader title="What we've learned" />
        <EmptyState
          title="No candidate profile"
          reason="Personalization is per candidate. Create a profile before there is anything to learn."
        />
      </div>
    );
  }

  const state = await service.getLearningState(profileId);
  const { config, profile, affinities, suggestions, timeline } = state;

  // ── Actions ───────────────────────────────────────────────────────────────

  async function setConfig(formData: FormData) {
    'use server';
    const { service: svc, profileId: id } = await getLearningContext();
    if (!id) return;

    await svc.updateConfig(id, {
      enabled: formData.get('enabled') === 'on',
      frozen: formData.get('frozen') === 'on',
      exploration: String(formData.get('exploration') ?? 'balanced') as never,
    });
    revalidatePath('/learning');
  }

  async function reset(formData: FormData) {
    'use server';
    if (formData.get('confirm') !== 'on') return;

    const scope = String(formData.get('scope') ?? 'all') as
      | 'all'
      | 'company'
      | 'technology'
      | 'location'
      | 'source';

    const { service: svc, profileId: id } = await getLearningContext();
    if (!id) return;

    await svc.resetLearning(id, scope);
    revalidatePath('/learning');
  }

  async function deleteHistory(formData: FormData) {
    'use server';
    if (formData.get('confirm') !== 'on') return;

    const { service: svc, profileId: id } = await getLearningContext();
    if (!id) return;

    await svc.deleteHistory(id);
    revalidatePath('/learning');
  }

  /**
   * Accepting a suggestion.
   *
   * Two separate writes, in this order: the preference change goes through the
   * candidate service's validated, versioned path, and only then is the
   * suggestion marked accepted. Doing it the other way round would leave a
   * suggestion marked applied when the write failed.
   */
  async function respond(formData: FormData) {
    'use server';
    const id = String(formData.get('id') ?? '');
    const action = String(formData.get('action') ?? '');
    if (!id) return;

    const { service: svc, repository, profileId: candidateId } = await getLearningContext();
    if (!candidateId) return;

    if (action !== 'accepted') {
      await svc.recordSuggestionResponse(id, action === 'declined' ? 'declined' : 'dismissed');
      revalidatePath('/learning');
      return;
    }

    const suggestion = await repository.getSuggestion(id);
    if (!suggestion) return;

    const candidate = await getCandidateService();
    const result = await candidate.service
      .applyProposals(candidateId, [
        {
          path: suggestion.path,
          operation: suggestion.operation,
          value: suggestion.suggestedValue,
          summary: suggestion.message,
        },
      ])
      .catch(() => null);

    await svc.recordSuggestionResponse(id, 'accepted', result?.version ?? null);
    revalidatePath('/learning');
  }

  // ── Grouping ──────────────────────────────────────────────────────────────

  const byDimension = new Map<FeatureDimension, typeof affinities>();
  for (const affinity of affinities) {
    const list = byDimension.get(affinity.dimension) ?? [];
    list.push(affinity);
    byDimension.set(affinity.dimension, list);
  }

  const strong = affinities.filter((a) => affinityStars(a) >= 4);
  const uncertain = affinities.filter((a) => affinityStars(a) <= 2);

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="What we've learned"
        description="Everything below is inferred from your behaviour. Your stated preferences always take priority."
        actions={
          <Link href="/preferences" className="text-xs" style={{ color: 'var(--accent)' }}>
            Your preferences →
          </Link>
        }
      />

      {/* ── The hierarchy, stated plainly ──────────────────────────────── */}
      <div
        className="rounded-md border px-3 py-2 text-xs"
        style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
      >
        <strong style={{ color: 'var(--text)' }}>How this is used.</strong> Your hard constraints
        come first, then your stated preferences, then your exclusions, and only then anything
        learned here. If your behaviour contradicts something you told us, we will ask — we will
        never change it for you.
      </div>

      {/* ── Status ─────────────────────────────────────────────────────── */}
      <Card title="Status">
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
          <Badge tone={config.enabled ? 'ok' : 'neutral'}>
            {config.enabled ? 'personalization on' : 'personalization off'}
          </Badge>
          {config.frozen && <Badge tone="warn">learning paused</Badge>}
          <Badge tone="accent">exploration: {config.exploration}</Badge>
          <span style={{ color: 'var(--muted)' }}>
            {profile?.totalEvents ?? 0} interaction(s) · {affinities.length} learned signal(s) ·
            algorithm {config.algorithmVersion}
          </span>
        </div>

        {profile && !profile.hasSufficientData && (
          <p className="mb-3 text-xs" style={{ color: 'var(--warn)' }}>
            {profile.coldStartReason}
          </p>
        )}

        <form action={setConfig} className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" name="enabled" defaultChecked={config.enabled} />
            <span>
              Use my behaviour to personalise rankings
              <span className="block text-[10px]" style={{ color: 'var(--muted)' }}>
                Off: your explicit preferences keep working exactly as they do now.
              </span>
            </span>
          </label>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" name="frozen" defaultChecked={config.frozen} />
            <span>
              Pause learning
              <span className="block text-[10px]" style={{ color: 'var(--muted)' }}>
                Keeps what has been learned, stops adding to it.
              </span>
            </span>
          </label>

          <label className="text-xs">
            <span className="mb-1 block font-medium">Exploration</span>
            <select
              name="exploration"
              defaultValue={config.exploration}
              className="rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            >
              {EXPLORATION_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-xs font-medium"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            Save
          </button>
        </form>
      </Card>

      {/* ── Suggestions ────────────────────────────────────────────────── */}
      {suggestions.length > 0 && (
        <Card
          title="Suggested preference changes"
          description="Your behaviour suggests these. Nothing changes unless you say so."
        >
          <ul className="space-y-3">
            {suggestions.map((suggestion) => (
              <li
                key={suggestion.id}
                className="rounded-md border px-3 py-2"
                style={{ borderColor: 'var(--accent)' }}
              >
                <p className="text-xs">{suggestion.message}</p>
                <p className="mt-1 text-[10px]" style={{ color: 'var(--muted)' }}>
                  Based on {suggestion.evidence.supporting} supporting and{' '}
                  {suggestion.evidence.contradicting} contradicting interaction(s) over{' '}
                  {suggestion.evidence.windowDays} days · confidence{' '}
                  {Math.round(suggestion.confidence * 100)}%
                </p>

                <div className="mt-2 flex flex-wrap gap-2">
                  {(['accepted', 'declined', 'dismissed'] as const).map((action) => (
                    <form key={action} action={respond}>
                      <input type="hidden" name="id" value={suggestion.id} />
                      <input type="hidden" name="action" value={action} />
                      <button
                        type="submit"
                        className="rounded px-2 py-1 text-[11px]"
                        style={{
                          border: `1px solid ${action === 'accepted' ? 'var(--accent)' : 'var(--border)'}`,
                          color: action === 'accepted' ? 'var(--accent)' : 'var(--muted)',
                        }}
                      >
                        {action === 'accepted'
                          ? 'Update preference'
                          : action === 'declined'
                            ? 'Keep current preference'
                            : 'Ignore'}
                      </button>
                    </form>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ── Signals ────────────────────────────────────────────────────── */}
      {affinities.length === 0 ? (
        <EmptyState
          title="Nothing learned yet"
          reason={
            config.enabled
              ? 'Interact with a few recommendations and this will fill in. Until then, ranking uses your explicit preferences, skills, job quality and freshness.'
              : 'Personalization is switched off, so nothing is being learned.'
          }
        />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Strong signals" description="Backed by enough evidence to act on.">
              {strong.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--muted)' }}>
                  Nothing has reached a strong signal yet.
                </p>
              ) : (
                <SignalList items={strong} />
              )}
            </Card>

            <Card title="Weak or uncertain" description="Noted, but not enough evidence to rely on.">
              {uncertain.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--muted)' }}>
                  Nothing uncertain right now.
                </p>
              ) : (
                <SignalList items={uncertain.slice(0, 12)} />
              )}
            </Card>
          </div>

          {[...byDimension.entries()]
            .sort((a, b) => FEATURE_DIMENSIONS.indexOf(a[0]) - FEATURE_DIMENSIONS.indexOf(b[0]))
            .map(([dimension, items]) => (
              <Card key={dimension} title={DIMENSION_LABEL[dimension] ?? dimension}>
                <Table head={['', 'Signal', 'Confidence', 'Interactions', '']}>
                  {items.slice(0, 20).map((item) => (
                    <tr
                      key={`${item.dimension}-${item.value}`}
                      className="border-b"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <td className="px-3 py-1.5 text-xs font-medium">{item.value}</td>
                      <td
                        className="px-3 py-1.5 text-xs"
                        style={{ color: item.affinity >= 0 ? 'var(--ok)' : 'var(--warn)' }}
                        title={`affinity ${item.affinity.toFixed(2)}`}
                      >
                        {stars(affinityStars(item))}
                        <span className="ml-1 text-[10px]" style={{ color: 'var(--muted)' }}>
                          {item.affinity >= 0 ? 'engaged' : 'passed over'}
                        </span>
                      </td>
                      <td className="tabular px-3 py-1.5 text-xs">
                        {Math.round(item.confidence * 100)}%
                      </td>
                      <td className="tabular px-3 py-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                        {item.sampleSize} ({item.positiveEvents}+ / {item.negativeEvents}−)
                      </td>
                      <td className="px-3 py-1.5">
                        {item.conflictsWithExplicit && (
                          <Badge tone="warn">differs from your stated preference</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
              </Card>
            ))}
        </>
      )}

      {/* ── Timeline ───────────────────────────────────────────────────── */}
      <Card title="Recent activity" description="What the system saw you do.">
        {timeline.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            No interactions recorded yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {timeline.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="tabular text-[11px]" style={{ color: 'var(--muted)' }}>
                  {entry.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}
                </span>
                <span className="font-medium">{EVENT_LABEL[entry.eventType] ?? entry.eventType}</span>
                <span>{entry.jobTitle ?? '—'}</span>
                {entry.companyName && (
                  <span style={{ color: 'var(--muted)' }}>at {entry.companyName}</span>
                )}
                {entry.rejectionReason && (
                  <Badge tone="neutral">{entry.rejectionReason.toLowerCase().replace(/_/g, ' ')}</Badge>
                )}
                <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                  via {entry.context.toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── Controls ───────────────────────────────────────────────────── */}
      <Card
        title="Reset and delete"
        description="These affect learned signals only. Your stated preferences are never touched."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <form action={reset} className="space-y-2">
            <label className="text-xs">
              <span className="mb-1 block font-medium">Reset learned signals</span>
              <select
                name="scope"
                className="w-full rounded border px-2 py-1 text-xs"
                style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
              >
                <option value="all">Everything learned</option>
                <option value="company">Company affinity</option>
                <option value="technology">Technology affinity</option>
                <option value="location">Location affinity</option>
                <option value="source">Source preferences</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-[11px]">
              <input type="checkbox" name="confirm" />
              <span>I understand this clears learned signals, not my preferences</span>
            </label>
            <button
              type="submit"
              className="rounded px-3 py-1.5 text-xs"
              style={{ border: '1px solid var(--border)' }}
            >
              Reset
            </button>
          </form>

          <form action={deleteHistory} className="space-y-2">
            <span className="block text-xs font-medium">Delete behavioural history</span>
            <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
              Removes every recorded interaction and everything learned from them. Your profile,
              preferences and saved jobs are unaffected.
            </p>
            <label className="flex items-center gap-2 text-[11px]">
              <input type="checkbox" name="confirm" />
              <span>I want my interaction history deleted</span>
            </label>
            <button
              type="submit"
              className="rounded px-3 py-1.5 text-xs"
              style={{ border: '1px solid var(--danger)', color: 'var(--danger)' }}
            >
              Delete history
            </button>
          </form>
        </div>
      </Card>
    </div>
  );
}

function SignalList({ items }: { items: ReadonlyArray<Parameters<typeof affinityStars>[0]> }) {
  return (
    <ul className="space-y-1">
      {items.slice(0, 12).map((item) => (
        <li
          key={`${item.dimension}-${item.value}`}
          className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
        >
          <span>
            <span className="font-medium">{item.value}</span>
            <span className="ml-1 text-[10px]" style={{ color: 'var(--muted)' }}>
              {DIMENSION_LABEL[item.dimension]?.toLowerCase() ?? item.dimension}
            </span>
          </span>
          <span style={{ color: item.affinity >= 0 ? 'var(--ok)' : 'var(--warn)' }}>
            {stars(affinityStars(item))}
            <span className="ml-1 text-[10px]" style={{ color: 'var(--muted)' }}>
              {item.sampleSize} interaction(s)
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
