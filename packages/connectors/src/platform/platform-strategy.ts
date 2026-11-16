import type { AcquisitionMethod } from '@job-intel/contracts';

/**
 * Per-platform acquisition strategy.
 *
 * The brief asks for LinkedIn, X, Reddit, HotNigerianJobs and a set of job
 * boards. Writing five classes would produce five near-identical scrapers and
 * exactly the monolith Part 1 warns against, so the platform-specific part is
 * *data*: which routes each platform permits, what it costs to use them, and
 * what to do when the direct route is closed.
 *
 * The consequential entries are the closed ones. LinkedIn and Indeed both
 * prohibit automated collection and defend it technically. The honest response
 * is not a cleverer fetcher — it is to say so, and to route the same demand
 * through the mechanisms that *are* open. Nearly every role posted on LinkedIn
 * is also on the company's own careers page or its ATS board, and those are
 * reachable without touching anything that forbids it. That is not a
 * consolation prize; for ATS-hosted roles it is a better source, because it is
 * the employer's own record rather than a copy.
 *
 * Each entry therefore carries `alternatives`, and those strings are not
 * documentation — the source dashboard renders them, so an operator looking at
 * a disabled LinkedIn source is told what to enable instead.
 */

export interface PlatformStrategy {
  readonly platformId: string;
  readonly displayName: string;

  /**
   * Routes that are actually open, best first.
   *
   * Empty means nothing about this platform may be fetched. That is a complete,
   * valid configuration — not a gap waiting to be filled.
   */
  readonly permitted: readonly AcquisitionMethod[];

  /** Why the direct route is unavailable, when it is. */
  readonly restriction: string | null;

  /** Concrete sources that cover the same ground. Shown in the dashboard. */
  readonly alternatives: readonly string[];

  /** Credentials the open routes need, by environment variable name. */
  readonly credentialRefs: readonly string[];

  /** Where an operator goes to obtain authorized access. */
  readonly setupUrl: string | null;

  /**
   * Whether a posting from this platform is a job or a lead.
   *
   * Social platforms produce leads: "we're hiring frontend engineers, DM me" is
   * a real signal and not a job posting. Marking it here means the pipeline
   * classifies before storing rather than filling the database with tweets.
   */
  readonly yieldsLeadsNotPostings: boolean;
}

/**
 * LinkedIn (Part 8).
 *
 * The user agreement prohibits automated collection, and the platform enforces
 * it. There is a Talent Solutions partner API, but it is sold to employers for
 * posting jobs rather than to individuals for reading them, so for this system
 * the practical answer is the alternatives list.
 *
 * The one genuinely open route is the operator's own inbox: LinkedIn sends job
 * alert emails to people who ask for them, and reading email that was
 * deliberately delivered to you is not circumvention of anything. That is what
 * `USER_PROVIDED_EXPORT` means here.
 */
const linkedin: PlatformStrategy = {
  platformId: 'linkedin',
  displayName: 'LinkedIn',
  permitted: ['USER_PROVIDED_EXPORT'],
  restriction:
    'LinkedIn’s user agreement prohibits automated collection of listings, and the platform enforces it technically. This system does not attempt to work around either.',
  alternatives: [
    'Subscribe to LinkedIn job alert emails and enable the mailbox source — the alerts are delivered to you, and reading your own inbox is permitted.',
    'Add the career pages of companies you care about; most LinkedIn postings appear there too.',
    'Enable ATS discovery — Greenhouse, Lever and Ashby host a large share of the same roles.',
    'Enable search-engine discovery, which surfaces ATS-hosted postings without touching LinkedIn.',
  ],
  credentialRefs: [],
  setupUrl: 'https://www.linkedin.com/legal/user-agreement',
  yieldsLeadsNotPostings: false,
};

/**
 * X / Twitter (Part 9).
 *
 * Unlike LinkedIn there is a real, purchasable API, so the strategy is
 * conditional: with `X_BEARER_TOKEN` configured the connector uses the official
 * endpoint, and without it the source reports `NOT_CONFIGURED` and does
 * nothing. There is no unauthenticated fallback, because the only way to read X
 * without a token is to pretend to be a browser.
 *
 * Everything X produces is a lead. "We're hiring a React developer, remote,
 * DM me" is genuinely useful and is not a job posting: it has no company field,
 * no location, no application URL and frequently no salary. The classifier
 * decides what becomes a posting; this flag makes sure it runs.
 */
const x: PlatformStrategy = {
  platformId: 'x',
  displayName: 'X (Twitter)',
  permitted: ['OFFICIAL_API'],
  restriction:
    'Requires a paid X API token. Without one the source stays inactive — there is no permitted way to read X anonymously at scale.',
  alternatives: [
    'Follow hiring accounts and forward interesting posts to the mailbox source.',
    'Enable search-engine discovery, which indexes public posts without an API token.',
  ],
  credentialRefs: ['X_BEARER_TOKEN'],
  setupUrl: 'https://developer.x.com/en/portal/dashboard',
  yieldsLeadsNotPostings: true,
};

/**
 * Reddit (Part 10).
 *
 * The friendliest of the social platforms: every listing has a public JSON
 * representation and an RSS feed, and the API terms permit read access with
 * identification. Subreddits are configuration, never hardcoded — Part 10 is
 * explicit, and it is right, because the useful communities differ completely
 * between a Nigerian frontend developer and a German data engineer.
 */
const reddit: PlatformStrategy = {
  platformId: 'reddit',
  displayName: 'Reddit',
  permitted: ['PUBLIC_API', 'RSS_FEED'],
  restriction: null,
  alternatives: [],
  credentialRefs: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  setupUrl: 'https://www.reddit.com/dev/api',
  yieldsLeadsNotPostings: true,
};

/**
 * HotNigerianJobs (Part 11).
 *
 * Publishes an RSS feed, which is the whole answer. The brief warns against
 * building a brittle scraper that assumes today's HTML survives, and the feed
 * makes that unnecessary: it is a contract the publisher maintains, and when it
 * breaks it breaks visibly rather than by silently returning navigation
 * furniture as job titles.
 */
const hotNigerianJobs: PlatformStrategy = {
  platformId: 'hotnigerianjobs',
  displayName: 'HotNigerianJobs',
  permitted: ['RSS_FEED', 'SITEMAP', 'SEARCH_ENGINE_DISCOVERY'],
  restriction: null,
  alternatives: [],
  credentialRefs: [],
  setupUrl: null,
  yieldsLeadsNotPostings: false,
};

/**
 * Job boards (Part 12).
 *
 * Deliberately heterogeneous, because the boards are. Jooble and Adzuna sell
 * API access and are straightforward. Indeed, Glassdoor, ZipRecruiter and
 * Wellfound restrict automated access to partners; they are registered so an
 * operator can see they were considered, and they never issue a request.
 *
 * The consistent thread: whether a board is usable is a property of the board's
 * terms, and it is recorded here rather than discovered by a connector getting
 * blocked in production.
 */
const jobBoards: PlatformStrategy[] = [
  {
    platformId: 'jooble',
    displayName: 'Jooble',
    permitted: ['OFFICIAL_API'],
    restriction: null,
    alternatives: [],
    credentialRefs: ['JOOBLE_API_KEY'],
    setupUrl: 'https://jooble.org/api/about',
    yieldsLeadsNotPostings: false,
  },
  {
    platformId: 'adzuna',
    displayName: 'Adzuna',
    permitted: ['OFFICIAL_API'],
    restriction: null,
    alternatives: [],
    credentialRefs: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
    setupUrl: 'https://developer.adzuna.com/',
    yieldsLeadsNotPostings: false,
  },
  {
    platformId: 'indeed',
    displayName: 'Indeed',
    permitted: [],
    restriction:
      'Indeed restricts automated access to approved partners and blocks it technically. No permitted route is available to this system.',
    alternatives: [
      'Subscribe to Indeed job alert emails and enable the mailbox source.',
      'Enable ATS discovery and career pages, which host much of the same inventory.',
    ],
    credentialRefs: [],
    setupUrl: null,
    yieldsLeadsNotPostings: false,
  },
  {
    platformId: 'glassdoor',
    displayName: 'Glassdoor',
    permitted: [],
    restriction: 'Glassdoor’s terms prohibit automated collection of listings.',
    alternatives: ['Use company career pages for the same employers.'],
    credentialRefs: [],
    setupUrl: null,
    yieldsLeadsNotPostings: false,
  },
  {
    platformId: 'ziprecruiter',
    displayName: 'ZipRecruiter',
    permitted: [],
    restriction: 'ZipRecruiter offers API access to partners only.',
    alternatives: ['Subscribe to ZipRecruiter alerts and enable the mailbox source.'],
    credentialRefs: [],
    setupUrl: null,
    yieldsLeadsNotPostings: false,
  },
  {
    platformId: 'wellfound',
    displayName: 'Wellfound',
    permitted: [],
    restriction: 'Wellfound requires an authenticated session and prohibits automated access.',
    alternatives: ['Add the career pages of startups you follow; most also post to an ATS.'],
    credentialRefs: [],
    setupUrl: null,
    yieldsLeadsNotPostings: false,
  },
];

export const PLATFORM_STRATEGIES: readonly PlatformStrategy[] = [
  linkedin,
  x,
  reddit,
  hotNigerianJobs,
  ...jobBoards,
];

export function findPlatformStrategy(platformId: string): PlatformStrategy | null {
  return (
    PLATFORM_STRATEGIES.find((entry) => entry.platformId === platformId.toLowerCase()) ?? null
  );
}

/** Platforms with no open route, for the dashboard's "why is this off" panel. */
export function restrictedPlatforms(): PlatformStrategy[] {
  return PLATFORM_STRATEGIES.filter((entry) => entry.permitted.length === 0);
}

/**
 * What an operator should enable instead, across every closed platform.
 *
 * De-duplicated, because four restricted platforms all point at career pages
 * and ATS discovery, and a dashboard repeating the same advice four times reads
 * as noise rather than as guidance.
 */
export function suggestedAlternatives(): string[] {
  const seen = new Set<string>();

  for (const platform of restrictedPlatforms()) {
    for (const alternative of platform.alternatives) seen.add(alternative);
  }

  return [...seen];
}
