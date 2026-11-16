import type { Env } from '@job-intel/config';
import { BullMqQueueDriver } from './bullmq-driver';
import { InMemoryQueueDriver } from './inmemory-driver';
import type { QueueDriver } from './types';

/**
 * @job-intel/queue
 *
 * Queue infrastructure behind a driver port. Stage processors are registered
 * against this in prompt 10.
 */
export * from './types';
export * from './inmemory-driver';
export * from './bullmq-driver';

/**
 * Selects the driver from configuration.
 *
 * The choice is explicit (`QUEUE_DRIVER`) rather than inferred from whether
 * `REDIS_URL` happens to be set — an accidentally-missing Redis URL must fail
 * loudly, not silently downgrade production to an in-memory queue.
 */
export function createQueueDriver(env: Env): QueueDriver {
  if (env.QUEUE_DRIVER === 'bullmq') {
    if (!env.REDIS_URL) {
      throw new Error('QUEUE_DRIVER=bullmq requires REDIS_URL (validated at startup)');
    }
    return new BullMqQueueDriver({ connectionUrl: env.REDIS_URL });
  }
  return new InMemoryQueueDriver();
}
