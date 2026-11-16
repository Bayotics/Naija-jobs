import { createDatabase, type Database, type DatabaseHandle } from '../client';
import { runMigrations } from '../migrate';

/**
 * Test database harness.
 *
 * Boots an ephemeral in-process Postgres (PGlite), applies the real migrations
 * and hands back a live `Database`. Tests therefore exercise actual SQL — real
 * constraints, real enums, real foreign keys — with no Docker daemon and no
 * shared state between suites.
 *
 * This is a test-only module. Production code never imports it, and the env
 * schema refuses `DATABASE_DRIVER=pglite` when `NODE_ENV=production`.
 */
export interface TestDatabase {
  db: Database;
  handle: DatabaseHandle;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const handle = await createDatabase({ driver: 'pglite', dataDir: 'memory://' });
  await runMigrations(handle);
  return {
    db: handle.db,
    handle,
    close: () => handle.close(),
  };
}

/**
 * Truncates every application table while preserving schema and enums.
 *
 * Faster than rebuilding the database between tests, and `RESTART IDENTITY
 * CASCADE` keeps foreign keys satisfiable regardless of truncation order.
 */
export async function resetTestDatabase(db: Database): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await db.execute(sql`
    DO $$
    DECLARE
      stmt text;
    BEGIN
      SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
        INTO stmt
        FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename <> '__drizzle_migrations';
      IF stmt IS NOT NULL THEN
        EXECUTE 'TRUNCATE TABLE ' || stmt || ' RESTART IDENTITY CASCADE';
      END IF;
    END $$;
  `);
}
