import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { getServerContext } from '@/lib/db';
import { getMatchingContext } from '@/lib/matching';
import { getResumeContext } from '@/lib/resume';
import { getApplicationContext } from '@/lib/application';
import { RECOMMENDATION_LABEL, type ApplicationRecommendation } from '@job-intel/contracts';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import {
  ComponentBreakdown,
  ConstraintList,
  ScoreHeadline,
  SignalList,
  SkillMatchList,
  TraceGrid,
} from '@/components/match';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ jobId: z.string().uuid() });

/**
 * One match, explained.
 *
 * The page is ordered by what the candidate needs in order to decide: the
 * verdict, then the sentence that justifies it, then eligibility, then the
 * breakdown, then provenance. Anyone who disagrees with the score can follow it
 * all the way down to the weights and versions that produced it — which is the
 * whole point of storing a trace rather than a number.
 */
export default async function MatchDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const { matches, profileId } = await getMatchingContext();
  if (!profileId) notFound();

  const match = await matches.get(parsed.data.jobId, profileId);
  const ctx = await getServerContext();
  const job = await ctx.jobs.getById(parsed.data.jobId);
  if (!job) notFound();

  /*
   * The job-specific candidate view.
   *
   * Best-effort: a candidate who has uploaded no documents sees the page
   * exactly as it was before this layer existed, rather than an error or an
   * empty section pretending to be data.
   */
  const { service: resume, profileId: intelligenceId } = await getResumeContext();
  const view = intelligenceId
    ? await resume
        .jobView({ candidateId: intelligenceId, jobId: parsed.data.jobId })
        .catch(() => null)
    : null;

  /*
   * The application recommendation.
   *
   * Computed on demand when nothing is stored, so this page is never blank
   * because a background run has not caught up. Best-effort throughout: a
   * candidate with no documents still gets the match explanation they had
   * before this layer existed.
   */
  const { service: applications, profileId: applicantId } = await getApplicationContext();
  const advice = applicantId
    ? await applications
        .intelligenceFor(applicantId, parsed.data.jobId)
        .then(
          async (stored) =>
            stored ??
            (await applications.analyse(applicantId, parsed.data.jobId)).intelligence,
        )
        .catch(() => null)
    : null;

  if (!match) {
    return (
      <div className="max-w-4xl">
        <PageHeader title={job.title} description={job.companyNameRaw ?? undefined} />
        <EmptyState
          title="Not scored yet"
          reason="This job has not been matched against your preferences. Trigger a recalculation to score it."
          action={<Link href="/matches">Back to matches</Link>}
        />
      </div>
    );
  }

  const history = await matches.history(parsed.data.jobId, profileId, 10);
  const trace = match.trace;

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title={job.title}
        description={`${job.company?.canonicalName ?? job.companyNameRaw ?? 'Unknown company'}`}
        actions={
          <a
            href={job.applyUrl ?? job.canonicalUrl ?? job.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sm hover:underline"
            style={{ color: 'var(--accent)' }}
          >
            View posting →
          </a>
        }
      />

      <Card>
        <ScoreHeadline
          score={match.overallScore}
          confidence={match.confidence}
          recommendation={match.recommendation}
        />
        <p className="mt-3 text-sm">{match.explanation}</p>
      </Card>

      <Card
        title="Eligibility"
        description="Decided in code before any scoring. Nothing below can overturn it."
      >
        <ConstraintList result={match.hardConstraintResult} />
      </Card>

      <Card
        title="Score breakdown"
        description="Each dimension scored independently, then combined using your stored weights."
      >
        <ComponentBreakdown components={match.componentScores} weights={trace.weightsUsed} />
      </Card>

      <Card title="Skills" description="Direct matches, and credit earned through related skills.">
        <SkillMatchList matches={match.skillMatches} />
      </Card>

      {(match.positiveSignals.length > 0 ||
        match.negativeSignals.length > 0 ||
        match.concerns.length > 0) && (
        <Card title="Signals">
          <div className="space-y-4">
            <SignalList title="In favour" items={match.positiveSignals} tone="ok" />
            <SignalList title="Against" items={match.negativeSignals} tone="warn" />
            <SignalList title="Worth checking" items={match.concerns} tone="warn" />
          </div>
        </Card>
      )}

      <Card
        title="How this score was produced"
        description="Enough provenance to reproduce the number, or to explain why it moved."
      >
        <TraceGrid
          entries={[
            ['Engine version', trace.matchingVersion],
            ['Profile version', `v${trace.profileVersion}`],
            ['Preference version', `v${trace.preferenceVersion}`],
            ['Enrichment version', `v${trace.enrichmentVersion}`],
            ['Structured score', trace.structuredScore.toFixed(1)],
            [
              'Semantic',
              trace.semanticScore === null ? 'not compared' : trace.semanticScore.toFixed(1),
            ],
            [
              'Behavioural adjustment',
              `${trace.behavioralAdjustment >= 0 ? '+' : ''}${trace.behavioralAdjustment.toFixed(1)}`,
            ],
            [
              'Model adjustment',
              `${trace.llmAdjustment >= 0 ? '+' : ''}${trace.llmAdjustment.toFixed(1)}`,
            ],
            ['Model', trace.llmModel ?? 'not used'],
            ['Embedding model', trace.embeddingModel ?? 'none'],
            ['Computed', match.computedAt.toISOString().slice(0, 16).replace('T', ' ')],
            ['Duration', `${trace.durationMs} ms`],
          ]}
        />

        <div className="mt-4 text-xs" style={{ color: 'var(--muted)' }}>
          <div className="font-medium">Model decision</div>
          <p className="mt-0.5">{trace.llmDecision}</p>
        </div>

        {trace.notes.length > 0 && (
          <div className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
            <div className="font-medium">Notes</div>
            <ul className="mt-0.5 space-y-0.5">
              {trace.notes.map((note, index) => (
                <li key={`note-${index}`}>{note}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {advice && (
        <Card
          title="Should you apply?"
          description="A separate question from how well you match. This weighs eligibility, fit, pay, timing and how much work the application is."
        >
          <div className="flex flex-wrap items-baseline gap-3">
            <span
              className="text-sm font-medium"
              style={{
                color:
                  advice.overallRecommendation === 'APPLY_NOW' ||
                  advice.overallRecommendation === 'APPLY'
                    ? 'var(--ok)'
                    : advice.overallRecommendation === 'BLOCKED'
                      ? 'var(--danger)'
                      : advice.overallRecommendation === 'CONSIDER'
                        ? 'var(--warn)'
                        : 'var(--muted)',
              }}
            >
              {RECOMMENDATION_LABEL[advice.overallRecommendation as ApplicationRecommendation]}
            </span>
            <span className="tabular text-sm">
              {Math.round(advice.applicationValueScore)}/100 application value
            </span>
            <span className="text-sm" style={{ color: 'var(--muted)' }}>
              {Math.round(advice.confidence * 100)}% confidence in this reading
            </span>
          </div>

          <p className="mt-3 text-sm">{advice.explanation.summary}</p>

          {advice.blockers.length > 0 && (
            <div className="mt-4">
              <div className="text-xs font-medium">Blockers</div>
              <ul className="mt-1 space-y-1 text-xs">
                {advice.blockers.map((blocker) => (
                  <li key={blocker.id}>
                    <span
                      style={{
                        color:
                          blocker.severity === 'HARD_BLOCKER' ? 'var(--danger)' : 'var(--warn)',
                      }}
                    >
                      {blocker.severity === 'HARD_BLOCKER' ? 'Blocked' : 'Likely issue'}:
                    </span>{' '}
                    {blocker.statement} {blocker.detail}
                    {blocker.resolution ? (
                      <span style={{ color: 'var(--muted)' }}> {blocker.resolution}</span>
                    ) : null}
                    {blocker.acknowledged ? (
                      <span style={{ color: 'var(--muted)' }}> (you marked this as resolved)</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {advice.explanation.strengths.length > 0 && (
              <div>
                <div className="text-xs font-medium">What you bring</div>
                <ul className="mt-1 space-y-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                  {advice.explanation.strengths.slice(0, 6).map((item, index) => (
                    <li key={`strength-${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {advice.explanation.concerns.length > 0 && (
              <div>
                <div className="text-xs font-medium">Worth knowing</div>
                <ul className="mt-1 space-y-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                  {advice.explanation.concerns.slice(0, 6).map((item, index) => (
                    <li key={`concern-${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {advice.explanation.unknowns.length > 0 && (
            <div className="mt-4">
              <div className="text-xs font-medium">Your profile does not say</div>
              <ul className="mt-1 space-y-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                {advice.explanation.unknowns.slice(0, 6).map((item, index) => (
                  <li key={`unknown-${index}`}>{item}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                These are unknowns, not gaps. Answering them in your profile may change this
                recommendation.
              </p>
            </div>
          )}

          <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="font-medium">Salary</div>
              <p style={{ color: 'var(--muted)' }}>{advice.compensation.explanation}</p>
            </div>
            <div>
              <div className="font-medium">Work authorisation</div>
              <p style={{ color: 'var(--muted)' }}>{advice.authorization.explanation}</p>
            </div>
            <div>
              <div className="font-medium">Application effort</div>
              <p style={{ color: 'var(--muted)' }}>{advice.friction.explanation}</p>
            </div>
            <div>
              <div className="font-medium">Competition</div>
              <p style={{ color: 'var(--muted)' }}>{advice.competitiveness.explanation}</p>
            </div>
          </div>

          {advice.legitimacy.verdict === 'SUSPICIOUS' && (
            <p className="mt-3 text-xs" style={{ color: 'var(--danger)' }}>
              {advice.legitimacy.explanation}
            </p>
          )}
        </Card>
      )}

      {advice && advice.resume.recommendedLabel && (
        <Card
          title="How to apply"
          description="Which document to send and what to lead with. Guidance only — nothing here edits your resume."
        >
          <div className="text-sm">
            <span className="font-medium">{advice.resume.recommendedLabel}</span>{' '}
            <span className="tabular" style={{ color: 'var(--muted)' }}>
              ({advice.resume.resumeFitScore}/100)
            </span>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
              {advice.resume.reason}
            </p>
          </div>

          {advice.resume.emphasise.length > 0 && (
            <p className="mt-3 text-xs">
              <span className="font-medium">Lead with:</span>{' '}
              <span style={{ color: 'var(--muted)' }}>{advice.resume.emphasise.join(', ')}</span>
            </p>
          )}

          {advice.positioning.addressGaps.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-medium">Address honestly</div>
              <ul className="mt-1 space-y-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                {advice.positioning.addressGaps.slice(0, 5).map((item, index) => (
                  <li key={`gap-${index}`}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {advice.checklist.length > 0 && (
            <div className="mt-4">
              <div className="text-xs font-medium">Before you submit</div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {advice.checklist.map((item) => (
                  <li key={item.id}>
                    <span style={{ color: item.required ? 'var(--fg)' : 'var(--muted)' }}>
                      {item.required ? 'Required' : 'Optional'} — {item.label}
                    </span>
                    {item.detail ? (
                      <span style={{ color: 'var(--muted)' }}> {item.detail}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-4 text-xs" style={{ color: 'var(--muted)' }}>
            This system does not submit applications. When you have applied, record it so your
            response rates and resume performance stay accurate.
          </p>
        </Card>
      )}

      {view && (
        <Card
          title="Your evidence for this role"
          description="Every row traces back to a document you uploaded. Requirements your profile does not mention are shown as unknowns, never as gaps."
        >
          <div className="flex flex-wrap gap-4 text-xs" style={{ color: 'var(--muted)' }}>
            <span>
              <span className="tabular font-medium" style={{ color: 'var(--fg)' }}>
                {view.matrix.coverageScore}
              </span>
              /100 requirement coverage
            </span>
            <span>{view.matrix.directMatches} direct</span>
            <span>{view.matrix.transferableMatches} transferable</span>
            <span>{view.matrix.unknowns} unknown</span>
            <span>{view.matrix.missing} not supported</span>
            <span>{Math.round(view.evidenceConfidence * 100)}% evidence confidence</span>
          </div>

          <ul className="mt-3 space-y-1 text-sm">
            {view.matrix.rows.slice(0, 20).map((row, index) => (
              <li key={`req-${index}`} className="flex flex-wrap items-baseline gap-2">
                <span
                  className="w-4 shrink-0 font-medium"
                  style={{
                    color:
                      row.support === 'SUPPORTED'
                        ? 'var(--ok)'
                        : row.support === 'NOT_SUPPORTED'
                          ? 'var(--danger)'
                          : 'var(--muted)',
                  }}
                  title={row.support}
                >
                  {row.support === 'SUPPORTED' ? '✓' : row.support === 'NOT_SUPPORTED' ? '✗' : '?'}
                </span>
                <span className="font-medium">{row.requirement}</span>
                <span className="text-xs" style={{ color: 'var(--muted)' }}>
                  {row.explanation}
                </span>
              </li>
            ))}
          </ul>

          {view.relevantExperience.length > 0 && (
            <div className="mt-4 text-xs">
              <div className="font-medium">Most relevant of your roles</div>
              <ul className="mt-0.5 space-y-0.5" style={{ color: 'var(--muted)' }}>
                {view.relevantExperience.map((entry) => (
                  <li key={entry.id}>{entry.summary}</li>
                ))}
              </ul>
            </div>
          )}

          {view.resumeFits.length > 0 && (
            <div className="mt-4 text-xs">
              <div className="font-medium">Which of your documents argues this best</div>
              <ul className="mt-0.5 space-y-0.5" style={{ color: 'var(--muted)' }}>
                {view.resumeFits.map((fit) => (
                  <li key={fit.documentId}>
                    <span className="tabular">{fit.resumeFitScore}/100</span> {fit.label} — {fit.rationale}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-4 text-xs" style={{ color: 'var(--muted)' }}>
            Requirement coverage is not the match score. Coverage asks how much of this posting your
            documents evidence; the match score asks whether you should apply.
          </p>
        </Card>
      )}

      {history.length > 1 && (
        <Card
          title="Score history"
          description="What this match scored previously, and which inputs had changed."
        >
          <ul className="space-y-1 text-xs">
            {history.map((entry, index) => (
              <li key={`h-${index}`} className="flex flex-wrap gap-2">
                <span className="tabular font-medium">{Math.round(entry.overallScore)}</span>
                <span style={{ color: 'var(--muted)' }}>
                  {entry.recommendation} · prefs v{entry.preferenceVersion} · engine{' '}
                  {entry.matchingVersion} · {entry.computedAt.toISOString().slice(0, 16).replace('T', ' ')}
                  {entry.reason ? ` · ${entry.reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
