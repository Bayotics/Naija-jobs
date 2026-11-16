import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import { htmlToText } from '@job-intel/core';
import type { HttpClient } from '../http/client';

/**
 * ATS provider adapters.
 *
 * Most companies do not host their own job board; they rent one. Greenhouse,
 * Lever, Ashby and the rest each publish a *public, documented JSON endpoint*
 * for a company's open roles — the same endpoint the company's own careers page
 * calls to render itself. Reading that is both the cheapest and the most
 * accurate way to discover those jobs, and it is what the company intends the
 * endpoint for.
 *
 * The important architectural claim: **the providers differ enough that a
 * shared schema would be a lie.** Greenhouse returns `content` as escaped HTML
 * and `location.name` as a free string; Lever returns `categories.location` and
 * a pre-split `lists` array; Ashby is a GraphQL-shaped POST. Pretending
 * otherwise produces an adapter full of `??` chains that silently drops fields.
 *
 * So each provider owns three small functions — build a URL, parse a response,
 * recognise itself in a page — and the connector owns everything else:
 * pagination, rate limiting, robots, retries, drafts.
 */

export interface AtsListing {
  externalId: string;
  title: string;
  url: string;
  descriptionHtml: string | null;
  descriptionText: string | null;
  locationText: string | null;
  department: string | null;
  team: string | null;
  employmentType: string | null;
  remote: boolean | null;
  postedAt: Date | null;
  updatedAt: Date | null;
  applyUrl: string | null;
  raw: unknown;
}

export interface AtsFetchInput {
  /** The company's identifier on this ATS — a board token, slug or handle. */
  identifier: string;
  http: HttpClient;
  signal: AbortSignal;
  /** Provider-specific extras, validated by the connector's config schema. */
  options?: Record<string, unknown>;
}

export interface AtsProvider {
  readonly id: string;
  readonly displayName: string;
  /** Documentation, shown in the UI next to the source. */
  readonly docsUrl: string;
  /**
   * Whether this provider publishes descriptions in the listing response.
   * When false the connector must fetch each posting separately, which is
   * dramatically more expensive and changes how the source is scheduled.
   */
  readonly listingsIncludeDescription: boolean;

  /**
   * The host a `site:` query should target (Part 21).
   *
   * Search-engine discovery against ATS hosts is the highest-yield strategy in
   * the system: companies that appear on no job board still post through these
   * platforms, and those boards are indexed.
   */
  readonly searchHost: string;

  /**
   * Whether the provider's boards are publicly indexed at all.
   *
   * False for providers that gate their boards behind a login or a `noindex`.
   * Querying those spends search quota to return nothing, so the query builder
   * skips them rather than discovering that empirically every cycle.
   */
  readonly publiclyIndexed: boolean;

  /** Recognises the provider from a careers URL or page body. */
  detect(input: { url: string; html?: string | null }): { identifier: string | null; confidence: number } | null;

  /** Public board URL for a company, for the UI and for `baseUrl`. */
  boardUrl(identifier: string): string;

  fetchListings(input: AtsFetchInput): Promise<AtsListing[]>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toDate(value: unknown): Date | null {
  if (typeof value === 'number') {
    // Lever and Ashby use epoch milliseconds; a value in seconds would land in
    // 1970, so anything below year 2000 is treated as seconds.
    const ms = value < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Pulls a path segment following a known marker, e.g. `/boards/acme/…`. */
function segmentAfter(url: string, markers: string[]): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    for (const marker of markers) {
      const index = segments.indexOf(marker);
      if (index !== -1 && segments[index + 1]) return segments[index + 1]!;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The first path segment.
 *
 * Most hosted boards put the company slug there — `jobs.lever.co/acme`,
 * `boards.greenhouse.io/acme`. Distinct from `segmentAfter`, which looks for a
 * named marker *inside* the path; passing it an empty marker list finds nothing
 * at all, which is the bug this exists to make impossible.
 */
function firstSegment(url: string): string | null {
  try {
    return new URL(url).pathname.split('/').filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

function hostIs(url: string, host: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(host);
  } catch {
    return false;
  }
}

function subdomainOf(url: string, host: string): string | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (!hostname.endsWith(`.${host}`)) return null;
    const sub = hostname.slice(0, -(host.length + 1));
    return sub && sub !== 'www' ? sub : null;
  } catch {
    return null;
  }
}

// ── Greenhouse ──────────────────────────────────────────────────────────────

/**
 * Greenhouse job board API.
 *
 * `?content=true` returns the full description inline, which turns a board of
 * 200 roles into one request instead of 201.
 */
export const greenhouseProvider: AtsProvider = {
  id: 'greenhouse',
  searchHost: 'boards.greenhouse.io',
  publiclyIndexed: true,
  displayName: 'Greenhouse',
  docsUrl: 'https://developers.greenhouse.io/job-board.html',
  listingsIncludeDescription: true,

  detect({ url, html }) {
    // `boards.greenhouse.io/<slug>` and `<site>/boards/<slug>` are both common.
    const fromUrl = hostIs(url, 'greenhouse.io')
      ? firstSegment(url)
      : segmentAfter(url, ['boards', 'embed']);
    if (fromUrl && /greenhouse/i.test(url)) return { identifier: fromUrl, confidence: 0.95 };

    if (html) {
      const embed = /boards\.greenhouse\.io\/embed\/job_board\?for=([a-z0-9_-]+)/i.exec(html);
      if (embed?.[1]) return { identifier: embed[1], confidence: 0.95 };
      const board = /boards\.greenhouse\.io\/([a-z0-9_-]+)/i.exec(html);
      if (board?.[1] && board[1] !== 'embed') return { identifier: board[1], confidence: 0.8 };
    }
    return null;
  },

  boardUrl: (identifier) => `https://boards.greenhouse.io/${identifier}`,

  async fetchListings({ identifier, http, signal }) {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(identifier)}/jobs?content=true`;
    const response = await http.getJson<{
      jobs?: Array<{
        id?: number;
        title?: string;
        absolute_url?: string;
        content?: string;
        updated_at?: string;
        first_published?: string;
        location?: { name?: string };
        departments?: Array<{ name?: string }>;
        offices?: Array<{ name?: string }>;
        metadata?: unknown;
      }>;
    }>(url, { signal, skipRobots: true });

    return (response.data.jobs ?? [])
      .filter((job) => job.id !== undefined && job.title)
      .map((job): AtsListing => {
        // Greenhouse escapes the description as an HTML entity soup.
        const decoded = job.content
          ? job.content
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&amp;/g, '&')
          : null;

        return {
          externalId: String(job.id),
          title: job.title!,
          url: job.absolute_url ?? `https://boards.greenhouse.io/${identifier}/jobs/${job.id}`,
          descriptionHtml: decoded,
          descriptionText: htmlToText(decoded),
          locationText: text(job.location?.name),
          department: text(job.departments?.[0]?.name),
          team: null,
          employmentType: null,
          remote: job.location?.name ? /remote/i.test(job.location.name) : null,
          postedAt: toDate(job.first_published),
          updatedAt: toDate(job.updated_at),
          applyUrl: job.absolute_url ?? null,
          raw: job,
        };
      });
  },
};

// ── Lever ───────────────────────────────────────────────────────────────────

export const leverProvider: AtsProvider = {
  id: 'lever',
  searchHost: 'jobs.lever.co',
  publiclyIndexed: true,
  displayName: 'Lever',
  docsUrl: 'https://github.com/lever/postings-api',
  listingsIncludeDescription: true,

  detect({ url, html }) {
    const fromUrl = hostIs(url, 'lever.co') ? firstSegment(url) : null;
    if (fromUrl) return { identifier: fromUrl, confidence: 0.95 };
    if (html) {
      const match = /jobs\.lever\.co\/([a-z0-9_-]+)/i.exec(html);
      if (match?.[1]) return { identifier: match[1], confidence: 0.9 };
    }
    return null;
  },

  boardUrl: (identifier) => `https://jobs.lever.co/${identifier}`,

  async fetchListings({ identifier, http, signal }) {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(identifier)}?mode=json`;
    const response = await http.getJson<
      Array<{
        id?: string;
        text?: string;
        hostedUrl?: string;
        applyUrl?: string;
        descriptionPlain?: string;
        description?: string;
        createdAt?: number;
        categories?: { location?: string; team?: string; commitment?: string; department?: string };
        workplaceType?: string;
        lists?: Array<{ text?: string; content?: string }>;
      }>
    >(url, { signal, skipRobots: true });

    return (Array.isArray(response.data) ? response.data : [])
      .filter((job) => job.id && job.text)
      .map((job): AtsListing => {
        // Lever splits requirements into `lists`; folding them back in keeps
        // the description complete rather than silently truncated at the intro.
        const sections = (job.lists ?? [])
          .map((list) => `<h3>${list.text ?? ''}</h3>${list.content ?? ''}`)
          .join('\n');
        const html = [job.description ?? '', sections].filter(Boolean).join('\n');

        return {
          externalId: job.id!,
          title: job.text!,
          url: job.hostedUrl ?? `https://jobs.lever.co/${identifier}/${job.id}`,
          descriptionHtml: html || null,
          descriptionText: job.descriptionPlain ?? htmlToText(html),
          locationText: text(job.categories?.location),
          department: text(job.categories?.department),
          team: text(job.categories?.team),
          employmentType: text(job.categories?.commitment),
          remote: job.workplaceType ? /remote/i.test(job.workplaceType) : null,
          postedAt: toDate(job.createdAt),
          updatedAt: null,
          applyUrl: job.applyUrl ?? job.hostedUrl ?? null,
          raw: job,
        };
      });
  },
};

// ── Ashby ───────────────────────────────────────────────────────────────────

export const ashbyProvider: AtsProvider = {
  id: 'ashby',
  searchHost: 'jobs.ashbyhq.com',
  publiclyIndexed: true,
  displayName: 'Ashby',
  docsUrl: 'https://developers.ashbyhq.com/docs/public-job-posting-api',
  listingsIncludeDescription: true,

  detect({ url, html }) {
    const fromUrl = hostIs(url, 'ashbyhq.com') ? firstSegment(url) : null;
    if (fromUrl) return { identifier: fromUrl, confidence: 0.95 };
    if (html) {
      const match = /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i.exec(html);
      if (match?.[1]) return { identifier: match[1], confidence: 0.9 };
    }
    return null;
  },

  boardUrl: (identifier) => `https://jobs.ashbyhq.com/${identifier}`,

  async fetchListings({ identifier, http, signal }) {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(identifier)}?includeCompensation=true`;
    const response = await http.getJson<{
      jobs?: Array<{
        id?: string;
        title?: string;
        jobUrl?: string;
        applyUrl?: string;
        descriptionHtml?: string;
        descriptionPlain?: string;
        location?: string;
        department?: string;
        team?: string;
        employmentType?: string;
        isRemote?: boolean;
        publishedAt?: string;
        updatedAt?: string;
      }>;
    }>(url, { signal, skipRobots: true });

    return (response.data.jobs ?? [])
      .filter((job) => job.id && job.title)
      .map((job): AtsListing => ({
        externalId: job.id!,
        title: job.title!,
        url: job.jobUrl ?? `https://jobs.ashbyhq.com/${identifier}/${job.id}`,
        descriptionHtml: job.descriptionHtml ?? null,
        descriptionText: job.descriptionPlain ?? htmlToText(job.descriptionHtml),
        locationText: text(job.location),
        department: text(job.department),
        team: text(job.team),
        employmentType: text(job.employmentType),
        remote: job.isRemote ?? null,
        postedAt: toDate(job.publishedAt),
        updatedAt: toDate(job.updatedAt),
        applyUrl: job.applyUrl ?? job.jobUrl ?? null,
        raw: job,
      }));
  },
};

// ── SmartRecruiters ─────────────────────────────────────────────────────────

/**
 * SmartRecruiters returns summaries only; descriptions need a second call per
 * posting. `listingsIncludeDescription: false` is how the connector knows to
 * budget for that rather than discovering it at runtime.
 */
export const smartRecruitersProvider: AtsProvider = {
  id: 'smartrecruiters',
  searchHost: 'jobs.smartrecruiters.com',
  publiclyIndexed: true,
  displayName: 'SmartRecruiters',
  docsUrl: 'https://developers.smartrecruiters.com/reference/postings-1',
  listingsIncludeDescription: false,

  detect({ url, html }) {
    const fromUrl = hostIs(url, 'smartrecruiters.com')
      ? firstSegment(url)
      : segmentAfter(url, ['careers']);
    if (fromUrl && /smartrecruiters/i.test(url)) return { identifier: fromUrl, confidence: 0.9 };
    if (html) {
      const match = /jobs\.smartrecruiters\.com\/([a-z0-9_-]+)/i.exec(html);
      if (match?.[1]) return { identifier: match[1], confidence: 0.85 };
    }
    return null;
  },

  boardUrl: (identifier) => `https://jobs.smartrecruiters.com/${identifier}`,

  async fetchListings({ identifier, http, signal }) {
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(identifier)}/postings?limit=100`;
    const response = await http.getJson<{
      content?: Array<{
        id?: string;
        name?: string;
        ref?: string;
        releasedDate?: string;
        location?: { city?: string; region?: string; country?: string; remote?: boolean };
        department?: { label?: string };
        typeOfEmployment?: { label?: string };
        applyUrl?: string;
      }>;
    }>(url, { signal, skipRobots: true });

    return (response.data.content ?? [])
      .filter((job) => job.id && job.name)
      .map((job): AtsListing => {
        const location = [job.location?.city, job.location?.region, job.location?.country]
          .filter(Boolean)
          .join(', ');

        return {
          externalId: job.id!,
          title: job.name!,
          url: job.applyUrl ?? `https://jobs.smartrecruiters.com/${identifier}/${job.id}`,
          // Summary-only: the description is genuinely absent here rather than
          // empty, and must not be reported as an empty description.
          descriptionHtml: null,
          descriptionText: null,
          locationText: location || null,
          department: text(job.department?.label),
          team: null,
          employmentType: text(job.typeOfEmployment?.label),
          remote: job.location?.remote ?? null,
          postedAt: toDate(job.releasedDate),
          updatedAt: null,
          applyUrl: job.applyUrl ?? null,
          raw: job,
        };
      });
  },
};

// ── Workable ────────────────────────────────────────────────────────────────

export const workableProvider: AtsProvider = {
  id: 'workable',
  searchHost: 'apply.workable.com',
  publiclyIndexed: true,
  displayName: 'Workable',
  docsUrl: 'https://help.workable.com/hc/en-us/articles/115015653428',
  listingsIncludeDescription: false,

  detect({ url, html }) {
    const sub = subdomainOf(url, 'workable.com');
    if (sub && sub !== 'apply') return { identifier: sub, confidence: 0.9 };
    const applyPath = hostIs(url, 'workable.com') ? firstSegment(url) : null;
    if (applyPath) return { identifier: applyPath, confidence: 0.95 };
    if (html) {
      const match = /apply\.workable\.com\/([a-z0-9_-]+)/i.exec(html);
      if (match?.[1]) return { identifier: match[1], confidence: 0.9 };
    }
    return null;
  },

  boardUrl: (identifier) => `https://apply.workable.com/${identifier}/`,

  async fetchListings({ identifier, http, signal }) {
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(identifier)}?details=true`;
    const response = await http.getJson<{
      jobs?: Array<{
        shortcode?: string;
        title?: string;
        url?: string;
        application_url?: string;
        description?: string;
        city?: string;
        state?: string;
        country?: string;
        telecommuting?: boolean;
        employment_type?: string;
        department?: string;
        published_on?: string;
      }>;
    }>(url, { signal, skipRobots: true });

    return (response.data.jobs ?? [])
      .filter((job) => job.shortcode && job.title)
      .map((job): AtsListing => ({
        externalId: job.shortcode!,
        title: job.title!,
        url: job.url ?? `https://apply.workable.com/${identifier}/j/${job.shortcode}/`,
        descriptionHtml: job.description ?? null,
        descriptionText: htmlToText(job.description),
        locationText: [job.city, job.state, job.country].filter(Boolean).join(', ') || null,
        department: text(job.department),
        team: null,
        employmentType: text(job.employment_type),
        remote: job.telecommuting ?? null,
        postedAt: toDate(job.published_on),
        updatedAt: null,
        applyUrl: job.application_url ?? job.url ?? null,
        raw: job,
      }));
  },
};

// ── Recruitee ───────────────────────────────────────────────────────────────

export const recruiteeProvider: AtsProvider = {
  id: 'recruitee',
  searchHost: 'recruitee.com',
  publiclyIndexed: true,
  displayName: 'Recruitee',
  docsUrl: 'https://docs.recruitee.com/reference/offers',
  listingsIncludeDescription: true,

  detect({ url, html }) {
    const sub = subdomainOf(url, 'recruitee.com');
    if (sub) return { identifier: sub, confidence: 0.95 };
    if (html) {
      const match = /([a-z0-9_-]+)\.recruitee\.com/i.exec(html);
      if (match?.[1]) return { identifier: match[1], confidence: 0.85 };
    }
    return null;
  },

  boardUrl: (identifier) => `https://${identifier}.recruitee.com/`,

  async fetchListings({ identifier, http, signal }) {
    const url = `https://${encodeURIComponent(identifier)}.recruitee.com/api/offers/`;
    const response = await http.getJson<{
      offers?: Array<{
        id?: number;
        title?: string;
        careers_url?: string;
        careers_apply_url?: string;
        description?: string;
        requirements?: string;
        location?: string;
        city?: string;
        country?: string;
        department?: string;
        employment_type_code?: string;
        remote?: boolean;
        published_at?: string;
      }>;
    }>(url, { signal, skipRobots: true });

    return (response.data.offers ?? [])
      .filter((job) => job.id !== undefined && job.title)
      .map((job): AtsListing => {
        const html = [job.description ?? '', job.requirements ?? ''].filter(Boolean).join('\n');
        return {
          externalId: String(job.id),
          title: job.title!,
          url: job.careers_url ?? `https://${identifier}.recruitee.com/o/${job.id}`,
          descriptionHtml: html || null,
          descriptionText: htmlToText(html),
          locationText: job.location ?? [job.city, job.country].filter(Boolean).join(', ') ?? null,
          department: text(job.department),
          team: null,
          employmentType: text(job.employment_type_code),
          remote: job.remote ?? null,
          postedAt: toDate(job.published_at),
          updatedAt: null,
          applyUrl: job.careers_apply_url ?? job.careers_url ?? null,
          raw: job,
        };
      });
  },
};

// ── Personio ────────────────────────────────────────────────────────────────

/**
 * Personio publishes XML rather than JSON — common among European ATS
 * platforms. Included specifically to prove the adapter seam does not assume a
 * JSON body.
 */
export const personioProvider: AtsProvider = {
  id: 'personio',
  searchHost: 'jobs.personio.de',
  publiclyIndexed: false,
  displayName: 'Personio',
  docsUrl: 'https://developer.personio.de/docs/retrieving-open-job-positions',
  listingsIncludeDescription: true,

  detect({ url, html }) {
    const sub = subdomainOf(url, 'jobs.personio.de') ?? subdomainOf(url, 'jobs.personio.com');
    if (sub) return { identifier: sub, confidence: 0.95 };
    if (html) {
      const match = /([a-z0-9_-]+)\.jobs\.personio\.(?:de|com)/i.exec(html);
      if (match?.[1]) return { identifier: match[1], confidence: 0.85 };
    }
    return null;
  },

  boardUrl: (identifier) => `https://${identifier}.jobs.personio.de/`,

  async fetchListings({ identifier, http, signal }) {
    const url = `https://${encodeURIComponent(identifier)}.jobs.personio.de/xml`;
    const response = await http.getXml<{
      'workzag-jobs'?: {
        position?: Array<Record<string, unknown>> | Record<string, unknown>;
      };
    }>(url, { signal, skipRobots: true });

    const raw = response.data['workzag-jobs']?.position;
    const positions = Array.isArray(raw) ? raw : raw ? [raw] : [];

    return positions
      .filter((job) => job.id !== undefined && job.name)
      .map((job): AtsListing => {
        const descriptions = job.jobDescriptions as
          | { jobDescription?: Array<{ name?: string; value?: string }> | { name?: string; value?: string } }
          | undefined;
        const sections = descriptions?.jobDescription;
        const list = Array.isArray(sections) ? sections : sections ? [sections] : [];
        const html = list
          .map((section) => `<h3>${section.name ?? ''}</h3>${section.value ?? ''}`)
          .join('\n');

        return {
          externalId: String(job.id),
          title: String(job.name),
          url: `https://${identifier}.jobs.personio.de/job/${String(job.id)}`,
          descriptionHtml: html || null,
          descriptionText: htmlToText(html),
          locationText: text(job.office) ?? text(job.subcompany),
          department: text(job.department),
          team: null,
          employmentType: text(job.employmentType),
          remote: null,
          postedAt: toDate(job.createdAt),
          updatedAt: null,
          applyUrl: null,
          raw: job,
        };
      });
  },
};

export const ATS_PROVIDERS: AtsProvider[] = [
  greenhouseProvider,
  leverProvider,
  ashbyProvider,
  smartRecruitersProvider,
  workableProvider,
  recruiteeProvider,
  personioProvider,
];

export function findAtsProvider(id: string): AtsProvider | null {
  return ATS_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/**
 * Identifies the ATS behind a careers URL or page.
 *
 * Returns the best-scoring match rather than the first, because a company
 * careers page frequently links to several platforms (a Greenhouse board plus a
 * Workable widget left over from a migration) and the highest-confidence
 * signal is the one that reflects where the jobs actually live now.
 */
export function detectAts(input: { url: string; html?: string | null }): {
  provider: AtsProvider;
  identifier: string;
  confidence: number;
} | null {
  let best: { provider: AtsProvider; identifier: string; confidence: number } | null = null;

  for (const provider of ATS_PROVIDERS) {
    const detected = provider.detect(input);
    if (!detected?.identifier) continue;
    if (!best || detected.confidence > best.confidence) {
      best = { provider, identifier: detected.identifier, confidence: detected.confidence };
    }
  }

  return best;
}

/** Turns one ATS listing into a validated draft, dropping records that fail. */
export function listingToDraft(
  listing: AtsListing,
  context: { providerId: string; identifier: string; companyName?: string | null },
): SourceJobDraft | null {
  const parsed = sourceJobDraftSchema.safeParse({
    title: listing.title,
    // The ATS identifier is the company's own handle on that platform. It is a
    // stand-in, not a claim about the legal name — the normalizer resolves the
    // real one from the posting and the domain.
    companyName: context.companyName ?? context.identifier,
    description: listing.descriptionHtml ?? listing.descriptionText,
    descriptionFormat: listing.descriptionHtml ? 'html' : 'text',
    locationText: listing.locationText,
    remoteFlag: listing.remote,
    employmentTypeTexts: listing.employmentType ? [listing.employmentType] : [],
    postedAt: listing.postedAt,
    url: listing.url,
    applyUrl: listing.applyUrl,
    externalId: listing.externalId,
    raw: listing.raw,
    sourceMetadata: {
      atsProvider: context.providerId,
      atsIdentifier: context.identifier,
      department: listing.department,
      team: listing.team,
      updatedAt: listing.updatedAt?.toISOString() ?? null,
      // States plainly whether the description was in the listing response, so
      // an empty description is distinguishable from a missing detail fetch.
      descriptionInListing: listing.descriptionHtml !== null || listing.descriptionText !== null,
    },
  });

  return parsed.success ? parsed.data : null;
}
