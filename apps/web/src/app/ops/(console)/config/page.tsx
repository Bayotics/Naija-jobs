import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { appConfigSchema } from '@job-intel/config';
import type { PreferenceProposal } from '@job-intel/contracts';
import { getServerContext } from '@/lib/db';
import { getCandidateService } from '@/lib/candidate';
import { getOpsContext } from '@/lib/ops';
import { currentSession, authConfigured } from '@/lib/auth';
import { Badge, Card, EmptyState, PageHeader, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Configuration.
 *
 * Three separate things that are easy to conflate and must not be:
 *
 *  - **Job search configuration** is candidate preference data. It is owned by
 *    the preference engine from prompt 5 and edited on `/preferences`; this
 *    page shows what is in force and links there. Re-implementing an editor
 *    here would be a second write path into the same data, and the second one
 *    always ends up skipping a validation the first one performs.
 *  - **Natural-language configuration** proposes, and only proposes. The model
 *    never writes. Every proposal is restated in plain language, shown with its
 *    confidence, and applied only after an explicit confirmation — through the
 *    same validated mutation a form edit would use.
 *  - **System configuration** is operational tunables. No secrets here, ever:
 *    API keys, database credentials and provider tokens live in the
 *    environment, and this page neither reads nor renders them.
 */

/** The tunables worth exposing. Each is validated by the app-config schema. */
const TUNABLES: Array<{ key: string; label: string; help: string; type: 'number' | 'boolean' }> = [
  { key: 'matching.minimumScore', label: 'Minimum match score', help: 'Below this, a job is never surfaced.', type: 'number' },
  { key: 'matching.instantNotifyScore', label: 'Instant-alert score', help: 'At or above this, alert immediately rather than batching.', type: 'number' },
  { key: 'matching.digestScore', label: 'Digest score', help: 'Threshold to enter a digest.', type: 'number' },
  { key: 'matching.minimumConfidence', label: 'Minimum confidence', help: '0–1. Low-confidence matches are held back.', type: 'number' },
  { key: 'pipeline.maxJobAgeDays', label: 'Max job age (days)', help: 'Postings older than this are not ingested.', type: 'number' },
  { key: 'pipeline.batchSize', label: 'Batch size', help: 'Jobs processed per pipeline batch.', type: 'number' },
  { key: 'notifications.enabled', label: 'Notifications enabled', help: 'Master switch for outbound email.', type: 'boolean' },
  { key: 'notifications.maxPerDay', label: 'Max notifications/day', help: 'Hard ceiling on outbound volume.', type: 'number' },
  { key: 'notifications.maxPerHour', label: 'Max notifications/hour', help: 'Burst ceiling.', type: 'number' },
  { key: 'ai.enabled', label: 'AI enabled', help: 'When off, the pipeline runs entirely deterministically.', type: 'boolean' },
  { key: 'ai.dailyBudgetUsd', label: 'AI daily budget (USD)', help: 'Reported on the metrics page as headroom.', type: 'number' },
  { key: 'validation.scamQuarantineThreshold', label: 'Scam quarantine threshold', help: '0–1. Above this a posting is quarantined.', type: 'number' },
];

function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, segment) => {
    if (typeof value !== 'object' || value === null) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, source);
}

export default async function OpsConfigPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const instruction = (Array.isArray(params.nl) ? params.nl[0] : params.nl) ?? '';
  const notice = Array.isArray(params.notice) ? params.notice[0] : params.notice;

  const ctx = await getServerContext();
  const [config, overrides, candidate, protectedConsole] = await Promise.all([
    ctx.config.get(),
    ctx.appConfig.listRaw().catch(() => []),
    getCandidateService(),
    authConfigured(),
  ]);

  const preferences = candidate.profileId
    ? await candidate.service.getPreferences(candidate.profileId).catch(() => null)
    : null;

  // Proposals are computed on GET and written nowhere. The instruction lives in
  // the URL, which is deliberate: a proposal you can link to is a proposal you
  // can review before accepting it.
  const bundle =
    instruction.trim().length >= 3 && candidate.profileId
      ? await candidate.service
          .proposeFromInstruction(candidate.profileId, instruction.trim())
          .catch(() => null)
      : null;

  // ── Actions ───────────────────────────────────────────────────────────────

  async function saveTunable(formData: FormData) {
    'use server';
    const key = String(formData.get('key') ?? '');
    const rawValue = String(formData.get('value') ?? '');
    const type = String(formData.get('type') ?? 'number');
    if (!TUNABLES.some((tunable) => tunable.key === key)) return;

    const value = type === 'boolean' ? rawValue === 'true' : Number(rawValue);
    if (type === 'number' && !Number.isFinite(value as number)) return;

    const server = await getServerContext();
    const who = (await currentSession())?.actor ?? 'local';

    // Validated as a whole before anything is written: an override that would
    // produce an invalid configuration is rejected rather than partly applied.
    const existing = await server.appConfig.getAll();
    const candidateConfig = structuredClone(existing) as Record<string, unknown>;
    const segments = key.split('.');
    let cursor = candidateConfig;
    for (const segment of segments.slice(0, -1)) {
      const next = cursor[segment];
      cursor[segment] =
        typeof next === 'object' && next !== null && !Array.isArray(next) ? next : {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1]!] = value;

    const merged = appConfigSchema.safeParse({
      ...(await server.config.get()),
      ...candidateConfig,
    });
    if (!merged.success) return;

    const before = readPath(await server.config.get(), key);
    await server.appConfig.set(key, value, who);

    const { repository } = await getOpsContext();
    await repository.recordAudit({
      action: 'config.updated',
      actor: who,
      target: key,
      before: { [key]: before ?? null },
      after: { [key]: value },
      reason: 'changed from the operations console',
    });
    revalidatePath('/ops/config');
  }

  async function applyProposals(formData: FormData) {
    'use server';
    // Explicit confirmation. Without it nothing is written — the model's output
    // is a suggestion until a person says otherwise.
    if (formData.get('confirm') !== 'on') return;

    const payload = String(formData.get('proposals') ?? '');
    let proposals: PreferenceProposal[];
    try {
      proposals = JSON.parse(payload) as PreferenceProposal[];
    } catch {
      return;
    }
    if (!Array.isArray(proposals) || proposals.length === 0) return;

    const service = await getCandidateService();
    if (!service.profileId) return;

    const who = (await currentSession())?.actor ?? 'local';
    const before = await service.service.getPreferences(service.profileId);
    const result = await service.service.applyProposals(service.profileId, proposals);

    const { repository } = await getOpsContext();
    await repository.recordAudit({
      action: 'preferences.nl_applied',
      actor: who,
      target: service.profileId,
      before: { version: before.version },
      after: {
        version: result.version,
        changes: result.changes.map((change) => change.summary),
      },
      reason: 'natural-language instruction, confirmed',
    });

    revalidatePath('/ops/config');
  }

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Configuration"
        description="What the system is told to do. Secrets are not here and never will be."
      />

      {notice === 'saved' && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
        >
          Change saved and recorded in the audit log.
        </div>
      )}

      {/* ── Job search configuration ───────────────────────────────────── */}
      <Card
        title="Job search configuration"
        description="Candidate preference data, owned by the preference engine. Edited on the preferences page — there is exactly one write path into it."
        footer={
          <Link href="/preferences" className="text-xs" style={{ color: 'var(--accent)' }}>
            Edit preferences →
          </Link>
        }
      >
        {!preferences ? (
          <EmptyState
            title="No active candidate profile"
            reason="Search configuration is candidate data. Create a profile before it exists."
          />
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <Badge tone="accent">version {preferences.version}</Badge>
              <span style={{ color: 'var(--muted)' }}>
                Matching, ranking and notification all read this same record.
              </span>
            </div>
            <pre
              className="scroll-x rounded-md p-3 text-[11px]"
              style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
            >
              {JSON.stringify(preferences.preferences, null, 2)}
            </pre>
          </div>
        )}
      </Card>

      {/* ── Natural language ───────────────────────────────────────────── */}
      <Card
        title="Describe a change in plain language"
        description="Produces proposals. Nothing is written until you confirm."
      >
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="min-w-64 flex-1 text-xs">
            <span className="mb-1 block font-medium">Instruction</span>
            <input
              name="nl"
              defaultValue={instruction}
              placeholder="stop showing me contract roles, and raise my minimum salary to 120k"
              className="w-full rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            />
          </label>
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-xs font-medium"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            Propose
          </button>
        </form>

        {bundle && (
          <div className="mt-4 space-y-3">
            {bundle.proposals.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                Nothing in that instruction mapped to a preference. Rather than guess, the parser
                reports that it could not interpret it.
              </p>
            ) : (
              <>
                <Table head={['Change', 'Path', 'Confidence', 'From your words']}>
                  {bundle.proposals.map((proposal, index) => (
                    <tr key={index} className="border-b" style={{ borderColor: 'var(--border)' }}>
                      <td className="px-3 py-1.5 text-xs">{proposal.summary}</td>
                      <td className="px-3 py-1.5 font-mono text-[11px]" style={{ color: 'var(--muted)' }}>
                        {proposal.path}
                      </td>
                      <td className="tabular px-3 py-1.5 text-xs">
                        <Badge tone={proposal.confidence >= 0.7 ? 'ok' : 'warn'}>
                          {(proposal.confidence * 100).toFixed(0)}%
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                        {proposal.sourceText ?? '—'}
                      </td>
                    </tr>
                  ))}
                </Table>

                <form action={applyProposals} className="space-y-2">
                  <input
                    type="hidden"
                    name="proposals"
                    value={JSON.stringify(bundle.proposals)}
                  />
                  <label className="flex items-center gap-2 text-[11px]">
                    <input type="checkbox" name="confirm" />
                    <span>
                      I have read these {bundle.proposals.length} change(s) and want them applied
                    </span>
                  </label>
                  <button
                    type="submit"
                    className="rounded-md px-3 py-1.5 text-xs font-medium"
                    style={{ background: 'var(--accent)', color: '#fff' }}
                  >
                    Apply confirmed changes
                  </button>
                </form>
              </>
            )}

            {bundle.unparsed.length > 0 && (
              <div
                className="rounded-md border px-3 py-2 text-[11px]"
                style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
              >
                Could not interpret: {bundle.unparsed.join(' · ')}. Surfaced rather than silently
                dropped — a change you think you made and did not is worse than one that failed
                loudly.
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ── System configuration ───────────────────────────────────────── */}
      <Card
        title="System configuration"
        description="Operational tunables. Every value is validated against the schema before it is stored."
      >
        <div
          className="mb-3 rounded-md border px-3 py-2 text-[11px]"
          style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
        >
          Secrets are <strong>not</strong> configurable here. API keys, database credentials, email
          credentials and model provider tokens come from the environment and are never read into
          this page.
          {!protectedConsole && (
            <>
              {' '}
              This console is currently unauthenticated — changes are attributed to{' '}
              <code>local</code>.
            </>
          )}
        </div>

        <div className="space-y-1">
          {TUNABLES.map((tunable) => {
            const value = readPath(config, tunable.key);
            const overridden = overrides.some((row) => row.key === tunable.key);

            return (
              <form
                key={tunable.key}
                action={saveTunable}
                className="flex flex-wrap items-center gap-2 border-b py-1.5"
                style={{ borderColor: 'var(--border)' }}
              >
                <input type="hidden" name="key" value={tunable.key} />
                <input type="hidden" name="type" value={tunable.type} />

                <div className="min-w-56 flex-1">
                  <div className="text-xs font-medium">{tunable.label}</div>
                  <div className="text-[10px]" style={{ color: 'var(--muted)' }}>
                    <code>{tunable.key}</code> — {tunable.help}
                  </div>
                </div>

                {tunable.type === 'boolean' ? (
                  <select
                    name="value"
                    defaultValue={String(value)}
                    className="rounded border px-2 py-1 text-xs"
                    style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
                  >
                    <option value="true">enabled</option>
                    <option value="false">disabled</option>
                  </select>
                ) : (
                  <input
                    name="value"
                    type="number"
                    step="any"
                    defaultValue={String(value ?? '')}
                    className="tabular w-24 rounded border px-2 py-1 text-xs"
                    style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
                  />
                )}

                <Badge tone={overridden ? 'accent' : 'neutral'}>
                  {overridden ? 'overridden' : 'default'}
                </Badge>

                <button
                  type="submit"
                  className="rounded px-2 py-1 text-[11px]"
                  style={{ border: '1px solid var(--border)' }}
                >
                  Save
                </button>
              </form>
            );
          })}
        </div>
      </Card>

      <Card title="Effective configuration" description="What the pipeline actually reads.">
        <pre
          className="scroll-x rounded-md p-3 text-[11px]"
          style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
        >
          {JSON.stringify(config, null, 2)}
        </pre>
      </Card>
    </div>
  );
}
