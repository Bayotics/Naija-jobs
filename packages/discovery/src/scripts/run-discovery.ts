/**
 * Discovery CLI: `pnpm discover [sourceId ...] [--max N] [--health]`
 *
 * Runs the real pipeline against real sources. Exists so discovery can be
 * exercised and verified without the web app in the loop — which is also how
 * the runner gets tested against live data during development.
 */
import { EnvSecretProvider, loadDotenv, loadEnv } from '@job-intel/config';
import { createLogger, EventRecorder } from '@job-intel/observability';
import {
  DiscoveryRepository,
  EventRepository,
  OpsRepository,
  SourceRepository,
  createDatabase,
  optionsFromEnv,
} from '@job-intel/db';
import { DomainRateLimiter, HttpClient, createDefaultRegistry } from '@job-intel/connectors';
import { SourceRunner } from '../source-runner';
import { SourceHealthService } from '../source-health';
import { EnrichmentRunner } from '../enrichment-runner';
import { EnrichmentRepository } from '@job-intel/db';
import { ENRICHMENT_VERSION } from '@job-intel/enrichment';

function parseArgs(argv: string[]) {
  const sourceIds: string[] = [];
  let maxItems: number | undefined;
  let health = false;
  let all = false;
  let enableAll = false;
  let enrich = false;
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max') {
      maxItems = Number(argv[++i]);
    } else if (arg === '--health') {
      health = true;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--enable-all') {
      enableAll = true;
    } else if (arg === '--enrich') {
      enrich = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg && !arg.startsWith('--')) {
      sourceIds.push(arg);
    }
  }
  return { sourceIds, maxItems, health, all, enableAll, enrich, force };
}

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv(process.env, { role: 'worker' });
  const args = parseArgs(process.argv.slice(2));

  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY,
    base: { service: 'discovery-cli' },
  });

  const handle = await createDatabase(optionsFromEnv(env));
  try {
    const sources = new SourceRepository(handle.db);
    const discovery = new DiscoveryRepository(handle.db);
    const events = new EventRecorder(logger, new EventRepository(handle.db));
    const secrets = new EnvSecretProvider();
    const rateLimiter = new DomainRateLimiter();
    const registry = createDefaultRegistry();

    if (args.enableAll) {
      // Development convenience: enable everything except `restricted`, which
      // must stay off — that tier is never fetched by policy.
      const all = await sources.list({ includeArchived: false });
      const enabled: string[] = [];
      for (const source of all) {
        if (source.accessTier === 'restricted' || source.enabled) continue;
        await sources.update(source.id, { enabled: true });
        enabled.push(source.id);
      }
      console.log(`[discover] enabled: ${enabled.join(', ') || '(none to change)'}`);
      return;
    }

    if (args.enrich) {
      const repo = new EnrichmentRepository(handle.db);
      const runner = new EnrichmentRunner({
        enrichment: repo,
        logger,
        events,
        ops: new OpsRepository(handle.db),
      });
      const before = await repo.stats(ENRICHMENT_VERSION);
      const result = await runner.run({
        limit: args.maxItems ?? 500,
        force: args.force,
      });
      const after = await repo.stats(ENRICHMENT_VERSION);

      console.log('\n=== ENRICHMENT ===');
      console.log(
        `processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed} ` +
          `aiCalls=${result.aiCalls} aiFailures=${result.aiFailures}`,
      );
      console.log(
        `avgDurationMs=${result.averageDurationMs} totalMs=${result.totalDurationMs}`,
      );
      console.log(`enriched: ${before.enriched} -> ${after.enriched} of ${after.jobs} jobs`);
      console.log(`avgQuality=${after.avgQuality} flaggedScam=${after.flaggedScam}`);
      for (const f of result.failures.slice(0, 5)) {
        console.log(`  FAIL ${f.jobId}: ${f.error}`);
      }
      return;
    }

    if (args.health) {
      const service = new SourceHealthService({ sources, discovery });
      const reports = await service.report();
      console.log('\n=== SOURCE HEALTH ===');
      for (const r of reports) {
        console.log(
          `${r.sourceId.padEnd(28)} ${r.status.padEnd(9)} ` +
            `enabled=${String(r.enabled).padEnd(5)} runs=${String(r.runsInWindow).padEnd(3)} ` +
            `discovered=${String(r.jobsDiscoveredInWindow).padEnd(5)} ` +
            `persisted=${String(r.jobsPersistedRecently).padEnd(5)} ` +
            `avg=${r.averageDurationMs ?? '-'}ms` +
            (r.yieldWarning ? '  ⚠ YIELD' : ''),
        );
        for (const note of r.notes) console.log(`${' '.repeat(30)}· ${note}`);
      }
      return;
    }

    const runner = new SourceRunner({
      registry,
      sources,
      discovery,
      logger,
      events,
      ops: new OpsRepository(handle.db),
      getSecret: (name) => secrets.get(name),
      createHttpClient: (source) =>
        new HttpClient({
          userAgent: env.CRAWLER_USER_AGENT,
          contactEmail: env.CRAWLER_CONTACT_EMAIL,
          timeoutMs: source.limits.timeoutMs,
          rateLimiter,
        }),
    });

    const options = {
      trigger: 'manual' as const,
      ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {}),
    };

    /*
     * A manual run from the CLI is a manual run, and the control centre must
     * see it as one. Without this record the console would report "no pipeline
     * run recorded yet" while discovery was demonstrably writing jobs — the
     * exact kind of gap that teaches an operator to distrust the dashboard.
     */
    const ops = new OpsRepository(handle.db);
    const runId = await ops.startRun({
      trigger: 'MANUAL',
      triggeredBy: 'cli',
      note: args.all ? 'discover --all' : `discover ${args.sourceIds.join(' ')}`,
    });
    await ops.appendTimeline(runId, [
      {
        at: new Date(),
        stage: 'discovery',
        event: 'Run started',
        detail: `Triggered from the discovery CLI${args.maxItems ? `, max ${args.maxItems} per source` : ''}`,
        severity: 'info',
      },
    ]);

    const results =
      args.all || args.sourceIds.length === 0
        ? await runner.runAll(options)
        : await runner.runMany(args.sourceIds, options);

    console.log('\n=== DISCOVERY RESULTS ===');
    const totals = { discovered: 0, created: 0, updated: 0, duplicates: 0, rejected: 0, errors: 0 };

    for (const r of results) {
      console.log(
        `${r.sourceId.padEnd(28)} ${r.status.padEnd(8)} ` +
          `discovered=${String(r.stats.jobsDiscovered).padEnd(5)} ` +
          `new=${String(r.stats.jobsAccepted).padEnd(5)} ` +
          `updated=${String(r.stats.jobsUpdated).padEnd(4)} ` +
          `dupes=${String(r.stats.jobsDuplicated).padEnd(5)} ` +
          `rejected=${String(r.stats.jobsRejected).padEnd(4)} ` +
          `${r.durationMs}ms`,
      );
      if (r.skippedReason) console.log(`${' '.repeat(30)}skipped: ${r.skippedReason}`);
      for (const e of r.errors.slice(0, 3)) {
        console.log(`${' '.repeat(30)}error [${e.type}] ${e.message.slice(0, 140)}`);
      }

      totals.discovered += r.stats.jobsDiscovered;
      totals.created += r.stats.jobsAccepted;
      totals.updated += r.stats.jobsUpdated;
      totals.duplicates += r.stats.jobsDuplicated;
      totals.rejected += r.stats.jobsRejected;
      totals.errors += r.stats.errorCount;
    }

    await ops.appendTimeline(
      runId,
      results.map((result) => ({
        at: new Date(),
        stage: 'discovery' as const,
        event: `${result.sourceId} ${result.status}`,
        detail:
          `discovered ${result.stats.jobsDiscovered}, new ${result.stats.jobsAccepted}, ` +
          `duplicates ${result.stats.jobsDuplicated} in ${result.durationMs}ms`,
        severity:
          result.status === 'failed'
            ? ('error' as const)
            : result.stats.errorCount > 0
              ? ('warning' as const)
              : ('info' as const),
      })),
    );

    // A manual trigger is an operator action and is attributable as one, whether
    // it came from the console or from a terminal.
    await ops.recordAudit({
      action: 'pipeline.run_triggered',
      actor: 'cli',
      target: runId,
      after: { sources: results.map((result) => result.sourceId), discovered: totals.discovered },
      reason: args.all ? 'discover --all' : `discover ${args.sourceIds.join(' ')}`,
    });

    await ops.completeRun(runId, {
      // `partial` when some sources failed but others produced work — the run
      // did something, and calling it a failure would hide that.
      status: results.every((result) => result.status === 'failed')
        ? 'failed'
        : results.some((result) => result.status === 'failed' || result.stats.errorCount > 0)
          ? 'partial'
          : 'success',
      counters: {
        jobsDiscovered: totals.discovered,
        jobsProcessed: totals.created + totals.updated + totals.duplicates,
        duplicatesDetected: totals.duplicates,
        errorCount: totals.errors,
      },
    });

    console.log(
      `\nTOTAL discovered=${totals.discovered} new=${totals.created} updated=${totals.updated} ` +
        `duplicates=${totals.duplicates} rejected=${totals.rejected} errors=${totals.errors}`,
    );
    console.log(`run recorded: ${runId}`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('[discover] failed:', error);
  process.exit(1);
});
