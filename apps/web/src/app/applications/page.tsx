import Link from 'next/link';
import { MIN_SAMPLE_FOR_INFERENCE } from '@job-intel/contracts';
import { getApplicationContext } from '@/lib/application';
import { getServerContext } from '@/lib/db';
import { Card, EmptyState, PageHeader, Stat, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The application pipeline and what it says about the advice.
 *
 * The discipline this page has to hold is statistical honesty. A job search
 * produces small numbers for a long time, and someone twelve applications in
 * who reads "8% response rate — your Frontend resume outperforms your Cloud
 * resume 3:1" will change strategy on noise, feeling evidence-based about it.
 *
 * So the numbers are always shown — they are the candidate's own history and
 * hiding them would be patronising — and every rate carries whether the sample
 * supports reading anything into it.
 */

const STATUS_ORDER = [
  'applied',
  'recruiter_contacted',
  'screening',
  'interview',
  'technical_interview',
  'final_interview',
  'offer',
  'rejected',
  'withdrawn',
  'ghosted',
] as const;

const STATUS_LABEL: Readonly<Record<string, string>> = {
  applied: 'Applied',
  recruiter_contacted: 'Recruiter contacted',
  screening: 'Screening',
  interview: 'Interview',
  technical_interview: 'Technical interview',
  final_interview: 'Final interview',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  ghosted: 'No response',
};

const percent = (value: number | null): string =>
  value === null ? '—' : `${Math.round(value * 100)}%`;

export default async function ApplicationsPage() {
  const { service, profileId } = await getApplicationContext();

  if (!profileId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Applications" description="What you sent and what came back." />
        <EmptyState title="No candidate profile yet" reason="Set up your profile to track applications." />
      </div>
    );
  }

  const ctx = await getServerContext();

  /*
   * Two stores, deliberately both shown.
   *
   * `engagement` holds the lightweight state a candidate sets from a job card —
   * saved, applied, dismissed — and predates this layer. `application_records`
   * holds the detailed record with the resume used and the outcome. A job can
   * be marked applied in the first without ever being written to the second,
   * and dropping the older list would make work the candidate already did
   * disappear from the page that is supposed to track it.
   */
  const [records, analytics, resumes, calibration, tracked, trackedCounts] = await Promise.all([
    service.applications(profileId),
    service.analytics(profileId),
    service.resumePerformance(profileId),
    service.calibration(profileId),
    ctx.engagement.listApplications(profileId).catch(() => []),
    ctx.engagement.applicationCounts(profileId).catch(() => ({}) as Record<string, number>),
  ]);

  const detailedJobIds = new Set(records.map((record) => record.jobId));
  const trackedOnly = tracked.filter((row) => !detailedJobIds.has(row.jobId));

  if (records.length === 0 && tracked.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Applications" description="What you sent and what came back." />
        <EmptyState
          title="No applications recorded"
          reason="When you apply to something, record it from the job's page. Nothing here is filled in automatically — the system does not submit applications, so it only knows what you tell it."
        />
      </div>
    );
  }

  const funnel = analytics.overall;

  const byStatus = new Map<string, number>();
  for (const record of records) {
    byStatus.set(record.status, (byStatus.get(record.status) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Applications"
        description="What you sent, what came back, and whether the recommendations were any good."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Applications" value={funnel.applications} />
        <Stat label="Responses" value={funnel.responses} hint={percent(funnel.responseRate)} />
        <Stat label="Interviews" value={funnel.interviews} hint={percent(funnel.interviewRate)} />
        <Stat label="Offers" value={funnel.offers} hint={percent(funnel.offerRate)} />
        <Stat
          label="Median reply"
          value={funnel.medianDaysToResponse === null ? '—' : `${Math.round(funnel.medianDaysToResponse)}d`}
        />
      </div>

      {!funnel.sufficientSample && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          These rates are computed from {funnel.applications} application
          {funnel.applications === 1 ? '' : 's'}. Around {MIN_SAMPLE_FOR_INFERENCE} is where a
          difference starts to mean something, so treat them as a record of what happened rather
          than a measurement of how you are doing.
        </p>
      )}

      {/* ── Pipeline ───────────────────────────────────────────────────── */}
      <Card title="Pipeline" description="Where each application currently sits.">
        <div className="flex flex-wrap gap-4 text-sm">
          {STATUS_ORDER.filter((status) => byStatus.has(status)).map((status) => (
            <span key={status}>
              <span className="tabular font-medium">{byStatus.get(status)}</span>{' '}
              <span style={{ color: 'var(--muted)' }}>{STATUS_LABEL[status]}</span>
            </span>
          ))}
        </div>
      </Card>

      {/* ── Resume performance ─────────────────────────────────────────── */}
      {resumes.length > 0 && (
        <Card
          title="Resume performance"
          description="Which document you sent, and what happened. A difference between two resumes only means something once both have enough applications behind them."
        >
          <Table head={['Resume', 'Sent', 'Responses', 'Interviews', 'Reading']}>
            {resumes.map((entry) => (
              <tr key={entry.documentId}>
                <td className="py-1">{entry.label}</td>
                <td className="tabular py-1">{entry.rates.applications}</td>
                <td className="tabular py-1">
                  {entry.rates.responses} ({percent(entry.rates.responseRate)})
                </td>
                <td className="tabular py-1">{entry.rates.interviews}</td>
                <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {entry.note}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {/* ── Calibration ────────────────────────────────────────────────── */}
      {calibration.buckets.length > 0 && (
        <Card
          title="Were the recommendations right?"
          description="What the system advised against what you did, and what happened next."
        >
          <Table head={['Recommendation', 'Shown', 'Applied', 'Skipped', 'Responses', 'Reading']}>
            {calibration.buckets.map((bucket) => (
              <tr key={bucket.recommendation}>
                <td className="py-1">{bucket.recommendation}</td>
                <td className="tabular py-1">{bucket.recommended}</td>
                <td className="tabular py-1">{bucket.applied}</td>
                <td className="tabular py-1">{bucket.skipped}</td>
                <td className="tabular py-1">{bucket.responses}</td>
                <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {bucket.sufficientSample
                    ? `${percent(bucket.followRate)} followed`
                    : 'Too few to read'}
                </td>
              </tr>
            ))}
          </Table>

          {calibration.note && (
            <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
              {calibration.note}
            </p>
          )}
        </Card>
      )}

      {/* ── The applications themselves ────────────────────────────────── */}
      {trackedOnly.length > 0 && (
        <Card
          title="Marked from job cards"
          description="Jobs you flagged without recording the detail. Adding the resume you sent and the outcome moves them into the analysis above."
        >
          <Table head={['State', 'Job', 'Company', 'Last change']}>
            {trackedOnly.map((row) => (
              <tr key={row.id}>
                <td className="py-1">{row.state}</td>
                <td className="py-1">
                  <Link href={`/matches/${row.jobId}`} className="hover:underline">
                    {row.jobTitle}
                  </Link>
                </td>
                <td className="py-1" style={{ color: 'var(--muted)' }}>
                  {row.companyName}
                </td>
                <td className="tabular py-1">
                  {row.lastTransitionAt ? row.lastTransitionAt.toISOString().slice(0, 10) : '—'}
                </td>
              </tr>
            ))}
          </Table>

          <div className="mt-3 flex flex-wrap gap-4 text-xs" style={{ color: 'var(--muted)' }}>
            {Object.entries(trackedCounts).map(([state, count]) => (
              <span key={state}>
                <span className="tabular">{count}</span> {state}
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card title="Your applications" description="Everything you have recorded in detail.">
        {records.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Nothing recorded in detail yet.
          </p>
        ) : (
        <Table head={['Applied', 'Job', 'Status', 'First reply', 'Advice at the time']}>
          {records.map((record) => (
            <tr key={record.id}>
              <td className="tabular py-1">{record.appliedAt.toISOString().slice(0, 10)}</td>
              <td className="py-1">
                <Link href={`/matches/${record.jobId}`} className="hover:underline">
                  {record.jobId.slice(0, 8)}
                </Link>
              </td>
              <td className="py-1">{STATUS_LABEL[record.status] ?? record.status}</td>
              <td className="tabular py-1">
                {record.firstResponseAt ? record.firstResponseAt.toISOString().slice(0, 10) : '—'}
              </td>
              <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                {record.recommendationAtApply ?? 'not analysed'}
                {record.valueScoreAtApply !== null
                  ? ` (${Math.round(record.valueScoreAtApply)})`
                  : ''}
              </td>
            </tr>
          ))}
        </Table>
        )}
      </Card>
    </div>
  );
}
