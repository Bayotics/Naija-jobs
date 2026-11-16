import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

/**
 * Loads `.env` from the workspace root.
 *
 * Plain `dotenv/config` resolves relative to `process.cwd()`, which in a pnpm
 * monorepo is the *package* directory when a script runs via `pnpm --filter`.
 * That silently yields an empty environment and a confusing validation failure,
 * so we walk up to the directory that owns the workspace instead.
 *
 * Values already present in `process.env` always win — a real deployment sets
 * variables directly and must never be overridden by a stray file.
 */
export interface LoadDotenvResult {
  loaded: string[];
  rootDir: string | null;
}

const WORKSPACE_MARKERS = ['pnpm-workspace.yaml', 'turbo.json'];

export function findWorkspaceRoot(startDir: string = process.cwd()): string | null {
  let current = resolve(startDir);
  for (;;) {
    if (WORKSPACE_MARKERS.some((marker) => existsSync(join(current, marker)))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * @param files Ordered by increasing precedence; later files override earlier
 *              ones, matching the conventional `.env` → `.env.local` chain.
 */
export function loadDotenv(
  files: readonly string[] = ['.env', '.env.local'],
  startDir: string = process.cwd(),
): LoadDotenvResult {
  const rootDir = findWorkspaceRoot(startDir);
  if (!rootDir) return { loaded: [], rootDir: null };

  const loaded: string[] = [];
  for (const file of files) {
    const path = join(rootDir, file);
    if (!existsSync(path)) continue;
    // `override: false` keeps real environment variables authoritative.
    dotenvConfig({ path, override: false });
    loaded.push(file);
  }
  return { loaded, rootDir };
}

/** Reads a file from the workspace root, or null. Used by tooling and health checks. */
export function readWorkspaceFile(relativePath: string): string | null {
  const rootDir = findWorkspaceRoot();
  if (!rootDir) return null;
  const path = join(rootDir, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
