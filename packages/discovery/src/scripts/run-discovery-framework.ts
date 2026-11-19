/**
 * Discovery framework CLI: `pnpm discovery [--plan] [--capabilities] [--coverage] [--schedule]`
 *
 * Drives the framework against the real database: plan queries from the live
 * candidate preferences, record source capabilities, compute value scores,
 * decide cadence, and report coverage.
 *
 * Deliberately separate from `pnpm discover`, which *executes* sources. This
 * one decides what should be executed and reports on what was.
 */
import { AppConfigProvider, EnvSecretProvider, loadDotenv, loadEnv } from '@job-intel/config';
import { createLogger, EventRecorder } from '@job-intel/observability';
import {
  CandidateRepository,
  ConfigRepository,
  DiscoveryFrameworkRepository,
  EventRepository,
  ProfileRepository,
  SourceRepository,
  createDatabase,
  optionsFromEnv,
} from '@job-intel/db';
import { DomainRateLimiter, HttpClient, createDefaultRegistry } from '@job-intel/connectors';
import { DiscoveryFrameworkService } from '../discovery-framework-service';

function parseArgs(argv: string[]) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')).map((arg) => arg.slice(2)));
  const all = flags.size === 0;
  return {
    plan: all || flags.has('plan'),
    capabilities: all || flags.has('capabilities'),
    coverage: all || flags.has('coverage'),
    schedule: all || flags.has('schedule'),
  };
}

const rule = (title: string) => `\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`;

async function main() {
  loadDotenv();
  const env = loadEnv(process.env, { role: 'worker' });
  const args = parseArgs(process.argv.slice(2));

  const logger = createLogger({ level: 'error', pretty: false, base: { service: 'discovery-cli' } });
  const handle = await createDatabase(optionsFromEnv(env));

  try {
    const profiles = new ProfileRepository(handle.db);
    const profile = await profiles.getActiveProfile();
    if (!profile) {
      console.error('No active candidate profile. Create one first.');
      process.exitCode = 1;
      return;
    }

    const secrets = new EnvSecretProvider(env);
    void secrets;
    void new AppConfigProvider(new ConfigRepository(handle.db));

    const framework = new DiscoveryFrameworkRepository(handle.db);
    const service = new DiscoveryFrameworkService({
      framework,
      sources: new SourceRepository(handle.db),
      profiles,
      candidates: new CandidateRepository(handle.db),
      registry: createDefaultRegistry(),
      logger,
      events: new EventRecorder(logger, new EventRepository(handle.db)),
      http: new HttpClient({
        userAgent: env.CRAWLER_USER_AGENT,
        contactEmail: env.CRAWLER_CONTACT_EMAIL,
        timeoutMs: 20_000,
        rateLimiter: new DomainRateLimiter(),
      }),
    });

    console.log(`Profile ${profile.profileId} (v${profile.version})`);

    if (args.plan) {
      const plan = await service.planFor(profile.profileId);
      console.log(rule('QUERY PLAN'));
      console.log(`generated ${plan.queries.length}, dropped ${plan.droppedCount}`);
      for (const reason of plan.dropReasons.slice(0, 5)) console.log(`  dropped: ${reason}`);

      const byPriority = { HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<string, number>;
      for (const query of plan.queries) byPriority[query.priority] = (byPriority[query.priority] ?? 0) + 1;
      console.log(`HIGH ${byPriority.HIGH}  MEDIUM ${byPriority.MEDIUM}  LOW ${byPriority.LOW}`);

      console.log('\ntop queries:');
      for (const query of plan.queries.slice(0, 12)) {
        console.log(
          `  [${query.priority.padEnd(6)} ${String(query.score).padStart(3)}] ${query.text}`,
        );
        console.log(`             ${query.rationale}`);
      }
    }

    if (args.capabilities) {
      const updated = await service.refreshCapabilities();
      const scored = await service.refreshPerformance();
      console.log(rule('CAPABILITIES'));
      console.log(`recorded capabilities for ${updated} source(s), scored ${scored}`);

      for (const row of await framework.listCapabilities()) {
        console.log(
          `  ${row.sourceId.padEnd(28)} ${String(row.activeMethod).padEnd(16)} ${row.methods.join(' → ')}`,
        );
      }

      const performance = await framework.listPerformance();
      if (performance.length > 0) {
        console.log('\nsource value:');
        for (const row of performance.slice(0, 12)) {
          console.log(
            `  ${row.sourceId.padEnd(28)} ${String(Math.round(row.valueScore)).padStart(3)}/100  ${row.explanation}`,
          );
        }
      }
    }

    if (args.schedule) {
      console.log(rule('ADAPTIVE SCHEDULE'));
      for (const decision of await service.schedule()) {
        console.log(
          `  ${decision.sourceId.padEnd(28)} ${String(decision.intervalMinutes).padStart(5)}m` +
            `${decision.suppressed ? ' [suppressed]' : ''}  ${decision.reason}`,
        );
      }
    }

    if (args.coverage) {
      const report = await service.reportCoverage(profile.profileId, 24);
      console.log(rule('COVERAGE'));
      console.log(
        `searched ${Math.round(report.searchedShare * 100)}% of your preferences, ` +
          `${Math.round(report.productiveShare * 100)}% produced a job`,
      );
      console.log(
        `${report.queriesExecuted} query(ies) executed · ${report.sourcesSearched}/${report.sourcesAvailable} source(s) productive · ` +
          `${report.uniqueJobsDiscovered} job(s)`,
      );

      console.log('\nper preference:');
      for (const item of report.items) {
        console.log(
          `  ${item.dimension.padEnd(11)} ${item.value.padEnd(24)} planned ${String(item.queriesPlanned).padStart(3)}  ` +
            `run ${String(item.queriesExecuted).padStart(3)}  found ${String(item.jobsDiscovered).padStart(4)}`,
        );
      }

      if (report.gaps.length > 0) {
        console.log('\ngaps:');
        for (const gap of report.gaps.slice(0, 10)) {
          console.log(`  [${gap.severity.padEnd(6)}] ${gap.kind.padEnd(24)} ${gap.value}`);
          console.log(`             ${gap.detail}`);
        }
      }

      console.log(
        '\nThis is coverage of your stated search space, not of the web. The web is too large ' +
          'and too dynamic to search exhaustively.',
      );
    }

    console.log('');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('[discovery] failed:', error);
  process.exitCode = 1;
});
