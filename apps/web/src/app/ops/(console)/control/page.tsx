import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { getOpsContext } from '@/lib/ops';
import { getMatchingContext } from '@/lib/matching';
import { getRecommendationContext } from '@/lib/recommendations';
import { currentSession, authConfigured } from '@/lib/auth';
import { Badge, Card, PageHeader } from '@/components/ui';
import { Metric } from '@/components/ops';

export const dynamic = 'force-dynamic';

/**
 * Manual controls and dry run.
 *
 * Server actions rather than client fetches, so every control is a POST with
 * Next's built-in action protection — a GET could be pre-fetched by a browser
 * or a link scanner, and one of these sends real email.
 *
 * Destructive or outward-facing actions carry an explicit confirmation
 * checkbox. The dry run does not: it is inert by construction, and requiring
 * ceremony for the safe option pushes people toward the unsafe one.
 */
export default async function OpsControlPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [{ service, repository }, session, protectedConsole] = await Promise.all([
    getOpsContext(),
    currentSession(),
    authConfigured(),
  ]);

  const actor = session?.actor ?? 'local';
  const lastReportId = Array.isArray(params.report) ? params.report[0] : params.report;
  const lastRun = lastReportId ? await repository.getRun(lastReportId) : null;
  const recentAudit = await repository.listAudit({ limit: 10 });

  // ── Actions ─────────────────────────────────────────────────────────────

  async function runDryRun(formData: FormData) {
    'use server';
    const reason = String(formData.get('reason') ?? '').slice(0, 200) || undefined;
    const { service: svc, repository: repo } = await getOpsContext();
    const who = (await currentSession())?.actor ?? 'local';

    const report = await svc.dryRun({ triggeredBy: who, reason });
    await repo.recordAudit({
      action: 'pipeline.dry_run',
      actor: who,
      target: report.runId,
      after: { wouldShortlist: report.wouldShortlist, wouldRecommend: report.wouldRecommend },
      reason: reason ?? null,
    });
    revalidatePath('/ops/control');
  }

  async function recalculateMatches(formData: FormData) {
    'use server';
    if (formData.get('confirm') !== 'on') return;
    const reason = String(formData.get('reason') ?? '').slice(0, 200) || 'manual recalculation';

    const matching = await getMatchingContext();
    if (!matching.profileId) return;

    const { repository: repo } = await getOpsContext();
    const who = (await currentSession())?.actor ?? 'local';
    const result = await matching.service.matchAll(matching.profileId, { force: true, reason });

    await repo.recordAudit({
      action: 'job.rematched',
      actor: who,
      target: matching.profileId,
      after: { matched: result.matched, failed: result.failed },
      reason,
    });
    revalidatePath('/ops/control');
  }

  async function recalculateRecommendations(formData: FormData) {
    'use server';
    if (formData.get('confirm') !== 'on') return;
    const reason = String(formData.get('reason') ?? '').slice(0, 200) || 'manual re-rank';

    const recommendation = await getRecommendationContext();
    if (!recommendation.profileId) return;

    const { repository: repo } = await getOpsContext();
    const who = (await currentSession())?.actor ?? 'local';

    await recommendation.service.refreshSignals({ limit: 1000, staleAfterHours: 0 });
    const result = await recommendation.service.rank(recommendation.profileId);

    await repo.recordAudit({
      action: 'job.reranked',
      actor: who,
      target: recommendation.profileId,
      after: { ranked: result.ranked, notifiable: result.notifiable },
      reason,
    });
    revalidatePath('/ops/control');
  }


  const dryRunSummary = await service
    .dryRun({ triggeredBy: actor, reason: 'preview' })
    .catch(() => null);

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="Controls"
        description="Manual pipeline operations. Every action is audited."
        actions={
          <Link href="/ops" className="text-xs" style={{ color: 'var(--accent)' }}>
            ← Operations
          </Link>
        }
      />

      {!protectedConsole && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
        >
          Running unauthenticated. Actions are attributed to <code>local</code>.
        </div>
      )}

      <Card
        title="Dry run"
        description="Executes the decision pipeline and performs no writes and no sends."
      >
        {dryRunSummary && (
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Metric label="Would enrich" value={dryRunSummary.wouldEnrich} />
            <Metric label="Would match" value={dryRunSummary.wouldMatch} />
            <Metric label="Would recommend" value={dryRunSummary.wouldRecommend} />
            <Metric label="Would shortlist" value={dryRunSummary.wouldShortlist} tone="ok" />
            <Metric label="Suppressed" value={dryRunSummary.suppressed.length} />
          </div>
        )}

        {dryRunSummary && dryRunSummary.shortlist.length > 0 && (
          <div className="mb-3">
            <div className="mb-1 text-xs font-semibold">Would reach the top of the list</div>
            <ul className="space-y-1 text-xs">
              {dryRunSummary.shortlist.slice(0, 8).map((entry) => (
                <li key={entry.jobId}>
                  <span className="font-medium">{entry.title}</span>{' '}
                  <span style={{ color: 'var(--muted)' }}>
                    — {entry.company} · {entry.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {dryRunSummary && (
          <div className="mb-3 text-[11px]" style={{ color: 'var(--muted)' }}>
            Skipped: {dryRunSummary.skippedWrites.join(' · ')}
          </div>
        )}

        <form action={runDryRun} className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="mb-1 block font-medium">Reason (optional)</span>
            <input
              name="reason"
              className="rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
            />
          </label>
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-xs font-medium"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            Record a dry run
          </button>
        </form>
      </Card>

      <Card title="Recalculate" description="Re-scores the stored corpus. Does not send anything.">
        <div className="grid gap-4 sm:grid-cols-2">
          <ConfirmForm
            action={recalculateMatches}
            label="Recalculate all matches"
            note="Re-scores every enriched job against your current preferences."
          />
          <ConfirmForm
            action={recalculateRecommendations}
            label="Recalculate recommendations"
            note="Refreshes job signals, then re-ranks and re-diversifies."
          />
        </div>
      </Card>

      {lastRun && (
        <Card title="Last recorded run">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <Badge tone={lastRun.dryRun ? 'neutral' : 'accent'}>
              {lastRun.dryRun ? 'dry run' : lastRun.trigger}
            </Badge>
            <span>{lastRun.status}</span>
            <span style={{ color: 'var(--muted)' }}>
              {lastRun.startedAt.toISOString().slice(0, 19).replace('T', ' ')}
            </span>
          </div>
        </Card>
      )}

      <Card title="Recent audit entries" description="Every manual action, with before and after.">
        {recentAudit.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Nothing yet.
          </p>
        ) : (
          <ul className="space-y-1 text-xs">
            {recentAudit.map((entry) => (
              <li key={entry.id} className="flex flex-wrap gap-2">
                <span className="tabular" style={{ color: 'var(--muted)' }}>
                  {entry.occurredAt.toISOString().slice(5, 16).replace('T', ' ')}
                </span>
                <span className="font-medium">{entry.action}</span>
                <span style={{ color: 'var(--muted)' }}>by {entry.actor}</span>
                {entry.reason && <span style={{ color: 'var(--muted)' }}>— {entry.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** A control that cannot fire without an explicit confirmation. */
function ConfirmForm({
  action,
  label,
  note,
  danger,
}: {
  action: (formData: FormData) => Promise<void>;
  label: string;
  note: string;
  danger?: boolean;
}) {
  return (
    <form action={action} className="space-y-2">
      <div className="text-xs font-medium">{label}</div>
      <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
        {note}
      </p>
      <label className="flex items-center gap-2 text-[11px]">
        <input type="checkbox" name="confirm" />
        <span>I understand what this does</span>
      </label>
      <input
        name="reason"
        placeholder="Reason (recorded in the audit log)"
        className="w-full rounded border px-2 py-1 text-xs"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      />
      <button
        type="submit"
        className="rounded-md px-3 py-1.5 text-xs font-medium"
        style={{
          background: danger ? 'var(--danger)' : 'var(--surface)',
          color: danger ? '#fff' : 'var(--text)',
          border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`,
        }}
      >
        {label}
      </button>
    </form>
  );
}
