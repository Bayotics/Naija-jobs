import 'server-only';
import { AcquisitionRepository } from '@job-intel/db';
import { SourceIntelligenceService } from '@job-intel/discovery';
import { createDefaultRegistry } from '@job-intel/connectors';
import { getServerContext } from './db';

/**
 * Acquisition composition for the web process.
 *
 * `getSecret` reads `process.env` directly and the *value* never leaves this
 * function — the service only ever asks whether a name resolves, and the
 * dashboard renders the name. That is the whole of Part 6 in this layer: a
 * credential cannot appear in a page because no code path carries one there.
 */
export async function getAcquisitionContext(): Promise<{
  service: SourceIntelligenceService;
  repository: AcquisitionRepository;
}> {
  const ctx = await getServerContext();
  const repository = new AcquisitionRepository(ctx.handle.db);

  const service = new SourceIntelligenceService({
    registry: createDefaultRegistry(),
    sources: ctx.sources,
    acquisition: repository,
    logger: ctx.logger,
    getSecret: (name) => process.env[name],
  });

  return { service, repository };
}
