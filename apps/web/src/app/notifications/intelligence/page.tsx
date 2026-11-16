import Link from 'next/link';
import { MIN_NOTIFICATIONS_FOR_INFERENCE } from '@job-intel/notifications';
import { getNotificationContext } from '@/lib/notification-intelligence';
import { Badge, Card, EmptyState, PageHeader, Stat, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The notification intelligence dashboard.
 *
 * The organising idea is that a system built to stay quiet has to be able to
 * account for its silence. So the suppression list is given as much room as the
 * alert list — arguably it is the more important half, because "why didn't I
 * hear about that job?" is the question that decides whether someone trusts
 * anything else on the page.
 *
 * The second commitment is statistical honesty. Job searches produce small
 * numbers for a long time, and every rate here says whether the sample supports
 * reading anything into it.
 */

const REASON_LABEL: Readonly<Record<string, string>> = {
  expired: 'Posting closed',
  duplicate: 'Same role, another listing',
  already_applied: 'Already applied',
  previously_rejected: 'You dismissed it',
  below_threshold: 'Below your threshold',
  hard_blocked: 'Blocked by a requirement',
  suspicious: 'Suspicious posting',
  outside_preferences: 'Outside your preferences',
  recently_notified: 'Told you recently',
  cooldown_job: 'Same-job cooldown',
  cooldown_company: 'Same-company cooldown',
  cooldown_role: 'Same-role cooldown',
  daily_limit: 'Daily alert limit',
  hourly_limit: 'Hourly alert limit',
  quiet_hours: 'Quiet hours',
  type_disabled: 'Type switched off',
  override_never_alert: 'You muted this',
  no_application_url: 'No usable link',
  recommendation_too_low: 'Recommendation too low',
  urgency_too_low: 'Not urgent enough',
  source_excluded: 'Source excluded',
};

const percent = (value: number | null): string =>
  value === null ? '—' : `${Math.round(value * 100)}%`;

export default async function NotificationIntelligencePage() {
  const { service, repository, profileId } = await getNotificationContext();

  if (!profileId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Notification intelligence" description="What gets through, and what does not." />
        <EmptyState title="No candidate profile yet" reason="Set up your profile to configure alerts." />
      </div>
    );
  }

  const [config, overrides, counts, suppressions, analytics, fatigue, quality, advice, scored] =
    await Promise.all([
      service.getConfig(profileId),
      service.listOverrides(profileId),
      service.suppressionCounts(profileId),
      service.suppressions(profileId, 25),
      service.analytics(profileId).catch(() => null),
      service.fatigue(profileId).catch(() => null),
      service.alertQuality(profileId).catch(() => null),
      service.thresholdAdvice(profileId).catch(() => null),
      repository.topScored(profileId, { limit: 15 }).catch(() => []),
    ]);

  const suppressedTotal = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const sent = analytics?.overall.sent ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notification intelligence"
        description="Signal over volume. Most jobs should not produce an email, and every one that does not has a reason."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Sent" value={sent} hint={`last ${analytics?.windowDays ?? 30} days`} />
        <Stat label="Clicked" value={analytics?.overall.clicked ?? 0} hint={percent(analytics?.clickRate ?? null)} />
        <Stat label="Suppressed" value={suppressedTotal} hint="with a recorded reason" />
        <Stat label="Instant threshold" value={config.thresholds.instant} hint="score to interrupt" />
        <Stat label="Digest threshold" value={config.thresholds.digest} />
        <Stat label="Daily cap" value={config.cooldowns.maxAlertsPerRollingDay} hint="alerts per day" />
      </div>

      {analytics && sent < MIN_NOTIFICATIONS_FOR_INFERENCE && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          These rates come from {sent} notification{sent === 1 ? '' : 's'}. Around{' '}
          {MIN_NOTIFICATIONS_FOR_INFERENCE} is where a difference starts to mean something — until
          then they are a record of what happened, not a measurement of how well it is working.
        </p>
      )}

      {/* ── What would alert now ───────────────────────────────────────── */}
      <Card
        title="Currently scoring highest"
        description="What the engine would put in front of you, ranked by notification score — not by match score."
      >
        {scored.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Nothing has been scored for notifications yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {scored.map((row) => (
              <li key={row.jobId} className="border-b pb-3 last:border-0" style={{ borderColor: 'var(--border)' }}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="tabular font-medium">{Math.round(row.score)}</span>
                  <Badge
                    tone={
                      row.urgency === 'CRITICAL'
                        ? 'danger'
                        : row.urgency === 'HIGH'
                          ? 'warn'
                          : 'neutral'
                    }
                  >
                    {row.urgency}
                  </Badge>
                  <Link href={`/matches/${row.jobId}`} className="font-medium hover:underline">
                    {row.title}
                  </Link>
                  <span className="text-sm" style={{ color: 'var(--muted)' }}>
                    {row.companyName}
                  </span>
                  <span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>
                    {row.score >= config.thresholds.instant
                      ? 'would alert'
                      : row.score >= config.thresholds.digest
                        ? 'next digest'
                        : 'dashboard only'}
                  </span>
                </div>
                <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {row.explanation}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── Suppressions ───────────────────────────────────────────────── */}
      <Card
        title="What was held back, and why"
        description="Every job that produced no notification, with the setting responsible. If a reason looks wrong, the setting named is the one to change."
      >
        {suppressions.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Nothing has been suppressed yet.
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-3 text-xs" style={{ color: 'var(--muted)' }}>
              {Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([reason, total]) => (
                  <span key={reason}>
                    <span className="tabular font-medium">{total}</span>{' '}
                    {REASON_LABEL[reason] ?? reason}
                  </span>
                ))}
            </div>

            <Table head={['Job', 'Reason', 'Detail', 'Setting']}>
              {suppressions.map((row) => (
                <tr key={row.jobId}>
                  <td className="py-1">
                    <Link href={`/matches/${row.jobId}`} className="hover:underline">
                      {row.title}
                    </Link>
                  </td>
                  <td className="py-1">{REASON_LABEL[row.reason] ?? row.reason}</td>
                  <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                    {row.detail}
                    {row.remedy ? ` ${row.remedy}` : ''}
                  </td>
                  <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                    {row.setting ?? '—'}
                  </td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </Card>

      {/* ── Fatigue ────────────────────────────────────────────────────── */}
      {fatigue && (
        <Card
          title="Are you getting too many?"
          description="Measured, never acted on. Nothing here changes a setting."
        >
          <p className="text-sm">{fatigue.advice}</p>

          {fatigue.suggestedChange && (
            <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
              Suggested: change <strong>{fatigue.suggestedChange.setting}</strong> from{' '}
              {fatigue.suggestedChange.from} to {fatigue.suggestedChange.to}.{' '}
              {fatigue.suggestedChange.rationale}
            </p>
          )}
        </Card>
      )}

      {/* ── Alert quality ──────────────────────────────────────────────── */}
      {quality && quality.buckets.length > 0 && (
        <Card
          title="Were the alerts worth it?"
          description="Precision per score band — how often an interruption led to a click, a save or an application."
        >
          <Table head={['Score band', 'Sent', 'Clicked', 'Precision', 'Reading']}>
            {quality.buckets.map((bucket) => (
              <tr key={bucket.band}>
                <td className="py-1">{bucket.band}</td>
                <td className="tabular py-1">{bucket.counts.sent}</td>
                <td className="tabular py-1">{bucket.counts.clicked}</td>
                <td className="tabular py-1">{percent(bucket.precision)}</td>
                <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {bucket.sufficientSample ? 'enough history to read' : 'too few to read'}
                </td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
            {quality.note} Open tracking is unreliable, so clicks are the number worth reading.
          </p>
        </Card>
      )}

      {/* ── Threshold advice ───────────────────────────────────────────── */}
      {advice && advice.scenarios.length > 0 && (
        <Card
          title="What a different threshold would have done"
          description="Replayed from your actual history. Advisory only — thresholds are never changed for you."
        >
          <Table head={['Threshold', 'Alerts', 'Change', 'Clicks kept', 'Summary']}>
            {advice.scenarios.map((scenario) => (
              <tr key={scenario.threshold}>
                <td className="tabular py-1">{scenario.threshold}</td>
                <td className="tabular py-1">{scenario.alertsSent}</td>
                <td className="tabular py-1">
                  {scenario.alertsChange >= 0 ? '+' : ''}
                  {scenario.alertsChange}%
                </td>
                <td className="tabular py-1">{percent(scenario.clicksRetainedShare)}</td>
                <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {scenario.summary}
                </td>
              </tr>
            ))}
          </Table>

          {!advice.sufficientSample && (
            <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
              Too few alerts so far for this comparison to mean much.
            </p>
          )}
        </Card>
      )}

      {/* ── Rules ──────────────────────────────────────────────────────── */}
      <Card
        title="Your alert rules"
        description="Explicit instructions about what to tell you. A block always beats an allow — if you mute a company, a starred job title will not override it."
      >
        {overrides.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            No rules set. You can mute a company, or ask to always hear about a particular title.
          </p>
        ) : (
          <Table head={['Rule', 'Subject', 'Value']}>
            {overrides.map((rule) => (
              <tr key={rule.id}>
                <td className="py-1">
                  <Badge tone={rule.action === 'never_alert' ? 'danger' : 'ok'}>
                    {rule.action.replace(/_/g, ' ')}
                  </Badge>
                </td>
                <td className="py-1">{rule.subject}</td>
                <td className="py-1">{rule.value}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Behaviour informs these scores by at most {config.maxBehavioralAdjustment} points and is
        refused outright wherever it contradicts something you stated explicitly.
      </p>
    </div>
  );
}
