import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { InspectedField } from '@job-intel/contracts';
import { getOpsContext } from '@/lib/ops';
import { buildJobInspection } from '@/lib/job-inspection';
import { Badge, Card, PageHeader, Table } from '@/components/ui';
import { Metric, OriginBadge } from '@/components/ops';

export const dynamic = 'force-dynamic';

/**
 * The job debugger.
 *
 * Answers four questions on one screen, in the order an operator actually asks
 * them:
 *
 *  1. What do we know about this job, and *who said so*? Raw, normalized,
 *     AI-extracted and system-derived are separate sections with a badge on
 *     every field, because "the model claimed this" and "the source stated
 *     this" are different kinds of fact.
 *  2. Is it a duplicate, and on what evidence?
 *  3. Why did it score what it scored? Component by component, with the exact
 *     weight applied to each — a component list without its weights explains
 *     nothing.
 *  4. Why did (or didn't) it reach my inbox?
 *
 * The explanation shown is the stored structured explanation. No model
 * reasoning is stored and none is reconstructed here.
 */
export default async function OpsJobDebuggerPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const { repository, profileId } = await getOpsContext();

  const inspection = await repository.inspectJob(jobId, profileId).catch(() => null);
  if (!inspection) notFound();

  const view = buildJobInspection(inspection);
  const { job, fields, duplicates, match, recommendation, events } = view;

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title={job.title}
        description={`${job.company ?? 'Company not stated'} · ${job.status} · ${job.id}`}
        actions={
          <Link href="/ops/jobs" className="text-xs" style={{ color: 'var(--accent)' }}>
            ← Explorer
          </Link>
        }
      />

      {/* Provenance. The whole point of the page. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <FieldCard
          title="Raw"
          description="Exactly what the source sent. Unmodified."
          fields={fields.raw}
        />
        <FieldCard
          title="Normalized"
          description="Deterministic parsing. No model involved."
          fields={fields.normalized}
        />
        <FieldCard
          title="Extracted"
          description="Enrichment output. Deterministic first, AI where it earns its place."
          fields={fields.extracted}
          emptyReason="This job has not been enriched yet."
        />
        <FieldCard
          title="Derived"
          description="Our own scoring. Computed, never reported by anyone else."
          fields={fields.derived}
          emptyReason="No signals have been computed for this job yet."
        />
      </div>

      <Card
        title="Duplicates"
        description="Deduplication records the evidence and a confidence, never a bare boolean."
      >
        {duplicates.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            No duplicate relationship recorded.
          </p>
        ) : (
          <Table head={['Relationship', 'Tier', 'Confidence', 'Merged', 'Reason']}>
            {duplicates.map((duplicate, index) => (
              <tr key={index} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-2 text-xs">
                  {duplicate.jobId === job.id ? (
                    <>
                      duplicate of{' '}
                      <Link
                        href={`/ops/jobs/${duplicate.duplicateOfJobId}`}
                        style={{ color: 'var(--accent)' }}
                      >
                        {duplicate.duplicateOfJobId.slice(0, 8)}
                      </Link>
                    </>
                  ) : (
                    <>
                      canonical for{' '}
                      <Link href={`/ops/jobs/${duplicate.jobId}`} style={{ color: 'var(--accent)' }}>
                        {duplicate.jobId.slice(0, 8)}
                      </Link>
                    </>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge
                    tone={
                      duplicate.tier === 'exact' || duplicate.tier === 'strong'
                        ? 'ok'
                        : duplicate.tier === 'distinct'
                          ? 'neutral'
                          : 'warn'
                    }
                  >
                    {duplicate.tier}
                  </Badge>
                </td>
                <td className="tabular px-3 py-2 text-xs">
                  {(duplicate.confidence * 100).toFixed(0)}%
                </td>
                <td className="px-3 py-2 text-xs">{duplicate.merged ? 'yes' : 'no'}</td>
                <td className="px-3 py-2 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {duplicate.reason}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* ── Match debugger ──────────────────────────────────────────────── */}
      <Card
        title="Match"
        description={
          match
            ? `Version ${match.versions.matchingVersion}, computed ${match.computedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`
            : undefined
        }
      >
        {!match ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            This job has not been matched against the active profile. Matching runs after
            enrichment; a job that failed enrichment never reaches it.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              <Metric
                label="Overall"
                value={Math.round(match.overallScore)}
                tone={match.eligible ? undefined : 'danger'}
              />
              <Metric label="Confidence" value={`${Math.round(match.confidence * 100)}%`} />
              <Metric label="Structured" value={Math.round(match.structuredScore)} />
              <Metric
                label="Semantic"
                value={match.semanticScore === null ? 'n/a' : Math.round(match.semanticScore)}
              />
              <Metric label="Behavioural" value={match.behavioralAdjustment.toFixed(1)} />
              <Metric label="LLM" value={match.llmAdjustment.toFixed(1)} />
            </div>

            {!match.eligible && (
              <div
                className="rounded-md border px-3 py-2 text-xs"
                style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
              >
                <strong>Ineligible.</strong> A hard constraint failed, so the score is zero by
                construction and no semantic or model signal was applied. Eligibility is decided in
                code, never by a model.
              </div>
            )}

            <div>
              <h3 className="mb-1 text-xs font-semibold">Hard constraints</h3>
              <Table head={['Constraint', 'Result', 'Severity', 'Actual']}>
                {match.hardConstraints.checks.map((check, index) => (
                  <tr key={index} className="border-b" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-3 py-1.5 text-xs">{check.constraint}</td>
                    <td className="px-3 py-1.5">
                      <Badge
                        tone={
                          check.result === 'PASS' ? 'ok' : check.result === 'FAIL' ? 'danger' : 'warn'
                        }
                      >
                        {check.result}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                      {check.severity}
                    </td>
                    <td className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                      {check.actual}
                    </td>
                  </tr>
                ))}
              </Table>
            </div>

            <div>
              <h3 className="mb-1 text-xs font-semibold">
                Component scores{' '}
                <span className="font-normal" style={{ color: 'var(--muted)' }}>
                  — score × weight, exactly as applied
                </span>
              </h3>
              <Table head={['Dimension', 'Score', 'Weight', 'Contribution', 'Why']}>
                {match.componentScores.map((component) => {
                  // The weight actually applied, read from the stored trace
                  // rather than recomputed — a recomputed weight would show what
                  // the *current* configuration says, not what produced this
                  // score.
                  const weight = match.weightsUsed[component.dimension] ?? 0;
                  return (
                    <tr
                      key={component.dimension}
                      className="border-b"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <td className="px-3 py-1.5 text-xs">
                        {component.dimension.replace(/_/g, ' ')}
                      </td>
                      <td className="tabular px-3 py-1.5 text-xs">
                        {component.applicable ? Math.round(component.score) : 'n/a'}
                      </td>
                      <td className="tabular px-3 py-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                        ×{weight}
                      </td>
                      <td className="tabular px-3 py-1.5 text-xs">
                        {component.applicable ? (component.score * weight).toFixed(1) : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                        {component.explanation}
                        {component.evidence.length > 0 && (
                          <span> · {component.evidence.slice(0, 4).join(', ')}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            </div>

            {match.skillMatches.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold">
                  Skill matches ({match.skillMatches.length})
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {match.skillMatches.slice(0, 30).map((skill, index) => (
                    <li key={index} className="text-[11px]">
                      <span className="font-medium">{skill.required}</span>{' '}
                      <span style={{ color: 'var(--muted)' }}>
                        ({skill.requirement}) — {skill.kind.replace(/_/g, ' ')}
                        {skill.satisfiedBy ? ` via ${skill.satisfiedBy}` : ''}
                        {skill.via.length > 0 ? ` [${skill.via.join(' → ')}]` : ''} · strength{' '}
                        {skill.strength.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <ListBlock title="Matched requirements" items={match.matchedRequirements} />
              <ListBlock title="Missing requirements" items={match.missingRequirements} tone="warn" />
            </div>

            {match.concerns.length > 0 && <ListBlock title="Concerns" items={match.concerns} tone="warn" />}

            <div>
              <h3 className="mb-1 text-xs font-semibold">Explanation</h3>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                {match.explanation}
              </p>
              <p className="mt-1 text-[10px]" style={{ color: 'var(--muted)' }}>
                Generated from the stored component scores. Model reasoning is not retained and is
                not shown.
              </p>
            </div>

            <details>
              <summary className="cursor-pointer text-xs font-semibold">Versions</summary>
              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-3">
                {Object.entries(match.versions).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-2">
                    <dt style={{ color: 'var(--muted)' }}>{key}</dt>
                    <dd className="tabular">{value === null ? '—' : String(value)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </div>
        )}
      </Card>

      {/* ── Recommendation debugger ─────────────────────────────────────── */}
      <Card
        title="Recommendation"
        description="Ranking is a separate layer. It never modifies the match score."
      >
        {!recommendation ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            This job has not been ranked. Ranking runs over matched jobs.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="Rank" value={`#${recommendation.rank}`} />
              <Metric label="Tier" value={recommendation.tier} />
              <Metric label="Raw" value={recommendation.rawScore.toFixed(1)} />
              <Metric label="Calibrated" value={recommendation.calibratedScore.toFixed(1)} />
              <Metric
                label="Diversity penalty"
                value={`−${recommendation.diversityPenalty.toFixed(1)}`}
                tone={recommendation.diversityPenalty > 0 ? 'warn' : undefined}
              />
              <Metric label="Final" value={recommendation.finalScore.toFixed(1)} tone="ok" />
            </div>

            <Table head={['Factor', 'Value', 'Weight', 'Contribution', 'Detail']}>
              {recommendation.factors.map((factor) => (
                <tr key={factor.factor} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-1.5 text-xs">{factor.factor.replace(/_/g, ' ')}</td>
                  <td className="tabular px-3 py-1.5 text-xs">{factor.value.toFixed(1)}</td>
                  <td className="tabular px-3 py-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                    ×{factor.weight}
                  </td>
                  <td className="tabular px-3 py-1.5 text-xs">{factor.contribution.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                    {factor.explanation}
                  </td>
                </tr>
              ))}
            </Table>

            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              {recommendation.explanation}
            </p>

            {recommendation.reasons.length > 0 && (
              <ListBlock title="Why it ranked here" items={recommendation.reasons} />
            )}
          </div>
        )}
      </Card>

      {/* ── Why this ranks where it does ────────────────────────────────── */}
      {recommendation && (
        <Card
          title="Surfacing"
          description="The direct answer to: why is this not near the top of my list?"
        >
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={recommendation.notificationEligible ? 'ok' : 'warn'}>
              {recommendation.notificationEligible ? 'shortlisted' : 'not shortlisted'}
            </Badge>
            {recommendation.notificationBlockers.map((blocker) => (
              <span key={blocker} style={{ color: 'var(--muted)' }}>
                {blocker}
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card title="Events" description="Everything this job triggered, newest first.">
        {events.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            No events recorded for this job.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {events.map((event, index) => (
              <li key={index} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                <span className="tabular" style={{ color: 'var(--muted)' }}>
                  {event.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                </span>
                <span
                  className="w-10 font-semibold"
                  style={{
                    color:
                      event.severity === 'error'
                        ? 'var(--danger)'
                        : event.severity === 'warn'
                          ? 'var(--warn)'
                          : 'var(--muted)',
                  }}
                >
                  {event.severity}
                </span>
                <span className="font-medium">{event.name}</span>
                <span style={{ color: 'var(--muted)' }}>{event.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** One provenance group. The badge is on every row, not just the heading. */
function FieldCard({
  title,
  description,
  fields,
  emptyReason,
}: {
  title: string;
  description: string;
  fields: InspectedField[];
  emptyReason?: string;
}) {
  return (
    <Card title={title} description={description}>
      {fields.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {emptyReason ?? 'Nothing recorded.'}
        </p>
      ) : (
        <dl className="space-y-1.5">
          {fields.map((field) => (
            <div key={field.label} className="flex flex-wrap items-baseline gap-x-2">
              <dt className="w-40 shrink-0 text-[11px]" style={{ color: 'var(--muted)' }}>
                {field.label}
              </dt>
              <dd className="flex flex-1 flex-wrap items-baseline gap-2 text-xs">
                <span className={field.value === null ? '' : 'font-medium'}>
                  {field.value ?? <span style={{ color: 'var(--muted)' }}>not stated</span>}
                </span>
                <OriginBadge origin={field.origin} />
                {field.confidence !== null && (
                  <span className="tabular text-[10px]" style={{ color: 'var(--muted)' }}>
                    confidence {(field.confidence * 100).toFixed(0)}%
                  </span>
                )}
                {field.evidence && (
                  <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                    {field.evidence}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

function ListBlock({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone?: 'warn';
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
          None.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((item, index) => (
            <li
              key={index}
              className="text-[11px]"
              style={{ color: tone === 'warn' ? 'var(--warn)' : 'var(--muted)' }}
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
