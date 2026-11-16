import { z } from 'zod';
import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import { NotPermittedError } from '../errors';
import {
  DEFAULT_CAPABILITIES,
  type Connector,
  type ConnectorAvailability,
  type ConnectorContext,
  type DiscoverySummary,
} from '../types';
import type { HttpClient } from '../http/client';
import { classifyContent, type ClassificationProvider } from './../web/classifier';
import { extractApplicationLinks } from './reddit-connector';

/**
 * Generic social-platform discovery.
 *
 * Social platforms are the part of this brief where the honest answer and the
 * impressive answer diverge most sharply. Public job-related posts on X and
 * LinkedIn genuinely exist and are genuinely useful. Reading them at scale
 * without authorisation is prohibited by both platforms and defended
 * technically, and building around that would make the whole system's value
 * contingent on violating access controls.
 *
 * So this connector is built around a **platform port** with one rule: a
 * platform whose access requires a credential the operator has not supplied
 * reports itself `unavailable`, with the specific mechanism named. It does not
 * silently fall back to scraping, and the rest of the system keeps running —
 * that graceful degradation is the actual deliverable here.
 *
 * What each platform can and cannot do today is stated on the adapter itself
 * rather than in documentation that drifts.
 */

export interface SocialPost {
  id: string;
  text: string;
  url: string;
  authorHandle: string | null;
  authorName: string | null;
  createdAt: Date | null;
  /** Links the platform itself resolved, when it provides them. */
  links: string[];
}

export interface SocialPlatform {
  readonly id: string;
  readonly displayName: string;
  /** Environment variable names required for authorised access. */
  readonly credentialNames: string[];
  /** How access is obtained, shown verbatim in the UI when unavailable. */
  readonly accessNote: string;
  /** Documentation for obtaining that access. */
  readonly docsUrl: string | null;

  isConfigured(getSecret: (name: string) => string | undefined): boolean;

  search(input: {
    query: string;
    limit: number;
    since: Date | null;
    http: HttpClient;
    getSecret: (name: string) => string | undefined;
    signal: AbortSignal;
  }): Promise<SocialPost[]>;
}

/**
 * X (Twitter) via the official API.
 *
 * Recent-search is a paid tier. Without a bearer token this platform is
 * unavailable — the public web interface is not an alternative, because reading
 * it programmatically is what the terms prohibit.
 */
export const xPlatform: SocialPlatform = {
  id: 'x',
  displayName: 'X (official API)',
  credentialNames: ['X_BEARER_TOKEN'],
  accessNote:
    'X requires an API plan with recent-search access. The public web interface is not a ' +
    'substitute: automated reading of it is prohibited by the platform terms.',
  docsUrl: 'https://developer.x.com/en/docs/x-api/tweets/search/introduction',

  isConfigured: (getSecret) => Boolean(getSecret('X_BEARER_TOKEN')),

  async search({ query, limit, since, http, getSecret, signal }) {
    const token = getSecret('X_BEARER_TOKEN');
    if (!token) throw new NotPermittedError('X_BEARER_TOKEN is not configured');

    const url = new URL('https://api.x.com/2/tweets/search/recent');
    url.searchParams.set('query', `${query} -is:retweet lang:en`);
    url.searchParams.set('max_results', String(Math.min(Math.max(limit, 10), 100)));
    url.searchParams.set('tweet.fields', 'created_at,entities,author_id');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'username,name');
    if (since) url.searchParams.set('start_time', since.toISOString());

    const response = await http.getJson<{
      data?: Array<{
        id?: string;
        text?: string;
        created_at?: string;
        author_id?: string;
        entities?: { urls?: Array<{ expanded_url?: string; unwound_url?: string }> };
      }>;
      includes?: { users?: Array<{ id?: string; username?: string; name?: string }> };
    }>(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
      signal,
      skipRobots: true,
    });

    const users = new Map(
      (response.data.includes?.users ?? []).map((user) => [user.id, user] as const),
    );

    return (response.data.data ?? [])
      .filter((post): post is { id: string; text: string } & typeof post =>
        Boolean(post.id && post.text),
      )
      .map((post): SocialPost => {
        const author = post.author_id ? users.get(post.author_id) : undefined;
        return {
          id: post.id,
          text: post.text,
          url: author?.username
            ? `https://x.com/${author.username}/status/${post.id}`
            : `https://x.com/i/web/status/${post.id}`,
          authorHandle: author?.username ?? null,
          authorName: author?.name ?? null,
          createdAt: post.created_at ? new Date(post.created_at) : null,
          links: (post.entities?.urls ?? [])
            .map((entry) => entry.unwound_url ?? entry.expanded_url)
            .filter((link): link is string => Boolean(link)),
        };
      });
  },
};

/**
 * LinkedIn.
 *
 * Registered here so the operator can see it and see *why* it is off, rather
 * than wondering why the largest job platform never appears. LinkedIn's Talent
 * Solutions APIs are partner-gated; there is no general-purpose job-search API
 * available to an individual developer, and its terms prohibit automated
 * collection of listings.
 *
 * `search` throws rather than returning empty: an empty result would be
 * indistinguishable from "LinkedIn had nothing", which is a materially
 * different and much more misleading statement.
 */
export const linkedInPlatform: SocialPlatform = {
  id: 'linkedin',
  displayName: 'LinkedIn (partner API only)',
  credentialNames: ['LINKEDIN_PARTNER_TOKEN'],
  accessNote:
    'LinkedIn job data is available only through partner-gated Talent Solutions APIs. There is ' +
    'no general job-search API for individual developers, and automated collection of listings ' +
    'is prohibited by the platform terms. Legitimate routes: an approved partner integration, a ' +
    'licensed data provider, LinkedIn job-alert emails delivered to your own inbox, or pasting a ' +
    'specific posting URL as a user-provided source.',
  docsUrl: 'https://learn.microsoft.com/en-us/linkedin/talent/',

  isConfigured: (getSecret) => Boolean(getSecret('LINKEDIN_PARTNER_TOKEN')),

  search() {
    return Promise.reject(
      new NotPermittedError(
        'LinkedIn search is not implemented. No authorised general-purpose mechanism exists ' +
          'for this use case, and this system does not implement unauthorised ones.',
      ),
    );
  },
};

export const SOCIAL_PLATFORMS: SocialPlatform[] = [xPlatform, linkedInPlatform];

export const socialConfigSchema = z.object({
  platform: z.enum(['x', 'linkedin']),
  /** Search terms. Generated from preferences by the query planner. */
  queries: z.array(z.string().trim().min(1).max(400)).min(1).max(50),
  resultsPerQuery: z.number().int().min(10).max(100).default(25),
  /** Only consider posts newer than this many hours. */
  lookbackHours: z.number().int().min(1).max(24 * 30).default(48),
  minJobConfidence: z.number().min(0).max(1).default(0.6),
  maxClassifierCalls: z.number().int().min(0).max(500).default(30),
});

export type SocialConfig = z.infer<typeof socialConfigSchema>;

export class SocialConnector implements Connector<SocialConfig> {
  readonly id = 'social';
  readonly displayName = 'Social platform';
  readonly sourceType = 'social' as const;
  readonly accessTier = 'official_api' as const;
  readonly capabilities = {
    ...DEFAULT_CAPABILITIES,
    supportsIncremental: true,
    requiresCredentials: true,
  };
  readonly configSchema = socialConfigSchema;

  constructor(
    private readonly platforms: SocialPlatform[] = SOCIAL_PLATFORMS,
    private readonly classifier: ClassificationProvider | null = null,
  ) {}

  private platform(id: string): SocialPlatform | null {
    return this.platforms.find((platform) => platform.id === id) ?? null;
  }

  availability(ctx: {
    config: SocialConfig;
    getSecret(name: string): string | undefined;
  }): ConnectorAvailability {
    const platform = this.platform(ctx.config.platform);
    if (!platform) {
      return {
        available: false,
        reason: `Unknown social platform "${ctx.config.platform}"`,
        requires: this.platforms.map((entry) => entry.id),
      };
    }

    if (platform.id === 'linkedin') {
      // Unavailable even *with* a token, because no implementation exists.
      // Claiming otherwise would be the "invented integration" the brief rules
      // out explicitly.
      return { available: false, reason: platform.accessNote, requires: platform.credentialNames };
    }

    if (!platform.isConfigured(ctx.getSecret)) {
      return { available: false, reason: platform.accessNote, requires: platform.credentialNames };
    }

    return { available: true, reason: null, requires: [] };
  }

  async healthCheck(ctx: ConnectorContext<SocialConfig>) {
    const availability = this.availability(ctx);
    if (!availability.available) {
      return {
        healthy: false,
        message: `${availability.reason}${
          availability.requires.length > 0 ? ` Missing: ${availability.requires.join(', ')}` : ''
        }`,
        checkedAt: new Date(),
      };
    }

    const platform = this.platform(ctx.config.platform)!;
    const startedAt = Date.now();

    try {
      const posts = await platform.search({
        query: ctx.config.queries[0] ?? 'hiring',
        limit: 10,
        since: null,
        http: ctx.http,
        getSecret: (name) => ctx.getSecret(name),
        signal: ctx.signal,
      });
      return {
        healthy: true,
        message: `${platform.displayName} returned ${posts.length} post(s)`,
        checkedAt: new Date(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date(),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  async *discover(
    ctx: ConnectorContext<SocialConfig>,
  ): AsyncGenerator<SourceJobDraft, DiscoverySummary, void> {
    const availability = this.availability(ctx);
    if (!availability.available) {
      throw new NotPermittedError(availability.reason ?? 'Platform unavailable', {
        requires: availability.requires,
        platform: ctx.config.platform,
      });
    }

    const platform = this.platform(ctx.config.platform)!;
    const since = new Date(Date.now() - ctx.config.lookbackHours * 3_600_000);
    const seen = new Set<string>(readSeen(ctx.cursor));
    const emitted: string[] = [];

    let classifierCalls = 0;
    let considered = 0;
    let rejected = 0;

    for (const query of ctx.config.queries) {
      if (ctx.signal.aborted) break;

      let posts: SocialPost[];
      try {
        posts = await platform.search({
          query,
          limit: ctx.config.resultsPerQuery,
          since,
          http: ctx.http,
          getSecret: (name) => ctx.getSecret(name),
          signal: ctx.signal,
        });
      } catch (error) {
        ctx.log('warn', `Social query failed: ${query}`, {
          platform: platform.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      for (const post of posts) {
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        considered += 1;

        // A social post is short, and short text is exactly where a title regex
        // performs worst — "we're hiring!" with no role, no company, no link is
        // not a job posting in any useful sense.
        const verdict = await classifyContent(
          {
            text: post.text,
            url: post.url,
            metadata: { author: post.authorHandle, platform: platform.id, query },
          },
          {
            provider: this.classifier,
            canSpend: () => classifierCalls < ctx.config.maxClassifierCalls,
          },
        );

        if (verdict.method === 'ai' || verdict.method === 'ai_failed_fallback') classifierCalls += 1;

        if (
          !verdict.classification.isJob ||
          verdict.classification.confidence < ctx.config.minJobConfidence
        ) {
          rejected += 1;
          continue;
        }

        const links = [...post.links, ...extractApplicationLinks(post.text)];
        const applyUrl = verdict.classification.applicationUrl ?? links[0] ?? null;

        const draft = sourceJobDraftSchema.safeParse({
          externalId: `${platform.id}:${post.id}`,
          title: verdict.classification.title ?? truncateTitle(post.text),
          companyName:
            verdict.classification.company ??
            (post.authorHandle ? `@${post.authorHandle}` : platform.displayName),
          description: post.text,
          descriptionFormat: 'text',
          locationText: verdict.classification.location,
          remoteFlag:
            verdict.classification.remoteStatus === 'remote'
              ? true
              : verdict.classification.remoteStatus === 'onsite'
                ? false
                : null,
          postedAt: post.createdAt,
          url: post.url,
          applyUrl,
          raw: post,
          sourceMetadata: {
            platform: platform.id,
            query,
            author: post.authorHandle,
            authorName: post.authorName,
            applicationLinks: links.slice(0, 5),
            contentType: verdict.classification.contentType,
            classificationMethod: verdict.method,
            classificationConfidence: verdict.classification.confidence,
            classificationReason: verdict.classification.reason,
            aiClassified: verdict.method === 'ai',
            model: verdict.modelUsed,
            // A social post is a lead. Nothing downstream should treat it as a
            // verified vacancy from a known employer.
            verifiedEmployer: false,
          },
        });

        if (draft.success) {
          emitted.push(post.id);
          yield draft.data;
        }
      }
    }

    ctx.log('info', 'Social discovery finished', {
      platform: platform.id,
      considered,
      accepted: emitted.length,
      rejected,
      classifierCalls,
    });

    // Bounded cursor: post ids are the only dedup key across runs, and an
    // unbounded set would grow forever in the source row.
    return { cursor: { seen: [...seen].slice(-2_000) } };
  }
}

function readSeen(cursor: Record<string, unknown> | null): string[] {
  const raw = cursor?.seen;
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** First line, trimmed to a plausible title when the classifier gave none. */
function truncateTitle(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? text;
  return firstLine.trim().slice(0, 140) || 'Untitled social post';
}
