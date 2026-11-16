import { z } from 'zod';
import { buildRedditQueries } from '../query/builders';
import type { QueryBuildInput } from '../types';
import type { SourceQuery } from '@job-intel/contracts';
import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import { ConfigurationError, NotPermittedError } from '../errors';
import { DEFAULT_CAPABILITIES, type Connector, type ConnectorContext } from '../types';
import { classifyContent, type ClassificationProvider } from '../web/classifier';

/**
 * Reddit discovery via the official API.
 *
 * Reddit no longer serves the unauthenticated `.json` endpoints to
 * non-browser clients (they return 403), and its terms require registered API
 * access. This connector therefore uses the documented OAuth2
 * **client-credentials** flow with a registered "script" app, and reports
 * itself unavailable when credentials are absent rather than attempting to look
 * like a browser. There is no fallback that evades that control, by design.
 *
 * Which communities to read is configuration, not code: the connector knows how
 * to read *a* subreddit, never which ones matter.
 *
 * Reddit posts are leads, not verified vacancies. Every draft is tagged with
 * its subreddit and flair so downstream validation can weigh it accordingly —
 * a hiring post, a scam, and someone *seeking* work all look alike here.
 */
export const redditConfigSchema = z.object({
  subreddits: z.array(z.string().trim().min(1).max(50)).min(1),
  /** `new` is the only ordering that supports incremental discovery. */
  listing: z.enum(['new', 'hot', 'top']).default('new'),
  limitPerSubreddit: z.number().int().min(1).max(100).default(50),
  /** Keeps only posts whose title matches — e.g. "[hiring]" on r/forhire. */
  titleFilter: z.string().nullable().default('\\[hiring\\]|hiring|\\[full.?time\\]'),
  /** Drops posts that are people offering their services rather than roles. */
  excludeTitleFilter: z.string().nullable().default('\\[for ?hire\\]|seeking work|looking for work'),
  minSelfTextLength: z.number().int().min(0).max(10_000).default(80),
  /**
   * Minimum classification confidence to accept a post as a job.
   *
   * Reddit is a lead source, so the bar is lower than for an ATS — but it is a
   * bar, and it is stated rather than implied by a regex.
   */
  minJobConfidence: z.number().min(0).max(1).default(0.5),
  maxClassifierCalls: z.number().int().min(0).max(500).default(25),
  userAgentSuffix: z.string().default('job-intel'),
  credentialNames: z
    .object({
      clientId: z.string().default('REDDIT_CLIENT_ID'),
      clientSecret: z.string().default('REDDIT_CLIENT_SECRET'),
    })
    .default({}),
});

export type RedditConfig = z.infer<typeof redditConfigSchema>;

interface RedditPost {
  id: string;
  name?: string;
  title: string;
  selftext?: string;
  selftext_html?: string | null;
  author?: string;
  subreddit?: string;
  permalink?: string;
  url?: string;
  created_utc?: number;
  link_flair_text?: string | null;
  over_18?: boolean;
  stickied?: boolean;
}

interface RedditListing {
  data?: { children?: Array<{ data?: RedditPost }>; after?: string | null };
}

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';

export class RedditConnector implements Connector<RedditConfig> {
  readonly id = 'reddit';
  readonly displayName = 'Reddit (official API)';
  readonly sourceType = 'social' as const;
  readonly accessTier = 'official_api' as const;
  readonly capabilities = { ...DEFAULT_CAPABILITIES, supportsIncremental: true, supportsPagination: true };
  readonly configSchema = redditConfigSchema;

  /**
   * One query per configured subreddit and role (Part 10).
   *
   * The subreddits are configuration, never a hardcoded list — the communities
   * that matter to a Nigerian frontend developer and a German data engineer
   * have almost nothing in common, and baking either set in would make the
   * source useless to the other.
   *
   * Configuration is not available at build time, so the defaults come from the
   * connector's schema; a configured source overrides them at run time.
   */
  buildQueries(input: QueryBuildInput): SourceQuery[] {
    const subreddits = this.configuredSubreddits ?? ['forhire', 'remotejs'];
    return buildRedditQueries(this.id, input, subreddits);
  }

  /** Set by the runner from the source row, so queries name real communities. */
  configuredSubreddits: string[] | null = null;

  /** Cached per connector instance; Reddit tokens last ~24h. */
  private token: { value: string; expiresAt: number } | null = null;

  /** Optional. Absent means classification stays deterministic. */
  constructor(private readonly classifier: ClassificationProvider | null = null) {}

  availability(ctx: { config: RedditConfig; getSecret(name: string): string | undefined }) {
    const { clientId, clientSecret } = ctx.config.credentialNames;
    const missing = [clientId, clientSecret].filter((name) => !ctx.getSecret(name));

    if (missing.length > 0) {
      return {
        available: false,
        reason:
          'Reddit requires registered API credentials. Its unauthenticated JSON endpoints ' +
          'return 403 to automated clients, and impersonating a browser would breach its terms.',
        requires: missing,
      };
    }
    return { available: true, reason: null, requires: [] };
  }

  async healthCheck(ctx: ConnectorContext<RedditConfig>) {
    const startedAt = Date.now();
    const availability = this.availability(ctx);
    if (!availability.available) {
      return {
        healthy: false,
        message: `${availability.reason} Missing: ${availability.requires.join(', ')}`,
        checkedAt: new Date(),
      };
    }

    try {
      const token = await this.getToken(ctx);
      const subreddit = ctx.config.subreddits[0];
      const response = await ctx.http.getJson<RedditListing>(
        `${API_BASE}/r/${subreddit}/new?limit=1`,
        { headers: this.authHeaders(token, ctx), signal: ctx.signal },
      );
      const count = response.data.data?.children?.length ?? 0;
      return {
        healthy: true,
        message: `Authenticated; r/${subreddit} returned ${count} post(s)`,
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
    ctx: ConnectorContext<RedditConfig>,
  ): AsyncGenerator<SourceJobDraft, { cursor: Record<string, unknown> }, void> {
    const availability = this.availability(ctx);
    if (!availability.available) {
      throw new NotPermittedError(availability.reason ?? 'Reddit credentials unavailable', {
        requires: availability.requires,
      });
    }

    const { config } = ctx;
    const token = await this.getToken(ctx);
    const include = safeRegex(config.titleFilter);
    const exclude = safeRegex(config.excludeTitleFilter);
    const seenBefore = readCursor(ctx.cursor);
    const newestPerSub: Record<string, number> = { ...seenBefore };

    let classifierCalls = 0;
    let accepted = 0;
    let rejected = 0;

    for (const subreddit of config.subreddits) {
      const url = `${API_BASE}/r/${encodeURIComponent(subreddit)}/${config.listing}?limit=${config.limitPerSubreddit}`;

      // One failing subreddit must not lose the others.
      let listing: RedditListing;
      try {
        const response = await ctx.http.getJson<RedditListing>(url, {
          headers: this.authHeaders(token, ctx),
          signal: ctx.signal,
        });
        listing = response.data;
      } catch (error) {
        ctx.log('warn', `Failed to read r/${subreddit}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const watermark = seenBefore[subreddit] ?? 0;
      let newest = watermark;

      for (const child of listing.data?.children ?? []) {
        const post = child.data;
        if (!post?.id || !post.title) continue;
        if (post.stickied || post.over_18) continue;

        const createdUtc = post.created_utc ?? 0;
        if (createdUtc <= watermark) continue;
        if (createdUtc > newest) newest = createdUtc;

        if (include && !include.test(post.title)) continue;
        if (exclude && exclude.test(post.title)) continue;

        const body = post.selftext ?? '';
        if (body.length < config.minSelfTextLength) continue;

        const permalink = post.permalink
          ? `https://www.reddit.com${post.permalink}`
          : `https://www.reddit.com/r/${subreddit}/comments/${post.id}`;

        // An off-Reddit `url` is the likely application link; a self-post's
        // `url` is just the permalink again and carries no extra information.
        const externalUrl =
          post.url && !post.url.includes('reddit.com') && /^https?:\/\//.test(post.url)
            ? post.url
            : null;

        /*
         * Is this actually a job?
         *
         * A title regex is a necessary filter and an insufficient one: r/forhire
         * carries `[Hiring]` posts that are recruiter announcements, career
         * questions that mention hiring, and outright scams. Classification
         * looks at the body and returns a *type*, so the pipeline can tell a
         * vacancy from a lead from spam rather than treating all three alike.
         */
        const verdict = await classifyContent(
          {
            text: body,
            url: permalink,
            metadata: {
              title: post.title,
              subreddit,
              flair: post.link_flair_text ?? null,
            },
          },
          {
            provider: this.classifier ?? null,
            canSpend: () => classifierCalls < config.maxClassifierCalls,
          },
        );

        if (verdict.method === 'ai' || verdict.method === 'ai_failed_fallback') classifierCalls += 1;

        if (!verdict.classification.isJob || verdict.classification.confidence < config.minJobConfidence) {
          rejected += 1;
          ctx.log('debug', `Not a job posting: ${post.title.slice(0, 80)}`, {
            contentType: verdict.classification.contentType,
            confidence: verdict.classification.confidence,
            reason: verdict.classification.reason,
          });
          continue;
        }

        // Application links inside the body — "apply at …" — are the actual
        // destination far more often than the post's own `url` field.
        const bodyLinks = extractApplicationLinks(body);

        const draft = sourceJobDraftSchema.safeParse({
          externalId: post.name ?? `t3_${post.id}`,
          title: post.title,
          // Reddit has no company field. Deliberately left as the poster rather
          // than guessed from the title: a wrong company breaks deduplication
          // far more badly than a missing one.
          companyName:
            verdict.classification.company ?? (post.author ? `u/${post.author}` : 'Unknown (Reddit)'),
          description: body,
          descriptionFormat: 'markdown',
          locationText: verdict.classification.location,
          remoteFlag:
            verdict.classification.remoteStatus === 'remote'
              ? true
              : verdict.classification.remoteStatus === 'onsite'
                ? false
                : null,
          tags: [subreddit, ...(post.link_flair_text ? [post.link_flair_text] : [])],
          postedAt: createdUtc ? new Date(createdUtc * 1000) : null,
          url: permalink,
          applyUrl: verdict.classification.applicationUrl ?? externalUrl ?? bodyLinks[0] ?? null,
          raw: post,
          sourceMetadata: {
            subreddit,
            author: post.author ?? null,
            flair: post.link_flair_text ?? null,
            externalUrl,
            applicationLinks: bodyLinks,
            // Explicitly unverified: a Reddit post is a lead, not a vacancy.
            verifiedEmployer: false,
            contentType: verdict.classification.contentType,
            classificationMethod: verdict.method,
            classificationConfidence: verdict.classification.confidence,
            classificationReason: verdict.classification.reason,
            aiClassified: verdict.method === 'ai',
            model: verdict.modelUsed,
          },
        });

        if (draft.success) {
          accepted += 1;
          yield draft.data;
        }
      }

      newestPerSub[subreddit] = newest;
    }

    ctx.log('info', 'Reddit discovery finished', {
      accepted,
      rejected,
      classifierCalls,
      subreddits: config.subreddits.length,
    });

    return { cursor: newestPerSub };
  }

  /** OAuth2 client-credentials, as documented for registered script apps. */
  private async getToken(ctx: ConnectorContext<RedditConfig>): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const { clientId, clientSecret } = ctx.config.credentialNames;
    const id = ctx.getSecret(clientId);
    const secret = ctx.getSecret(clientSecret);
    if (!id || !secret) {
      throw new ConfigurationError(`Missing Reddit credentials: ${clientId}, ${clientSecret}`);
    }

    const response = await ctx.http.getJson<{ access_token?: string; expires_in?: number }>(
      TOKEN_URL,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': this.userAgent(ctx),
        },
        body: 'grant_type=client_credentials',
        signal: ctx.signal,
        skipRobots: true,
      },
    );

    const accessToken = response.data.access_token;
    if (!accessToken) {
      throw new NotPermittedError('Reddit did not return an access token', { status: response.status });
    }

    this.token = {
      value: accessToken,
      expiresAt: Date.now() + (response.data.expires_in ?? 3600) * 1000,
    };
    return accessToken;
  }

  private authHeaders(token: string, ctx: ConnectorContext<RedditConfig>): Record<string, string> {
    return { authorization: `Bearer ${token}`, 'user-agent': this.userAgent(ctx) };
  }

  /** Reddit requires a descriptive, unique User-Agent and enforces it. */
  private userAgent(ctx: ConnectorContext<RedditConfig>): string {
    return `nodejs:${ctx.config.userAgentSuffix}:v0.1 (by /u/job-intel-bot)`;
  }
}

function readCursor(cursor: Record<string, unknown> | null): Record<string, number> {
  if (!cursor) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(cursor)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function safeRegex(pattern: string | null): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/**
 * Application links in a post body.
 *
 * Ordered by how likely each is to be the real destination: a known ATS domain
 * beats a generic careers page, which beats any other link. A social post
 * typically carries several URLs — the company homepage, a Discord invite, the
 * poster's portfolio — and picking the first one found is usually wrong.
 */
export function extractApplicationLinks(body: string, limit = 5): string[] {
  const ATS_HOSTS =
    /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|personio\.de|teamtailor\.com|breezy\.hr|jobvite\.com|bamboohr\.com)/i;
  const CAREER_PATH = /\/(careers?|jobs|vacanc|apply|positions?|openings?)\b/i;
  const NOISE =
    /(discord\.gg|t\.me|twitter\.com|x\.com|linkedin\.com\/in\/|imgur|reddit\.com|youtube\.com)/i;

  const seen = new Set<string>();
  const scored: Array<{ url: string; score: number }> = [];

  for (const match of body.matchAll(/https?:\/\/[^\s)<>\]"']+/g)) {
    const raw = match[0].replace(/[.,;:]+$/, '');
    if (seen.has(raw) || raw.length > 500) continue;
    seen.add(raw);

    if (NOISE.test(raw)) continue;

    let score = 1;
    if (ATS_HOSTS.test(raw)) score += 10;
    if (CAREER_PATH.test(raw)) score += 5;
    scored.push({ url: raw, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.url);
}
