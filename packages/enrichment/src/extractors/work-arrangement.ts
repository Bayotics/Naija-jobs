import type { ExtractedLocation, WorkArrangement } from '@job-intel/contracts';
import { collapseWhitespace, parseLocation } from '@job-intel/core';
import { countryFromCity } from './city-country';

/**
 * Work arrangement and location extraction.
 *
 * The distinction this module exists to protect: **"remote" is not one thing.**
 * "Remote worldwide" and "Remote — US only" are different opportunities, and a
 * model that stores both as `remote` has destroyed the only detail a candidate
 * outside the US cares about. `remoteRegions` and `remoteWorldwide` keep it.
 *
 * Likewise "hybrid" carries a cadence ("2 days in office") that decides whether
 * a role is viable for someone two hours away.
 */

const HYBRID_PATTERNS: RegExp[] = [
  /\bhybrid\b/i,
  /\b(\d)\s*(?:days?)\s*(?:per|a|\/)\s*week\s*(?:in|at)\s*(?:the\s*)?office\b/i,
  /\b(?:in|at)\s*(?:the\s*)?office\s*(\d)\s*days?\b/i,
  /\bpartially\s+remote\b/i,
  /\bsplit\s+between\s+(?:home|remote)\s+and\s+(?:the\s+)?office\b/i,
];

const REMOTE_PATTERNS: RegExp[] = [
  /\b100\s*%\s*remote\b/i,
  /\bfully\s+remote\b/i,
  /\bremote[\s-](?:first|only|friendly|based)\b/i,
  /\bwork\s+from\s+home\b/i,
  /\bwork\s+from\s+anywhere\b/i,
  /\bwfh\b/i,
  /\btelecommut(?:e|ing)\b/i,
  /\bfully\s+distributed\b/i,
  /\bdistributed\s+team\b/i,
  /\bhome[\s-]based\b/i,
  /\bremote\b/i,
];

const ONSITE_PATTERNS: RegExp[] = [
  /\bon[\s-]?site\b/i,
  /\bin[\s-]office\b/i,
  /\boffice[\s-]based\b/i,
  /\bno\s+remote\b/i,
  /\bremote\s+(?:work\s+)?is\s+not\b/i,
  /\bthis\s+is\s+not\s+a\s+remote\b/i,
];

const WORLDWIDE_PATTERNS: RegExp[] = [
  /\bremote\s*[-–—(,]?\s*(?:worldwide|globally|global|anywhere)\b/i,
  /\bwork\s+from\s+anywhere\s+in\s+the\s+world\b/i,
  /\bany\s+(?:time\s*zone|timezone|location)\b/i,
];

/**
 * Region restrictions on a remote role.
 *
 * Matched against short, high-signal text (title, location field, first lines)
 * rather than the whole description — a description that merely mentions a US
 * office does not make a role US-only.
 */
const REGION_PATTERNS: Array<{ pattern: RegExp; regions: string[] }> = [
  { pattern: /\bremote\s*[-–—(,]?\s*(?:us|usa|u\.s\.|united states)\s*(?:only|based)?\b/i, regions: ['US'] },
  { pattern: /\b(?:us|usa|united states)[\s-]based\s+(?:candidates?|applicants?|only)\b/i, regions: ['US'] },
  { pattern: /\bremote\s*[-–—(,]?\s*(?:uk|united kingdom)\s*(?:only|based)?\b/i, regions: ['GB'] },
  { pattern: /\bremote\s*[-–—(,]?\s*canada\s*(?:only|based)?\b/i, regions: ['CA'] },
  { pattern: /\bremote\s*[-–—(,]?\s*(?:eu|europe|european union)\b/i, regions: ['EU'] },
  { pattern: /\bremote\s*[-–—(,]?\s*(?:emea)\b/i, regions: ['EMEA'] },
  { pattern: /\bremote\s*[-–—(,]?\s*(?:apac|asia[\s-]pacific)\b/i, regions: ['APAC'] },
  { pattern: /\bremote\s*[-–—(,]?\s*(?:latam|latin america)\b/i, regions: ['LATAM'] },
  { pattern: /\bremote\s*[-–—(,]?\s*(?:americas)\b/i, regions: ['AMERICAS'] },
  { pattern: /\bremote\s*[-–—(,]?\s*(?:nigeria)\b/i, regions: ['NG'] },
  { pattern: /\bmust\s+(?:be\s+)?(?:located|reside|based)\s+in\s+([A-Z][\w\s]{2,30})/i, regions: [] },
  { pattern: /\beligible\s+to\s+work\s+in\s+(?:the\s+)?([A-Z][\w\s]{2,30})/i, regions: [] },
];

/** Timezone constraints, e.g. "within CET", "overlap with PST". */
const TIMEZONE_PATTERN =
  /\b(?:within|overlap(?:ping)?\s+with|aligned\s+to|in)\s+((?:CET|CEST|GMT|UTC|BST|EST|EDT|PST|PDT|WAT|IST|SGT)(?:\s*[+-]\s*\d{1,2})?)\b/i;

/** Explicit geographic restrictions that are not simple country limits. */
const GEO_RESTRICTION_PATTERNS: RegExp[] = [
  /\bwithin\s+\d{1,3}\s*(?:miles|km|kilometers)\s+of\s+[\w\s,]{2,40}/i,
  /\bmust\s+(?:be\s+)?(?:located|reside|live|based)\s+(?:in|within|near)\s+[\w\s,]{2,40}/i,
  /\bcommutable\s+distance\s+(?:to|from)\s+[\w\s,]{2,40}/i,
];

const TRAVEL_PATTERN =
  /\b(?:travel|travelling|traveling)\s+(?:requirement\s*:?\s*)?(?:up\s+to\s+)?(\d{1,3}\s*%|\w+\s+times?\s+(?:per|a)\s+(?:month|quarter|year))/i;

export interface WorkArrangementInput {
  /** The source's location field, if any. Highest-signal short text. */
  locationText: string | null;
  title: string;
  description: string | null;
  /** Structured remote flag from the source, when provided. */
  remoteFlag: boolean | null;
  tags?: readonly string[];
}

export function extractWorkArrangement(input: WorkArrangementInput): WorkArrangement {
  const shortText = collapseWhitespace(
    [input.locationText ?? '', input.title, (input.tags ?? []).join(' ')].join(' | '),
  );
  const description = input.description ?? '';
  // Cap the body scan: an arrangement stated in paragraph 40 is not the headline.
  const body = description.slice(0, 4000);
  const combined = `${shortText}\n${body}`;

  const base: WorkArrangement = {
    mode: 'unknown',
    confidence: 0,
    method: 'default',
    evidence: null,
    remoteAllowed: null,
    remoteRegions: [],
    remoteWorldwide: false,
    officeDaysPerWeek: null,
    officeLocation: null,
    relocationRequired: null,
    geographicRestriction: null,
    travelRequirement: null,
  };

  // ── Mode ──────────────────────────────────────────────────────────────────
  // Hybrid is tested first and wins: postings routinely say "hybrid — 2 days
  // remote", and reading that as fully remote is the most common error here.
  const hybridHit = firstMatch(HYBRID_PATTERNS, shortText) ?? firstMatch(HYBRID_PATTERNS, body);
  const remoteHitShort = firstMatch(REMOTE_PATTERNS, shortText);
  const onsiteHitShort = firstMatch(ONSITE_PATTERNS, shortText);

  let mode: WorkArrangement['mode'] = 'unknown';
  let confidence = 0;
  let method: WorkArrangement['method'] = 'default';
  let evidence: string | null = null;

  if (hybridHit) {
    mode = 'hybrid';
    confidence = 0.85;
    method = 'pattern';
    evidence = `matched "${hybridHit[0]}"`;
    // The office cadence lives in a different pattern from the bare word
    // "hybrid", so it is searched separately rather than read off whichever
    // pattern happened to match first.
    const days = findOfficeDays(combined);
    if (days !== null) base.officeDaysPerWeek = days;
  } else if (remoteHitShort) {
    mode = 'remote';
    confidence = 0.9;
    method = 'pattern';
    evidence = `matched "${remoteHitShort[0]}" in title/location`;
  } else if (onsiteHitShort) {
    mode = 'onsite';
    confidence = 0.85;
    method = 'pattern';
    evidence = `matched "${onsiteHitShort[0]}" in title/location`;
  } else if (input.remoteFlag === true) {
    mode = 'remote';
    confidence = 0.9;
    method = 'source_structured';
    evidence = 'source reported remote=true';
  } else if (input.remoteFlag === false && input.locationText) {
    mode = 'onsite';
    confidence = 0.75;
    method = 'source_structured';
    evidence = 'source reported remote=false with a location';
  } else {
    // Body prose is the weakest signal and is trusted least.
    const remoteBody = firstMatch(REMOTE_PATTERNS, body);
    const onsiteBody = firstMatch(ONSITE_PATTERNS, body);
    if (onsiteBody) {
      mode = 'onsite';
      confidence = 0.5;
      method = 'heuristic';
      evidence = `matched "${onsiteBody[0]}" in description`;
    } else if (remoteBody) {
      mode = 'remote';
      confidence = 0.45;
      method = 'heuristic';
      evidence = `matched "${remoteBody[0]}" in description (weak signal)`;
    }
  }

  base.mode = mode;
  base.confidence = confidence;
  base.method = method;
  base.evidence = evidence;
  base.remoteAllowed = mode === 'remote' ? true : mode === 'onsite' ? false : null;

  // ── Remote scope ──────────────────────────────────────────────────────────
  if (mode === 'remote' || mode === 'hybrid') {
    if (firstMatch(WORLDWIDE_PATTERNS, combined)) {
      base.remoteWorldwide = true;
    } else {
      const regions = new Set<string>();
      // Restricted to the short text plus the opening of the body: a country
      // named deep in a benefits paragraph is not a hiring restriction.
      const scopeText = `${shortText}\n${body.slice(0, 1200)}`;
      for (const rule of REGION_PATTERNS) {
        const match = rule.pattern.exec(scopeText);
        if (!match) continue;
        if (rule.regions.length > 0) {
          for (const region of rule.regions) regions.add(region);
        } else if (match[1]) {
          const parsed = parseLocation(match[1]);
          if (parsed.value.countryCode) regions.add(parsed.value.countryCode);
        }
      }
      base.remoteRegions = [...regions];
    }

    const tz = TIMEZONE_PATTERN.exec(`${shortText}\n${body.slice(0, 1500)}`);
    if (tz?.[1]) base.officeLocation = null; // timezone is not an office
    // Timezone hint belongs to the location record; see extractLocation below.
  }

  // ── Geographic restriction, relocation, travel ────────────────────────────
  const geo = firstMatch(GEO_RESTRICTION_PATTERNS, combined);
  if (geo) base.geographicRestriction = collapseWhitespace(geo[0]).slice(0, 300);

  if (/\brelocation\s+(?:is\s+)?required\b|\bmust\s+relocate\b/i.test(combined)) {
    base.relocationRequired = true;
  } else if (/\bno\s+relocation\s+required\b/i.test(combined)) {
    base.relocationRequired = false;
  }

  const travel = TRAVEL_PATTERN.exec(combined);
  if (travel) base.travelRequirement = collapseWhitespace(travel[0]).slice(0, 200);

  if (mode === 'hybrid' || mode === 'onsite') {
    const parsed = parseLocation(input.locationText);
    if (parsed.value.city) base.officeLocation = parsed.value.city;
  }

  return base;
}

/**
 * Structured location.
 *
 * Reuses the shared location parser so "Berlin, Germany" resolves identically
 * here and in the discovery normalizer, and adds only the timezone hint, which
 * is enrichment-specific.
 */
export function extractLocation(input: {
  locationText: string | null;
  description: string | null;
}): ExtractedLocation {
  const parsed = parseLocation(input.locationText);
  const tzMatch = TIMEZONE_PATTERN.exec(
    `${input.locationText ?? ''}\n${(input.description ?? '').slice(0, 1500)}`,
  );

  /*
   * Fall back to the city gazetteer when the posting named a city but no
   * country. Only ever fills a null — a stated country always wins, because the
   * posting knows better than any lookup table.
   */
  /*
   * The raw location field, not the parsed city. Parsing narrows "Berlin HQ" to
   * a city of "Berlin HQ" and drops nothing useful, but it can also fail
   * entirely on strings like "Hybrid (London)" — where the answer is present
   * and simply not where a city parser looks.
   */
  const countryCode =
    parsed.value.countryCode ?? countryFromCity(input.locationText ?? parsed.value.city);
  const inferredCountry = parsed.value.countryCode === null && countryCode !== null;

  return {
    raw: input.locationText,
    city: parsed.value.city,
    region: parsed.value.region,
    countryCode,
    timezoneHint: tzMatch?.[1] ? tzMatch[1].toUpperCase() : null,
    /*
     * A gazetteer hit is real evidence, but it is weaker than a stated country
     * and must not inherit the parser's confidence for a field the parser
     * failed to produce. Floored rather than replaced, so a well-parsed city
     * does not lose confidence it earned.
     */
    confidence: inferredCountry ? Math.max(parsed.confidence, 0.6) : parsed.confidence,
    method: input.locationText ? 'pattern' : 'default',
  };
}

/** Extracts a stated in-office cadence, e.g. "2 days per week in office". */
function findOfficeDays(text: string): number | null {
  const patterns = [
    /\b(\d)\s*days?\s*(?:per|a|\/)\s*week\s*(?:in|at)?\s*(?:the\s*)?(?:office|hq)?\b/i,
    /\b(?:in|at)\s*(?:the\s*)?office\s*(\d)\s*days?\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1] ? Number(match[1]) : null;
    if (value !== null && Number.isFinite(value) && value >= 0 && value <= 7) return value;
  }
  return null;
}

function firstMatch(patterns: RegExp[], text: string): RegExpExecArray | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}
