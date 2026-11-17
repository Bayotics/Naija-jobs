/**
 * Schema.org JobPosting extraction.
 *
 * This is the highest-quality discovery mechanism available on the open web,
 * and it is worth reaching for first every single time. A publisher that emits
 * JSON-LD has already done the structuring: the salary is a number with a
 * currency and a period, the location is a country code, the posting date is
 * ISO-8601. Everything downstream would otherwise have to infer those from
 * prose, and inference is where job data goes wrong.
 *
 * Two properties this module holds to:
 *
 *  - **Nothing is invented.** A field the markup does not state comes back
 *    `null`. Publishers routinely emit partial JobPosting objects, and a
 *    plausible guess is indistinguishable from a fact once it is in the
 *    database.
 *  - **Malformed markup is normal.** Real pages ship JSON-LD with trailing
 *    commas, HTML entities, `@graph` wrappers, arrays where the spec says
 *    object, and objects where it says array. Every one of those is handled by
 *    returning what could be read rather than by throwing.
 */

export interface ExtractedJobPosting {
  title: string | null;
  description: string | null;
  descriptionIsHtml: boolean;
  datePosted: Date | null;
  validThrough: Date | null;
  employmentTypes: string[];
  hiringOrganization: string | null;
  organizationUrl: string | null;
  organizationLogo: string | null;
  /** Human-readable location, assembled from the address parts present. */
  locationText: string | null;
  countryCode: string | null;
  city: string | null;
  region: string | null;
  jobLocationType: string | null;
  /** ISO-3166 codes from `applicantLocationRequirements`, for remote roles. */
  applicantLocationRequirements: string[];
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  identifier: string | null;
  directApplyUrl: string | null;
  /** Which block this came from, for the provenance trail. */
  extractedFrom: 'json_ld' | 'microdata';
  /** Fields present in the markup, so partial extractions are visible. */
  fieldsPresent: string[];
}

/** Everything found on one page, in document order. */
export interface SchemaOrgExtraction {
  postings: ExtractedJobPosting[];
  /** Non-JobPosting types seen, useful for deciding what a page actually is. */
  otherTypes: string[];
  /** Blocks that looked like JSON-LD but could not be parsed. */
  malformedBlocks: number;
}

const SCRIPT_RE = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Extracts every JSON-LD block, tolerating the malformed ones. */
export function extractJsonLdBlocks(html: string): { values: unknown[]; malformed: number } {
  const values: unknown[] = [];
  let malformed = 0;

  for (const match of html.matchAll(SCRIPT_RE)) {
    const raw = match[1];
    if (!raw) continue;

    // HTML-escaped JSON is common when a CMS renders the block through a
    // template that escapes by default.
    const text = raw
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .trim();

    if (!text) continue;

    try {
      values.push(JSON.parse(text));
    } catch {
      // One more attempt after stripping trailing commas, which are the single
      // most common defect in hand-written JSON-LD.
      try {
        values.push(JSON.parse(text.replace(/,\s*([}\]])/g, '$1')));
      } catch {
        malformed += 1;
      }
    }
  }

  return { values, malformed };
}

/** Flattens `@graph`, arrays and nested `mainEntity` into a list of nodes. */
function flattenNodes(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || value === null || typeof value !== 'object') return [];

  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenNodes(entry, depth + 1));
  }

  const node = value as Record<string, unknown>;
  const nodes: Record<string, unknown>[] = [node];

  for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item']) {
    if (key in node) nodes.push(...flattenNodes(node[key], depth + 1));
  }

  return nodes;
}

/**
 * Resolves a JSON-LD `@id` reference against the rest of the document.
 *
 * Schema.org lets a document say the same thing two ways. Most sites inline
 * the organisation:
 *
 *     "hiringOrganization": { "@type": "Organization", "name": "Acme" }
 *
 * Jobberman — and anything else built on a normalised graph — instead emits a
 * pointer, and puts the organisation beside the posting in the same `@graph`:
 *
 *     "hiringOrganization": { "@id": ".../Organization/agency-1273500" }
 *     ...
 *     { "@type": "Organization", "@id": ".../agency-1273500", "name": "SENCE" }
 *
 * Reading only the first form loses every company name on such a site. Ours
 * then fell back to the host, so 681 postings claimed to be hiring at
 * "jobberman.com" — a value that is not wrong enough to look broken, which is
 * what made it survive.
 */
type NodeIndex = ReadonlyMap<string, Record<string, unknown>>;

function indexById(nodes: readonly Record<string, unknown>[]): NodeIndex {
  const index = new Map<string, Record<string, unknown>>();

  for (const node of nodes) {
    const id = node['@id'];
    // First writer wins. A duplicate @id is malformed, and preferring the
    // earlier node keeps the result stable rather than order-dependent on a
    // detail the publisher got wrong.
    if (typeof id === 'string' && id.length > 0 && !index.has(id)) index.set(id, node);
  }

  return index;
}

/**
 * Follows a reference once.
 *
 * Once, not transitively: a chain of references is either a loop or a document
 * doing something this parser should not be guessing at, and one hop covers
 * every real case.
 */
function deref(value: unknown, index: NodeIndex): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;

  const node = value as Record<string, unknown>;
  const id = node['@id'];
  if (typeof id !== 'string') return value;

  const target = index.get(id);
  // A reference that resolves to itself is not a reference.
  if (!target || target === node) return value;

  // Merge rather than replace: a node may carry both a pointer and some
  // inline fields, and the inline ones are the more specific statement.
  return { ...target, ...node };
}

function typesOf(node: Record<string, unknown>): string[] {
  const raw = node['@type'] ?? node.type;
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  return [];
}

function str(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number') return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    // Strips currency symbols and thousands separators without inventing a
    // value: a string with no digits returns null.
    const cleaned = value.replace(/[^\d.-]/g, '');
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function date(value: unknown): Date | null {
  const text = str(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Reads a nested value that may be a plain string, an object, or an array. */
function pick(node: unknown, ...keys: string[]): unknown {
  if (node === null || typeof node !== 'object') return undefined;
  const target = Array.isArray(node) ? node[0] : node;
  if (target === null || typeof target !== 'object') return undefined;
  for (const key of keys) {
    const value = (target as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

const SALARY_PERIODS: Record<string, string> = {
  hour: 'hour',
  hourly: 'hour',
  day: 'day',
  daily: 'day',
  week: 'week',
  weekly: 'week',
  month: 'month',
  monthly: 'month',
  year: 'year',
  yearly: 'year',
  annual: 'year',
};

function normalisePeriod(value: unknown): string | null {
  const text = str(value)?.toLowerCase();
  if (!text) return null;
  return SALARY_PERIODS[text] ?? null;
}

/** Assembles the location fields from `jobLocation`, which is often an array. */
function readLocation(node: Record<string, unknown>): {
  locationText: string | null;
  countryCode: string | null;
  city: string | null;
  region: string | null;
} {
  const location = node.jobLocation;
  const address = pick(location, 'address') ?? pick(location, 'location');

  const city = str(pick(address, 'addressLocality'));
  const region = str(pick(address, 'addressRegion'));
  const rawCountry = pick(address, 'addressCountry');
  const country = str(rawCountry) ?? str(pick(rawCountry, 'name', 'alternateName', 'identifier'));

  // ISO-3166 alpha-2 only when the markup actually supplies one; a full
  // country name is left to the normalizer, which owns that mapping.
  const countryCode = country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null;

  const parts = [city, region, country].filter((part): part is string => Boolean(part));
  const named = str(pick(location, 'name'));

  return {
    locationText: parts.length > 0 ? parts.join(', ') : named,
    countryCode,
    city,
    region,
  };
}

function readSalary(node: Record<string, unknown>): {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: string | null;
} {
  const base = node.baseSalary;
  if (!base) return { min: null, max: null, currency: null, period: null };

  const currency = str(pick(base, 'currency')) ?? str(pick(base, 'salaryCurrency'));
  const value = pick(base, 'value');

  // `value` is a MonetaryAmount: either a single `value` or a min/max pair.
  const min = num(pick(value, 'minValue')) ?? num(pick(value, 'value'));
  const max = num(pick(value, 'maxValue')) ?? num(pick(value, 'value'));
  const period = normalisePeriod(pick(value, 'unitText')) ?? normalisePeriod(pick(base, 'unitText'));

  return {
    min,
    max,
    currency: currency ? currency.toUpperCase().slice(0, 3) : null,
    period,
  };
}

function readApplicantRequirements(node: Record<string, unknown>): string[] {
  const raw = node.applicantLocationRequirements;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((entry) => str(pick(entry, 'name')) ?? str(entry))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 20);
}

function toPosting(node: Record<string, unknown>, index: NodeIndex = new Map()): ExtractedJobPosting {
  const description = str(node.description);
  const location = readLocation(node);
  const salary = readSalary(node);

  const employmentRaw = node.employmentType;
  const employmentTypes = (
    Array.isArray(employmentRaw) ? employmentRaw : employmentRaw ? [employmentRaw] : []
  )
    .map((entry) => str(entry))
    .filter((entry): entry is string => Boolean(entry));

  const identifier =
    str(pick(node.identifier, 'value')) ?? str(node.identifier) ?? str(node.jobPostingId);

  const fieldsPresent = [
    'title',
    'description',
    'datePosted',
    'validThrough',
    'employmentType',
    'hiringOrganization',
    'jobLocation',
    'baseSalary',
    'jobLocationType',
    'applicantLocationRequirements',
    'identifier',
    'directApply',
  ].filter((key) => node[key] !== undefined && node[key] !== null);

  return {
    title: str(node.title) ?? str(node.name),
    description,
    // A description containing tags is HTML; the caller decides whether to
    // strip it. Sniffing here beats trusting a `descriptionFormat` nobody sets.
    descriptionIsHtml: Boolean(description && /<[a-z][\s\S]*>/i.test(description)),
    datePosted: date(node.datePosted),
    validThrough: date(node.validThrough),
    employmentTypes,
    hiringOrganization:
      str(pick(deref(node.hiringOrganization, index), 'name')) ?? str(node.hiringOrganization),
    organizationUrl: str(pick(deref(node.hiringOrganization, index), 'url')) ?? null,
    organizationLogo:
      str(pick(node.hiringOrganization, 'logo')) ??
      str(pick(pick(node.hiringOrganization, 'logo'), 'url')),
    ...location,
    jobLocationType: str(node.jobLocationType),
    applicantLocationRequirements: readApplicantRequirements(node),
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    salaryPeriod: salary.period,
    identifier,
    directApplyUrl: str(node.url) ?? str(pick(node.potentialAction, 'target')),
    extractedFrom: 'json_ld',
    fieldsPresent,
  };
}

/**
 * Reads every JobPosting on a page.
 *
 * Returns an array because index pages legitimately carry many, and a job page
 * occasionally carries the posting plus a BreadcrumbList and an Organization.
 * `otherTypes` reports what else was there, which is how the auto-detector
 * tells a job page from a careers index.
 */
export function extractJobPostings(html: string): SchemaOrgExtraction {
  const { values, malformed } = extractJsonLdBlocks(html);
  const postings: ExtractedJobPosting[] = [];
  const otherTypes = new Set<string>();

  /*
   * Every node first, then the postings.
   *
   * The organisation a posting points at may appear after it in the document,
   * so a single pass that parsed each posting as it was found could not
   * resolve a forward reference.
   */
  const allNodes = values.flatMap((value) => flattenNodes(value));
  const index = indexById(allNodes);

  for (const node of allNodes) {
    const types = typesOf(node);
    if (types.some((type) => type.toLowerCase().endsWith('jobposting'))) {
      postings.push(toPosting(node, index));
    } else {
      for (const type of types) otherTypes.add(type);
    }
  }

  return { postings, otherTypes: [...otherTypes], malformedBlocks: malformed };
}

/**
 * Microdata fallback.
 *
 * Deliberately shallow: full microdata parsing needs a DOM, and the pages that
 * still use it overwhelmingly do so with flat `itemprop` attributes inside one
 * `itemscope`. This recovers title, company, date and location from those, and
 * declines to guess at anything nested.
 */
export function extractMicrodataJobPosting(html: string): ExtractedJobPosting | null {
  if (!/itemtype\s*=\s*["'][^"']*schema\.org\/JobPosting["']/i.test(html)) return null;

  const prop = (name: string): string | null => {
    const pattern = new RegExp(
      `itemprop\\s*=\\s*["']${name}["'][^>]*?(?:content\\s*=\\s*["']([^"']*)["'])?[^>]*>([^<]*)`,
      'i',
    );
    const match = pattern.exec(html);
    if (!match) return null;
    const value = (match[1] ?? match[2] ?? '').trim();
    return value.length > 0 ? value : null;
  };

  const title = prop('title');
  if (!title) return null;

  const country = prop('addressCountry');

  return {
    title,
    description: prop('description'),
    descriptionIsHtml: false,
    datePosted: date(prop('datePosted')),
    validThrough: date(prop('validThrough')),
    employmentTypes: [prop('employmentType')].filter((v): v is string => Boolean(v)),
    hiringOrganization: prop('hiringOrganization') ?? prop('name'),
    organizationUrl: null,
    organizationLogo: null,
    locationText: [prop('addressLocality'), prop('addressRegion'), country]
      .filter((part): part is string => Boolean(part))
      .join(', ') || null,
    countryCode: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
    city: prop('addressLocality'),
    region: prop('addressRegion'),
    jobLocationType: prop('jobLocationType'),
    applicantLocationRequirements: [],
    salaryMin: num(prop('minValue')),
    salaryMax: num(prop('maxValue')),
    salaryCurrency: prop('currency'),
    salaryPeriod: normalisePeriod(prop('unitText')),
    identifier: prop('identifier'),
    directApplyUrl: null,
    extractedFrom: 'microdata',
    fieldsPresent: ['title'],
  };
}

/** JSON-LD first, microdata only when it found nothing. */
export function extractStructuredJobs(html: string): SchemaOrgExtraction {
  const jsonLd = extractJobPostings(html);
  if (jsonLd.postings.length > 0) return jsonLd;

  const microdata = extractMicrodataJobPosting(html);
  return microdata
    ? { postings: [microdata], otherTypes: jsonLd.otherTypes, malformedBlocks: jsonLd.malformedBlocks }
    : jsonLd;
}
