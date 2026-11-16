/**
 * Local development database: `pnpm dev:db`
 *
 * ⚠️  DEVELOPMENT ONLY. Never run this in production.
 *
 * Serves an embedded PGlite instance over the real PostgreSQL wire protocol, so
 * a clone of this repo has a working Postgres — with pgvector — without Docker,
 * a local install, or a cloud account.
 *
 * Why a socket server rather than embedding PGlite in each process:
 *
 *  1. **The app uses the production code path.** The web app and worker connect
 *     with `pg` over TCP, exactly as they will against Neon or RDS. Embedding
 *     PGlite would exercise a driver that never runs in production.
 *  2. **Bundlers break embedded PGlite.** Next/webpack rewrites PGlite's
 *     `.tar.gz` extension bundles into static asset URLs, which Postgres cannot
 *     load. Out-of-process, that problem does not exist.
 *  3. **A process can connect at all.** A file-backed PGlite is single-process,
 *     so nothing else could open it while a process held it. Over a socket, one
 *     client at a time can — but only one. See the warning below.
 *
 * Point `DATABASE_URL` at it and set `DATABASE_DRIVER=pg`:
 *     DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres
 */
import { rmSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { findWorkspaceRoot, loadDotenv } from '@job-intel/config';

const DEFAULT_PORT = 55432;
const DEFAULT_HOST = '127.0.0.1';

function resolveDataDir(dataDir: string): string {
  if (isAbsolute(dataDir)) return dataDir;
  const root = findWorkspaceRoot();
  return root ? resolve(root, dataDir) : resolve(dataDir);
}

async function main(): Promise<void> {
  loadDotenv();

  const port = Number(process.env.DEV_DB_PORT ?? DEFAULT_PORT);
  const host = process.env.DEV_DB_HOST ?? DEFAULT_HOST;
  const dataDir = resolveDataDir(process.env.PGLITE_DATA_DIR ?? './.pgdata');

  if (process.argv.includes('--fresh')) {
    console.log(`[dev:db] removing ${dataDir}`);
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`[dev:db] starting embedded Postgres at ${dataDir}`);
  const db = await PGlite.create({ dataDir, extensions: { vector, pg_trgm } });
  // Install here as well as in the migrator: a consumer connecting over the
  // wire cannot register extension bundles itself.
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector;');
  await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

  /*
   * ⚠️  This server accepts ONE client connection at a time.
   *
   * `PGLiteSocketServer` at this version has no concurrency option — the
   * `maxConnections` multiplexer arrived in a later release that requires
   * PGlite 0.4+, and upgrading across that boundary risks the on-disk format of
   * an existing `.pgdata`.
   *
   * The practical consequence: **the web app and the worker cannot both hold a
   * connection.** Whichever connects first wins, and the other waits until its
   * pool times out and reports "Connection terminated due to connection
   * timeout" — a message that points at the network rather than at the real
   * cause, which is why this comment exists.
   *
   * Running both together requires a database that serves more than one client:
   *
   *     docker compose up -d      # postgres with pgvector, detached
   *     # or point DATABASE_URL at Neon / Supabase
   *
   * This server remains the zero-setup option for a single process — migrate,
   * seed, the worker on its own, or the web app on its own.
   */
  const server = new PGLiteSocketServer({ db, port, host });
  await server.start();

  console.log(
    `[dev:db] listening on ${host}:${port}\n` +
      `[dev:db] DATABASE_URL=postgresql://postgres:postgres@${host}:${port}/postgres\n` +
      '[dev:db] ONE client at a time — run the worker OR the web app, not both.\n' +
      '[dev:db]   To run both: docker compose up -d, or point DATABASE_URL at Neon.\n' +
      '[dev:db] development only — press Ctrl+C to stop',
  );

  // Clients connect and disconnect constantly here — migrate, seed, the web app
  // and the worker all come and go, and `pg` pools drop idle connections. An
  // abrupt disconnect surfaces as an unhandled socket error, which would
  // otherwise take the whole database down mid-session. Treat the benign
  // network codes as routine and keep serving; anything else is still fatal.
  const BENIGN_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECANCELED', 'ERR_STREAM_PREMATURE_CLOSE']);

  const codeOf = (error: unknown): string | undefined =>
    typeof error === 'object' && error !== null
      ? (error as NodeJS.ErrnoException).code
      : undefined;

  const handleProcessError = (error: unknown, kind: string): void => {
    const code = codeOf(error);
    if (code && BENIGN_SOCKET_CODES.has(code)) {
      console.warn(`[dev:db] client disconnected (${code}) — still serving`);
      return;
    }
    console.error(`[dev:db] fatal ${kind}:`, error);
    process.exit(1);
  };

  process.on('uncaughtException', (error) => handleProcessError(error, 'exception'));
  process.on('unhandledRejection', (reason) => handleProcessError(reason, 'rejection'));

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[dev:db] ${signal} — stopping`);
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('[dev:db] failed to start:', error);
  process.exit(1);
});
