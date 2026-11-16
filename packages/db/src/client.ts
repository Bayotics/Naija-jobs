import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { isAbsolute, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { findWorkspaceRoot, type Env } from '@job-intel/config';
import * as schema from './schema/index';

/**
 * Database access, behind a driver abstraction.
 *
 * Three drivers, chosen by `DATABASE_DRIVER`:
 *
 *   `pg`     — node-postgres against any Postgres (Neon, RDS, local). Production.
 *   `neon`   — Neon over WebSocket on port 443, for networks where the Postgres
 *              wire protocol on 5432 is filtered. See below.
 *   `pglite` — in-process WASM Postgres. Lets the test suite and offline dev run
 *              real SQL, real migrations and real constraints with no Docker
 *              daemon. Rejected at startup in production by the env schema.
 *
 * All three expose the identical Drizzle API, so nothing above this file knows
 * which one it is talking to.
 *
 * **Why `neon` exists.** Plenty of networks — consumer antivirus with network
 * inspection, corporate DPI, some ISPs — allow a TCP connection to port 5432
 * and then reset it the moment recognisable Postgres protocol bytes appear. The
 * symptom is `read ECONNRESET` immediately after the SSLRequest packet, before
 * the server has replied, which reads like a database problem and is not one.
 * Neon's driver carries the same SQL over a WebSocket on 443, which is
 * indistinguishable from ordinary web traffic and passes through.
 */

export type Schema = typeof schema;

/**
 * The application-facing database type.
 *
 * Both drivers satisfy this. Repositories accept it, so they are testable
 * against PGlite and run unchanged against Postgres in production.
 */
export type Database = NodePgDatabase<Schema>;

export interface DatabaseHandle {
  db: Database;
  /** Releases pooled connections / shuts down the embedded engine. */
  close(): Promise<void>;
  driver: 'pg' | 'neon' | 'pglite';
}

export interface CreateDatabaseOptions {
  driver: 'pg' | 'neon' | 'pglite';
  connectionString?: string | undefined;
  /** Filesystem path, or `memory://` for an ephemeral instance. */
  dataDir?: string | undefined;
  poolMax?: number;
  /** Milliseconds an idle pooled connection is kept. 0 = never close. */
  idleTimeoutMs?: number;
  logger?: boolean;
}

/**
 * Anchors a relative PGlite data directory to the workspace root.
 *
 * Without this, `./.pgdata` resolves against each process's cwd — so migrations
 * run from `packages/db` and the worker started from `apps/worker` would open
 * two *different*, silently empty databases. Absolute paths and `memory://`
 * pass through untouched.
 */
function resolveDataDir(dataDir: string): string {
  if (dataDir === 'memory://' || isAbsolute(dataDir)) return dataDir;
  const root = findWorkspaceRoot();
  return root ? resolve(root, dataDir) : resolve(dataDir);
}

export function optionsFromEnv(env: Env): CreateDatabaseOptions {
  return {
    driver: env.DATABASE_DRIVER,
    connectionString: env.DATABASE_URL,
    dataDir: env.PGLITE_DATA_DIR,
    poolMax: env.DATABASE_POOL_MAX,
    idleTimeoutMs: env.DATABASE_IDLE_TIMEOUT_MS,
  };
}

export async function createDatabase(
  options: CreateDatabaseOptions,
): Promise<DatabaseHandle> {
  if (options.driver === 'pglite') return createPgliteDatabase(options);
  if (options.driver === 'neon') return createNeonDatabase(options);

  return createPgDatabase(options);
}

/**
 * Neon over WebSocket.
 *
 * `@neondatabase/serverless` exposes a `Pool` that is API-compatible with
 * node-postgres, so Drizzle's adapter and every repository above it are
 * unchanged — only the transport differs. WebSocket rather than Neon's HTTP
 * driver because migrations need transactions and session state, which the HTTP
 * driver deliberately does not provide.
 */
function createNeonDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  if (!options.connectionString) {
    throw new Error('createDatabase: connectionString is required for the "neon" driver');
  }

  /*
   * Node has no global WebSocket before v22, and the driver needs one. Supplied
   * explicitly rather than relying on the runtime, so behaviour does not change
   * silently between Node versions.
   */
  neonConfig.webSocketConstructor = ws;

  const pool = new NeonPool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    /*
     * Longer than the `pg` path allows. Neon's free tier scales compute to
     * zero, and the first connection after an idle period has to wake it —
     * routinely several seconds. A 10s budget turns a normal cold start into a
     * failure that looks like an outage.
     */
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
  });

  const db = drizzleNeon(pool, { schema, logger: options.logger ?? false }) as unknown as Database;

  return {
    db,
    driver: 'neon',
    close: async () => {
      await pool.end();
    },
  };
}

function createPgDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  if (!options.connectionString) {
    throw new Error('createDatabase: connectionString is required for the "pg" driver');
  }
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    // Fail fast rather than hanging a worker on an unreachable database.
    connectionTimeoutMillis: 10_000,
    // 0 keeps connections pinned for the process lifetime. Useful against
    // endpoints that dislike reconnect churn — including the local `dev:db`
    // bridge, whose embedded engine cannot survive a mid-protocol reset.
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
  });

  const db = drizzlePg(pool, { schema, logger: options.logger ?? false });
  return {
    db,
    driver: 'pg',
    close: async () => {
      await pool.end();
    },
  };
}

/**
 * PGlite is loaded dynamically so it stays a devDependency and never enters a
 * production bundle.
 *
 * Note this driver is for tests and CLI scripts (migrate, seed) only. It is
 * *not* used by the Next.js app: bundlers rewrite PGlite's `.tar.gz` extension
 * bundles into static asset URLs, which Postgres cannot load. The web app and
 * worker use the `pg` driver against a real Postgres endpoint — in local
 * development, the PGlite-backed one started by `pnpm dev:db`.
 */
async function createPgliteDatabase(
  options: CreateDatabaseOptions,
): Promise<DatabaseHandle> {
  const [{ PGlite }, { vector }, { pg_trgm }, { drizzle: drizzlePglite }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite/vector'),
    import('@electric-sql/pglite/contrib/pg_trgm'),
    import('drizzle-orm/pglite'),
  ]);

  // A bundler that mangles these dynamic imports yields `undefined` here, which
  // PGlite accepts silently and then fails much later with an opaque
  // "extension is not available". Fail loudly at the point of the real problem.
  if (!vector || !pg_trgm) {
    throw new Error(
      'PGlite extension bundles failed to load (vector/pg_trgm resolved to undefined). ' +
        'If running under a bundler, ensure @electric-sql/pglite is not pre-bundled.',
    );
  }

  // Always use the single options-object form. The positional form
  // `new PGlite(undefined, opts)` silently drops `extensions`, which surfaces
  // much later as an opaque "extension is not available" from Postgres.
  const dataDir = resolveDataDir(options.dataDir ?? 'memory://');
  const client = new PGlite({
    ...(dataDir === 'memory://' ? {} : { dataDir }),
    extensions: { vector, pg_trgm },
  });
  await client.waitReady;

  const db = drizzlePglite(client, {
    schema,
    logger: options.logger ?? false,
  }) as unknown as Database;

  return {
    db,
    driver: 'pglite',
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Installs the extensions the schema depends on.
 *
 * Must run before migrations: `vector` provides the column type used by
 * `job_embeddings`, and `pg_trgm` backs fuzzy company/title matching.
 */
export async function ensureExtensions(db: Database): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
}

/** Cheap liveness probe for the health endpoint. */
export async function checkDatabaseHealth(
  db: Database,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
