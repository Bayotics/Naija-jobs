import Link from 'next/link';
import { z } from 'zod';
import { RECOMMENDATION_TIERS, TIER_ICONS } from '@job-intel/contracts';
import { getRecommendationContext } from '@/lib/recommendations';
import { Badge, Card, EmptyState, PageHeader, Stat } from '@/components/ui';
import { WorkerStatus } from '@/components/worker-status';

export const dynamic = 'force-dynamic';

/**
 * The list the candidate actually reads. With no email, this page *is* the
 * product — everything the pipeline does ends here.
 *
 * Leads with the recommendation score but always shows the match score beside
 * it, because they answer different questions and hiding one makes the other
 * look wrong. A job ranked below a lower-matching one is not a bug, and the two
 * numbers side by side are what make that legible instead of alarming.
 *
 * Every row carries the four facts someone decides on — where, how much, what
 * arrangement, how old — rather than making them open the posting to find out.
 * A ranked list you have to click through to evaluate is not ranked, it is
 * sorted.
 */
const querySchema = z.object({
  tier: z.enum(RECOMMENDATION_TIERS).optional(),
  shortlistOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const TIER_TONE: Record<string, 'ok' | 'accent' | 'neutral' | 'warn' | 'danger'> = {
  EXCEPTIONAL: 'ok',
  HIGHLY_RECOMMENDED: 'ok',
  STRONG: 'accent',
  WORTH_CONSIDERING: 'neutral',
  LOW_PRIORITY: 'neutral',
  EXCLUDED: 'danger',
  STALE: 'warn',
};

/**
 * Salary as the posting stated it.
 *
 * Never converted and never inferred. A Nigerian listing quotes a monthly
 * naira figure; rendering that as an annual dollar equivalent would be a
 * number nobody wrote down, and "₦150,000" with no period is a different job
 * depending on whether it is a month or a year.
 */
function formatSalary(job: {
  salaryMin: string | null;
  salaryMax: string | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
}): string | null {
  const min = job.salaryMin ? Number(job.salaryMin) : null;
  const max = job.salaryMax ? Number(job.salaryMax) : null;
  if (min === null && max === null) return null;

  const currency = job.salaryCurrency ?? '';
  const money = (value: number) =>
    `${currency}${currency ? ' ' : ''}${Math.round(value).toLocaleString('en-NG')}`;

  const period = job.salaryPeriod ? `/${job.salaryPeriod.toLowerCase()}` : '';
  const range =
    min !== null && max !== null && min !== max
      ? `${money(min)} – ${money(max)}`
      : money((min ?? max) as number);

  return `${range}${period}`;
}

/** Where it is, in the words a person would use. */
function formatPlace(job: {
  city: string | null;
  countryCode: string | null;
  locationRaw: string | null;
  remoteType: string;
}): string | null {
  const place = job.city ?? job.locationRaw ?? (job.countryCode === 'NG' ? 'Nigeria' : null);
  if (job.remoteType === 'remote') return place ? `Remote · ${place}` : 'Remote';
  if (job.remoteType === 'hybrid') return place ? `Hybrid · ${place}` : 'Hybrid';
  return place;
}

/**
 * Age, coarsely.
 *
 * "3 days ago" is the decision-relevant fact on a job board; a timestamp to
 * the minute is noise that has to be converted in the reader's head.
 */
function formatAge(postedAt: Date | null, firstSeenAt: Date): string {
  const at = postedAt ?? firstSeenAt;
  const hours = Math.floor((Date.now() - at.getTime()) / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** The ring colour. Same scale as the badge, so the row reads as one thing. */
const TIER_DIAL: Record<string, string> = {
  EXCEPTIONAL: 'var(--ok)',
  HIGHLY_RECOMMENDED: 'var(--ok)',
  STRONG: 'var(--accent)',
  WORTH_CONSIDERING: 'var(--muted)',
  LOW_PRIORITY: 'var(--muted)',
  EXCLUDED: 'var(--danger)',
  STALE: 'var(--warn)',
};

/**
 * A score as a filled ring.
 *
 * Printed bare, 32 and 84 look like the same kind of fact and the reader has
 * to do the comparing. The ring fills in proportion, so the gap registers
 * before either number is read.
 */
function ScoreDial({ score, color, label }: { score: number; color: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="score-dial grid h-14 w-14 place-items-center rounded-full"
        style={
          {
            '--score': Math.max(0, Math.min(100, score)),
            '--score-color': color,
          } as React.CSSProperties
        }
      >
        <div className="score-dial-inner grid h-11 w-11 place-items-center rounded-full">
          <span className="tabular text-base font-semibold leading-none">{Math.round(score)}</span>
        </div>
      </div>
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
    </div>
  );
}

export default async function RecommendationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = querySchema.safeParse(
    Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v] as const),
    ),
  );
  const query = parsed.success ? parsed.data : querySchema.parse({});

  const { service, repository, profileId } = await getRecommendationContext();
  if (!profileId) {
    return (
      <div className="max-w-4xl">
        <PageHeader
          title="Your jobs"
          description="What to actually look at, in order, and why."
        />
        <EmptyState
          title="No candidate profile yet"
          reason="Jobs are ranked against a stored profile. Create one first."
          action={<Link href="/profile">Create a profile</Link>}
        />
      </div>
    );
  }

  const [rows, statistics] = await Promise.all([
    service.getTopRecommendations(profileId, {
      limit: query.limit,
      ...(query.tier ? { tiers: [query.tier] } : {}),
      ...(query.shortlistOnly ? { notificationEligibleOnly: true } : {}),
    }),
    repository.statistics(profileId),
  ]);

  return (
    <div className="max-w-5xl">
      <WorkerStatus />

      <PageHeader
        title="Your jobs"
        description="Everything worth your time, best first. Ranked on more than how well each one matches."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Ranked" value={statistics.total} />
        <Stat
          label="Shortlisted"
          value={statistics.notifiable}
          hint="clears every quality bar"
          emphasis
        />
        <Stat label="Average score" value={statistics.averageScore} />
        <Stat
          label="Exceptional"
          value={statistics.byTier.EXCEPTIONAL ?? 0}
          hint={`${statistics.byTier.HIGHLY_RECOMMENDED ?? 0} highly recommended`}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing ranked yet"
          reason="Jobs must be discovered, enriched and matched before they can be ranked. The worker does this hourly; the Sources page shows whether anything is coming in."
          action={<Link href="/sources">Check sources</Link>}
        />
      ) : (
        <Card
          title={`${rows.length} job${rows.length === 1 ? '' : 's'}`}
          description={
            query.shortlistOnly
              ? 'Shortlisted only.'
              : 'Including jobs that fell short of the shortlist.'
          }
        >
          <ol className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {rows.map((row) => {
              const rec = row.recommendation;
              const href = row.job.applyUrl ?? row.job.canonicalUrl ?? row.job.sourceUrl;
              const salary = formatSalary(row.job);
              const place = formatPlace(row.job);

              return (
                <li key={row.job.id} className="job-row -mx-5 px-5 py-4">
                  <div className="flex gap-4">
                    {/*
                      Both numbers, side by side, always.

                      They answer different questions - "how well does this fit
                      me" and "how good a thing is it to look at today" - and a
                      job ranked below a better-matching one is not a bug.
                      Showing only the composite is what makes it look like one.
                    */}
                    <div className="hidden shrink-0 flex-col items-center gap-2 sm:flex">
                      <ScoreDial
                        score={rec.finalScore}
                        color={TIER_DIAL[rec.tier] ?? 'var(--muted)'}
                        label="rank"
                      />
                      <ScoreDial score={rec.matchScore} color="var(--info)" label="match" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                        <div className="min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span
                              className="tabular text-xs font-medium"
                              style={{ color: 'var(--muted)' }}
                            >
                              #{rec.rank}
                            </span>
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-base font-semibold leading-snug hover:underline"
                            >
                              {row.job.title}
                            </a>
                          </div>
                          <div className="mt-0.5 text-sm" style={{ color: 'var(--muted)' }}>
                            {row.job.companyNameRaw}
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          <Badge tone={TIER_TONE[rec.tier] ?? 'neutral'}>
                            {TIER_ICONS[rec.tier]} {rec.tier.replace(/_/g, ' ').toLowerCase()}
                          </Badge>
                          {/* The dials are desktop-only; on a phone the numbers
                              still have to be somewhere. */}
                          <span className="tabular text-sm font-semibold sm:hidden">
                            {Math.round(rec.finalScore)}
                            <span className="font-normal" style={{ color: 'var(--muted)' }}>
                              {' '}
                              · match {Math.round(rec.matchScore)}
                            </span>
                          </span>
                        </div>
                      </div>

                      <div
                        className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                        style={{ color: 'var(--muted)' }}
                      >
                        {place && <span>📍 {place}</span>}
                        {salary ? (
                          <span className="tabular">💰 {salary}</span>
                        ) : (
                          /*
                            Said out loud rather than left blank. Most Nigerian
                            postings omit salary, and a silent gap reads as "the
                            system failed to parse it" when the employer simply
                            never published one.
                          */
                          <span>💰 not stated</span>
                        )}
                        <span>🕑 {formatAge(row.job.postedAt, row.job.firstSeenAt)}</span>
                        <span>via {row.job.sourceId}</span>
                      </div>

                      <p className="clamp-3 mt-2.5 text-sm" style={{ color: 'var(--muted)' }}>
                        {rec.rankExplanation}
                      </p>

                      {rec.rankReasons.length > 0 && (
                        <ul className="mt-2.5 flex flex-wrap gap-1.5 text-[11px]">
                          {rec.rankReasons.slice(0, 4).map((reason, index) => (
                            <li
                              key={`${row.job.id}-r${index}`}
                              className="px-2 py-0.5"
                              style={{
                                background: 'var(--surface-2)',
                                color: 'var(--muted)',
                                borderRadius: '999px',
                              }}
                            >
                              {reason}
                            </li>
                          ))}
                        </ul>
                      )}

                      {!rec.notificationEligible && rec.notificationBlockers.length > 0 && (
                        <p className="mt-2.5 text-xs" style={{ color: 'var(--warn)' }}>
                          Below the shortlist: {rec.notificationBlockers.slice(0, 2).join('; ')}
                        </p>
                      )}

                      <div className="mt-3">
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold"
                          style={{
                            background: 'var(--accent-soft)',
                            color: 'var(--accent)',
                            borderRadius: 'var(--radius-sm)',
                          }}
                        >
                          Open posting →
                        </a>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
      )}
    </div>
  );
}
