import { z } from 'zod';
import type { SourceJobDraft } from '@job-intel/contracts';
import { ConfigurationError, ParseError } from '../errors';
import { DEFAULT_CAPABILITIES, type Connector, type ConnectorContext, type DiscoverySummary } from '../types';
import { ATS_PROVIDERS, findAtsProvider, listingToDraft, type AtsProvider } from './providers';

/**
 * One connector, every ATS.
 *
 * The value of this shape is what it does *not* require: adding Teamtailor
 * means writing an adapter with three functions and appending it to
 * `ATS_PROVIDERS`. No new connector, no new source type, no change to the
 * runner, the pipeline, matching, ranking or notifications — and no new place
 * for rate limiting or robots handling to be forgotten.
 *
 * Companies are a list rather than a single value because a source usefully
 * models "the twelve Berlin startups I care about, all on Greenhouse" as one
 * scheduled unit. Each is fetched independently and one failing does not
 * abandon the rest, mirroring the failure isolation the whole discovery layer
 * is built around.
 */
export const atsConfigSchema = z.object({
  provider: z.enum([
    'greenhouse',
    'lever',
    'ashby',
    'smartrecruiters',
    'workable',
    'recruitee',
    'personio',
  ]),
  /** Board tokens / slugs on that provider. */
  companies: z
    .array(
      z.union([
        z.string().trim().min(1).max(200),
        z.object({
          identifier: z.string().trim().min(1).max(200),
          /** Display name, when the slug is not the company's real name. */
          name: z.string().trim().max(200).nullable().default(null),
        }),
      ]),
    )
    .min(1)
    .max(200),
  /** Drops postings whose title matches — boards carry internships and sales. */
  excludeTitlePattern: z.string().nullable().default(null),
  includeTitlePattern: z.string().nullable().default(null),
  maxPerCompany: z.number().int().min(1).max(2000).default(500),
});

export type AtsConfig = z.infer<typeof atsConfigSchema>;

interface Target {
  identifier: string;
  name: string | null;
}

function toTargets(companies: AtsConfig['companies']): Target[] {
  return companies.map((entry) =>
    typeof entry === 'string' ? { identifier: entry, name: null } : entry,
  );
}

function safeRegex(pattern: string | null): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    // A bad pattern is a configuration mistake, not a reason to abort the run;
    // it is reported by the health check and ignored here.
    return null;
  }
}

export class AtsConnector implements Connector<AtsConfig> {
  readonly id = 'ats';
  readonly displayName = 'Applicant tracking system';
  readonly sourceType = 'ats' as const;
  readonly accessTier = 'official_api' as const;
  readonly capabilities = {
    ...DEFAULT_CAPABILITIES,
    supportsDetailFetch: true,
    supportsExpiryCheck: true,
    supportsPagination: false,
  };
  readonly configSchema = atsConfigSchema;

  constructor(private readonly providers: AtsProvider[] = ATS_PROVIDERS) {}

  private provider(id: string): AtsProvider {
    const found = this.providers.find((provider) => provider.id === id) ?? findAtsProvider(id);
    if (!found) throw new ConfigurationError(`Unknown ATS provider "${id}"`, { provider: id });
    return found;
  }

  availability(ctx: { config: AtsConfig }) {
    const provider = this.providers.find((p) => p.id === ctx.config.provider);
    return provider
      ? { available: true, reason: null, requires: [] }
      : {
          available: false,
          reason: `Unknown ATS provider "${ctx.config.provider}"`,
          requires: this.providers.map((p) => p.id),
        };
  }

  async healthCheck(ctx: ConnectorContext<AtsConfig>) {
    const startedAt = Date.now();
    const targets = toTargets(ctx.config.companies);
    const first = targets[0];

    if (!first) {
      return { healthy: false, message: 'No companies configured', checkedAt: new Date() };
    }

    for (const pattern of [ctx.config.excludeTitlePattern, ctx.config.includeTitlePattern]) {
      if (pattern && safeRegex(pattern) === null) {
        return {
          healthy: false,
          message: `Invalid title pattern: ${pattern}`,
          checkedAt: new Date(),
        };
      }
    }

    try {
      const provider = this.provider(ctx.config.provider);
      const listings = await provider.fetchListings({
        identifier: first.identifier,
        http: ctx.http,
        signal: ctx.signal,
      });

      return {
        healthy: true,
        message: `${provider.displayName}: ${listings.length} posting(s) for ${first.identifier}`,
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
    ctx: ConnectorContext<AtsConfig>,
  ): AsyncGenerator<SourceJobDraft, DiscoverySummary, void> {
    const provider = this.provider(ctx.config.provider);
    const targets = toTargets(ctx.config.companies);
    const exclude = safeRegex(ctx.config.excludeTitlePattern);
    const include = safeRegex(ctx.config.includeTitlePattern);

    let boardsRead = 0;
    let failures = 0;

    for (const target of targets) {
      if (ctx.signal.aborted) break;

      let listings;
      try {
        listings = await provider.fetchListings({
          identifier: target.identifier,
          http: ctx.http,
          signal: ctx.signal,
        });
        boardsRead += 1;
      } catch (error) {
        // One company's board being gone — a slug change, a company that moved
        // ATS — must not lose the other eleven.
        failures += 1;
        ctx.log('warn', `ATS board unavailable: ${target.identifier}`, {
          provider: provider.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      let emitted = 0;
      for (const listing of listings) {
        if (emitted >= ctx.config.maxPerCompany) break;
        if (exclude?.test(listing.title)) continue;
        if (include && !include.test(listing.title)) continue;

        const draft = listingToDraft(listing, {
          providerId: provider.id,
          identifier: target.identifier,
          companyName: target.name,
        });

        if (draft) {
          emitted += 1;
          yield draft;
        }
      }
    }

    // Every board failing is a source failure, not a quiet empty run.
    if (boardsRead === 0 && failures > 0) {
      throw new ParseError(
        `All ${failures} ${provider.displayName} board(s) failed to load`,
        { provider: provider.id, failures },
      );
    }

    return { cursor: { boardsRead, failures, checkedAt: new Date().toISOString() } };
  }
}
