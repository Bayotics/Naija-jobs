/**
 * Deterministic text normalization shared by identity, dedup and matching.
 *
 * Everything here is pure and side-effect free so it can be unit tested without
 * a database and reused unchanged by the semantic dedup stage in prompt 12.
 */

/** Legal-entity suffixes stripped before comparing company names. */
const COMPANY_SUFFIXES = [
  'inc',
  'incorporated',
  'llc',
  'l l c',
  'ltd',
  'limited',
  'plc',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'ag',
  'bv',
  'nv',
  'sa',
  'sas',
  'srl',
  'spa',
  'ab',
  'oy',
  'as',
  'aps',
  'pty',
  'pte',
  'kk',
  'kg',
  'ug',
  'sarl',
];

/**
 * Tokens that carry no discriminating signal in a job title.
 * Kept small on purpose: over-stripping merges genuinely different roles.
 */
const TITLE_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'for',
  'to',
  'in',
  'at',
  'with',
  'job',
  'role',
  'position',
  'opening',
  'vacancy',
  'hiring',
  'wanted',
  'urgent',
  'new',
]);

/** Gendered job-ad markers common in DE/FR/NL postings. */
const GENDER_MARKERS = /\((?:m|w|f|h|d|x)(?:\s*\/\s*(?:m|w|f|h|d|x))+\)/gi;

export function stripDiacritics(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Canonical company key. `Acme Inc.` , `ACME, Inc` and `Acme` all collapse to
 * `acme`, which is what makes cross-source blocking work at all.
 */
export function normalizeCompanyName(name: string): string {
  let out = stripDiacritics(name).toLowerCase();
  out = out.replace(/&/g, ' and ');
  out = out.replace(/[^a-z0-9\s]/g, ' ');
  out = collapseWhitespace(out);

  // Strip trailing legal suffixes repeatedly ("acme holdings ltd co").
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of COMPANY_SUFFIXES) {
      if (out.endsWith(` ${suffix}`)) {
        out = out.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return collapseWhitespace(out);
}

/**
 * Order-insensitive title key.
 *
 * Tokens are sorted so "Backend Engineer" and "Engineer, Backend" produce the
 * same key. This is a *blocking* key: high recall is the goal, and precision is
 * restored by the verification step before any merge is committed.
 */
export function normalizeTitle(title: string): string {
  let out = stripDiacritics(title).toLowerCase();
  out = out.replace(GENDER_MARKERS, ' ');
  out = out.replace(/\([^)]*\)/g, ' '); // parentheticals: "(Remote)", "(Contract)"
  out = out.replace(/[^a-z0-9+#.\s]/g, ' '); // keep c++, c#, .net
  out = collapseWhitespace(out);

  const tokens = out
    .split(' ')
    .filter((t) => t.length > 0 && !TITLE_STOPWORDS.has(t))
    .sort();

  return tokens.join(' ');
}

/** Human-readable title cleanup for display — preserves word order. */
export function cleanTitle(title: string): string {
  return collapseWhitespace(title.replace(GENDER_MARKERS, ' ').replace(/\s*[-–—|]\s*$/, ''));
}

/**
 * Query parameters removed before comparing URLs.
 *
 * Exposed as a mutable default so the list becomes a configurable value in
 * `app_config` (see the architecture's configurable-decisions section) rather
 * than a constant baked into the binary.
 */
export const DEFAULT_TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gh_src',
  'gh_jid',
  'ref',
  'referrer',
  'source',
  'src',
  'from',
  'trk',
  'trackingId',
  'lever-source',
  'lever-origin',
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  '_ga',
];

export interface NormalizeUrlOptions {
  trackingParams?: readonly string[];
  /** Keep the fragment. Off by default: `#apply` is not a different job. */
  keepFragment?: boolean;
}

/**
 * Canonical URL form used for exact cross-source matching.
 *
 * Two boards linking the same Greenhouse posting differ only by tracking
 * parameters and host casing; after this they are byte-identical.
 * Returns null for anything unparseable rather than throwing — a malformed URL
 * from a source is data, not an exception.
 */
export function normalizeUrl(
  rawUrl: string,
  options: NormalizeUrlOptions = {},
): string | null {
  const tracking = new Set(
    (options.trackingParams ?? DEFAULT_TRACKING_PARAMS).map((p) => p.toLowerCase()),
  );

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.protocol = 'https:'; // http/https of the same page is the same page
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (
    (url.port === '80' && url.protocol === 'http:') ||
    (url.port === '443' && url.protocol === 'https:')
  ) {
    url.port = '';
  }
  if (!options.keepFragment) url.hash = '';

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !tracking.has(key.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);

  let out = url.toString();
  // Drop a trailing slash on a path, but never turn "https://x.com/" into "https://x.com"
  if (out.endsWith('/') && url.pathname !== '/') out = out.slice(0, -1);
  return out;
}

/** ISO-8601 year-week, e.g. `2026-W33`. Used as a coarse time bucket. */
export function isoYearWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Word shingles used as SimHash features. */
export function shingles(text: string, size = 3): string[] {
  const words = collapseWhitespace(stripDiacritics(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' '))
    .split(' ')
    .filter(Boolean);
  if (words.length < size) return words.length > 0 ? [words.join(' ')] : [];

  const out: string[] = [];
  for (let i = 0; i <= words.length - size; i += 1) {
    out.push(words.slice(i, i + size).join(' '));
  }
  return out;
}
