import 'server-only';
import { CandidateRepository, SearchConfigRepository, SourceRepository } from '@job-intel/db';
import { SearchConfigService } from '@job-intel/discovery';
import { getServerContext } from './db';

/**
 * Search-configuration composition for the web process.
 *
 * One service instance per request, like every other context here. The
 * service's own cache is keyed on `configVersion` rather than on instance
 * lifetime, so a per-request instance loses nothing — and a long-lived one
 * would risk serving a configuration the user changed in another tab.
 *
 * No intent provider is wired: the deterministic rules cover the instructions
 * people actually type, and a model call on a page render would make the
 * command bar feel slow for the common case. The provider hook exists for a
 * deployment that wants it.
 */

export interface SearchConfigContext {
  service: SearchConfigService;
  repository: SearchConfigRepository;
  profileId: string | null;
}

export async function getSearchConfigContext(): Promise<SearchConfigContext> {
  const ctx = await getServerContext();
  const profile = await ctx.profiles.getActiveProfile().catch(() => null);

  const repository = new SearchConfigRepository(ctx.handle.db);

  const service = new SearchConfigService({
    repository,
    candidates: new CandidateRepository(ctx.handle.db),
    sources: new SourceRepository(ctx.handle.db),
    logger: ctx.logger,
    events: ctx.events,
  });

  return { service, repository, profileId: profile?.profileId ?? null };
}
