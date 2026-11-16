import type { QueueDriver } from '@job-intel/queue';
import { createEnvelope } from '@job-intel/queue';
import type { Logger } from '@job-intel/observability';
import type { SearchConfigService } from './search-config-service';

/**
 * Search configuration queue jobs.
 *
 * Two jobs, and Part 44's requirement is that there is exactly one scheduler
 * rather than one per setting. That falls out of the resolver: frequency, pause
 * state, profile enablement and source selection are all already folded into
 * the effective configuration, so the scheduler's whole job is to ask which
 * profiles are due and compare two timestamps.
 */

export interface SearchScheduleTickPayload {
  /** Optional narrowing, for a manual "run this profile now". */
  candidateId?: string;
}

export interface SearchConfigJobDependencies {
  service: SearchConfigService;
  queue: QueueDriver;
  logger: Logger;
  /** Called for each due profile. Injected so this file owns no discovery logic. */
  onDue?: (input: { candidateId: string; profileId: string }) => Promise<void>;
}

export function registerSearchConfigJobs(deps: SearchConfigJobDependencies): void {
  const { service, queue, logger } = deps;

  /*
   * The scheduler tick.
   *
   * Expiry runs first. An override whose window closed during the last interval
   * must stop applying *before* the profiles it affects are resolved for this
   * pass — otherwise a "Germany only for 48 hours" window would keep steering
   * one more round of searches after it ended.
   */
  void queue.process<SearchScheduleTickPayload>('search-schedule-tick', async (payload) => {
    const expired = await service.expireOverrides();

    const due = await service.dueProfiles();
    const scoped = payload.candidateId
      ? due.filter((entry) => entry.config.candidateId === payload.candidateId)
      : due;

    for (const entry of scoped) {
      await deps.onDue?.({
        candidateId: entry.config.candidateId,
        profileId: entry.config.profileId,
      });

      await service.markRun(entry.config.profileId);
    }

    logger.info('Search schedule tick', {
      overridesExpired: expired,
      profilesDue: scoped.length,
      profiles: scoped.map((entry) => entry.config.profileName).join(', '),
    });
  });

  /** Sweeps expired overrides on its own, for deployments running it separately. */
  void queue.process('search-override-expiry', async () => {
    const expired = await service.expireOverrides();
    if (expired > 0) logger.info('Search overrides expired', { count: expired });
  });
}

export async function enqueueScheduleTick(
  queue: QueueDriver,
  traceId: string,
  payload: SearchScheduleTickPayload = {},
): Promise<string> {
  const key = `search-schedule:${payload.candidateId ?? 'all'}:${Math.floor(Date.now() / 60_000)}`;

  return queue.enqueue(
    'search-schedule-tick',
    { ...payload, envelope: createEnvelope(traceId, key) },
    { deduplicationId: key },
  );
}
