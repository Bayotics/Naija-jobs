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
  NotificationIntelligenceRepository,
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
  NotificationIntelligenceService,
  ResumeService,
  SearchConfigService,
  registerApplicationJobs,
  registerNotificationIntelligenceJobs,
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
  const env = loadEnv();

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
    notificationsEnabled: resolved.notifications.enabled,
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
   * Notification intelligence.
   *
   * Given a link probe here and nowhere else: reachability checks make outbound
   * requests to arbitrary employer sites, which belongs in a background process
   * rather than on a page render. The probe is the SSRF-hardened client, so the
   * system has exactly one code path that follows a redirect from untrusted
   * content.
   */
  const notificationService = new NotificationIntelligenceService({
    notifications: new NotificationIntelligenceRepository(handle.db),
    applications: new ApplicationRepository(handle.db),
    matches: new MatchRepository(handle.db),
    jobs: new JobRepository(handle.db),
    enrichments: new EnrichmentRepository(handle.db),
    candidates: new CandidateRepository(handle.db),
    logger,
    events,
    linkProbe: async (url) => {
      try {
        /*
         * `getText` rather than a HEAD.
         *
         * Many employer sites answer HEAD with a 405 or a bare 200 that says
         * nothing about whether the posting is still there, and the client's
         * redirect handling — the part that matters for deciding whether a link
         * still points at a job — only runs on a real request.
         */
        const response = await http.getText(url);

        return {
          status: response.status,
          finalUrl: response.url,
          // The client follows redirects itself; a changed URL means it did.
          redirects: response.url === url ? 0 : 1,
        };
      } catch {
        // A failed probe is not a failed link — the caller records `unverified`.
        return null;
      }
    },
  });

  registerNotificationIntelligenceJobs({ service: notificationService, queue, logger });

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
  .catch((error: unknown) => {
    if (error instanceof ConfigurationError) {
      console.error(`\n[worker] ${error.format()}`);
    } else {
      console.error('[worker] failed to start:', error);
    }
    process.exit(1);
  });
