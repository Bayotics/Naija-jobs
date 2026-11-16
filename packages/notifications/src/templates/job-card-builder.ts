import type { JobCardData } from '@job-intel/contracts';

/**
 * Building a job card from structured data.
 *
 * Every field an email displays passes through here, and every one of them is
 * copied from a value the pipeline produced. Nothing is inferred, summarised or
 * phrased by a model — the brief's rule is "do not hallucinate information",
 * and the way to guarantee that is to give the renderer no source of facts
 * other than this structure.
 *
 * Where a value is unknown the card carries `null` and the template omits the
 * row. An email that says "Salary: not specified" is honest; one that says
 * "Salary: competitive" because that read better is not.
 */

export interface JobCardSource {
  jobId: string;
  title: string;
  company: string;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  remoteType: string | null;

  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;

  matchScore: number;
  confidence: number;
  recommendationScore: number;
  tier: string;

  rankReasons: string[];
  concerns: string[];
  matchedRequirements: string[];
  missingRequirements: string[];

  sourceId: string;
  sourceLabel: string;
  sourceAuthority: string;
  postedAt: Date | null;
  firstSeenAt: Date;

  applyUrl: string | null;
  canonicalUrl: string | null;
  sourceUrl: string;
  applicationUrlVerified: boolean;
  atsVendor: string | null;

  updateNote: string | null;
  appUrl: string;
  now?: Date;
}

/** "12 minutes ago", "3 days ago". Null-safe and never invented. */
export function formatAge(from: Date | null, now: Date): string {
  if (!from) return 'at an unknown time';
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) return 'moments ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} day${days === 1 ? '' : 's'} ago`;
  return `${Math.round(days / 30)} months ago`;
}

/**
 * Salary as the posting stated it.
 *
 * Returns null when nothing was stated — never a normalised estimate. The
 * candidate applies against the employer's figure, not against our USD
 * annualisation of it, and showing the latter as though it were the former
 * would be a fabrication.
 */
export function formatSalary(source: JobCardSource): string | null {
  const { salaryMin, salaryMax, salaryCurrency, salaryPeriod } = source;
  if (salaryMin === null && salaryMax === null) return null;

  const currency = salaryCurrency ?? '';
  const period = salaryPeriod ? `/${salaryPeriod}` : '';
  const money = (value: number) =>
    `${currency ? `${currency} ` : ''}${Math.round(value).toLocaleString()}`;

  if (salaryMin !== null && salaryMax !== null && salaryMin !== salaryMax) {
    return `${money(salaryMin)}–${money(salaryMax)}${period}`;
  }
  return `${money((salaryMin ?? salaryMax) as number)}${period}`;
}

export function formatLocation(source: JobCardSource): string | null {
  const parts = [source.city, source.region, source.countryCode].filter(
    (value): value is string => Boolean(value),
  );
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * The best application path, and an honest label for it.
 *
 * Preference order is the brief's: a direct ATS link, then the company's own
 * careers page, then whatever the source gave us. The `kind` travels with the
 * URL so the CTA can name the destination rather than implying it is the
 * employer when it is an aggregator.
 */
export function resolveApplyUrl(source: JobCardSource): {
  url: string;
  kind: JobCardData['applyUrlKind'];
  verified: boolean;
} {
  if (source.applyUrl) {
    if (source.atsVendor) {
      return { url: source.applyUrl, kind: 'ats', verified: source.applicationUrlVerified };
    }
    const kind: JobCardData['applyUrlKind'] =
      source.sourceAuthority === 'authoritative' || source.sourceAuthority === 'high'
        ? 'company'
        : 'aggregator';
    return { url: source.applyUrl, kind, verified: source.applicationUrlVerified };
  }

  if (source.canonicalUrl) {
    return { url: source.canonicalUrl, kind: 'source', verified: false };
  }

  // Never fabricated: the worst case is the URL the job was discovered at,
  // labelled as unconfirmed.
  return { url: source.sourceUrl, kind: 'unverified', verified: false };
}

const ARRANGEMENT_LABELS: Readonly<Record<string, string>> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
};

export function buildJobCard(source: JobCardSource): JobCardData {
  const now = source.now ?? new Date();
  const apply = resolveApplyUrl(source);

  return {
    jobId: source.jobId,
    title: source.title,
    company: source.company,
    location: formatLocation(source),
    workArrangement:
      source.remoteType && source.remoteType !== 'unknown'
        ? (ARRANGEMENT_LABELS[source.remoteType] ?? source.remoteType)
        : null,
    salary: formatSalary(source),

    matchScore: source.matchScore,
    confidence: source.confidence,
    recommendationScore: source.recommendationScore,
    tier: source.tier,

    // The ranking layer's own reasons, verbatim. Rewriting them here would be
    // a second place where an explanation could drift from the arithmetic.
    whyItMatches: source.rankReasons.slice(0, 6),
    concerns: source.concerns.slice(0, 4),
    matchedSkills: source.matchedRequirements.slice(0, 10),
    missingRequirements: source.missingRequirements.slice(0, 6),

    sourceId: source.sourceId,
    sourceLabel: source.sourceLabel,
    postedAgo: formatAge(source.postedAt ?? source.firstSeenAt, now),
    applyUrl: apply.url,
    applyUrlKind: apply.kind,
    applyUrlVerified: apply.verified,
    viewUrl: `${source.appUrl.replace(/\/+$/, '')}/matches/${source.jobId}`,

    updateNote: source.updateNote,
  };
}
