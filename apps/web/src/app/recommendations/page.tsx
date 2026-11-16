import Link from 'next/link';
import { z } from 'zod';
import { RECOMMENDATION_TIERS, TIER_ICONS } from '@job-intel/contracts';
import { getRecommendationContext } from '@/lib/recommendations';
import { Badge, Card, EmptyState, PageHeader, Stat } from '@/components/ui';

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
                <li key={row.job.id} className="py-4 first:pt-0 last:pb-0">
                  {/* ── Line 1: who and what, with the two scores ──────────── */}
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="tabular text-xs" style={{ color: 'var(--muted)' }}>
                        #{rec.rank}
                      </span>
                      <div className="min-w-0">
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-base font-semibold hover:underline"
                        >
                          {row.job.title}
                        </a>
                        <div className="text-sm" style={{ color: 'var(--muted)' }}>
                          {row.job.companyNameRaw}
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone={TIER_TONE[rec.tier] ?? 'neutral'}>
                        {TIER_ICONS[rec.tier]} {rec.tier.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                      <span className="tabular text-lg font-semibold leading-none">
                        {Math.round(rec.finalScore)}
                      </span>
                      {/* Shown beside, never instead of, the recommendation score. */}
                      <span className="tabular text-xs" style={{ color: 'var(--muted)' }}>
                        match {Math.round(rec.matchScore)}
                      </span>
                    </div>
                  </div>

                  {/* ── Line 2: the facts you decide on ────────────────────── */}
                  <div
                    className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                    style={{ color: 'var(--muted)' }}
                  >
                    {place && <span>📍 {place}</span>}
                    {salary ? (
                      <span className="tabular">💰 {salary}</span>
                    ) : (
                      /*
                       * Said out loud rather than left blank.
                       *
                       * Most Nigerian postings omit salary, and a silent gap
                       * reads as "the system failed to parse it" when in fact
                       * the employer never published one.
                       */
                      <span>💰 not stated</span>
                    )}
                    <span>🕑 {formatAge(row.job.postedAt, row.job.firstSeenAt)}</span>
                    <span>via {row.job.sourceId}</span>
                  </div>

                  {/* ── Line 3: why it sits here ───────────────────────────── */}
                  <p className="mt-2 text-sm">{rec.rankExplanation}</p>

                  {rec.rankReasons.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                      {rec.rankReasons.slice(0, 5).map((reason, index) => (
                        <li
                          key={`${row.job.id}-r${index}`}
                          className="rounded border px-1.5 py-0.5"
                          style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                        >
                          {reason}
                        </li>
                      ))}
                    </ul>
                  )}

                  {!rec.notificationEligible && rec.notificationBlockers.length > 0 && (
                    <p className="mt-2 text-xs" style={{ color: 'var(--warn)' }}>
                      Below the shortlist: {rec.notificationBlockers.slice(0, 2).join('; ')}
                    </p>
                  )}

                  <div className="mt-2">
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-block rounded border px-2.5 py-1 text-xs font-medium hover:underline"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      Open posting →
                    </a>
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
