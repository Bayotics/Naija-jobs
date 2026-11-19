/**
 * Worker entrypoint.
 *
 * Long-lived process that will host every pipeline stage. Today it establishes
 * and verifies the runtime — config, database, queue, logging — and shuts down
 * cleanly. Stage processors are registered here from prompt 10 onward.
 *
 * Deliberately a separate process from the web app: Playwright, BullMQ
 * consumers and long-running stages cannot live in serverless functions, which
 * is why the architecture splits the deployment.
 */
import {
  ConfigurationError,
  AppConfigProvider,
  EnvSecretProvider,
  loadDotenv,
  loadEnv,
} from '@job-intel/config';
import { createLogger, EventRecorder, type Logger } from '@job-intel/observability';
import {
  ApplicationRepository,
  CandidateRepository,
  ConfigRepository,
  SearchConfigRepository,
  EnrichmentRepository,
  EventRepository,
  IntelligenceRepository,
  JobRepository,
  MatchRepository,
  ProfileRepository,
  SourceRepository,
  checkDatabaseHealth,
  createDatabase,
  optionsFromEnv,
  type DatabaseHandle,
} from '@job-intel/db';
import { createQueueDriver, type QueueDriver } from '@job-intel/queue';
import { hostname } from 'node:os';
import { createExecutionEngine, type ExecutionEngine } from './execution-engine';
import {
  ApplicationService,
  ResumeService,
  SearchConfigService,
  registerApplicationJobs,
  registerResumeJobs,
  registerSearchConfigJobs,
} from '@job-intel/discovery';
import {
  GitHubPortfolioConnector,
  HttpClient,
  PersonalSiteConnector,
} from '@job-intel/connectors';
import { SKILL_TAXONOMY } from '@job-intel/resume';

interface Runtime {
  logger: Logger;
  handle: DatabaseHandle;
  queue: QueueDriver;
  events: EventRecorder;
  engine: ExecutionEngine;
}

async function start(): Promise<Runtime> {
  loadDotenv();
  /*
   * Asks as the worker.
   *
   * It serves no HTTP and signs no sessions, so AUTH_SECRET and OPS_PASSWORD
   * are not its business. Demanding them here once stopped every scheduled
   * pass on a host where they happened to be blank.
   */
  const env = loadEnv(process.env, { role: 'worker' });

  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY,
    base: { service: 'worker', role: env.WORKER_ROLE },
  });

  logger.info('Worker starting', {
    nodeEnv: env.NODE_ENV,
    role: env.WORKER_ROLE,
    databaseDriver: env.DATABASE_DRIVER,
    queueDriver: env.QUEUE_DRIVER,
    concurrency: env.WORKER_CONCURRENCY,
  });

  const handle = await createDatabase(optionsFromEnv(env));
  const health = await checkDatabaseHealth(handle.db);
  if (!health.ok) {
    throw new Error(`Database is unreachable: ${health.error ?? 'unknown error'}`);
  }
  logger.info('Database connected', { driver: handle.driver, latencyMs: health.latencyMs });

  const queue = createQueueDriver(env);
  const queueHealth = await queue.healthCheck();
  if (!queueHealth.ok) {
    throw new Error(`Queue is unreachable: ${queueHealth.error ?? 'unknown error'}`);
  }
  logger.info('Queue connected', { driver: queue.kind });

  if (queue.kind === 'inmemory' && env.NODE_ENV !== 'test') {
    logger.warn(
      'Queue driver is in-memory: jobs will not survive a restart. Set QUEUE_DRIVER=bullmq with REDIS_URL for durable processing.',
    );
  }

  const events = new EventRecorder(logger, new EventRepository(handle.db));
  const config = new AppConfigProvider(new ConfigRepository(handle.db));
  const resolved = await config.get();
  logger.info('Configuration resolved', {
    minimumScore: resolved.matching.minimumScore,
    aiEnabled: resolved.ai.enabled,
  });

  // Report which enabled sources are missing declared credentials. Names only —
  // a source that cannot run must be visible, not silently failing every cycle.
  const secrets = new EnvSecretProvider();
  const sources = await new SourceRepository(handle.db).list({ enabledOnly: true });
  for (const source of sources) {
    const missing = secrets.missing(source.credentialRefs);
    if (missing.length > 0) {
      logger.warn('Source is enabled but missing credentials', {
        sourceId: source.id,
        missing,
      });
    }
  }

  await events.emit('SYSTEM_STARTED', {
    message: 'Worker started',
    data: { role: env.WORKER_ROLE, enabledSources: sources.length },
  });

  /*
   * Candidate-intelligence processors.
   *
   * Extraction itself is not here: it runs inline on upload, because the
   * candidate is waiting to be told whether their file could be read. What the
   * worker owns is the work that can happen afterwards — rebuilding the merged
   * profile, refreshing linked public profiles, and precomputing requirement
   * matrices for jobs the candidate is about to be shown.
   */
  const http = new HttpClient({
    userAgent: env.CRAWLER_USER_AGENT,
    contactEmail: env.CRAWLER_CONTACT_EMAIL,
  });

  const resumeService = new ResumeService({
    intelligence: new IntelligenceRepository(handle.db),
    jobs: new JobRepository(handle.db),
    enrichments: new EnrichmentRepository(handle.db),
    logger,
    events,
    portfolioConnectors: [
      new GitHubPortfolioConnector(http, { token: process.env.GITHUB_TOKEN ?? null }),
      new PersonalSiteConnector(
        http,
        SKILL_TAXONOMY.filter((skill) => skill.category !== 'soft_skill').map((skill) => skill.name),
      ),
    ],
  });

  registerResumeJobs({ service: resumeService, queue, logger });

  /*
   * Application intelligence.
   *
   * Note what is registered and what is not: two analysis jobs, and nothing
   * that submits, approves or applies. The opportunity state machine has no
   * transition the system can take past RECOMMENDED, so a job that tried would
   * be rejected by the repository — the worker simply has no such job to run.
   */
  const applicationService = new ApplicationService({
    applications: new ApplicationRepository(handle.db),
    intelligence: new IntelligenceRepository(handle.db),
    candidates: new CandidateRepository(handle.db),
    profiles: new ProfileRepository(handle.db),
    matches: new MatchRepository(handle.db),
    jobs: new JobRepository(handle.db),
    enrichments: new EnrichmentRepository(handle.db),
    logger,
    events,
  });

  registerApplicationJobs({ service: applicationService, queue, logger });


  /*
   * Search configuration.
   *
   * One scheduler for every setting. Frequency, pause state, profile
   * enablement and source selection are already folded into the effective
   * configuration, so the tick asks which profiles are due and does nothing
   * else — no separate scheduler per switch, which is Part 44's whole point.
   */
  const searchConfigService = new SearchConfigService({
    repository: new SearchConfigRepository(handle.db),
    candidates: new CandidateRepository(handle.db),
    sources: new SourceRepository(handle.db),
    logger,
    events,
  });

  registerSearchConfigJobs({
    service: searchConfigService,
    queue,
    logger,
    onDue: async ({ candidateId, profileId }) => {
      /*
       * Discovery itself is not wired here yet.
       *
       * The tick resolves what each due profile *would* search and records the
       * run; connecting that to the source runner is prompt 16's subject, and
       * inventing a half-connection now would mean two places deciding which
       * sources to query.
       */
      const queries = await searchConfigService.queriesFor(candidateId, profileId);

      logger.info('Search profile due', {
        candidateId,
        profileId,
        queries: queries.length,
        sample: queries.slice(0, 3).map((query) => query.text),
      });
    },
  });

  logger.info('Worker ready', {
    enabledSources: sources.length,
    registeredProcessors: [
      'profile-rebuild',
      'portfolio-refresh',
      'requirement-matrix',
      'application-analyse',
      'application-analyse-all',
      'notification-score',
      'notification-digest',
      'search-schedule-tick',
      'search-override-expiry',
    ],
  });

  /*
   * The execution engine.
   *
   * Started last so that everything it schedules against — database, queue,
   * services — is already up. Started in *every* worker: the scheduler lease
   * means exactly one of them will actually be scheduling, and running more
   * copies of this process is the entire horizontal scaling story.
   */
  const engine = createExecutionEngine({
    db: handle.db,
    logger,
    events,
    instanceId: `${hostname()}-${process.pid}`,
    concurrency: 4,
    userAgent: env.CRAWLER_USER_AGENT,
    ...(env.CRAWLER_CONTACT_EMAIL ? { contactEmail: env.CRAWLER_CONTACT_EMAIL } : {}),
    stages: {
      env,
      events,
      /*
       * Re-read per stage run rather than captured once at boot. A worker that
       * has been up for a week would otherwise still be acting on the config it
       * started with, and the whole point of runtime configuration is that
       * turning notifications on takes effect without a restart.
       */
      config: () => config.get(),
    },
  });

  await engine.start();

  return { logger, handle, queue, events, engine };
}

async function shutdown(runtime: Runtime, signal: string): Promise<void> {
  runtime.logger.info('Shutting down', { signal });
  try {
    await runtime.events.emit('SYSTEM_SHUTDOWN', { message: `Received ${signal}` });
    /*
     * The engine stops first: it must finish in-flight tasks and release its
     * leases while the database is still open, or every task it held would have
     * to wait out its lease instead of returning to the queue immediately.
     */
    await runtime.engine.stop();
    // Drain the queue before closing the database: in-flight jobs still need it.
    await runtime.queue.close();
    await runtime.handle.close();
    runtime.logger.info('Shutdown complete');
  } catch (error) {
    runtime.logger.error('Error during shutdown', { err: error });
    process.exitCode = 1;
  }
}

start()
  .then((runtime) => {
    let shuttingDown = false;
    const handle = (signal: string) => {
      if (shuttingDown) return; // a second signal must not race the first
      shuttingDown = true;
      void shutdown(runtime, signal).then(() => process.exit(process.exitCode ?? 0));
    };

    process.on('SIGTERM', () => handle('SIGTERM'));
    process.on('SIGINT', () => handle('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      runtime.logger.error('Unhandled promise rejection', { err: reason });
    });

    // A one-shot mode so CI and the verification step can prove the runtime
    // boots without leaving a process running forever.
    if (process.env.WORKER_ONCE === 'true') {
      runtime.logger.info('WORKER_ONCE set — exiting after successful startup');
      handle('WORKER_ONCE');
    }
  })
  .catch(async (error: unknown) => {
    const detail =
      error instanceof ConfigurationError
        ? error.format()
        : error instanceof Error
          ? (error.stack ?? error.message)
          : String(error);

    console.error('[worker] failed to start:', detail);
    await reportStartFailure(detail);
    process.exit(1);
  });

/**
 * Tells the database that this process could not start.
 *
 * -- Why a process writes its own obituary ----------------------------------
 *
 * A worker that dies during startup leaves no trace anywhere the owner looks.
 * It writes no heartbeat, so the liveness banner can say "stopped" but never
 * why. It runs no stage, so no source has a failure to report. The deploy goes
 * green, because the image built perfectly. The only record is a stack trace
 * in a hosting platform's log viewer, behind a login, in a tab nobody opens --
 * and this system spent two days dead in exactly that way, with every
 * dashboard it owns reporting health.
 *
 * So the failure is written where failures are visible: the same database the
 * dashboard reads. The next page load says what happened, in words, without
 * anyone opening a hosting console.
 *
 * -- Why it is allowed to fail ----------------------------------------------
 *
 * This runs on a path where something has already gone wrong, and one likely
 * cause is the database itself. It is therefore best-effort and strictly
 * bounded: its own single connection, a hard timeout, every error swallowed. A
 * reporter that hung would turn a crash that restarts in seconds into a
 * container that has to be killed; a reporter that threw would replace the
 * real error with its own.
 */
async function reportStartFailure(detail: string): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return; // Nowhere to write it. The console line stands.

  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, 10_000).unref();
  });

  const write = (async () => {
    let handle: DatabaseHandle | undefined;
    try {
      handle = await createDatabase({
        /*
         * Built by hand rather than from `optionsFromEnv`, because parsing the
         * environment is one of the things that may just have failed. One
         * connection, not a pool: this process is about to exit.
         */
        driver: process.env.DATABASE_DRIVER === 'neon' ? 'neon' : 'pg',
        connectionString,
        poolMax: 1,
      });

      await new EventRepository(handle.db).record({
        name: 'SYSTEM_START_FAILED',
        severity: 'error',
        // Bounded: a stack trace is diagnostic for a few lines and a storage
        // problem after that.
        message: detail.slice(0, 2000),
        traceId: null,
        sourceId: null,
        jobId: null,
        runId: null,
        data: { hostname: hostname(), pid: process.pid },
      });

      console.error('[worker] recorded SYSTEM_START_FAILED. The dashboard will show it.');
    } catch {
      // Already failing. Saying so twice helps nobody.
    } finally {
      try {
        await handle?.close();
      } catch {
        // Closing a connection that never opened is not news.
      }
    }
  })();

  await Promise.race([write, timeout]);
}
