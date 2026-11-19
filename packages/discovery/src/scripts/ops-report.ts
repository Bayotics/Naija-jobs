/**
 * Operations CLI: `pnpm ops [--window 24] [--dry-run]`
 *
 * Prints exactly what the control centre renders, from the same service the web
 * app uses. Exists so the dashboard can be verified against a real database
 * without a browser in the loop — if this and the screen ever disagree, one of
 * them is reading something it should not be.
 */
import { EnvSecretProvider, loadDotenv, loadEnv, AppConfigProvider } from '@job-intel/config';
import { createLogger, EventRecorder } from '@job-intel/observability';
import {
  ConfigRepository,
  EventRepository,
  OpsRepository,
  ProfileRepository,
  RecommendationRepository,
  SourceRepository,
  checkDatabaseHealth,
  createDatabase,
  optionsFromEnv,
} from '@job-intel/db';
import { createQueueDriver } from '@job-intel/queue';
import { biggestDrop, concerningMetrics } from '@job-intel/ops';
import { OpsService } from '../ops-service';

function parseArgs(argv: string[]) {
  let windowHours = 24;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--window') windowHours = Number(argv[++i]) || 24;
    else if (argv[i] === '--dry-run') dryRun = true;
  }
  return { windowHours, dryRun };
}

const pad = (label: string, width = 26) => label.padEnd(width);
const rule = (title: string) => `\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`;

async function main() {
  loadDotenv();
  const env = loadEnv(process.env, { role: 'worker' });
  const { windowHours, dryRun } = parseArgs(process.argv.slice(2));

  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY,
    base: { service: 'ops-cli' },
  });
  const handle = await createDatabase(optionsFromEnv(env));
  const secrets = new EnvSecretProvider(env);
  void secrets;

  const ops = new OpsRepository(handle.db);
  const config = await new AppConfigProvider(new ConfigRepository(handle.db)).get();

  const service = new OpsService({
    ops,
    sources: new SourceRepository(handle.db),
    profiles: new ProfileRepository(handle.db),
    recommendations: new RecommendationRepository(handle.db),
    queue: createQueueDriver(env),
    logger,
    events: new EventRecorder(logger, new EventRepository(handle.db)),
    checkDatabase: () => checkDatabaseHealth(handle.db),
    aiEnabled: config.ai.enabled,
    aiModel: config.ai.triageModel,
    dailyBudgetUsd: config.ai.dailyBudgetUsd,
  });

  // ── System status ─────────────────────────────────────────────────────────
  const overview = await service.overview();
  console.log(rule('SYSTEM STATUS'));
  console.log(`${pad('overall')} ${overview.health.status} — ${overview.health.summary}`);
  for (const component of overview.health.components) {
    console.log(`${pad(`  ${component.component}`)} ${component.status.padEnd(9)} ${component.detail}`);
  }

  // ── Pipeline ──────────────────────────────────────────────────────────────
  console.log(rule('JOB PIPELINE'));
  for (const [key, value] of Object.entries(overview.pipeline)) {
    console.log(`${pad(`  ${key}`)} ${value}`);
  }

  console.log(rule('PIPELINE STAGES'));
  for (const stage of await service.pipelineStages()) {
    console.log(
      `${pad(`  ${stage.stage}`)} ${stage.status.padEnd(9)} processed=${stage.processed} failed=${stage.failed} waiting=${stage.waiting}`,
    );
  }

  // ── Recommendations and notifications ─────────────────────────────────────
  console.log(rule('RECOMMENDATIONS'));
  for (const [key, value] of Object.entries(overview.recommendations)) {
    console.log(`${pad(`  ${key}`)} ${value}`);
  }

  // ── Sources ───────────────────────────────────────────────────────────────
  console.log(rule('SOURCE HEALTH'));
  const scores = await service.sourceHealthScores();
  if (scores.length === 0) console.log('  no sources registered');
  for (const score of scores) {
    console.log(
      `${pad(`  ${score.sourceId}`)} ${score.status.padEnd(9)} ${String(score.score).padStart(3)}/100` +
        (score.anomalies.length > 0 ? `  ⚠ ${score.anomalies[0]}` : ''),
    );
  }

  // ── Funnel ────────────────────────────────────────────────────────────────
  const funnel = await service.funnel(windowHours);
  console.log(rule(`FUNNEL (last ${windowHours}h)`));
  for (const step of funnel.steps) {
    const retention = step.retention === null ? '' : ` (${Math.round(step.retention * 100)}%)`;
    console.log(`${pad(`  ${step.label}`)} ${String(step.count).padStart(6)}${retention}`);
  }
  const drop = biggestDrop(funnel);
  if (drop) {
    console.log(`  biggest processing drop: ${drop.step.label} lost ${(drop.lost * 100).toFixed(0)}%`);
  }

  // ── Queues ────────────────────────────────────────────────────────────────
  console.log(rule('QUEUES'));
  const counts = await service.queueCounts();
  if (counts.size === 0) console.log('  queue driver unreachable');
  for (const [name, value] of counts) {
    if (value.waiting + value.active + value.failed + value.delayed === 0) continue;
    console.log(
      `${pad(`  ${name}`)} waiting=${value.waiting} active=${value.active} failed=${value.failed} delayed=${value.delayed}`,
    );
  }
  const failed = await service.failedJobs(5);
  console.log(`${pad('  dead-letter')} ${failed.length}`);
  for (const job of failed) console.log(`    ${job.queue}: ${job.failedReason.slice(0, 100)}`);

  // ── Metrics ───────────────────────────────────────────────────────────────
  console.log(rule('LATENCY'));
  const latencies = await service.latencies(windowHours);
  if (latencies.length === 0) console.log('  no samples recorded');
  for (const latency of latencies) {
    console.log(
      `${pad(`  ${latency.operation}`)} n=${String(latency.count).padStart(5)} p50=${Math.round(latency.p50)}ms p95=${Math.round(latency.p95)}ms p99=${Math.round(latency.p99)}ms`,
    );
  }

  console.log(rule('AI USAGE'));
  const cost = await service.aiCost(windowHours);
  console.log(`${pad('  calls')} ${cost.totalCalls}`);
  console.log(`${pad('  input tokens')} ${cost.totalInputTokens}`);
  console.log(`${pad('  output tokens')} ${cost.totalOutputTokens}`);
  console.log(`${pad('  cost')} $${cost.totalCostUsd.toFixed(4)}`);
  console.log(`${pad('  daily budget')} ${cost.dailyBudgetUsd === null ? 'none' : `$${cost.dailyBudgetUsd}`}`);
  const unpriced = await ops.unpricedModels();
  if (unpriced.length > 0) console.log(`  ⚠ unpriced models: ${unpriced.join(', ')}`);

  console.log(rule('DATA QUALITY'));
  const quality = await service.dataQuality();
  for (const metric of quality) {
    console.log(
      `${pad(`  ${metric.label}`)} ${String(metric.count).padStart(6)}/${metric.total} (${(metric.share * 100).toFixed(1)}%)`,
    );
  }
  const concerns = concerningMetrics(quality);
  if (concerns.length > 0) {
    console.log(`  ⚠ past threshold: ${concerns.map((metric) => metric.label).join(', ')}`);
  }

  console.log(rule('RATE LIMITS'));
  const limits = await ops.rateLimitSummaries(windowHours);
  if (limits.length === 0) console.log('  no HTTP activity recorded');
  for (const limit of limits) {
    console.log(
      `${pad(`  ${limit.sourceId}`)} requests=${limit.requests} ok=${limit.succeeded} failed=${limit.failed} limited=${limit.rateLimited}`,
    );
  }

  // ── Runs and audit ────────────────────────────────────────────────────────
  console.log(rule('RUN HISTORY'));
  const runs = await ops.listRuns({ limit: 5 });
  if (runs.length === 0) console.log('  no pipeline run recorded');
  for (const run of runs) {
    console.log(
      `  ${run.startedAt.toISOString().slice(0, 19).replace('T', ' ')} ${run.trigger.padEnd(9)} ${run.status.padEnd(8)} ` +
        `discovered=${run.jobsDiscovered} matched=${run.jobsMatched} recommended=${run.jobsRecommended}` +
        (run.dryRun ? '  [dry run]' : ''),
    );
  }

  console.log(rule('AUDIT LOG'));
  const audit = await ops.listAudit({ limit: 8 });
  if (audit.length === 0) console.log('  nothing recorded');
  for (const entry of audit) {
    console.log(
      `  ${entry.occurredAt.toISOString().slice(0, 19).replace('T', ' ')} ${entry.action.padEnd(26)} ${entry.actor}` +
        (entry.reason ? ` — ${entry.reason}` : ''),
    );
  }

  console.log(rule('RECENT ERRORS'));
  const errors = await ops.queryEvents({ severity: ['error'], sinceHours: windowHours, limit: 10 });
  if (errors.length === 0) console.log('  none');
  for (const error of errors) {
    console.log(
      `  ${error.createdAt.toISOString().slice(11, 19)} ${error.name} — ${(error.message ?? '').slice(0, 120)}`,
    );
  }

  // ── Optional dry run ──────────────────────────────────────────────────────
  if (dryRun) {
    console.log(rule('DRY RUN'));
    const report = await service.dryRun({ triggeredBy: 'cli', reason: 'ops report' });
    console.log(`${pad('  would enrich')} ${report.wouldEnrich}`);
    console.log(`${pad('  would match')} ${report.wouldMatch}`);
    console.log(`${pad('  would recommend')} ${report.wouldRecommend}`);
    console.log(`${pad('  would notify')} ${report.wouldShortlist}`);
    console.log(`${pad('  suppressed')} ${report.suppressed.length}`);
    for (const skipped of report.skippedWrites) console.log(`    skipped: ${skipped}`);
  }

  console.log('');
  await handle.close();
}

main().catch((error: unknown) => {
  console.error('[ops] failed:', error);
  process.exitCode = 1;
});
