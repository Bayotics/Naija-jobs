import 'server-only';
import {
  CoordinationService,
  DeadLetterQueue,
  Scheduler,
  SystemHealthService,
  TaskQueue,
  WorkerRegistry,
} from '@job-intel/scheduler';
import { getServerContext } from './db';

/**
 * Execution-engine composition for the web process.
 *
 * The web app reads the engine and can act on dead letters; it never runs the
 * scheduler tick. A scheduler instance inside a serverless request handler
 * would hold the leadership lease for the length of one request and then
 * vanish, which is worse than not having one — the lease would flap and the
 * real scheduler in the worker would spend its life re-acquiring it.
 */
export async function getExecutionContext() {
  const ctx = await getServerContext();

  const queue = new TaskQueue(ctx.handle.db);
  const deadLetters = new DeadLetterQueue(ctx.handle.db);
  const workers = new WorkerRegistry(ctx.handle.db);
  const coordination = new CoordinationService(ctx.handle.db);

  const scheduler = new Scheduler({
    db: ctx.handle.db,
    queue,
    coordination,
    logger: ctx.logger,
    instanceId: 'web-readonly',
  });

  const health = new SystemHealthService({
    queue,
    deadLetters,
    workers,
    scheduler,
    logger: ctx.logger,
    probes: [
      {
        component: 'database',
        check: async () => {
          await ctx.handle.db.execute('select 1');
          return { status: 'healthy' as const, detail: 'Database reachable.' };
        },
      },
    ],
  });

  return { queue, deadLetters, workers, scheduler, health };
}
