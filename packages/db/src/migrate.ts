import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Database, DatabaseHandle } from './client';
import { ensureExtensions } from './client';

/** Absolute path to the generated SQL migrations, resolved relative to this file. */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../migrations');
}

/**
 * Applies all pending migrations.
 *
 * Extensions are installed first: the very first migration creates a
 * `vector(1536)` column, which fails unless pgvector already exists. Doing this
 * inside the migration itself would make it non-rerunnable on a fresh database.
 *
 * The migrator is driver-specific, so it is imported dynamically based on which
 * driver actually created the handle.
 */
export async function runMigrations(handle: DatabaseHandle): Promise<void> {
  await ensureExtensions(handle.db);

  const folder = migrationsFolder();

  if (handle.driver === 'pglite') {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    // The handle's db is structurally identical across drivers; the migrator
    // signature is the only thing that differs.
    await migrate(handle.db as never, { migrationsFolder: folder });
    return;
  }

  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  await migrate(handle.db as Database, { migrationsFolder: folder });
}
