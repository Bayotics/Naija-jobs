import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import type { ExtractedJobPosting } from '../extract/schema-org';

/**
 * Structured posting → source draft.
 *
 * Parsing lives apart from acquisition (Part 30) for a reason that shows up the
 * first time a site changes its markup: the connector — which knows how to
 * reach the source politely, when to stop, and what its rate limits are — is
 * stable, and the parser is the part that rots. Keeping them in one class means
 * every markup fix risks the acquisition logic, and every acquisition fix
 * requires re-reading the parser.
 *
 * Concretely, this function is shared by the web, sitemap, career-page and
 * job-board connectors: five sources, one mapping, one place to fix it.
 */

export interface DraftDefaults {
  defaultCompany?: string | null;
  defaultLocationText?: string | null;
  /** Merged into `sourceMetadata`, for connector-specific context. */
  metadata?: Record<string, unknown>;
  /** How this posting was found, for the provenance trail. */
  discoveryMethod?: string;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Maps one extracted posting onto a draft, or returns null.
 *
 * Null rather than a partial draft when validation fails. A posting missing a
 * title is not a job with an unknown name — it is evidence that the extraction
 * was wrong, and inventing "Untitled position" to satisfy the schema would put
 * a record downstream that nothing can ever correct.
 */
export function postingToDraft(
  posting: ExtractedJobPosting,
  url: string,
  defaults: DraftDefaults = {},
): SourceJobDraft | null {
  const parsed = sourceJobDraftSchema.safeParse({
    title: posting.title,
    companyName:
      posting.hiringOrganization ?? defaults.defaultCompany ?? hostOf(url) ?? 'Unknown',
    companyWebsite: posting.organizationUrl,
    description: posting.description,
    descriptionFormat: posting.descriptionIsHtml ? 'html' : 'text',
    locationText: posting.locationText ?? defaults.defaultLocationText,

    /*
     * `jobLocationType` is the only remote signal schema.org offers, and it is
     * present far less often than remote roles are. Absent, the flag stays
     * null rather than false — "the markup did not say" is not "not remote",
     * and the normalizer reads the description for the answer.
     */
    remoteFlag: posting.jobLocationType ? /telecommute|remote/i.test(posting.jobLocationType) : null,

    employmentTypeTexts: posting.employmentTypes,
    salaryMin: posting.salaryMin,
    salaryMax: posting.salaryMax,
    salaryCurrency: posting.salaryCurrency,
    salaryPeriod: posting.salaryPeriod,
    postedAt: posting.datePosted,
    validThrough: posting.validThrough,

    /*
     * The posting's own URL stays the identity; `directApply` becomes the apply
     * link. Using the apply URL as the identity would collapse every posting
     * that shares an applicant-tracking form into one job.
     */
    url,
    applyUrl: posting.directApplyUrl,
    externalId: posting.identifier,

    raw: posting,
    sourceMetadata: {
      discoveryMethod: defaults.discoveryMethod ?? 'structured_data',
      extractedFrom: posting.extractedFrom,
      fieldsPresent: posting.fieldsPresent,
      applicantLocationRequirements: posting.applicantLocationRequirements,
      ...defaults.metadata,
    },
  });

  return parsed.success ? parsed.data : null;
}
