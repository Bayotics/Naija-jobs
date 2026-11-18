/**
 * The retention purge, as a command.
 *
 * `pnpm purge:jobs [--days N] [--dry-run]`
 *
 * The worker runs this on a weekly schedule. It exists as a command as well
 * because the thing that deletes half the corpus should be inspectable before
 * it runs and re-runnable afterwards, without redeploying a worker — and
 * because a scheduled workflow needs something to call.
 *
 * `--dry-run` reports exactly what would go and deletes nothing.
 */
import { loadDotenv, loadEnv, AppConfigProvider } from '@job-intel/config';
import { ConfigRepository, JobRepository, createDatabase, optionsFromEnv } from '@job-intel/db';

loadDotenv();

function parseArgs(argv: string[]): { days: number | null; dryRun: boolean } {
  let days: number | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) days = Math.floor(value);
      i += 1;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    }
  }

  return { days, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv(process.env, { role: 'worker' });
  const handle = await createDatabase(optionsFromEnv(env));

  try {
    const config = await new AppConfigProvider(new ConfigRepository(handle.db)).get();
    const days = args.days ?? config.retention.jobDays;
    const jobs = new JobRepository(handle.db);

    const before = await jobs.countsByStatus();
    const total = Object.values(before).reduce((sum, n) => sum + n, 0);

    if (args.dryRun) {
      // `countExpired`, not `purgeExpired` with a flag: the code that deletes
      // has no mode in which it does not delete.
      const preview = await jobs.countExpired({ days });
      console.log(
        `DRY RUN — would delete ${preview.wouldDelete} of ${total} jobs older than ${days} days, ` +
          `keeping ${preview.wouldKeep} you saved or applied to.`,
      );
      console.log('Nothing was deleted. Re-run without --dry-run to apply.');
      return;
    }

    const result = await jobs.purgeExpired({ days });

    console.log(`Purged ${result.deleted} of ${total} jobs older than ${days} days.`);
    console.log(`Kept ${result.keptBecauseActedOn} outside the window: saved or applied to.`);
    console.log(`${total - result.deleted} remain.`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
