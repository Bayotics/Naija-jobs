import type { HttpClient } from '../http/client';

/**
 * Public portfolio connectors.
 *
 * Strictly limited, and the limits are the design:
 *
 *  - **Only what the candidate links.** Nothing here searches for a person, or
 *    guesses a handle from their name. The candidate supplies a URL or a
 *    username and that is the entire input.
 *
 *  - **Only public data, only through documented APIs.** GitHub's public REST
 *    API, unauthenticated, at its documented rate limit. No scraping of a
 *    signed-in view, no evading a limit, no reading anything the anonymous
 *    internet cannot already see.
 *
 *  - **Evidence, never claims.** A repository in Go is evidence that someone
 *    has written Go. It is not evidence of proficiency, and the weight assigned
 *    here (`public_repository`, below a professional role) says so.
 *
 * The framework is provider-shaped so a second provider is a class rather than
 * a rewrite, and each provider states plainly what it can and cannot see.
 */

export interface PortfolioEvidence {
  /** Canonical-ish skill name; normalisation happens in the resume package. */
  name: string;
  /** What this provider actually observed. */
  detail: string;
  /** Repository or page URL, so the evidence is checkable. */
  url: string | null;
  /** Bytes, stars, commits — whatever the provider counts. */
  weight: number;
  observedFrom: Date | null;
  observedTo: Date | null;
}

export interface PortfolioResult {
  ok: boolean;
  provider: string;
  identifier: string;
  url: string;
  /** Raw normalised payload, stored for the debugger. */
  payload: Record<string, unknown>;
  evidence: PortfolioEvidence[];
  /** Phrased for the candidate. */
  error: string | null;
  /** Things the provider could not see, stated rather than silently omitted. */
  limitations: string[];
  fetchedAt: Date;
}

export interface PortfolioConnector {
  readonly provider: string;
  /** Whether this connector recognises a URL the candidate pasted. */
  matches(url: string): boolean;
  /** Extracts the account identifier from a URL. */
  identifierFrom(url: string): string | null;
  fetch(identifier: string): Promise<PortfolioResult>;
}

const failure = (
  provider: string,
  identifier: string,
  url: string,
  error: string,
): PortfolioResult => ({
  ok: false,
  provider,
  identifier,
  url,
  payload: {},
  evidence: [],
  error,
  limitations: [],
  fetchedAt: new Date(),
});

interface GitHubRepo {
  name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  fork: boolean;
  archived: boolean;
  stargazers_count: number;
  topics?: string[];
  created_at: string;
  pushed_at: string;
}

/**
 * GitHub, through the public REST API.
 *
 * What it can see: public repositories, their primary language, their topics,
 * their star counts and their activity dates.
 *
 * What it deliberately does not do: infer that a starred repository means the
 * candidate knows its language, count forks as authored work, or treat an
 * archived project as current. Each of those would manufacture evidence.
 */
export class GitHubPortfolioConnector implements PortfolioConnector {
  readonly provider = 'github';

  constructor(
    private readonly http: HttpClient,
    private readonly options: { maxRepositories?: number; token?: string | null } = {},
  ) {}

  matches(url: string): boolean {
    try {
      return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.endsWith('github.com');
    } catch {
      return false;
    }
  }

  identifierFrom(url: string): string | null {
    try {
      const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
      const segment = parsed.pathname.split('/').filter(Boolean)[0];
      // A username, not a repository path: this connector reads an account.
      return segment && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(segment) ? segment : null;
    } catch {
      return null;
    }
  }

  async fetch(identifier: string): Promise<PortfolioResult> {
    const url = `https://github.com/${identifier}`;

    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(identifier)) {
      return failure(this.provider, identifier, url, 'That does not look like a GitHub username.');
    }

    const apiUrl =
      `https://api.github.com/users/${encodeURIComponent(identifier)}/repos` +
      `?per_page=${Math.min(100, this.options.maxRepositories ?? 100)}&sort=pushed&type=owner`;

    try {
      const response = await this.http.getJson<GitHubRepo[]>(apiUrl, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          // A token, when configured, only raises the documented rate limit.
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        },
      });

      const repos = response.data;
      if (!Array.isArray(repos)) {
        return failure(this.provider, identifier, url, 'GitHub returned an unexpected response.');
      }

      /*
       * Forks and archives are excluded. A fork is someone else's code in the
       * candidate's account, and an archived repository is explicitly not
       * current work — counting either would inflate the profile with things
       * the candidate did not write or no longer does.
       */
      const authored = repos.filter((repo) => !repo.fork && !repo.archived);

      const byLanguage = new Map<string, { repos: GitHubRepo[]; stars: number }>();

      for (const repo of authored) {
        if (!repo.language) continue;
        const bucket = byLanguage.get(repo.language) ?? { repos: [], stars: 0 };
        bucket.repos.push(repo);
        bucket.stars += repo.stargazers_count;
        byLanguage.set(repo.language, bucket);
      }

      const evidence: PortfolioEvidence[] = [];

      for (const [language, bucket] of byLanguage) {
        const dates = bucket.repos.flatMap((repo) => [
          new Date(repo.created_at),
          new Date(repo.pushed_at),
        ]);

        evidence.push({
          name: language,
          detail:
            `${bucket.repos.length} public repositor${bucket.repos.length === 1 ? 'y' : 'ies'} ` +
            `with ${language} as the primary language` +
            (bucket.stars > 0 ? `, ${bucket.stars} stars total` : ''),
          url: bucket.repos[0]!.html_url,
          weight: bucket.repos.length,
          observedFrom: new Date(Math.min(...dates.map((date) => date.getTime()))),
          observedTo: new Date(Math.max(...dates.map((date) => date.getTime()))),
        });
      }

      // Topics are the author's own labels for their work, which makes them
      // better evidence than anything inferred from a description.
      const topicCounts = new Map<string, number>();
      for (const repo of authored) {
        for (const topic of repo.topics ?? []) {
          topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
        }
      }

      for (const [topic, count] of topicCounts) {
        if (count < 2) continue;
        evidence.push({
          name: topic.replace(/-/g, ' '),
          detail: `Tagged on ${count} public repositories`,
          url: null,
          weight: count,
          observedFrom: null,
          observedTo: null,
        });
      }

      return {
        ok: true,
        provider: this.provider,
        identifier,
        url,
        payload: {
          publicRepositories: authored.length,
          totalReturned: repos.length,
          languages: [...byLanguage.keys()],
          topRepositories: authored
            .slice(0, 10)
            .map((repo) => ({
              name: repo.name,
              url: repo.html_url,
              language: repo.language,
              stars: repo.stargazers_count,
              pushedAt: repo.pushed_at,
            })),
        },
        evidence: evidence.sort((a, b) => b.weight - a.weight).slice(0, 40),
        error: null,
        limitations: [
          'Only public repositories are visible. Private and organisation-owned work is not counted.',
          'Forks and archived repositories are excluded, so contributions to other projects do not appear.',
          'Language is GitHub\'s own guess from file extensions, not a statement about what the candidate wrote.',
        ],
        fetchedAt: new Date(),
      };
    } catch (error) {
      return failure(
        this.provider,
        identifier,
        url,
        `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * A generic personal site.
 *
 * Reads the page the candidate linked and nothing else — no crawling, no
 * following links, one request. What it produces is weaker evidence than a
 * repository and is weighted accordingly; the point is to notice technologies
 * a resume omitted, not to build a second profile.
 */
export class PersonalSiteConnector implements PortfolioConnector {
  readonly provider = 'personal_site';

  constructor(
    private readonly http: HttpClient,
    private readonly vocabulary: readonly string[],
  ) {}

  matches(): boolean {
    // The fallback: anything not claimed by a specific provider.
    return true;
  }

  identifierFrom(url: string): string | null {
    try {
      return new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    } catch {
      return null;
    }
  }

  async fetch(identifier: string): Promise<PortfolioResult> {
    const url = identifier.startsWith('http') ? identifier : `https://${identifier}`;

    try {
      const response = await this.http.getText(url);
      const text = response.data
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 200_000);

      const evidence: PortfolioEvidence[] = [];

      for (const term of this.vocabulary) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(^|[^a-z0-9+#])${escaped}([^a-z0-9+#]|$)`, 'i');
        if (!pattern.test(text)) continue;

        evidence.push({
          name: term,
          detail: 'Mentioned on the linked personal site',
          url,
          // Deliberately the weakest signal here: a mention is not a project.
          weight: 1,
          observedFrom: null,
          observedTo: null,
        });
      }

      return {
        ok: true,
        provider: this.provider,
        identifier,
        url,
        payload: { characters: text.length, matched: evidence.length },
        evidence: evidence.slice(0, 40),
        error: null,
        limitations: [
          'Only the single page you linked was read. Nothing was crawled.',
          'A technology named on a page is a mention, not evidence of use.',
        ],
        fetchedAt: new Date(),
      };
    } catch (error) {
      return failure(
        this.provider,
        identifier,
        url,
        `The site could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Picks the connector for a URL the candidate supplied. */
export function selectPortfolioConnector(
  url: string,
  connectors: readonly PortfolioConnector[],
): PortfolioConnector | null {
  // Specific providers first; the generic site connector matches everything.
  const specific = connectors.filter((connector) => connector.provider !== 'personal_site');
  return (
    specific.find((connector) => connector.matches(url)) ??
    connectors.find((connector) => connector.provider === 'personal_site') ??
    null
  );
}
