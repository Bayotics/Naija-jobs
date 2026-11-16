import { linkValidationSchema, type LinkValidation } from '@job-intel/contracts';

/**
 * Link validation for outbound emails.
 *
 * A job alert whose link is wrong is worse than no alert: the candidate clicks,
 * lands on a careers homepage or a 404, and learns that the links in these
 * emails cannot be trusted. After that the emails stop working even when they
 * are right.
 *
 * Three rules follow from that, and the first is the one the brief states
 * outright: **never invent a URL.** If no application link was discovered, the
 * email carries the source link or says there is none. It does not construct a
 * plausible-looking one from the company domain.
 *
 * The second is that a *search results page* is not a job link. Aggregators
 * frequently resolve to `/jobs?q=frontend`, which technically loads and is
 * useless — the candidate has to find the posting themselves, and the alert has
 * spent its credibility on nothing.
 *
 * The third is that reachability is a bonus, not a requirement. `unverified` is
 * a perfectly good verdict: many employers block automated requests, and
 * dropping every link we could not fetch would empty the emails.
 */

/** Schemes that may appear in an email. Everything else is rejected. */
const SAFE_SCHEMES = new Set(['http:', 'https:']);

/**
 * Paths that indicate a search or listing page rather than one job.
 *
 * Checked against the path *and* the query, because both forms occur:
 * `/search?q=react` and `/jobs/search`.
 */
const SEARCH_PAGE_PATTERNS: readonly RegExp[] = [
  /\/search\b/i,
  /\/jobs\/?$/i,
  /\/careers\/?$/i,
  /\/vacancies\/?$/i,
  /\/opportunities\/?$/i,
  /\/browse\b/i,
  /\/results\b/i,
];

const SEARCH_QUERY_KEYS = ['q', 'query', 'keywords', 'search', 'k'];

/** Hosts whose bare root is never a job page. */
const AGGREGATOR_ROOTS = new Set([
  'linkedin.com',
  'www.linkedin.com',
  'indeed.com',
  'www.indeed.com',
  'glassdoor.com',
  'www.glassdoor.com',
]);

export interface LinkCheckOptions {
  /**
   * Optional reachability probe.
   *
   * Injected rather than imported so this module stays pure and testable, and
   * so the SSRF-hardened client from the connectors package is the only thing
   * that ever makes the request.
   */
  probe?: (url: string) => Promise<{ status: number; finalUrl: string; redirects: number } | null>;
  /** Redirect hops beyond which the destination is no longer trustworthy. */
  maxRedirects?: number;
}

/** Structural checks. No network, so it is safe to run on everything. */
export function inspectUrl(raw: string | null): {
  ok: boolean;
  url: URL | null;
  reason: string | null;
} {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, url: null, reason: 'No URL was discovered for this posting.' };
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, url: null, reason: 'The stored URL is not a valid address.' };
  }

  if (!SAFE_SCHEMES.has(url.protocol)) {
    return { ok: false, url: null, reason: `Unsupported scheme ${url.protocol}.` };
  }

  /*
   * Credentials in a URL are a phishing shape.
   *
   * `https://jobs.example.com@evil.example/` renders as the first host in most
   * clients and resolves to the second. Never forwarded.
   */
  if (url.username || url.password) {
    return { ok: false, url: null, reason: 'The URL embeds credentials, which is unsafe to forward.' };
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (AGGREGATOR_ROOTS.has(host) && (path === '/' || path === '')) {
    return { ok: false, url: null, reason: 'The URL points at a site homepage rather than a job.' };
  }

  for (const pattern of SEARCH_PAGE_PATTERNS) {
    if (pattern.test(path)) {
      return {
        ok: false,
        url: null,
        reason: 'The URL points at a search or listing page rather than a specific job.',
      };
    }
  }

  for (const key of SEARCH_QUERY_KEYS) {
    if (url.searchParams.has(key)) {
      return {
        ok: false,
        url: null,
        reason: 'The URL carries a search query rather than identifying one posting.',
      };
    }
  }

  return { ok: true, url, reason: null };
}

/**
 * Validates a link for inclusion in an email.
 *
 * Structure first, then an optional reachability probe. The probe is expected
 * to be the SSRF-hardened client — this module never constructs its own
 * request, so there is exactly one code path in the system that follows a
 * redirect from untrusted content.
 */
export async function validateLink(
  input: { applicationUrl: string | null; canonicalUrl: string | null; sourceUrl: string | null },
  options: LinkCheckOptions = {},
): Promise<LinkValidation> {
  /*
   * Preference order, and it matters.
   *
   * The application URL is where the candidate can act. The canonical URL is
   * the posting's own page. The source URL is where it was found, which may be
   * an aggregator's copy. Falling back rather than substituting means the email
   * always carries the most direct link that actually exists.
   */
  const ordered = [input.applicationUrl, input.canonicalUrl, input.sourceUrl].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );

  if (ordered.length === 0) {
    return linkValidationSchema.parse({
      originalUrl: '',
      verdict: 'rejected',
      rejectionReason: 'No URL of any kind was discovered for this posting.',
    });
  }

  let lastReason: string | null = null;

  for (const candidate of ordered) {
    const inspection = inspectUrl(candidate);

    if (!inspection.ok || !inspection.url) {
      lastReason = inspection.reason;
      continue;
    }

    const usable = inspection.url.toString();

    if (!options.probe) {
      // No probe available. Structurally sound is the most that can be said,
      // and saying more would be a claim the system has not checked.
      return linkValidationSchema.parse({
        originalUrl: candidate,
        canonicalUrl: input.canonicalUrl,
        finalUrl: null,
        verdict: 'unverified',
        redirects: 0,
      });
    }

    try {
      const result = await options.probe(usable);

      if (result === null) {
        return linkValidationSchema.parse({
          originalUrl: candidate,
          canonicalUrl: input.canonicalUrl,
          verdict: 'unverified',
          rejectionReason: null,
          checkedAt: new Date(),
        });
      }

      const maxRedirects = options.maxRedirects ?? 5;

      if (result.redirects > maxRedirects) {
        lastReason = `The link redirected ${result.redirects} times, which is too many to trust.`;
        continue;
      }

      /*
       * Where a redirect landed matters as much as whether it worked.
       *
       * A posting URL that ends up on a careers homepage or a search page has
       * expired in all but name, and forwarding it sends the candidate on a
       * hunt. Re-inspected rather than assumed.
       */
      const destination = inspectUrl(result.finalUrl);

      if (!destination.ok) {
        lastReason = `The link redirects somewhere unusable: ${destination.reason}`;
        continue;
      }

      if (result.status === 404 || result.status === 410) {
        lastReason = `The posting returns ${result.status} — it has been taken down.`;
        continue;
      }

      if (result.status >= 400) {
        // Not necessarily gone: 403 is what most bot protection returns, and
        // the page loads perfectly well in a browser.
        return linkValidationSchema.parse({
          originalUrl: candidate,
          canonicalUrl: input.canonicalUrl,
          finalUrl: result.finalUrl,
          verdict: 'unverified',
          httpStatus: result.status,
          redirects: result.redirects,
          checkedAt: new Date(),
        });
      }

      return linkValidationSchema.parse({
        originalUrl: candidate,
        canonicalUrl: input.canonicalUrl,
        finalUrl: result.finalUrl,
        verdict: 'usable',
        httpStatus: result.status,
        redirects: result.redirects,
        checkedAt: new Date(),
      });
    } catch {
      // A failed probe is not a failed link.
      return linkValidationSchema.parse({
        originalUrl: candidate,
        canonicalUrl: input.canonicalUrl,
        verdict: 'unverified',
        checkedAt: new Date(),
      });
    }
  }

  return linkValidationSchema.parse({
    originalUrl: ordered[0]!,
    canonicalUrl: input.canonicalUrl,
    verdict: 'rejected',
    rejectionReason: lastReason ?? 'No usable link could be resolved.',
  });
}

/** The URL an email should link to, or null when none is fit to send. */
export function emailLink(validation: LinkValidation): string | null {
  if (validation.verdict === 'rejected') return null;
  return validation.finalUrl ?? validation.canonicalUrl ?? validation.originalUrl;
}
