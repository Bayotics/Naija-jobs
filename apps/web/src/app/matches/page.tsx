import Link from 'next/link';
import { z } from 'zod';
import { MATCHING_VERSION, RECOMMENDATION_CATEGORIES } from '@job-intel/contracts';
import { getServerContext } from '@/lib/db';
import { getMatchingContext } from '@/lib/matching';
import { Badge, Card, EmptyState, PageHeader, Stat } from '@/components/ui';
import { RecommendationBadge } from '@/components/match';

export const dynamic = 'force-dynamic';

/** Query params are user input, so they are validated before reaching a repository. */
const querySchema = z.object({
  minScore: z.coerce.number().min(0).max(100).optional(),
  recommendation: z.enum(RECOMMENDATION_CATEGORIES).optional(),
  showIneligible: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export default async function MatchesPage({
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

  const { matches, profileId } = await getMatchingContext();
  if (!profileId) {
    return (
      <div className="max-w-4xl">
        <PageHeader title="Matches" description="Scored jobs with the reasoning behind each score." />
        <EmptyState
          title="No candidate profile yet"
          reason="Matching scores jobs against a stored profile and preference set. Create a profile first."
          action={<Link href="/profile">Create a profile</Link>}
        />
      </div>
    );
  }

  const ctx = await getServerContext();
  const [items, statistics, pending] = await Promise.all([
    matches.list({
      profileId,
      limit: 100,
      eligibleOnly: !query.showIneligible,
      ...(query.minScore !== undefined ? { minScore: query.minScore } : {}),
      ...(query.recommendation ? { recommendations: [query.recommendation] } : {}),
    }),
    matches.statistics(profileId),
    matches.findJobsNeedingMatch(profileId, { limit: 5000 }),
  ]);

  const jobs = await Promise.all(items.map((match) => ctx.jobs.getById(match.jobId)));
  const jobById = new Map(jobs.filter(Boolean).map((job) => [job!.id, job!]));

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Matches"
        description="Scored against your stored preferences. Every score opens to its full breakdown."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Scored" value={statistics.total} hint={`${statistics.eligible} eligible`} />
        <Stat label="Average score" value={statistics.averageScore} />
        <Stat
          label="Average confidence"
          value={`${Math.round(statistics.averageConfidence * 100)}%`}
        />
        <Stat
          label="Awaiting rescore"
          value={pending.length}
          // The number that explains a stale-looking list: these jobs have not
          // yet been scored against the current preferences.
          hint={pending.length > 0 ? 'preferences or data moved on' : 'up to date'}
        />
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="Nothing scored yet"
          reason={
            pending.length > 0
              ? `${pending.length} enriched job(s) are waiting to be scored. Run a recalculation to score them against your current preferences.`
              : 'No enriched jobs are available to score. Run discovery and enrichment first.'
          }
        />
      ) : (
        <Card
          title={`${items.length} match${items.length === 1 ? '' : 'es'}`}
          description={`Engine ${MATCHING_VERSION}. ${query.showIneligible ? 'Including ineligible jobs.' : 'Ineligible jobs hidden.'}`}
        >
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {items.map((match) => {
              const job = jobById.get(match.jobId);
              return (
                <li key={match.jobId} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link
                      href={`/matches/${match.jobId}`}
                      className="text-sm font-semibold hover:underline"
                    >
                      {job?.title ?? 'Untitled role'}
                    </Link>
                    <div className="flex items-center gap-2">
                      <RecommendationBadge value={match.recommendation} />
                      <span className="tabular text-sm font-semibold">
                        {Math.round(match.overallScore)}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--muted)' }}>
                        {Math.round(match.confidence * 100)}% conf.
                      </span>
                    </div>
                  </div>

                  <div className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                    {job?.company?.canonicalName ?? job?.companyNameRaw ?? 'Unknown company'}
                  </div>

                  <p className="mt-1 text-sm">{match.explanation}</p>

                  {match.concerns.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {match.concerns.slice(0, 3).map((concern, index) => (
                        <Badge key={`${match.jobId}-c${index}`} tone="warn">
                          {concern.length > 70 ? `${concern.slice(0, 70)}…` : concern}
                        </Badge>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
