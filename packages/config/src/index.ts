/**
 * @job-intel/config
 *
 * Four configuration domains, deliberately kept apart:
 *
 *   1. APPLICATION config  → `app-config.ts`  (runtime tunables, DB-backed)
 *   2. CANDIDATE prefs     → `@job-intel/contracts` + the profile tables
 *   3. SOURCE config       → the `job_sources` table, per-connector schema
 *   4. SECRET config       → `env.ts` + `secrets.ts` (environment only)
 *
 * Mixing these is what makes a preference change require a deploy.
 */
export * from './errors';
export * from './dotenv';
export * from './env';
export * from './app-config';
export * from './secrets';
