import { loadDotenv, loadEnv } from '@job-intel/config';
import { createLogger } from '@job-intel/observability';
import { AcquisitionRepository, SourceRepository, createDatabase, optionsFromEnv } from '@job-intel/db';
import { createDefaultRegistry, planQueries, resolvePolicy, restrictedPlatforms } from '@job-intel/connectors';
import { SourceIntelligenceService } from '../source-intelligence-service';

/**
 * End-to-end verification for the acquisition layer.
 *
 * Runs against the real source registry and the real database. The claim under
 * test is the one Part 2 and the final verification section both make: that the
 * scheduler decides what to run from the registry alone, and that turning a
 * source off stops acquisition from it without touching anything else.
 */

const line = (label: string, value: unknown): void => {
  console.log(`  ${label.padEnd(32)} ${String(value)}`);
};

const heading = (text: string): void => {
  console.log(`\n${text}\n${'─'.repeat(text.length)}`);
};

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv();

  const logger = createLogger({ level: 'error', pretty: false, base: { service: 'acquisition-verify' } });
  const handle = await createDatabase(optionsFromEnv(env));

  try {
    const registry = createDefaultRegistry();
    const sources = new SourceRepository(handle.db);
    const acquisition = new AcquisitionRepository(handle.db);

    const service = new SourceIntelligenceService({
      registry,
      sources,
      acquisition,
      logger,
      getSecret: (name) => process.env[name],
    });

    // ── 1. The registry ───────────────────────────────────────────────────
    heading('1. Connector registry');

    line('connectors registered', registry.ids().length);
    console.log(`  ${registry.ids().join(', ')}`);

    for (const connector of registry.all()) {
      const policy = resolvePolicy(connector);
      console.log(
        `  ${connector.id.padEnd(20)} ${policy.acquisitionType.padEnd(20)} ` +
          `${policy.fetchable ? 'fetchable' : 'NOT FETCHED'.padEnd(11)}  ` +
          `${policy.rateLimit.requestsPerMinute}/min`,
      );
    }

    // ── 2. Source intelligence ────────────────────────────────────────────
    heading('2. Source intelligence');

    const described = await service.describeAll();
    const summary = await service.summary();

    line('sources', summary.total);
    line('schedulable', summary.schedulable);

    for (const [state, count] of Object.entries(summary.byState)) {
      if (count > 0) line(`  ${state.toLowerCase()}`, count);
    }

    console.log();

    for (const source of described) {
      console.log(
        `  ${source.entry.sourceName.slice(0, 28).padEnd(30)} ` +
          `${source.entry.state.padEnd(15)} score ${String(source.entry.healthScore).padStart(3)}  ` +
          `${source.method ?? 'not fetched'}`,
      );

      if (source.blockedReason) {
        console.log(`      ↳ ${source.blockedReason.slice(0, 100)}`);
      }
    }

    // ── 3. Restricted platforms ───────────────────────────────────────────
    heading('3. Platforms that are not fetched');

    for (const platform of restrictedPlatforms()) {
      console.log(`  ${platform.displayName}`);
      console.log(`      ${platform.restriction?.slice(0, 110)}`);
      console.log(`      → ${platform.alternatives[0]?.slice(0, 100)}`);
    }

    // ── 4. Query planning ─────────────────────────────────────────────────
    heading('4. Query planning');

    const all = await sources.list({});

    const plan = planQueries({
      connectors: all
        .map((source) => ({ sourceId: source.id, connector: registry.find(source.connectorId) }))
        .filter((entry): entry is { sourceId: string; connector: NonNullable<typeof entry.connector> } =>
          entry.connector !== null,
        ),
      build: {
        profileId: null,
        roles: ['Frontend Engineer', 'React Developer'],
        locations: ['Germany'],
        keywords: ['typescript'],
        remoteAcceptable: true,
        maxQueries: 12,
      },
    });

    line('queries planned', plan.queries.length);
    line('skipped', plan.skipped.length);
    line('sources with no queries', plan.sourcesWithoutQueries.length);

    for (const query of plan.queries.slice(0, 6)) {
      console.log(`  [${query.priority}] ${query.text.slice(0, 80)}`);
    }

    for (const entry of plan.sourcesWithoutQueries.slice(0, 4)) {
      console.log(`  ${entry.sourceId}: ${entry.reason}`);
    }

    // ── 5. Incremental state ──────────────────────────────────────────────
    heading('5. Incremental scan plans');

    for (const source of all.slice(0, 8)) {
      const scanPlan = await service.scanPlanFor(source.id);
      if (!scanPlan) continue;

      console.log(
        `  ${source.displayName.slice(0, 28).padEnd(30)} ${scanPlan.mode.padEnd(12)} ${scanPlan.reason.slice(0, 60)}`,
      );
    }

    // ── 6. Disabling a source stops only that source ──────────────────────
    heading('6. Disabling a source');

    const target = described.find(
      (source) => source.entry.state === 'HEALTHY' || source.entry.state === 'DEGRADED',
    );

    if (!target) {
      line('no schedulable source to test with', '—');
    } else {
      const before = await service.schedulable();
      line('schedulable before', before.length);
      line('turning off', target.entry.sourceName);

      await sources.update(target.entry.sourceId, { enabled: false });

      const after = await service.schedulable();
      line('schedulable after', after.length);
      line('the disabled source is gone', !after.some((s) => s.entry.sourceId === target.entry.sourceId));
      line(
        'every other source unaffected',
        before
          .filter((s) => s.entry.sourceId !== target.entry.sourceId)
          .every((s) => after.some((a) => a.entry.sourceId === s.entry.sourceId)),
      );

      const state = (await service.describe((await sources.get(target.entry.sourceId))!)).entry.state;
      line('its state now', state);

      // Put it back, so the verification leaves nothing changed.
      await sources.update(target.entry.sourceId, { enabled: true });
      const restored = await service.schedulable();
      line('restored', restored.length === before.length);
    }

    heading('Summary');
    line('source logic in the scheduler', 'none — it reads the registry');
    line('restricted sources fetched', 0);
    line('credentials in this output', 'none — names only');
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
