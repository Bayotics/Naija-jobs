import { loadDotenv, loadEnv } from '@job-intel/config';
import {
  ProfileRepository,
  SearchConfigRepository,
  createDatabase,
  optionsFromEnv,
} from '@job-intel/db';
import { sql } from 'drizzle-orm';
import { buildRelevanceProfile, judgeRelevance } from '../pipeline/relevance';

/**
 * Removes stored postings the relevance gate would now reject.
 *
 * The gate filters at ingestion, which fixes the future and does nothing about
 * the past. Anything discovered before it existed is still sitting in the
 * database — and on the jobs page.
 *
 * Dry run by default. Pass `--apply` to delete.
 *
 * Deletion is the right disposition here rather than a hidden flag: these are
 * public postings that any future scan re-fetches in seconds, so the cost of
 * being wrong is a re-scan, not lost data.
 */

async function main(): Promise<void> {
  loadDotenv();
  const apply = process.argv.includes('--apply');
  const handle = await createDatabase(optionsFromEnv(loadEnv()));

  try {
    const active = await new ProfileRepository(handle.db).getActiveProfile();

    if (!active) {
      console.error('No active candidate profile.');
      process.exitCode = 1;
      return;
    }

    const profiles = await new SearchConfigRepository(handle.db).listProfiles(active.profileId);
    const relevance = buildRelevanceProfile(profiles);

    if (!relevance.usable) {
      console.error(
        'The search profile states too few roles or skills to filter on. Refusing to delete anything.',
      );
      process.exitCode = 1;
      return;
    }

    const result: { rows?: Array<Record<string, unknown>> } = await handle.db.execute(
      sql.raw(`select id, source_id, title from jobs`),
    );
    const rows = (result.rows ?? []) as Array<{ id: string; source_id: string; title: string }>;

    const doomed = rows.filter((row) => !judgeRelevance(row.title, relevance).relevant);

    const bySource = new Map<string, number>();
    for (const row of doomed) bySource.set(row.source_id, (bySource.get(row.source_id) ?? 0) + 1);

    console.log(`${rows.length} stored, ${doomed.length} irrelevant, ${rows.length - doomed.length} kept.\n`);
    for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${source.padEnd(30)} ${count}`);
    }

    console.log('\nExamples of what would go:');
    for (const row of doomed.slice(0, 12)) console.log(`  ${row.title}`);

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to delete.');
      return;
    }

    /*
     * Deleted in chunks inside one transaction per chunk. Dependent rows go
     * through ON DELETE CASCADE; doing this as a single statement over
     * thousands of ids would hold locks far longer than a live worker's scan
     * can tolerate.
     */
    let deleted = 0;
    const CHUNK = 100;

    for (let index = 0; index < doomed.length; index += CHUNK) {
      const ids = doomed.slice(index, index + CHUNK).map((row) => `'${row.id}'`);
      await handle.db.execute(sql.raw(`delete from jobs where id in (${ids.join(',')})`));
      deleted += ids.length;
    }

    console.log(`\nDeleted ${deleted}. They will not come back: the gate now rejects them at ingestion.`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('[prune] failed:', error);
  process.exit(1);
});
