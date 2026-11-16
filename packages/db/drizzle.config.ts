import { defineConfig } from 'drizzle-kit';

/**
 * Migration generation reads only the schema; `dbCredentials` matters solely
 * for `drizzle-kit studio`/`push`. Keeping the URL optional means
 * `pnpm db:generate` works on a machine with no database configured.
 */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jobintel',
  },
  verbose: true,
  strict: false,
});
