import {
  type DedupSignal,
  type DedupSignalResult,
  type SignalAgreement,
} from '@job-intel/contracts';
import { normalizeCompanyName, normalizeTitle, normalizeUrl } from '@job-intel/core';

/**
 * Deduplication signals.
 *
 * Twelve independent comparisons, each answering `match` / `conflict` /
 * `unknown` about one aspect of two postings. Nothing here decides whether the
 * pair is a duplicate — that is the detector's job, and keeping the two apart
 * is what makes a bad verdict debuggable: you can look at exactly which signal
 * lied.
 *
 * The rule that matters most: **`unknown` is never `match`.** Two postings that
 * both omit salary have not agreed about salary. Counting shared silence as
 * evidence is how a dedup system confidently merges two different jobs at the
 * same company, and it is the single easiest mistake to make here.
 */

/**
 * The subset of a posting deduplication looks at.
 *
 * Deliberately narrower than the full job record: the comparison must not
 * depend on enrichment having succeeded, because an unenriched posting still
 * needs to be recognised as a duplicate of an enriched one.
 */
export interface DedupCandidate {
  jobId: string;
  sourceId: string;
  externalId: string | null;
  sourceUrl: string;
  canonicalUrl: string | null;
  applyUrl: string | null;
  companyName: string;
  companyDomain: string | null;
  title: string;
  city: string | null;
  countryCode: string | null;
  remoteType: string | null;
  salaryAnnualUsd: number | null;
  postedAt: Date | null;
  description: string | null;
  requirements: string[];
  /** ATS vendor and slug, when the enrichment layer resolved them. */
  atsVendor: string | null;
  atsSlug: string | null;
  simhash: string | null;
}

/**
 * Per-signal weight.
 *
 * A shared application URL is close to proof; a shared title is close to
 * nothing. The spread is deliberately wide so that no accumulation of weak
 * agreements can reach the merge threshold on its own — which is the failure
 * mode of a flat-weighted scheme.
 */
export const SIGNAL_WEIGHTS: Readonly<Record<DedupSignal, number>> = {
  application_url: 1,
  canonical_url: 0.95,
  ats_identity: 0.9,
  external_id: 0.85,
  description_similarity: 0.7,
  company: 0.55,
  title: 0.45,
  requirements_similarity: 0.35,
  company_domain: 0.35,
  location: 0.3,
  posted_date: 0.15,
  salary: 0.15,
};

/**
 * Signals whose disagreement vetoes a merge outright.
 *
 * Two different companies are two different jobs however similar the text —
 * job descriptions are copied between employers constantly, and a
 * similarity-only system merges half a job board into one record.
 */
export const VETO_SIGNALS: ReadonlySet<DedupSignal> = new Set<DedupSignal>([
  'company',
  'ats_identity',
]);

function result(
  signal: DedupSignal,
  agreement: SignalAgreement,
  strength: number,
  detail: string,
): DedupSignalResult {
  return { signal, agreement, weight: SIGNAL_WEIGHTS[signal], strength, detail };
}

function unknown(signal: DedupSignal, detail: string): DedupSignalResult {
  return result(signal, 'unknown', 0, detail);
}

/** Token-set overlap (Jaccard). 0-1. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

function words(text: string | null): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Domain of a URL, without `www.`. Null when unparseable. */
export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// ── Individual signals ──────────────────────────────────────────────────────

function compareExternalId(a: DedupCandidate, b: DedupCandidate): DedupSignalResult {
  if (!a.externalId || !b.externalId) return unknown('external_id', 'one side has no external id');
  // Only meaningful within a source: two boards routinely reuse "12345".
  if (a.sourceId !== b.sourceId) {
    return unknown('external_id', 'external ids are only comparable within one source');
  }
  return a.externalId === b.externalId
    ? result('external_id', 'match', 1, `same external id ${a.externalId} on ${a.sourceId}`)
    : result('external_id', 'conflict', 1, 'different external ids on the same source');
}

function compareUrl(
  signal: 'canonical_url' | 'application_url',
  left: string | null,
  right: string | null,
): DedupSignalResult {
  if (!left || !right) return unknown(signal, 'one side has no url');
  const a = normalizeUrl(left);
  const b = normalizeUrl(right);
  if (!a || !b) return unknown(signal, 'url could not be normalized');
  if (a === b) return result(signal, 'match', 1, `same normalized url ${a}`);

  // Different URLs on different hosts are not evidence *against* a duplicate —
  // the same job legitimately has a LinkedIn url and a careers-page url. Only
  // two different paths on the *same* host suggest two different postings.
  const domainA = domainOf(left);
  const domainB = domainOf(right);
  return domainA !== null && domainA === domainB
    ? result(signal, 'conflict', 0.6, `different paths on ${domainA}`)
    : unknown(signal, 'urls point at different hosts, which proves nothing either way');
}

function compareAts(a: DedupCandidate, b: DedupCandidate): DedupSignalResult {
  if (!a.atsVendor || !b.atsVendor || !a.atsSlug || !b.atsSlug) {
    return unknown('ats_identity', 'ats identity not resolved on both sides');
  }
  if (a.atsVendor !== b.atsVendor) {
    return unknown('ats_identity', `different ats vendors (${a.atsVendor} vs ${b.atsVendor})`);
  }
  return a.atsSlug === b.atsSlug
    ? result('ats_identity', 'match', 1, `same ${a.atsVendor} posting ${a.atsSlug}`)
    : result('ats_identity', 'conflict', 1, `different ${a.atsVendor} postings`);
}

function compareCompany(a: DedupCandidate, b: DedupCandidate): DedupSignalResult {
  const left = normalizeCompanyName(a.companyName);
  const right = normalizeCompanyName(b.companyName);
  if (!left || !right) return unknown('company', 'company name missing');
  if (left === right) return result('company', 'match', 1, `same company "${a.companyName}"`);

  // One side is often "Acme" and the other "Acme GmbH via Recruiter Ltd".
  // Containment is treated as a weaker match rather than a conflict.
  if (left.includes(right) || right.includes(left)) {
    return result('company', 'match', 0.75, `company names overlap: "${a.companyName}" / "${b.companyName}"`);
  }
  return result('company', 'conflict', 1, `different companies: "${a.companyName}" vs "${b.companyName}"`);
}

function compareCompanyDomain(a: DedupCandidate, b: DedupCandidate): DedupSignalResult {
  const left = a.companyDomain ?? domainOf(a.applyUrl);
  const right = b.companyDomain ?? domainOf(b.applyUrl);
  if (!left || !right) return unknown('company_domain', 'company domain unknown on one side');
  return left === right
    ? result('company_domain', 'match', 1, `same company domain ${left}`)
    : unknown('company_domain', `different domains (${left} / ${right}) — often just different hosts`);
}

function compareTitle(a: DedupCandidate, b: DedupCandidate): DedupSignalResult {
  const left = normalizeTitle(a.title);
  const right = normalizeTitle(b.title);
  if (!left || !right) return unknown('title', 'title missing');
  if (left === right) return result('title', 'match', 1, `same normalized title "${left}"`);

  const overlap = jaccard(left.split(' '), right.split(' '));
  if (overlap >= 0.6) {
    return result('title', 'match', overlap, `titles overlap ${Math.round(overlap * 100)}%`);
  }
  return result('title', 'conflict', 1 - overlap, `different titles: "${a.title}" vs "${b.title}"`);
}

function compareLocation(a: DedupCandidate, b: DedupCandidate): DedupSignalResult {
  // A remote role on both sides is location-agnostic; comparing city strings
  // then produces noise rather than signal.
  if (a.remoteType === 'remote' && b.remoteType === 'remote') {
    return result('location', 'match', 0.8, 'both fully remote');
  }
  if (a.countryCode && b.countryCode && a.countryCode !== b.countryCode) {
    return result('location', 'conflict', 1, `different countries (${a.countryCode} / ${b.countryCode})`);
  }
  if (a.city && b.city) {
    const left = normalizeCompanyName(a.city);
    const right = normalizeCompanyName(b.city);
    return left === right
      ? result('location', 'match', 1, `same city ${a.city}`)
      : result('location', 'conflict', 0.8, `different cities (${a.city} / ${b.city})`);
  }
  if (a.countryCode && b.countryCode) {
    return result('location', 'match', 0.6, `same country ${a.countryCode}`);
  }
  return unknown('location', 'location not stated on both sides');
}

function compareSalary(a: DedupCandidate, b: DedupCandidate): DedupSignalResult {
  if (a.salaryAnnualUsd === null || b.salaryAnnualUsd === null) {
    // The common case, and firmly `unknown`. Most postings state no salary.
    return unknown('salary', 'salary not stated on both sides');
  }
  const larger = Math.max(a.salaryAnnualUsd, b.salaryAnnualUsd);
  const ratio = larger === 0 ? 1 : Math.min(a.salaryAnnualUsd, b.salaryAnnualUsd) / larger;
  if (ratio >= 0.9) {
    return result('salary', 'match', ratio, `salaries within ${Math.round((1 - ratio) * 100)}%`);
  }
  // A wide gap is weak evidence against, not proof: aggregators frequently
  // publish an estimated band beside an employer's exact figure.
  return result('salary', 'conflict', 0.5, 'stated salaries differ substantially');
}

function comparePostedDate(a: DedupCandidate, b: DedupCandidate, windowDays: number): DedupSignalResult {
  if (!a.postedAt || !b.postedAt) return unknown('posted_date', 'posted date missing on one side');
  const days = Math.abs(a.postedAt.getTime() - b.postedAt.getTime()) / 86_400_000;
  if (days <= windowDays) {
    return result('posted_date', 'match', 1 - days / windowDays, `posted ${days.toFixed(1)} days apart`);
  }
  return result('posted_date', 'conflict', 0.6, `posted ${Math.round(days)} days apart`);
}

function compareDescription(a: DedupCandidate, b: DedupCandidate): DedupSignalResult {
  const left = words(a.description);
  const right = words(b.description);
  if (left.length < 20 || right.length < 20) {
    return unknown('description_similarity', 'description too short to compare');
  }
  const similarity = jaccard(left, right);
  if (similarity >= 0.6) {
    return result(
      'description_similarity',
      'match',
      similarity,
      `descriptions ${Math.round(similarity * 100)}% similar`,
    );
  }
  return result(
    'description_similarity',
    'conflict',
    1 - similarity,
    `descriptions only ${Math.round(similarity * 100)}% similar`,
  );
}

function compareRequirements(a: DedupCandidate, b: DedupCandidate): DedupSignalResult {
  if (a.requirements.length === 0 || b.requirements.length === 0) {
    return unknown('requirements_similarity', 'requirements not extracted on both sides');
  }
  const similarity = jaccard(
    a.requirements.flatMap((r) => words(r)),
    b.requirements.flatMap((r) => words(r)),
  );
  return similarity >= 0.5
    ? result(
        'requirements_similarity',
        'match',
        similarity,
        `requirements ${Math.round(similarity * 100)}% similar`,
      )
    : result(
        'requirements_similarity',
        'conflict',
        1 - similarity,
        `requirements only ${Math.round(similarity * 100)}% similar`,
      );
}

/** Every signal, computed once. */
export function computeSignals(
  a: DedupCandidate,
  b: DedupCandidate,
  options: { postedWindowDays: number },
): DedupSignalResult[] {
  return [
    compareExternalId(a, b),
    compareUrl('canonical_url', a.canonicalUrl ?? a.sourceUrl, b.canonicalUrl ?? b.sourceUrl),
    compareUrl('application_url', a.applyUrl, b.applyUrl),
    compareAts(a, b),
    compareCompany(a, b),
    compareCompanyDomain(a, b),
    compareTitle(a, b),
    compareLocation(a, b),
    compareSalary(a, b),
    comparePostedDate(a, b, options.postedWindowDays),
    compareDescription(a, b),
    compareRequirements(a, b),
  ];
}
