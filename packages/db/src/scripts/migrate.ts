/**
 * Migration CLI: `pnpm db:migrate`
 *
 * Loads .env, validates the environment, connects with whichever driver is
 * configured, and applies pending migrations. Exits non-zero on failure so it
 * can gate a deploy.
 */
import { ConfigurationError, loadDotenv, loadEnv } from '@job-intel/config';
import { createDatabase, optionsFromEnv } from '../client';
import { runMigrations } from '../migrate';

async function main(): Promise<void> {
  // Resolves .env from the workspace root, not the package directory.
  loadDotenv();
  const env = loadEnv(process.env, { role: 'worker' });
  console.log(`[migrate] driver=${env.DATABASE_DRIVER} env=${env.NODE_ENV}`);

  const handle = await createDatabase(optionsFromEnv(env));
  try {
    const started = Date.now();
    await runMigrations(handle);
    console.log(`[migrate] completed in ${Date.now() - started}ms`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    console.error(`\n[migrate] ${error.format()}`);
  } else {
    console.error('[migrate] failed:', error);
  }
  process.exit(1);
});
