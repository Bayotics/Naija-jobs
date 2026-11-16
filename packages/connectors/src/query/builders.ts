import { ATS_PROVIDERS } from '../ats/providers';
import { queryFingerprint } from './query-plan';
import type { QueryBuildInput } from '../types';
import type { SourceQuery } from '@job-intel/contracts';

/**
 * Source-specific query construction.
 *
 * "Frontend engineer in Germany" is not one query — it is
 * `site:lever.co "frontend engineer" Germany` to a search engine, a subreddit
 * plus a keyword to Reddit, and a board token plus a location parameter to an
 * ATS. Part 23 asks for these to live apart, and the reason is concrete: a
 * single `buildQueries` covering every source becomes a switch statement that
 * each new connector must be added to, which is precisely the coupling this
 * layer exists to remove.
 *
 * These are helpers rather than the connectors' own methods only because
 * several connectors share them; each connector still chooses which to call and
 * what to pass.
 */

/** Quotes a phrase when it contains a space, as every search syntax expects. */
export function phrase(value: string): string {
  return value.includes(' ') ? `"${value}"` : value;
}

/**
 * The cross product of roles and locations, capped.
 *
 * Capped by *taking the most important of each* rather than by truncating the
 * product, so a profile with six roles and four locations yields the top roles
 * against the top locations rather than every combination of the first role.
 */
export function rolesByLocations(
  input: QueryBuildInput,
  max: number,
): Array<{ role: string; location: string | null }> {
  const roles = input.roles.slice(0, Math.max(1, Math.ceil(Math.sqrt(max))));
  const locations = input.locations.slice(0, Math.max(1, Math.ceil(max / Math.max(1, roles.length))));

  const pairs: Array<{ role: string; location: string | null }> = [];

  for (const role of roles) {
    if (locations.length === 0) {
      pairs.push({ role, location: null });
      continue;
    }

    for (const location of locations) {
      if (pairs.length >= max) return pairs;
      pairs.push({ role, location });
    }
  }

  return pairs.slice(0, max);
}

const make = (
  sourceId: string,
  text: string,
  options: {
    priority?: SourceQuery['priority'];
    rationale?: string;
    parameters?: Record<string, unknown>;
    profileId?: string | null;
    residualFilters?: string[];
  } = {},
): SourceQuery => ({
  queryId: queryFingerprint(sourceId, text, options.parameters ?? {}),
  sourceId,
  text,
  parameters: options.parameters ?? {},
  priority: options.priority ?? 'medium',
  rationale: options.rationale ?? '',
  profileId: options.profileId ?? null,
  residualFilters: options.residualFilters ?? [],
});

/**
 * Search-engine queries scoped to ATS hosts (Part 21).
 *
 * The single highest-yield discovery strategy in the system, and the reason is
 * structural: companies that would never appear on a job board still post
 * through Greenhouse or Lever, and those postings are indexed. A `site:` query
 * reaches them without touching anything that forbids automated access.
 *
 * Nothing here is a hardcoded query string — the template is fixed, the terms
 * come entirely from the profile.
 */
export function buildAtsSearchQueries(sourceId: string, input: QueryBuildInput): SourceQuery[] {
  const queries: SourceQuery[] = [];

  /*
   * Only providers whose boards are publicly indexed.
   *
   * A `site:` query against a provider that gates its boards returns nothing
   * and spends quota, so the list is filtered by what the provider registry
   * actually says rather than by hope.
   */
  const hosts = ATS_PROVIDERS.filter((provider) => provider.publiclyIndexed).map(
    (provider) => provider.searchHost,
  );

  const pairs = rolesByLocations(input, Math.max(1, Math.floor(input.maxQueries / Math.max(1, hosts.length))));

  for (const host of hosts) {
    for (const { role, location } of pairs) {
      if (queries.length >= input.maxQueries) return queries;

      const parts = [`site:${host}`, phrase(role)];
      if (location) parts.push(phrase(location));

      queries.push(
        make(sourceId, parts.join(' '), {
          priority: 'high',
          rationale: `Finds ${role} postings hosted on ${host}, which job boards often miss.`,
          profileId: input.profileId,
          parameters: { host, role, location },
          /*
           * A search engine filters by nothing we care about. Every criterion
           * is residual, and saying so keeps the pipeline from assuming the
           * results are already narrowed.
           */
          residualFilters: ['date', 'salary', 'remote', 'location'],
        }),
      );
    }
  }

  return queries;
}

/** Career-page queries: the same idea, aimed at company sites. */
export function buildCareerPageSearchQueries(
  sourceId: string,
  input: QueryBuildInput,
): SourceQuery[] {
  const queries: SourceQuery[] = [];

  for (const { role, location } of rolesByLocations(input, input.maxQueries)) {
    const parts = ['inurl:careers', phrase(role)];
    if (location) parts.push(phrase(location));

    queries.push(
      make(sourceId, parts.join(' '), {
        priority: 'medium',
        rationale: `Finds ${role} roles on company career pages.`,
        profileId: input.profileId,
        parameters: { role, location },
        residualFilters: ['date', 'salary', 'remote', 'location'],
      }),
    );

    if (queries.length >= input.maxQueries) break;
  }

  return queries;
}

/**
 * Reddit queries (Part 10).
 *
 * Reddit's own search is weak and its subreddits are topical, so the useful
 * unit is a subreddit plus a role term rather than a general query. The
 * subreddits come from configuration — Part 10 is explicit that they must not
 * be hardcoded as mandatory.
 */
export function buildRedditQueries(
  sourceId: string,
  input: QueryBuildInput,
  subreddits: readonly string[],
): SourceQuery[] {
  const queries: SourceQuery[] = [];
  const perSubreddit = Math.max(1, Math.floor(input.maxQueries / Math.max(1, subreddits.length)));

  for (const subreddit of subreddits) {
    for (const role of input.roles.slice(0, perSubreddit)) {
      if (queries.length >= input.maxQueries) return queries;

      queries.push(
        make(sourceId, role, {
          priority: 'low',
          rationale: `Looks for ${role} posts in r/${subreddit}.`,
          profileId: input.profileId,
          parameters: { subreddit, role },
          /*
           * A community post is a lead, not a posting. Everything must be
           * re-checked downstream, including whether it is a job at all.
           */
          residualFilters: ['date', 'salary', 'remote', 'location', 'keyword'],
        }),
      );
    }
  }

  return queries;
}

/**
 * Social-platform queries (Part 9).
 *
 * The hiring phrases are the signal — "we're hiring", "join our team" — and the
 * role is the filter. Both are needed: the phrases alone return every
 * recruitment post on the platform, and the role alone returns people talking
 * about their jobs.
 *
 * Even together this is the weakest source in the system, which is why every
 * result is a lead requiring classification rather than a posting.
 */
const HIRING_PHRASES = ['we are hiring', "we're hiring", 'now hiring', 'join our team'] as const;

export function buildSocialQueries(sourceId: string, input: QueryBuildInput): SourceQuery[] {
  const queries: SourceQuery[] = [];
  const roles = input.roles.slice(0, Math.max(1, Math.floor(input.maxQueries / 2)));

  for (const role of roles) {
    for (const hiring of HIRING_PHRASES.slice(0, 2)) {
      if (queries.length >= input.maxQueries) return queries;

      queries.push(
        make(sourceId, `${phrase(hiring)} ${phrase(role)}`, {
          priority: 'low',
          rationale: `Hiring announcements mentioning ${role}. Every result needs classifying.`,
          profileId: input.profileId,
          parameters: { role, hiring },
          residualFilters: ['date', 'salary', 'remote', 'location', 'keyword'],
        }),
      );
    }
  }

  return queries;
}

/**
 * Keyword queries for an API that takes a search string.
 *
 * The simplest builder, and the one most sources use. Location is passed as a
 * parameter rather than folded into the text when the source can filter on it,
 * so the API does the narrowing rather than the text matcher.
 */
export function buildKeywordQueries(
  sourceId: string,
  input: QueryBuildInput,
  options: { supportsLocationParameter?: boolean; supportsRemoteParameter?: boolean } = {},
): SourceQuery[] {
  const queries: SourceQuery[] = [];

  for (const { role, location } of rolesByLocations(input, input.maxQueries)) {
    const parameters: Record<string, unknown> = {};
    const residual: string[] = ['salary'];

    if (location) {
      if (options.supportsLocationParameter) {
        parameters['location'] = location;
      } else {
        residual.push('location');
      }
    }

    if (input.remoteAcceptable) {
      if (options.supportsRemoteParameter) {
        parameters['remote'] = true;
      } else {
        residual.push('remote');
      }
    }

    const text = location && !options.supportsLocationParameter ? `${role} ${location}` : role;

    queries.push(
      make(sourceId, text, {
        priority: 'high',
        rationale: `Searches for ${role}${location ? ` in ${location}` : ''}.`,
        profileId: input.profileId,
        parameters,
        residualFilters: residual,
      }),
    );

    if (queries.length >= input.maxQueries) break;
  }

  return queries;
}
