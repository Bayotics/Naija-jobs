import { z } from 'zod';

/**
 * APPLICATION configuration — layer 2 of the config model.
 *
 * Operational tunables that must be changeable at runtime without a redeploy,
 * but which are *not* candidate preferences and *not* secrets. Every value here
 * has a safe code default, so the system boots before any row exists in the
 * database.
 *
 * Resolution order (lowest to highest precedence):
 *   code defaults (this file) → `app_config` table → explicit overrides
 *
 * Note what is absent: no salary figures, no locations, no technologies. Those
 * belong to the candidate profile. Mixing them here is exactly the coupling
 * that makes a preference change require a deploy.
 */
export const appConfigSchema = z.object({
  pipeline: z
    .object({
      /** Days back to reconsider when a profile or ruleset version changes. */
      rematchLookbackDays: z.number().int().min(1).max(365).default(30),
      /** Postings older than this are not ingested at all. */
      maxJobAgeDays: z.number().int().min(1).max(365).default(60),
      batchSize: z.number().int().min(1).max(1000).default(50),
    })
    .default({}),

  matching: z
    .object({
      /** Below this, a job is never surfaced. */
      minimumScore: z.number().min(0).max(100).default(50),
      /** At or above this, notify immediately rather than batching to a digest. */
      /** At or above this a job is marked exceptional and pinned to the top. */
      exceptionalScore: z.number().min(0).max(100).default(85),
      digestScore: z.number().min(0).max(100).default(65),
      minimumConfidence: z.number().min(0).max(1).default(0.4),
    })
    .default({}),

  dedup: z
    .object({
      simhashMaxDistance: z.number().int().min(0).max(64).default(3),
      embeddingSimilarityThreshold: z.number().min(0).max(1).default(0.92),
      /** Width of the posted-date blocking window, in days. */
      postedWindowDays: z.number().int().min(1).max(90).default(14),
    })
    .default({}),

  validation: z
    .object({
      scamQuarantineThreshold: z.number().min(0).max(1).default(0.6),
      minimumQualityScore: z.number().min(0).max(1).default(0.2),
      /** Consecutive absences from a source listing before presuming closed. */
      expiryAbsenceRuns: z.number().int().min(1).max(20).default(3),
    })
    .default({}),

  ai: z
    .object({
      enabled: z.boolean().default(false),
      triageModel: z.string().default('claude-haiku-4-5'),
      deepModel: z.string().default('claude-opus-5'),
      embeddingModel: z.string().default('text-embedding-3-small'),
      embeddingDimensions: z.number().int().min(64).max(4096).default(1536),
      dailyBudgetUsd: z.number().min(0).default(2),
      /** Flag a job when the LLM and the deterministic rules disagree this much. */
      scoreDivergenceThreshold: z.number().min(0).max(100).default(40),
    })
    .default({}),

  retention: z
    .object({
      rawPostingDays: z.number().int().min(1).max(3650).default(90),
      sourceRunDays: z.number().int().min(1).max(3650).default(180),
      systemEventDays: z.number().int().min(1).max(3650).default(90),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

/** All defaults, with nothing supplied. Always valid by construction. */
export function defaultAppConfig(): AppConfig {
  return appConfigSchema.parse({});
}

/**
 * Persistence port for runtime config. Implemented by `@job-intel/db` against
 * the `app_config` table; kept as an interface here so this package depends on
 * no storage engine.
 */
export interface ConfigStore {
  getAll(): Promise<Record<string, unknown>>;
  set(key: string, value: unknown): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] =
      isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value;
  }
  return out;
}

/**
 * Merges stored overrides onto the defaults and re-validates. An override that
 * would produce an invalid config is rejected as a whole rather than partially
 * applied, so the running system is never in a half-configured state.
 */
export function resolveAppConfig(overrides: Record<string, unknown> = {}): AppConfig {
  const merged = deepMerge(defaultAppConfig() as unknown as Record<string, unknown>, overrides);
  return appConfigSchema.parse(merged);
}

/**
 * Caching resolver with TTL-bounded staleness.
 *
 * A pub/sub invalidation channel is added alongside this in prompt 10; the TTL
 * is the backstop that bounds the damage if an invalidation message is dropped.
 */
export class AppConfigProvider {
  private cache: AppConfig | undefined;
  private loadedAt = 0;

  constructor(
    private readonly store: ConfigStore | null,
    private readonly ttlMs = 30_000,
  ) {}

  async get(): Promise<AppConfig> {
    const fresh = this.cache && Date.now() - this.loadedAt < this.ttlMs;
    if (fresh && this.cache) return this.cache;

    const overrides = this.store ? await this.store.getAll() : {};
    this.cache = resolveAppConfig(overrides);
    this.loadedAt = Date.now();
    return this.cache;
  }

  invalidate(): void {
    this.cache = undefined;
    this.loadedAt = 0;
  }
}
