import {
  normalizedJobSchema,
  type NormalizedJob,
  type SourceJobDraft,
} from '@job-intel/contracts';
import { htmlToText, sanitizeHtml, detectHiddenContent } from './html';
import {
  normalizeEmploymentTypes,
  normalizeRemoteType,
  normalizeSeniority,
  parseLocation,
  parseSalaryText,
  toAnnualUsd,
  type Normalized,
} from './fields';
import { cleanTitle, collapseWhitespace, normalizeUrl } from './text';

/**
 * Draft → domain model.
 *
 * The single place where source wording becomes internal meaning. A connector
 * that extracts fields correctly gets every semantic rule here for free, and
 * cannot introduce a private interpretation of "full-time" or "remote".
 *
 * Two properties the rest of the system depends on:
 *
 *  1. **Total.** Any draft that satisfies its schema produces a job or an
 *     explicit rejection. It never throws, because one malformed posting must
 *     not abort a source run.
 *  2. **Non-destructive.** Every interpretation keeps the raw value it came
 *     from, exposed via `NormalizationReport`, so a wrong mapping is
 *     diagnosable rather than invisible.
 */

export interface NormalizationOptions {
  /** Applied when the source states an amount with no currency. */
  defaultCurrency?: string | null;
  fxRates?: Readonly<Record<string, number>>;
  /** Query parameters stripped during URL normalization. */
  trackingParams?: readonly string[];
  /** Descriptions longer than this are truncated before storage. */
  maxDescriptionLength?: number;
}

/** Per-field provenance, retained for the debugging UI and connector tests. */
export interface NormalizationReport {
  remoteType: Normalized<NormalizedJob['remoteType']>;
  employmentTypes: Normalized<NormalizedJob['employmentTypes']>;
  seniority: Normalized<NormalizedJob['seniority']>;
  salary: ReturnType<typeof parseSalaryText>;
  location: ReturnType<typeof parseLocation>;
  /** Hidden-text findings, fed to quality/scam scoring later. */
  contentFlags: string[];
  warnings: string[];
}

export type NormalizationResult =
  | { ok: true; job: NormalizedJob; report: NormalizationReport }
  | { ok: false; reason: string; report: Partial<NormalizationReport> };

const DEFAULT_MAX_DESCRIPTION = 100_000;

export function normalizeJobDraft(
  draft: SourceJobDraft,
  options: NormalizationOptions = {},
): NormalizationResult {
  const warnings: string[] = [];

  try {
    // ── Description: keep both a rendered and a plain-text form ────────────
    const isHtml = draft.descriptionFormat === 'html';
    const contentFlags = isHtml ? detectHiddenContent(draft.description) : [];
    const descriptionHtml = isHtml ? sanitizeHtml(draft.description) : null;
    const descriptionText = isHtml
      ? htmlToText(draft.description)
      : draft.description
        ? collapseWhitespace(draft.description)
        : null;

    const maxLength = options.maxDescriptionLength ?? DEFAULT_MAX_DESCRIPTION;
    const truncatedText =
      descriptionText && descriptionText.length > maxLength
        ? descriptionText.slice(0, maxLength)
        : descriptionText;
    if (descriptionText && truncatedText !== descriptionText) {
      warnings.push(`description truncated from ${descriptionText.length} to ${maxLength} chars`);
    }

    // ── Semantic fields ────────────────────────────────────────────────────
    const remote = normalizeRemoteType({
      explicitRemote: draft.remoteFlag,
      location: draft.locationText,
      title: draft.title,
      tags: draft.tags,
      description: truncatedText,
    });

    const employment = normalizeEmploymentTypes([
      ...draft.employmentTypeTexts,
      // Titles often carry the only employment signal ("… (Contract)").
      draft.title,
    ]);

    const seniority = normalizeSeniority(draft.title);
    const location = parseLocation(draft.locationText);

    // Structured salary from the source always beats parsing its prose.
    const salary = resolveSalary(draft, options);

    // ── URLs ───────────────────────────────────────────────────────────────
    const urlOptions = options.trackingParams ? { trackingParams: options.trackingParams } : {};
    const canonicalUrl = normalizeUrl(draft.url, urlOptions);
    if (!canonicalUrl) {
      return {
        ok: false,
        reason: `unparseable source URL: ${draft.url}`,
        report: { warnings, contentFlags },
      };
    }
    const applyUrl = draft.applyUrl ? normalizeUrl(draft.applyUrl, urlOptions) : null;
    if (draft.applyUrl && !applyUrl) warnings.push(`unparseable apply URL: ${draft.applyUrl}`);

    const companyWebsite = draft.companyWebsite ? normalizeUrl(draft.companyWebsite, urlOptions) : null;

    // ── Dates ──────────────────────────────────────────────────────────────
    // A posting dated in the future is a source bug; keep it but flag it rather
    // than silently trusting it, since posted_at drives freshness and blocking.
    const now = Date.now();
    let postedAt = draft.postedAt;
    if (postedAt && postedAt.getTime() > now + 86_400_000) {
      warnings.push(`postedAt is in the future (${postedAt.toISOString()}); ignoring`);
      postedAt = null;
    }

    const report: NormalizationReport = {
      remoteType: remote,
      employmentTypes: employment,
      seniority,
      salary,
      location,
      contentFlags,
      warnings,
    };

    const parsed = normalizedJobSchema.safeParse({
      title: cleanTitle(draft.title),
      company: {
        name: collapseWhitespace(draft.companyName),
        websiteUrl: companyWebsite,
        domain: companyWebsite ? safeHostname(companyWebsite) : null,
      },
      description: truncatedText,
      descriptionHtml,
      skills: draft.tags,
      techStack: draft.tags,
      salary: {
        min: salary.value.min,
        max: salary.value.max,
        currency: salary.value.currency,
        period: salary.value.period,
        isEstimated: false,
        normalizedAnnualUsd: salary.value.normalizedAnnualUsd,
        fxRateUsed: salary.value.fxRateUsed,
      },
      location: {
        raw: draft.locationText,
        city: location.value.city,
        region: location.value.region,
        countryCode: location.value.countryCode,
      },
      remoteType: remote.value,
      employmentTypes: employment.value,
      seniority: seniority.value,
      seniorityConfidence: seniority.confidence > 0 ? seniority.confidence : null,
      sourceUrl: draft.url,
      canonicalUrl,
      applyUrl,
      externalId: draft.externalId,
      postedAt,
      validThrough: draft.validThrough,
      status: 'active',
    });

    if (!parsed.success) {
      return {
        ok: false,
        reason: `normalized job failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
        report,
      };
    }

    return { ok: true, job: parsed.data, report };
  } catch (error) {
    // Defensive: normalization is called in a loop over untrusted data, and an
    // unexpected throw here would take down an entire source run.
    return {
      ok: false,
      reason: `normalization threw: ${error instanceof Error ? error.message : String(error)}`,
      report: { warnings },
    };
  }
}

/**
 * Prefers the source's structured salary and falls back to parsing its text.
 * Sources that give numbers are far more reliable than any regex over prose.
 */
function resolveSalary(
  draft: SourceJobDraft,
  options: NormalizationOptions,
): ReturnType<typeof parseSalaryText> {
  const hasStructured = draft.salaryMin !== null || draft.salaryMax !== null;
  if (!hasStructured) {
    return parseSalaryText(draft.salaryText, {
      defaultCurrency: options.defaultCurrency ?? null,
      ...(options.fxRates ? { fxRates: options.fxRates } : {}),
    });
  }

  const currency = draft.salaryCurrency?.toUpperCase() ?? options.defaultCurrency ?? null;
  const period = draft.salaryPeriod;
  const annual = toAnnualUsd(
    draft.salaryMax ?? draft.salaryMin,
    currency,
    period,
    options.fxRates,
  );

  return {
    value: {
      min: draft.salaryMin,
      max: draft.salaryMax,
      currency,
      period,
      normalizedAnnualUsd: annual.value,
      fxRateUsed: annual.rate,
    },
    confidence: 0.95,
    raw: draft.salaryText,
    evidence: 'structured salary supplied by source',
  };
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
