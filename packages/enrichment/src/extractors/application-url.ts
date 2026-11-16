import type { ApplicationTarget, AtsVendor } from '@job-intel/contracts';
import { normalizeUrl } from '@job-intel/core';

/**
 * Application URL resolution.
 *
 * A posting can carry several URLs: the board page, the company careers page,
 * a third-party ATS link, and whatever the description embeds. The goal is the
 * most *direct legitimate* destination, not the first one seen.
 *
 * The ranking ladder, highest first:
 *
 *   1.0  ATS direct     the employer's own applicant tracking system
 *   0.9  company careers the employer's own domain
 *   0.7  board          a job board's apply page
 *   0.5  aggregator     a re-poster
 *   0.2  social         a Reddit or X post
 *
 * A recognisable ATS domain is not proof of legitimacy: anyone can create a
 * Greenhouse board. Recognising the vendor tells us the *kind* of URL, and the
 * `atsSlug` is checked against the company name so a mismatch lowers confidence
 * rather than being silently trusted.
 */

interface AtsRule {
  vendor: AtsVendor;
  hostPattern: RegExp;
  /** Extracts the employer slug from the URL. */
  slugFrom?: (url: URL) => string | null;
}

const ATS_RULES: AtsRule[] = [
  {
    vendor: 'greenhouse',
    hostPattern: /(?:^|\.)(?:boards\.)?greenhouse\.io$|(?:^|\.)job-boards\.greenhouse\.io$/i,
    slugFrom: (url) => url.pathname.split('/').filter(Boolean)[0] ?? null,
  },
  {
    vendor: 'lever',
    hostPattern: /(?:^|\.)lever\.co$/i,
    slugFrom: (url) => url.pathname.split('/').filter(Boolean)[0] ?? null,
  },
  {
    vendor: 'ashby',
    hostPattern: /(?:^|\.)ashbyhq\.com$/i,
    slugFrom: (url) => url.pathname.split('/').filter(Boolean)[0] ?? null,
  },
  { vendor: 'workday', hostPattern: /(?:^|\.)myworkdayjobs\.com$|(?:^|\.)workday\.com$/i },
  {
    vendor: 'smartrecruiters',
    hostPattern: /(?:^|\.)smartrecruiters\.com$/i,
    slugFrom: (url) => url.pathname.split('/').filter(Boolean)[0] ?? null,
  },
  { vendor: 'icims', hostPattern: /(?:^|\.)icims\.com$/i },
  {
    vendor: 'workable',
    hostPattern: /(?:^|\.)workable\.com$/i,
    slugFrom: (url) => url.hostname.split('.')[0] ?? null,
  },
  {
    vendor: 'recruitee',
    hostPattern: /(?:^|\.)recruitee\.com$/i,
    slugFrom: (url) => url.hostname.split('.')[0] ?? null,
  },
  {
    vendor: 'personio',
    hostPattern: /(?:^|\.)personio\.(?:de|com)$/i,
    slugFrom: (url) => url.hostname.split('.')[0] ?? null,
  },
  { vendor: 'teamtailor', hostPattern: /(?:^|\.)teamtailor\.com$/i },
  { vendor: 'bamboohr', hostPattern: /(?:^|\.)bamboohr\.com$/i },
  { vendor: 'jobvite', hostPattern: /(?:^|\.)jobvite\.com$/i },
  { vendor: 'taleo', hostPattern: /(?:^|\.)taleo\.net$/i },
  { vendor: 'successfactors', hostPattern: /(?:^|\.)successfactors\.(?:com|eu)$/i },
];

/** Known aggregators and boards, so their URLs are not mistaken for employers. */
const BOARD_HOSTS = /(?:^|\.)(?:remotive\.com|weworkremotely\.com|jobicy\.com|arbeitnow\.com|remoteok\.com|himalayas\.app|hotnigerianjobs\.com|myjobmag\.com|indeed\.com|linkedin\.com|glassdoor\.com|monster\.com|ziprecruiter\.com)$/i;
const SOCIAL_HOSTS = /(?:^|\.)(?:reddit\.com|twitter\.com|x\.com|facebook\.com|t\.me)$/i;

const KIND_RANK: Record<string, number> = {
  ats_direct: 1.0,
  company_careers: 0.9,
  board: 0.7,
  aggregator: 0.5,
  social: 0.2,
  unknown: 0.1,
};

export interface UrlCandidateInput {
  sourceUrl: string;
  applyUrl?: string | null;
  companyWebsite?: string | null;
  companyName: string;
  /** URLs found in the description body. */
  embeddedUrls?: readonly string[];
}

export function resolveApplicationTarget(input: UrlCandidateInput): ApplicationTarget {
  const seen = new Set<string>();
  const candidates: ApplicationTarget['candidates'] = [];

  const consider = (raw: string | null | undefined, note: string | null): void => {
    if (!raw) return;
    const normalized = normalizeUrl(raw);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);

    const classified = classifyUrl(normalized, input.companyName, input.companyWebsite ?? null);
    candidates.push({
      url: normalized,
      kind: classified.kind,
      rank: classified.rank,
      note: note ?? classified.note,
    });
  };

  // Ordered by how likely each is to be the real destination.
  consider(input.applyUrl, 'source-provided apply URL');
  consider(input.sourceUrl, 'source URL');
  consider(input.companyWebsite, 'company website');
  for (const url of input.embeddedUrls ?? []) consider(url, 'found in description');

  candidates.sort((a, b) => b.rank - a.rank);

  const best = candidates[0] ?? null;
  const sourceNormalized = normalizeUrl(input.sourceUrl) ?? input.sourceUrl;
  const atsInfo = best ? detectAts(best.url) : null;

  /**
   * `canonicalJobUrl` is where the posting lives; `applicationUrl` is where you
   * apply. They are usually the same, but when a board links out to an ATS the
   * distinction is the whole point of this module.
   */
  const applicationUrl = best && best.rank >= (KIND_RANK.board ?? 0.7) ? best.url : null;

  return {
    sourceUrl: sourceNormalized,
    canonicalJobUrl: sourceNormalized,
    applicationUrl,
    atsVendor: atsInfo?.vendor ?? null,
    atsSlug: atsInfo?.slug ?? null,
    confidence: best?.rank ?? 0,
    kind: best?.kind ?? 'unknown',
    candidates: candidates.slice(0, 10),
  };
}

export function detectAts(url: string): { vendor: AtsVendor; slug: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  for (const rule of ATS_RULES) {
    if (!rule.hostPattern.test(parsed.hostname)) continue;
    return { vendor: rule.vendor, slug: rule.slugFrom?.(parsed) ?? null };
  }
  return null;
}

function classifyUrl(
  url: string,
  companyName: string,
  companyWebsite: string | null,
): { kind: string; rank: number; note: string | null } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'unknown', rank: KIND_RANK.unknown ?? 0.1, note: 'unparseable URL' };
  }

  const ats = detectAts(url);
  if (ats) {
    /**
     * A recognisable ATS domain says what kind of link it is, not that it is
     * the right employer's. Compare the slug with the company name and demote
     * on a mismatch rather than trusting the domain.
     */
    const slugMatches = ats.slug ? slugResemblesCompany(ats.slug, companyName) : false;
    return {
      kind: 'ats_direct',
      rank: slugMatches ? (KIND_RANK.ats_direct ?? 1) : 0.75,
      note: ats.slug
        ? slugMatches
          ? `${ats.vendor} board for "${ats.slug}"`
          : `${ats.vendor} board for "${ats.slug}" — does not obviously match "${companyName}"`
        : `${ats.vendor} link`,
    };
  }

  if (SOCIAL_HOSTS.test(parsed.hostname)) {
    return { kind: 'social', rank: KIND_RANK.social ?? 0.2, note: 'social post' };
  }
  if (BOARD_HOSTS.test(parsed.hostname)) {
    return { kind: 'board', rank: KIND_RANK.board ?? 0.7, note: 'job board' };
  }

  // The employer's own domain.
  if (companyWebsite) {
    try {
      const companyHost = new URL(companyWebsite).hostname.replace(/^www\./, '');
      if (parsed.hostname.replace(/^www\./, '').endsWith(companyHost)) {
        return {
          kind: 'company_careers',
          rank: KIND_RANK.company_careers ?? 0.9,
          note: 'company-owned domain',
        };
      }
    } catch {
      // Unusable company website; fall through.
    }
  }

  if (/\b(?:careers?|jobs?|vacancies|hiring)\b/i.test(parsed.pathname)) {
    return { kind: 'company_careers', rank: 0.8, note: 'careers path on an unknown domain' };
  }

  return { kind: 'aggregator', rank: KIND_RANK.aggregator ?? 0.5, note: null };
}

/** Loose comparison: "acme-corp" vs "Acme Corp, Inc." should match. */
function slugResemblesCompany(slug: string, companyName: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = normalize(slug);
  const b = normalize(companyName);
  if (a.length < 3 || b.length < 3) return false;
  return a.includes(b) || b.includes(a) || a.slice(0, 6) === b.slice(0, 6);
}

/** Pulls http(s) URLs out of description text. */
export function extractUrlsFromText(text: string | null | undefined, limit = 10): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    const cleaned = match.replace(/[.,;:!?]+$/, '');
    unique.add(cleaned);
    if (unique.size >= limit) break;
  }
  return [...unique];
}
