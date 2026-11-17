import {
  AcquisitionRepository,
  DiscoveryRepository,
  JobRepository,
  SourceRepository,
  type Database,
} from '@job-intel/db';
import { DomainRateLimiter, HttpClient, createDefaultRegistry } from '@job-intel/connectors';
import { SourceRunner } from '@job-intel/discovery';
import type { EventRecorder, Logger } from '@job-intel/observability';
import {
  CoordinationService,
  DeadLetterQueue,
  ReconciliationService,
  Scheduler,
  SystemHealthService,
  TaskQueue,
  Worker,
  WorkerRegistry,
  type DesiredProfileState,
} from '@job-intel/scheduler';
import { RelevanceProvider, reconcileConfiguration } from './configuration-bridge';
import {
  runEnrichment,
  runMatching,
  runRecommendation,
  type StageDependencies,
} from './pipeline-stages';

/**
 * The execution engine, running inside the worker process.
 *
 * Deliberately one process rather than several. The scheduler tick is a few
 * queries a minute and the maintenance sweeps are cheaper still; splitting them
 * into their own deployables would triple the operational surface to save
 * nothing. Leadership is already handled by a lease, so running the scheduler
 * in every worker is safe — exactly one of them will be doing the work.
 *
 * The horizontal scaling path needs no code change: run more copies of this
 * process. They contend for the scheduler lease, claim from the same queue, and
 * one of them wins each piece of work.
 */

export interface EngineOptions {
  db: Database;
  logger: Logger;
  instanceId: string;
  /** Recorder for system events. Required for the runner's audit trail. */
  events: EventRecorder;
  userAgent?: string;
  contactEmail?: string;
  /** How often the scheduler looks for due work. */
  tickIntervalMs?: number;
  /** How often leases, stale workers and old rows are swept. */
  maintenanceIntervalMs?: number;
  /**
   * How often the user's configuration is re-derived into schedules. Frequent
   * enough that a change in the Control Center takes effect while the user is
   * still looking at the page.
   */
  reconcileIntervalMs?: number;
  concurrency?: number;
  version?: string;
  /**
   * Everything the downstream stages need. Supplied by the entrypoint rather
   * than built here so the engine stays constructible in a test without an
   * email provider or a config store.
   */
  stages: Omit<StageDependencies, 'db' | 'logger'>;
}

export interface ExecutionEngine {
  queue: TaskQueue;
  scheduler: Scheduler;
  worker: Worker;
  health: SystemHealthService;
  reconciler: ReconciliationService;
  deadLetters: DeadLetterQueue;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createExecutionEngine(options: EngineOptions): ExecutionEngine {
  const { db, logger, instanceId } = options;
  const rateLimiter = new DomainRateLimiter();

  const queue = new TaskQueue(db);
  const coordination = new CoordinationService(db);
  const deadLetters = new DeadLetterQueue(db);
  const registry = new WorkerRegistry(db);

  const scheduler = new Scheduler({ db, queue, coordination, logger, instanceId });
  const reconciler = new ReconciliationService({ scheduler, queue, logger });

  const health = new SystemHealthService({
    queue,
    deadLetters,
    workers: registry,
    scheduler,
    logger,
    probes: [
      {
        component: 'database',
        check: async () => {
          await db.execute('select 1');
          return { status: 'healthy' as const, detail: 'Database reachable.' };
        },
      },
    ],
  });

  const worker = new Worker(
    { db, queue, logger },
    {
      workerId: `${instanceId}-worker`,
      concurrency: options.concurrency ?? 4,
      version: options.version ?? '1.0.0',
    },
  );

  /*
   * One runner, one registry, one rate limiter for the life of the process.
   * Rebuilding them per task would reset the politeness state the limiter
   * exists to hold.
   */
  const runner = new SourceRunner({
    registry: createDefaultRegistry(),
    sources: new SourceRepository(db),
    discovery: new DiscoveryRepository(db),
    logger,
    events: options.events,
    getSecret: (name) => process.env[name],
    createHttpClient: (source) =>
      new HttpClient({
        userAgent: options.userAgent ?? 'JobIntelBot/1.0',
        ...(options.contactEmail ? { contactEmail: options.contactEmail } : {}),
        timeoutMs: source.limits.timeoutMs,
        rateLimiter,
      }),
    acquisition: new AcquisitionRepository(db),
  });

  /*
   * One provider for the process, so the vocabulary is built once a minute
   * rather than once per source scan.
   */
  const relevance = new RelevanceProvider(db, logger);

  const stages: StageDependencies = { db, logger, ...options.stages };

  registerHandlers(worker, {
    db,
    logger,
    queue,
    scheduler,
    reconciler,
    runner,
    relevance,
    stages,
  });

  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  /** Zero so the first leader tick reconciles immediately. */
  let lastReconcileAt = 0;

  return {
    queue,
    scheduler,
    worker,
    health,
    reconciler,
    deadLetters,

    async start() {
      await worker.start();

      /*
       * The tick is frequent and cheap. Idempotency keys mean a tick that fires
       * while another is still running cannot create duplicate work, so there is
       * no need for the interval to be conservative.
       */
      tickTimer = setInterval(() => {
        void scheduler
          .tick()
          .then(async (result) => {
            if (result.isLeader && result.enqueued > 0) {
              logger.info('Scheduler tick', {
                enqueued: result.enqueued,
                duplicates: result.duplicates,
                skippedMisfires: result.skippedMisfires,
              });
            }

            /*
             * Reconciliation rides the tick rather than owning a timer.
             *
             * The tick has already established leadership, and reconciliation
             * must run under the same lease — two instances deriving schedules
             * at once would race on the same rows. Attaching it here means
             * leadership is proven rather than checked again and hoped for.
             *
             * The first leader tick after boot always reconciles, because
             * `lastReconcileAt` starts at zero. That is what makes a fresh
             * install come alive on its own instead of waiting for an event
             * nothing emits.
             */
            if (!result.isLeader) return;

            const dueAt = lastReconcileAt + (options.reconcileIntervalMs ?? 300_000);
            if (Date.now() < dueAt) return;

            lastReconcileAt = Date.now();
            await reconcileConfiguration({ db, logger, reconciler, scheduler });
          })
          .catch((error: unknown) => logger.warn('Scheduler tick failed', { err: error }));
      }, options.tickIntervalMs ?? 30_000);
      tickTimer.unref?.();

      /*
       * Maintenance recovers what crashed and removes what is finished. Run
       * under the same leadership lease as the scheduler so several instances
       * do not each sweep the same rows.
       */
      maintenanceTimer = setInterval(() => {
        void (async () => {
          try {
            const leader = await coordination.holdsLease('scheduler', instanceId);
            if (!leader) return;

            const [reaped, stale] = await Promise.all([
              queue.reapExpiredLeases(),
              registry.markStaleUnhealthy(),
            ]);

            await queue.purgeCompleted(24);
            await registry.purgeStopped(24);

            if (reaped > 0 || stale > 0) {
              logger.info('Maintenance sweep', { reclaimedTasks: reaped, staleWorkers: stale });
            }
          } catch (error) {
            logger.warn('Maintenance sweep failed', { err: error });
          }
        })();
      }, options.maintenanceIntervalMs ?? 60_000);
      maintenanceTimer.unref?.();

      logger.info('Execution engine started', { instanceId });
    },

    async stop() {
      if (tickTimer) clearInterval(tickTimer);
      if (maintenanceTimer) clearInterval(maintenanceTimer);

      await worker.stop();

      /*
       * Leadership is released explicitly so a successor takes over in
       * milliseconds rather than waiting out the remaining lease.
       */
      await coordination.releaseLease('scheduler', instanceId).catch(() => undefined);

      logger.info('Execution engine stopped', { instanceId });
    },
  };
}

/**
 * Task handlers.
 *
 * Every handler must be idempotent — execution is at-least-once, so any of
 * these can run twice for one logical unit of work. Where a handler delegates
 * to an existing service, that service already upserts on a natural key, which
 * is what makes the guarantee hold rather than a promise that it does.
 *
 * The pipeline stages that already run through BullMQ are not duplicated here.
 * This engine owns *scheduling* — deciding what is due and making sure it
 * happens — and hands the actual stage work to the services that own it.
 */
function registerHandlers(
  worker: Worker,
  deps: {
    db: Database;
    logger: Logger;
    queue: TaskQueue;
    scheduler: Scheduler;
    reconciler: ReconciliationService;
    runner: SourceRunner;
    relevance: RelevanceProvider;
    stages: StageDependencies;
  },
): void {
  worker.register('SOURCE_HEALTH_CHECK', async (task, ctx) => {
    const sources = new SourceRepository(deps.db);
    const sourceId = task.sourceId ?? (task.payload['sourceId'] as string | undefined);

    if (!sourceId) return;

    const source = await sources.get(sourceId);
    ctx.logger.debug('Source health check', { sourceId, found: source !== null });
  });

  worker.register('CONFIGURATION_RECONCILIATION', async (task, ctx) => {
    const desired = task.payload['desired'] as DesiredProfileState | undefined;

    if (!desired) {
      ctx.logger.debug('Reconciliation task carried no desired state', { taskId: task.taskId });
      return;
    }

    await deps.reconciler.reconcileSearchProfile(desired);
  });


  /*
   * The four stages between a stored posting and an email.
   *
   * Each drains its own backlog and each is separately scheduled, so a stage
   * that fails leaves the others running — the next cycle simply has more to
   * do. Registered here rather than chained to discovery because a chain makes
   * every stage's health depend on the one before it, and a missed link stops
   * the pipeline silently, which is exactly how this system came to sit idle.
   */
  worker.register('ENRICH_JOB', async (_task, ctx) => {
    const result = await runEnrichment(deps.stages);
    if (result.processed > 0) ctx.logger.info('Enrichment pass complete', result.detail);
  });

  worker.register('MATCH_JOB', async (_task, ctx) => {
    const result = await runMatching(deps.stages);
    if (result.processed > 0) ctx.logger.info('Match pass complete', result.detail);
  });

  worker.register('RANK_JOBS', async (_task, ctx) => {
    /*
     * The last stage in the pipeline, and the one the dashboard reads.
     *
     * This used to rank and then decide what to email. There is no email now:
     * the ranking *is* the delivery, so the pass ends here and the ordered
     * list the candidate opens is its only output.
     */
    const ranked = await runRecommendation(deps.stages);

    if (ranked.processed > 0) ctx.logger.info('Ranking pass complete', ranked.detail);
  });

  worker.register('CLEANUP', async (_task, ctx) => {
    const purgedTasks = await deps.queue.purgeCompleted(24);

    /*
     * The weekly purge.
     *
     * A corpus that only grows becomes an archive: a posting older than a
     * week has been applied to or passed over, and either way it is noise on
     * a page whose job is to show what to do today.
     *
     * Jobs the candidate saved or applied to are kept regardless of age —
     * every table referencing a job cascades on delete, so purging one of
     * those would take its application record with it.
     */
    const config = await deps.stages.config();
    const jobs = await new JobRepository(deps.db).purgeExpired({
      days: config.retention.jobDays,
    });

    ctx.logger.info('Cleanup complete', {
      purgedTasks,
      jobsDeleted: jobs.deleted,
      jobsKeptBecauseActedOn: jobs.keptBecauseActedOn,
      olderThanDays: config.retention.jobDays,
    });
  });

  worker.register('UPDATE_ANALYTICS', async (task, ctx) => {
    const acquisition = new AcquisitionRepository(deps.db);

    if (task.sourceId) {
      await acquisition.reliabilityFor(task.sourceId, 24);
    }

    ctx.logger.debug('Analytics refreshed', { sourceId: task.sourceId ?? undefined });
  });

  /*
   * The scan handlers.
   *
   * These are what make the system autonomous: without them the scheduler
   * creates work every hour and nothing executes it. They were left as
   * logging stubs through Prompt 17 and wiring them is the single change that
   * turns a set of well-tested libraries into a running pipeline.
   *
   * The runner is built once per engine rather than per task. A fresh
   * connector registry and rate limiter for every scan would defeat the
   * limiter entirely — its whole job is remembering what it has already sent
   * to a host.
   */
  worker.register('SOURCE_SCAN', async (task, ctx) => {
    const sourceId = task.sourceId ?? (task.payload['sourceId'] as string | undefined);

    if (!sourceId) {
      ctx.logger.warn('Source scan task carried no source id', { taskId: task.taskId });
      return;
    }

    const result = await deps.runner.run(sourceId, {
      trigger: 'schedule',
      /*
       * The relevance gate. Postings outside the candidate's field are dropped
       * before they are written, rather than stored and filtered later.
       *
       * Filtering at ingestion rather than at read time is the difference
       * between a jobs page a software engineer can use and one showing
       * "IGCSE Teacher - English Language" — and it keeps enrichment, embedding
       * and matching from being spent on postings that can never surface.
       */
      relevance: await deps.relevance.get(),
      /*
       * The age limit, which until now was declared in configuration and read
       * by nothing: `pipeline.maxJobAgeDays` existed, defaulted to 60, and no
       * caller ever passed it, so ingestion fell back to the rule's own 90-day
       * default and stored whatever it found.
       *
       * It belongs here rather than only in the weekly purge. Storing a
       * month-old posting and deleting it days later still costs the fetch,
       * the enrichment, the embedding and the match — all spent on something
       * that was never going to be shown.
       */
      pipeline: { maxAgeDays: (await deps.stages.config()).pipeline.maxJobAgeDays },
      /*
       * Bounded by the task's own timeout, less a margin. A scan that outlived
       * its lease would be reclaimed and run again while still running — the
       * duplicate execution leases exist to prevent.
       */
      timeBudgetMs: Math.max(30_000, (task.timeoutMs ?? 180_000) - 20_000),
    });

    ctx.logger.info('Source scan complete', {
      sourceId,
      status: result.status,
      discovered: result.stats.jobsDiscovered,
      accepted: result.stats.jobsAccepted,
      duplicates: result.stats.jobsDuplicated,
    });

    /*
     * A partial run is not a failure. One posting failing to parse must not
     * discard the ninety that succeeded, and throwing here would retry the
     * whole source for the sake of one bad record.
     */
    if (result.status === 'failed') {
      throw new Error(
        result.errors[0]?.message ?? `Source ${sourceId} failed with no recorded error.`,
      );
    }
  });

  /*
   * A profile scan fans out to that profile's sources.
   *
   * It enqueues rather than executing inline: a profile with twelve sources
   * would otherwise hold one worker for twelve sequential network scans, and
   * the per-source tasks distribute across the fleet instead.
   */
  worker.register('SEARCH_PROFILE_SCAN', async (task, ctx) => {
    const profileId = task.profileId;

    if (!profileId) {
      ctx.logger.warn('Profile scan task carried no profile id', { taskId: task.taskId });
      return;
    }

    const sources = await new SourceRepository(deps.db).list({ enabledOnly: true });

    const enqueued = await deps.queue.enqueueMany(
      sources.map((source) => ({
        type: 'SOURCE_SCAN' as const,
        key: [profileId, source.id, new Date().toISOString().slice(0, 13)],
        profileId,
        sourceId: source.id,
        payload: { scheduledBy: task.taskId },
      })),
    );

    ctx.logger.info('Profile scan fanned out', {
      profileId,
      sources: sources.length,
      created: enqueued.created.length,
      duplicates: enqueued.duplicates,
    });
  });
}
