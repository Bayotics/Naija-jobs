import { revalidatePath } from 'next/cache';
import { EVIDENCE_SOURCE_WEIGHT, type CandidateSkillFact } from '@job-intel/contracts';
import { getResumeContext } from '@/lib/resume';
import { Badge, Card, EmptyState, PageHeader, Stat, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The candidate's own view of what the system extracted from their documents.
 *
 * The organising idea is that nothing here should be a surprise. Every claim
 * shows its evidence, every estimate says how confident it is, and every
 * unknown is labelled as an unknown rather than dressed up as a fact or hidden
 * altogether.
 *
 * Three things the page is careful about:
 *
 *  - **Facts, preferences and behaviour stay separate.** This page shows facts
 *    only. Preferences live at `/preferences` and behaviour at `/learning`, and
 *    mixing them is exactly the confusion the layer exists to prevent.
 *
 *  - **Conflicts are questions, not errors.** Where two documents disagree,
 *    both positions are shown with their source and the candidate chooses.
 *
 *  - **Evidence strength is visible.** A skill backed by a two-year role and
 *    one that appears in a comma-separated list look different here, because
 *    they are different.
 */

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  user_verified: 'You confirmed this',
  certification: 'Certification',
  employment_responsibility: 'A role you held',
  project_implementation: 'A project',
  portfolio: 'Your portfolio',
  public_repository: 'A public repository',
  resume_skill_section: 'Listed in a skills section',
  candidate_self_report: 'You told us',
  education_coursework: 'Coursework',
  behavioral_signal: 'Your activity',
  inferred: 'Inferred',
};

const PROFICIENCY_TONE: Readonly<Record<string, 'ok' | 'neutral' | 'warn'>> = {
  EXPERT: 'ok',
  ADVANCED: 'ok',
  PROFICIENT: 'neutral',
  WORKING: 'neutral',
  BEGINNER: 'warn',
};

function months(value: number | null, isEstimate: boolean): string {
  if (value === null) return 'not dated';
  const years = value / 12;
  const text = years >= 1 ? `${years.toFixed(1)} yrs` : `${value} mo`;
  return isEstimate ? `~${text}` : text;
}

function evidenceStrength(fact: CandidateSkillFact): number {
  const total = fact.evidence.reduce((sum, item) => sum + EVIDENCE_SOURCE_WEIGHT[item.source], 0);
  return Math.min(5, Math.max(1, Math.round(total * 1.6)));
}

const bar = (filled: number): string => '●'.repeat(filled) + '○'.repeat(5 - filled);

export default async function ResumePage() {
  const { service, repository, profileId } = await getResumeContext();

  if (!profileId) {
    return (
      <div className="max-w-4xl">
        <PageHeader title="Your profile from your documents" />
        <EmptyState
          title="No candidate profile yet"
          reason="Create a candidate profile before uploading a resume."
        />
      </div>
    );
  }

  const [profile, documents, conflicts, versions, externals] = await Promise.all([
    service.getProfile(profileId),
    repository.listDocuments(profileId),
    service.listConflicts(profileId),
    repository.listProfileVersions(profileId, 10),
    repository.listExternalProfiles(profileId),
  ]);

  async function uploadDocument(formData: FormData): Promise<void> {
    'use server';
    const { service: uploadService, profileId: id } = await getResumeContext();
    if (!id) return;

    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) return;

    await uploadService.upload({
      candidateId: id,
      bytes: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
      declaredMimeType: file.type || null,
      label: formData.get('label')?.toString() || undefined,
      targetRole: formData.get('targetRole')?.toString() || null,
    });

    revalidatePath('/resume');
  }

  async function resolveConflict(formData: FormData): Promise<void> {
    'use server';
    const { service: resolveService, profileId: id } = await getResumeContext();
    if (!id) return;

    const conflictId = formData.get('conflictId')?.toString();
    if (!conflictId) return;

    await resolveService.resolveConflict({
      candidateId: id,
      conflictId,
      chosenValue: formData.get('chosenValue')?.toString() ?? null,
      status: formData.get('status')?.toString() === 'ignored' ? 'ignored' : 'resolved',
    });

    revalidatePath('/resume');
  }

  async function linkPortfolio(formData: FormData): Promise<void> {
    'use server';
    const { service: linkService, profileId: id } = await getResumeContext();
    if (!id) return;

    const url = formData.get('url')?.toString();
    if (!url) return;

    await linkService.linkExternalProfile({ candidateId: id, url });
    revalidatePath('/resume');
  }

  return (
    <div className="max-w-6xl space-y-8">
      <PageHeader
        title="Your profile from your documents"
        description="Everything here was read from files you uploaded. Nothing was invented, and anything the documents did not say is marked unknown rather than guessed."
      />

      {/* ── Upload ─────────────────────────────────────────────────────── */}
      <Card title="Add a document">
        <form action={uploadDocument} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              <span className="block text-slate-600 dark:text-slate-400">File</span>
              <input
                type="file"
                name="file"
                accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                required
                className="mt-1 w-full text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="block text-slate-600 dark:text-slate-400">Label</span>
              <input
                type="text"
                name="label"
                placeholder="Frontend CV"
                maxLength={120}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="text-sm">
              <span className="block text-slate-600 dark:text-slate-400">Targets which roles?</span>
              <input
                type="text"
                name="targetRole"
                placeholder="Frontend engineering"
                maxLength={120}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            PDF, DOCX or plain text, up to 10MB. Scanned or image-only PDFs cannot be read — the
            upload will say so rather than producing an empty profile. Files are validated before
            anything opens them.
          </p>

          <button
            type="submit"
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
          >
            Upload and extract
          </button>
        </form>
      </Card>

      {!profile ? (
        <EmptyState
          title="Nothing extracted yet"
          reason="Upload a resume above and the extracted profile will appear here."
        />
      ) : (
        <>
          {/* ── Quality ──────────────────────────────────────────────── */}
          <Card
            title="Profile quality"
            description="Three separate scores, because they answer different questions and move independently."
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat
                label="Completeness"
                value={`${profile.quality?.completenessScore ?? 0}/100`}
                hint="Do we have the fields that affect matching?"
              />
              <Stat
                label="Evidence quality"
                value={`${profile.quality?.evidenceQualityScore ?? 0}/100`}
                hint="How good is the evidence behind what we have?"
              />
              <Stat
                label="Extraction confidence"
                value={`${profile.quality?.confidenceScore ?? 0}/100`}
                hint="How sure are we we read it correctly?"
              />
            </div>

            {(profile.quality?.materialGaps.length ?? 0) > 0 && (
              <ul className="mt-4 space-y-2 text-sm">
                {profile.quality!.materialGaps.map((gap) => (
                  <li key={gap.field} className="flex gap-2">
                    <Badge tone={gap.impact === 'high' ? 'warn' : 'neutral'}>{gap.impact}</Badge>
                    <span>
                      <span className="text-slate-700 dark:text-slate-300">{gap.reason}</span>{' '}
                      <span className="text-slate-500 dark:text-slate-400">{gap.action}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ── Conflicts ────────────────────────────────────────────── */}
          {conflicts.length > 0 && (
            <Card
              title={`${conflicts.length} thing${conflicts.length === 1 ? '' : 's'} your documents disagree about`}
              description="Nothing has been chosen for you. Both positions are shown with the document each came from."
            >
              <div className="space-y-4">
                {conflicts.map((conflict) => (
                  <div
                    key={conflict.id}
                    className="rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30"
                  >
                    <p className="text-sm font-medium">{conflict.subject}</p>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{conflict.detail}</p>

                    <form action={resolveConflict} className="mt-3 space-y-2">
                      <input type="hidden" name="conflictId" value={conflict.id} />

                      {conflict.positions.map((position, index) => (
                        <label key={index} className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="chosenValue"
                            value={position.value}
                            required
                          />
                          <span className="font-medium">{position.value}</span>
                          <span className="text-slate-500 dark:text-slate-400">
                            from {position.documentLabel ?? 'an unnamed document'}
                          </span>
                        </label>
                      ))}

                      <div className="flex gap-2">
                        <button
                          type="submit"
                          className="rounded bg-slate-900 px-3 py-1 text-sm text-white dark:bg-slate-100 dark:text-slate-900"
                        >
                          Use this one
                        </button>
                        <button
                          type="submit"
                          name="status"
                          value="ignored"
                          className="rounded border border-slate-300 px-3 py-1 text-sm dark:border-slate-700"
                        >
                          Both are fine
                        </button>
                      </div>
                    </form>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* ── Summary and seniority ────────────────────────────────── */}
          <Card title="What we understand">
            <p className="text-sm text-slate-700 dark:text-slate-300">{profile.summary}</p>

            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Stat
                label="Estimated level"
                value={profile.seniority.estimatedLevel ?? 'unknown'}
                hint={`${Math.round(profile.seniority.confidence * 100)}% confidence`}
              />
              <Stat
                label="Recorded experience"
                value={
                  profile.trajectory.totalExperienceMonths === null
                    ? 'not dated'
                    : `${(profile.trajectory.totalExperienceMonths / 12).toFixed(1)} yrs`
                }
                hint="Overlapping roles counted once"
              />
              <Stat
                label="Profile version"
                value={`v${profile.profileVersion}`}
                hint={`from ${profile.sourceDocumentIds.length} document(s)`}
              />
            </div>

            {profile.seniority.titleVsEvidenceNote && (
              <p className="mt-3 rounded bg-slate-100 p-2 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {profile.seniority.titleVsEvidenceNote}
              </p>
            )}

            {profile.seniority.signals.length > 0 && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-slate-600 dark:text-slate-400">
                  How the level was estimated ({profile.seniority.signals.length} signals)
                </summary>
                <ul className="mt-2 space-y-1">
                  {profile.seniority.signals.map((signal, index) => (
                    <li key={index} className="text-slate-600 dark:text-slate-400">
                      <span className="font-mono text-xs">{signal.name}</span>{' '}
                      <span className="text-xs">(weight {signal.weight})</span> — {signal.detail}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>

          {/* ── Skills with evidence ─────────────────────────────────── */}
          <Card
            title={`${profile.skills.length} skills`}
            description="Proficiency describes what the evidence supports, not a judgement about you."
          >
            <Table head={['Skill', 'Evidence supports', 'Duration', 'Last used', 'Evidence', 'Where from']}>
              {profile.skills.slice(0, 60).map((fact) => (
                <tr key={fact.slug} className="border-t border-slate-200 dark:border-slate-800">
                  <td className="px-3 py-2 font-medium">
                    {fact.name}
                    {fact.userVerified && (
                      <span className="ml-2">
                        <Badge tone="ok">confirmed</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {fact.proficiency ? (
                      <Badge tone={PROFICIENCY_TONE[fact.proficiency] ?? 'neutral'}>
                        {fact.proficiency.toLowerCase()}
                      </Badge>
                    ) : (
                      <span className="text-slate-400">unknown</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                    {months(fact.totalMonths, fact.monthsIsEstimate)}
                  </td>
                  <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                    {fact.lastEvidencedAt ? fact.lastEvidencedAt.getUTCFullYear() : '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs" title={fact.proficiencyRationale}>
                    {bar(evidenceStrength(fact))}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                    {fact.strongestSource ? SOURCE_LABEL[fact.strongestSource] : '—'}
                  </td>
                </tr>
              ))}
            </Table>
          </Card>

          {/* ── Timeline ─────────────────────────────────────────────── */}
          <Card
            title="Career timeline"
            description="Reconstructed from your documents. Gaps are shown as dates only — they are not interpreted."
          >
            <ol className="space-y-2 text-sm">
              {profile.trajectory.timeline.slice(0, 40).map((entry, index) => (
                <li key={index} className="flex gap-3">
                  <span className="w-24 shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">
                    {entry.year}
                    {entry.month ? `-${String(entry.month).padStart(2, '0')}` : ''}
                  </span>
                  <span>
                    {entry.label}
                    {entry.company && (
                      <span className="text-slate-500 dark:text-slate-400"> — {entry.company}</span>
                    )}
                    {entry.detail && (
                      <span className="text-xs text-slate-400"> ({entry.detail})</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>

            {profile.trajectory.gaps.length > 0 && (
              <div className="mt-4 text-sm text-slate-600 dark:text-slate-400">
                <p className="font-medium">Periods between recorded roles</p>
                <ul className="mt-1 space-y-1">
                  {profile.trajectory.gaps.map((gap, index) => (
                    <li key={index}>
                      {gap.fromYear}–{gap.toYear}: {gap.note}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          {/* ── Trajectory ───────────────────────────────────────────── */}
          {profile.trajectory.dimensions.length > 0 && (
            <Card title="Trajectory" description={profile.trajectory.trajectorySummary}>
              <Table head={['Dimension', 'Direction', 'Confidence', 'Detail']}>
                {profile.trajectory.dimensions.map((dimension) => (
                  <tr key={dimension.dimension} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="px-3 py-2 capitalize">{dimension.dimension.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2">
                      <Badge
                        tone={
                          dimension.direction > 0.2
                            ? 'ok'
                            : dimension.direction < -0.2
                              ? 'warn'
                              : 'neutral'
                        }
                      >
                        {dimension.direction > 0.2
                          ? 'increasing'
                          : dimension.direction < -0.2
                            ? 'decreasing'
                            : 'steady'}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                      {Math.round(dimension.confidence * 100)}%
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{dimension.detail}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
        </>
      )}

      {/* ── Documents ──────────────────────────────────────────────────── */}
      <Card title="Your documents">
        {documents.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Nothing uploaded yet.</p>
        ) : (
          <Table head={['Label', 'File', 'Status', 'Targets', 'Uploaded']}>
            {documents.map((document) => (
              <tr key={document.id} className="border-t border-slate-200 dark:border-slate-800">
                <td className="px-3 py-2 font-medium">{document.label}</td>
                <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                  {document.filename} · {(document.sizeBytes / 1024).toFixed(0)}KB
                </td>
                <td className="px-3 py-2">
                  <Badge tone={document.status === 'rejected' ? 'warn' : 'neutral'}>
                    {document.status}
                  </Badge>
                  {document.rejectionReason && (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                      {document.rejectionReason}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                  {document.targetRole ?? '—'}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                  {document.uploadedAt.toISOString().slice(0, 10)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* ── Linked public profiles ─────────────────────────────────────── */}
      <Card
        title="Linked public profiles"
        description="Only links you paste, only public data, only through documented APIs."
      >
        <form action={linkPortfolio} className="flex gap-2">
          <input
            type="url"
            name="url"
            placeholder="https://github.com/your-handle"
            required
            maxLength={500}
            className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          <button
            type="submit"
            className="rounded bg-slate-900 px-3 py-1 text-sm text-white dark:bg-slate-100 dark:text-slate-900"
          >
            Link
          </button>
        </form>

        {externals.length > 0 && (
          <ul className="mt-4 space-y-2 text-sm">
            {externals.map((external) => (
              <li key={`${external.provider}:${external.identifier}`} className="flex items-center gap-2">
                <Badge tone={external.status === 'linked' ? 'ok' : 'warn'}>
                  {external.provider}
                </Badge>
                <span className="text-slate-600 dark:text-slate-400">{external.url}</span>
                <span className="text-xs text-slate-500">
                  {external.derivedSkills.length} skills evidenced
                </span>
                {external.lastError && (
                  <span className="text-xs text-amber-700 dark:text-amber-400">{external.lastError}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── Version history ────────────────────────────────────────────── */}
      {versions.length > 0 && (
        <Card
          title="Profile history"
          description="Each upload creates a new version. Matches computed against an older one stay reproducible."
        >
          <Table head={['Version', 'Skills', 'Computed', 'Active']}>
            {versions.map((version) => (
              <tr key={version.profileVersion} className="border-t border-slate-200 dark:border-slate-800">
                <td className="px-3 py-2 font-mono text-sm">v{version.profileVersion}</td>
                <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{version.skillCount}</td>
                <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                  {version.computedAt.toISOString().slice(0, 16).replace('T', ' ')}
                </td>
                <td className="px-3 py-2">{version.isActive ? <Badge tone="ok">active</Badge> : ''}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
