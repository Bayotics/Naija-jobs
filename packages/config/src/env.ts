import { z } from 'zod';
import { LOG_LEVELS } from '@job-intel/contracts';
import { ConfigurationError } from './errors';

/**
 * SECRET + DEPLOYMENT configuration — layer 4 of the config model.
 *
 * This file holds *only* credentials and deployment topology. It deliberately
 * contains no thresholds, weights, schedules or preferences: those live in
 * application config and the candidate profile, so they can be changed from the
 * UI without a redeploy. Putting a tunable here would quietly re-couple
 * behaviour to the deploy pipeline.
 */

const optionalUrl = z.string().trim().url().optional();
const optionalNonEmpty = z.string().trim().min(1).optional();

/**
 * The schema, as a function of which process is asking.
 *
 * Everything parses identically; only the production requirements differ.
 * `envSchema` below is this applied to the stricter role, so the exported
 * type and every existing reference are unchanged.
 */
export function envSchemaFor(role: 'web' | 'worker') {
  return z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_URL: z.string().trim().url().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    LOG_PRETTY: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),

    // ── Database ────────────────────────────────────────────────────────────
    /**
     * `pg`     — any Postgres (Neon, RDS, local). The production driver.
     * `pglite` — in-process WASM Postgres. Used by tests and offline dev so the
     *            suite needs no Docker daemon; never used in production.
     */
    DATABASE_DRIVER: z.enum(['pg', 'neon', 'pglite']).default('pg'),
    DATABASE_URL: optionalNonEmpty,
    /** Unpooled connection, required only for migrations against pgBouncer/Neon. */
    DATABASE_URL_UNPOOLED: optionalNonEmpty,
    /** Filesystem path (or `memory://`) when DATABASE_DRIVER=pglite. */
    PGLITE_DATA_DIR: z.string().trim().default('./.pgdata'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    /** Idle pooled-connection lifetime. 0 pins connections for the process. */
    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),

    // ── Queue ───────────────────────────────────────────────────────────────
    /**
     * `bullmq`   — Redis-backed, the production driver.
     * `inmemory` — process-local, for tests and the web app (which enqueues but
     *              never consumes). Chosen explicitly, never inferred.
     */
    QUEUE_DRIVER: z.enum(['bullmq', 'inmemory']).default('inmemory'),
    REDIS_URL: optionalNonEmpty,

    // ── Auth / signing (consumed from prompt 17 onward) ──────────────────────
    AUTH_SECRET: optionalNonEmpty,
    /**
     * The operations console credential.
     *
     * Deliberately separate from `AUTH_SECRET`: that key signs sessions, and a
     * system where the signing key is also the thing typed into a login box is
     * one shoulder-surf away from forgeable sessions.
     */
    OPS_PASSWORD: optionalNonEmpty,
    /** Role granted on successful login. Defaults to the most privileged. */
    OPS_ROLE: z.enum(['viewer', 'operator', 'admin']).default('admin'),
    ADMIN_API_KEY: optionalNonEmpty,

    // ── AI providers (prompt 15+) ───────────────────────────────────────────
    ANTHROPIC_API_KEY: optionalNonEmpty,
    AI_EMBEDDING_PROVIDER: z.enum(['openai', 'voyage', 'cohere']).optional(),
    AI_EMBEDDING_API_KEY: optionalNonEmpty,

    // ── Crawling identity ───────────────────────────────────────────────────
    CRAWLER_USER_AGENT: z
      .string()
      .trim()
      .default('JobIntelBot/0.1 (+https://github.com/your-org/job-intel)'),
    CRAWLER_CONTACT_EMAIL: z.string().trim().email().optional(),

    // ── Observability ───────────────────────────────────────────────────────
    SENTRY_DSN: optionalUrl,
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,

    // ── Worker topology ─────────────────────────────────────────────────────
    WORKER_ROLE: z.enum(['pipeline', 'browser', 'scheduler', 'all']).default('all'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
  })
  .superRefine((env, ctx) => {
    // Cross-field rules that a flat schema cannot express.
    if ((env.DATABASE_DRIVER === 'pg' || env.DATABASE_DRIVER === 'neon') && !env.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message:
          'Required when DATABASE_DRIVER=pg or neon. Set a Postgres connection string, ' +
          'or set DATABASE_DRIVER=pglite to run against in-process Postgres.',
      });
    }
    if (env.QUEUE_DRIVER === 'bullmq' && !env.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'Required when QUEUE_DRIVER=bullmq. Set a Redis connection string.',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (env.DATABASE_DRIVER === 'pglite') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_DRIVER'],
          message:
            'pglite is an in-process test driver and must not be used in production. ' +
            'Set DATABASE_DRIVER=pg with a real DATABASE_URL.',
        });
      }
      /*
       * Required by the process that uses them, not by every process.
       *
       * `AUTH_SECRET` signs dashboard sessions and `OPS_PASSWORD` is the
       * console credential. The worker serves no HTTP, issues no session and
       * has no console — it reads neither — yet refusing to boot without them
       * meant a blank value on the worker's host stopped all discovery,
       * enrichment and ranking over two secrets it would never have read.
       *
       * That is not hypothetical. Splitting the dashboard onto its own host
       * left the worker with its own environment, and one missing value there
       * is the difference between a system that finds jobs overnight and one
       * that silently does nothing.
       *
       * The web app still demands both, which is where the demand belongs.
       */
      if (role !== 'worker') {
        if (!env.AUTH_SECRET) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['AUTH_SECRET'],
            message: 'Required in production. Generate with: openssl rand -base64 32',
          });
        }
        if (!env.OPS_PASSWORD) {
          // A signed-session console with no credential to obtain a session is
          // not a locked door — it is a door nobody can open, which in practice
          // means the operator disables auth entirely.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['OPS_PASSWORD'],
            message:
              'Required in production. Without it the operations console can be signed into by nobody.',
          });
        }
      }

      if (!env.DATABASE_URL) {
        /*
         * Said plainly, because the alternative is a stack trace.
         *
         * Without it the process gets as far as opening a connection and
         * fails somewhere inside the driver, which reads as a database
         * problem rather than a missing variable.
         */
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_URL'],
          message: 'Required in production. Nothing can run without a database to read.',
        });
      }
    }
  });
}

export const envSchema = envSchemaFor('web');

export type Env = z.infer<typeof envSchema>;

/** Actionable hints for the variables people most often get wrong. */
const HINTS: Record<string, string> = {
  DATABASE_URL: 'e.g. postgresql://user:pass@host:5432/jobintel?sslmode=require',
  REDIS_URL: 'e.g. redis://localhost:6379 (or rediss:// for TLS)',
  AUTH_SECRET: 'Generate with: openssl rand -base64 32',
  OPS_PASSWORD: 'The console login credential. Must differ from AUTH_SECRET.',
};

/**
 * Parses and validates the environment. Throws a `ConfigurationError` whose
 * `format()` lists every problem at once — not just the first — so a misconfigured
 * deployment is fixed in one pass rather than N restarts.
 */
/**
 * `role` says which process is asking.
 *
 * Only production requirements differ by role; every variable parses the same
 * way. The default is the stricter one, so a caller that forgets to say gets
 * the dashboard's rules rather than the worker's.
 */
export function loadEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
  options: { role?: 'web' | 'worker' } = {},
): Env {
  const result = envSchemaFor(options.role ?? 'web').safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return { key, problem: issue.message, hint: HINTS[key] };
  });
  throw new ConfigurationError(
    `Invalid environment configuration (${issues.length} problem${issues.length === 1 ? '' : 's'}). ` +
      'See .env.example for the full list of supported variables.',
    issues,
  );
}

let cached: Env | undefined;

/** Memoised accessor. Call `resetEnv()` in tests that mutate the environment. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

export function resetEnv(): void {
  cached = undefined;
}
