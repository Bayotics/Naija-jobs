import 'server-only';
import {
  CandidateRepository,
  EmbeddingRepository,
  EnrichmentRepository,
  IntelligenceRepository,
  MatchRepository,
} from '@job-intel/db';
import { MatchingService } from '@job-intel/discovery';
import { HashingEmbeddingProvider, NullEmbeddingProvider } from '@job-intel/matching';
import { apiError } from './api';
import { getServerContext } from './db';

/**
 * Matching composition for the web process.
 *
 * Built fresh per request, like the candidate service and for the same reason:
 * the service holds no preference state, and a cached one would be the exact
 * mechanism by which a preference edit failed to affect the next scoring run.
 *
 * No LLM provider is wired in here. The web process should not be making
 * multi-second model calls inside a request; when reasoning is enabled it runs
 * in the worker, and the API enqueues.
 */
export interface MatchingContext {
  service: MatchingService;
  matches: MatchRepository;
  profileId: string | null;
}

export async function getMatchingContext(): Promise<MatchingContext> {
  const ctx = await getServerContext();
  const config = await ctx.config.get();
  const profile = await ctx.profiles.getActiveProfile();

  const matches = new MatchRepository(ctx.handle.db);

  const service = new MatchingService({
    matches,
    candidates: new CandidateRepository(ctx.handle.db),
    profiles: ctx.profiles,
    enrichments: new EnrichmentRepository(ctx.handle.db),
    jobs: ctx.jobs,
    embeddings: new EmbeddingRepository(ctx.handle.db),
    // Supplies evidence for the explanation. It changes no score; a candidate
    // who has uploaded nothing simply gets the explanation matching always gave.
    intelligence: new IntelligenceRepository(ctx.handle.db),
    logger: ctx.logger,
    events: ctx.events,
    config: {
      thresholds: { possible: config.matching.minimumScore },
      // Reasoning is a worker concern; see the note above.
      llm: { enabled: false },
    },
    // The local hashing embedder is a stand-in that exercises the semantic
    // pathway without a paid API. It is only used when the deployment has not
    // configured a real one, and the model id it records says so plainly, so a
    // vector produced by it can never be silently compared against a real one.
    embedder: config.ai.enabled
      ? new NullEmbeddingProvider()
      : new HashingEmbeddingProvider(config.ai.embeddingDimensions),
  });

  return { service, matches, profileId: profile?.profileId ?? null };
}

/** Shared guard: every matching endpoint needs a profile to act on. */
export async function requireMatchingProfile(): Promise<
  | { ok: true; service: MatchingService; matches: MatchRepository; profileId: string }
  | { ok: false; response: ReturnType<typeof apiError> }
> {
  const { service, matches, profileId } = await getMatchingContext();
  if (!profileId) {
    return {
      ok: false,
      response: apiError(409, 'NO_PROFILE', 'No active candidate profile. Create one first.'),
    };
  }
  return { ok: true, service, matches, profileId };
}
