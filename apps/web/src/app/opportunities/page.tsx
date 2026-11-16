import Link from 'next/link';
import {
  RECOMMENDATION_LABEL,
  type ApplicationRecommendation,
} from '@job-intel/contracts';
import { getApplicationContext } from '@/lib/application';
import { Badge, Card, EmptyState, PageHeader, Stat, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The application intelligence dashboard.
 *
 * Ordered by what a person actually needs when they sit down to job-hunt for an
 * hour: what should I do right now, what deserves a think, what is blocked and
 * why, and what does the pattern across all of it tell me about my profile.
 *
 * Two presentational commitments carry the layer's principles into the UI:
 *
 *  - **Blocked and unknown are visibly different states.** A blocked job has a
 *    reason the candidate can dispute in one click; an unknown one has a
 *    question they can answer. Rendering either as "not a match" would throw
 *    away the distinction the whole layer is built on.
 *
 *  - **Nothing here submits anything.** Every action is a decision the person
 *    records, and the page says so.
 */

const TONE: Readonly<Record<ApplicationRecommendation, 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'>> = {
  APPLY_NOW: 'ok',
  APPLY: 'ok',
  CONSIDER: 'warn',
  // Worth keeping, not worth acting on this week — quieter than CONSIDER.
  LOW_PRIORITY: 'neutral',
  SKIP: 'neutral',
  BLOCKED: 'danger',
  // Visibly distinct from SKIP: "we could not tell" is not "not a fit".
  UNKNOWN: 'accent',
};

export default async function OpportunitiesPage() {
  const { service, profileId } = await getApplicationContext();

  if (!profileId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Opportunities" description="Where to spend your application time." />
        <EmptyState
          title="No candidate profile yet"
          reason="Set up your preferences and upload a resume, and this page will fill in."
        />
      </div>
    );
  }

  const [counts, gaps, top, blocked, applications] = await Promise.all([
    service.counts(profileId),
    service.commonGaps(profileId, 8),
    service.opportunities(profileId, {
      recommendations: ['APPLY_NOW', 'APPLY', 'CONSIDER'],
      limit: 25,
    }),
    service.opportunities(profileId, { recommendations: ['BLOCKED'], limit: 10 }),
    service.applications(profileId).catch(() => []),
  ]);

  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  if (total === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Opportunities" description="Where to spend your application time." />
        <EmptyState
          title="Nothing analysed yet"
          reason="Once jobs have been discovered and matched, the application analysis runs over them and they appear here."
        />
      </div>
    );
  }

  const expired = top.filter((row) => row.timing.state === 'expired').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Opportunities"
        description="Ranked by whether applying is worth an hour of your time — not by match score."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Apply now" value={counts.APPLY_NOW ?? 0} hint="Strong fit, nothing outstanding" />
        <Stat label="Worth applying" value={counts.APPLY ?? 0} />
        <Stat label="Worth considering" value={counts.CONSIDER ?? 0} hint="Good, with a caveat" />
        <Stat label="Blocked" value={counts.BLOCKED ?? 0} hint="A stated requirement you do not meet" />
        <Stat label="Unknown" value={counts.UNKNOWN ?? 0} hint="Not enough information to judge" />
        <Stat label="Applications" value={applications.length} hint="Recorded by you" />
      </div>

      {/* ── Top opportunities ─────────────────────────────────────────── */}
      <Card
        title="Worth your time"
        description="Highest application value first. The score weighs fit, pay, timing and effort — it is deliberately not the match score."
      >
        {top.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Nothing currently reads as worth applying to. That is a finding, not an error — the
            blocked and unknown lists below say why.
          </p>
        ) : (
          <ul className="space-y-4">
            {top.map((row) => (
              <li key={row.jobId} className="border-b pb-4 last:border-0" style={{ borderColor: 'var(--border)' }}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={TONE[row.recommendation as ApplicationRecommendation]}>
                    {RECOMMENDATION_LABEL[row.recommendation as ApplicationRecommendation]}
                  </Badge>
                  <Link href={`/matches/${row.jobId}`} className="font-medium hover:underline">
                    {row.title}
                  </Link>
                  <span className="text-sm" style={{ color: 'var(--muted)' }}>
                    {row.companyName}
                  </span>
                  <span className="tabular ml-auto text-sm">
                    {Math.round(row.valueScore)}/100
                    <span style={{ color: 'var(--muted)' }}>
                      {' '}
                      · {Math.round(row.confidence * 100)}% confidence
                    </span>
                  </span>
                </div>

                <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
                  {row.explanation.summary}
                </p>

                <div className="mt-1 flex flex-wrap gap-3 text-xs" style={{ color: 'var(--muted)' }}>
                  {row.timing.state === 'closing_soon' && (
                    <span style={{ color: 'var(--warn)' }}>{row.timing.explanation}</span>
                  )}
                  {row.resume.recommendedLabel && <span>Send: {row.resume.recommendedLabel}</span>}
                  {row.matchScore !== null && <span>Match score {Math.round(row.matchScore)}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── Blocked ───────────────────────────────────────────────────── */}
      {blocked.length > 0 && (
        <Card
          title="Blocked"
          description="A requirement these postings state, that your profile says you do not meet. If any of that is wrong, you can clear it on the job's page and the recommendation recomputes."
        >
          <ul className="space-y-3 text-sm">
            {blocked.map((row) => (
              <li key={row.jobId}>
                <Link href={`/matches/${row.jobId}`} className="font-medium hover:underline">
                  {row.title}
                </Link>{' '}
                <span style={{ color: 'var(--muted)' }}>{row.companyName}</span>
                <ul className="mt-0.5 space-y-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                  {row.blockers
                    .filter((blocker) => blocker.severity === 'HARD_BLOCKER')
                    .map((blocker) => (
                      <li key={blocker.id}>
                        {blocker.statement} {blocker.detail}
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ── Recurring gaps ────────────────────────────────────────────── */}
      {gaps.length > 0 && (
        <Card
          title="What your opportunities keep asking for"
          description="Requirements your profile does not answer, counted across the jobs analysed. These are unknowns rather than gaps — adding them to your profile may clear them outright."
        >
          <Table head={['Requirement', 'Jobs', 'Share']}>
            {gaps.map((gap) => (
              <tr key={gap.requirement}>
                <td className="py-1">{gap.requirement}</td>
                <td className="tabular py-1">{gap.jobs}</td>
                <td className="tabular py-1">{Math.round(gap.share * 100)}%</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {expired > 0 && (
        <Card title="Recently expired" description="Postings whose deadline has passed.">
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {expired} of the opportunities above have closed since they were analysed.
          </p>
        </Card>
      )}

      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Nothing on this page submits an application. Every recommendation is advice you act on
        yourself, and every application in your history is one you recorded.
      </p>
    </div>
  );
}
