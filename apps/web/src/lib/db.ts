import 'server-only';
import {
  ConfigRepository,
  EngagementRepository,
  EventRepository,
  JobRepository,
  ProfileRepository,
  SourceRepository,
  createDatabase,
  optionsFromEnv,
  type DatabaseHandle,
} from '@job-intel/db';
import { AppConfigProvider, loadDotenv, loadEnv, type Env } from '@job-intel/config';
import { createLogger, EventRecorder, type Logger } from '@job-intel/observability';

/**
 * Server-side composition root.
 *
 * Next.js re-evaluates modules on every hot reload in development, which would
 * otherwise open a new connection pool (or a second PGlite instance) per edit.
 * Caching on `globalThis` keeps exactly one of each per process.
 *
 * `server-only` makes an accidental import from a client component a build
 * error rather than a runtime secret leak.
 */
export interface ServerContext {
  env: Env;
  handle: DatabaseHandle;
  logger: Logger;
  events: EventRecorder;
  config: AppConfigProvider;
  profiles: ProfileRepository;
  sources: SourceRepository;
  jobs: JobRepository;
  engagement: EngagementRepository;
  appConfig: ConfigRepository;
}

declare global {
  var __jobIntelContext: Promise<ServerContext> | undefined;
}

async function build(): Promise<ServerContext> {
  loadDotenv();
  const env = loadEnv();

  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY,
    base: { service: 'web' },
  });

  const handle = await createDatabase(optionsFromEnv(env));
  const appConfig = new ConfigRepository(handle.db);

  return {
    env,
    handle,
    logger,
    // Durable sink as well as the log stream: API-triggered events (profile
    // activations, source changes, feedback) must be queryable later, not just
    // visible in whichever log the request happened to land in.
    events: new EventRecorder(logger, new EventRepository(handle.db)),
    config: new AppConfigProvider(appConfig),
    profiles: new ProfileRepository(handle.db),
    sources: new SourceRepository(handle.db),
    jobs: new JobRepository(handle.db),
    engagement: new EngagementRepository(handle.db),
    appConfig,
  };
}

export function getServerContext(): Promise<ServerContext> {
  globalThis.__jobIntelContext ??= build();
  return globalThis.__jobIntelContext;
}
