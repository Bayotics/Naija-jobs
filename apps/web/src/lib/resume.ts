import 'server-only';
import { EnrichmentRepository, IntelligenceRepository, JobRepository } from '@job-intel/db';
import { ResumeService } from '@job-intel/discovery';
import { HttpClient, GitHubPortfolioConnector, PersonalSiteConnector } from '@job-intel/connectors';
import { SKILL_TAXONOMY } from '@job-intel/resume';
import { getServerContext } from './db';

/**
 * Candidate-intelligence composition for the web process.
 *
 * Built per request, like the other contexts here. The profile is versioned and
 * the active version changes on upload; a cached service would keep serving the
 * version it captured at boot, which is precisely the bug the versioning exists
 * to make visible.
 *
 * Note what is *not* wired in: no document storage driver. Until one is
 * configured the bytes are read, validated, extracted and discarded, and the
 * system holds only the structured result plus a hash. That is the safer
 * default — a resume nobody chose to retain is a resume that cannot leak — and
 * `signedUrl` correctly reports that the original is unavailable.
 */

export interface ResumeContext {
  service: ResumeService;
  repository: IntelligenceRepository;
  profileId: string | null;
}

/** Taxonomy names a personal site is scanned for. */
const SITE_VOCABULARY = SKILL_TAXONOMY.filter((skill) => skill.category !== 'soft_skill').map(
  (skill) => skill.name,
);

export async function getResumeContext(): Promise<ResumeContext> {
  const ctx = await getServerContext();
  const profile = await ctx.profiles.getActiveProfile().catch(() => null);

  const repository = new IntelligenceRepository(ctx.handle.db);

  const http = new HttpClient({
    userAgent: ctx.env.CRAWLER_USER_AGENT,
    contactEmail: ctx.env.CRAWLER_CONTACT_EMAIL,
  });

  const service = new ResumeService({
    intelligence: repository,
    jobs: new JobRepository(ctx.handle.db),
    enrichments: new EnrichmentRepository(ctx.handle.db),
    logger: ctx.logger,
    events: ctx.events,
    portfolioConnectors: [
      new GitHubPortfolioConnector(http, { token: process.env.GITHUB_TOKEN ?? null }),
      new PersonalSiteConnector(http, SITE_VOCABULARY),
    ],
  });

  return { service, repository, profileId: profile?.profileId ?? null };
}
