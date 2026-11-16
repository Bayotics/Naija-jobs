/**
 * Test stub for the `server-only` package.
 *
 * The real module throws unless resolved under React's `react-server`
 * condition, which the vitest runner does not set. Server modules are exactly
 * what these tests exercise, so the guard is replaced with a no-op rather than
 * worked around by loosening the import boundary in production code.
 */
export {};
