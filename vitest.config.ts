import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the Next.js path alias so route handlers import identically
      // under test and at runtime.
      '@': fromRoot('./apps/web/src'),
      // See test/stubs/server-only.ts.
      'server-only': fromRoot('./test/stubs/server-only.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    environment: 'node',
    server: {
      deps: {
        // PGlite ships WASM + tarballed extension bundles; pre-bundling them
        // breaks extension registration. Load it as a real external module.
        external: ['@electric-sql/pglite'],
      },
    },
    // PGlite boots a WASM Postgres per integration suite; give it room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    /*
     * Teardown gets the same budget. Integration suites close a WASM Postgres
     * on the way out, which is not instant, and a teardown that overruns
     * surfaces as an unhandled error long after every assertion has passed.
     */
    teardownTimeout: 60_000,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**'],
    },
  },
});
