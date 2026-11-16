import { remoteGeographySchema, type RemoteGeography } from '@job-intel/contracts';

/**
 * What a posting means when it says "remote".
 *
 * This is the highest-value extraction in the whole matching layer, and the
 * reason is arithmetic: a candidate in Lagos shown a hundred "remote" roles
 * that all quietly mean "remote within the United States" has been shown a
 * hundred rejections. The failure is invisible to every other part of the
 * system — the skills match, the salary matches, the title matches — and it
 * wastes the candidate's time in the most demoralising possible way.
 *
 * The patterns are deliberately narrow. A wrong *positive* here is far worse
 * than a miss: telling someone a role is open to them when it is not costs them
 * an application, while leaving it `UNSPECIFIED` costs them a glance. So
 * anything that does not clearly state a restriction stays unresolved rather
 * than being optimistically read as global.
 */

/** Regions that appear as such in postings, with the phrases that name them. */
const REGION_PATTERNS: ReadonlyArray<{ region: string; pattern: RegExp }> = [
  { region: 'US', pattern: /\b(?:us|usa|u\.s\.|united states|america)[- ]?(?:only|based|residents?)?\b/i },
  { region: 'EU', pattern: /\b(?:eu|european union|europe)[- ]?(?:only|based|wide)?\b/i },
  { region: 'EMEA', pattern: /\bemea\b/i },
  { region: 'APAC', pattern: /\bapac\b/i },
  { region: 'LATAM', pattern: /\b(?:latam|latin america)\b/i },
  { region: 'UK', pattern: /\b(?:uk|united kingdom|britain)[- ]?(?:only|based)?\b/i },
  { region: 'CANADA', pattern: /\bcanada\b/i },
];

/** Country names that show up in remote restrictions, mapped to ISO codes. */
const COUNTRY_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp }> = [
  { code: 'US', pattern: /\bunited states\b|\bu\.?s\.?a?\b/i },
  { code: 'GB', pattern: /\bunited kingdom\b|\bengland\b|\bbritain\b/i },
  { code: 'DE', pattern: /\bgermany\b|\bdeutschland\b/i },
  { code: 'FR', pattern: /\bfrance\b/i },
  { code: 'ES', pattern: /\bspain\b/i },
  { code: 'PT', pattern: /\bportugal\b/i },
  { code: 'NL', pattern: /\bnetherlands\b/i },
  { code: 'PL', pattern: /\bpoland\b/i },
  { code: 'CA', pattern: /\bcanada\b/i },
  { code: 'AU', pattern: /\baustralia\b/i },
  { code: 'IN', pattern: /\bindia\b/i },
  { code: 'NG', pattern: /\bnigeria\b/i },
  { code: 'ZA', pattern: /\bsouth africa\b/i },
  { code: 'KE', pattern: /\bkenya\b/i },
  { code: 'BR', pattern: /\bbrazil\b/i },
  { code: 'IE', pattern: /\bireland\b/i },
];

/**
 * Phrases that genuinely mean "anywhere".
 *
 * Short list on purpose. "Fully remote" is *not* here: it describes the working
 * arrangement, not the hiring geography, and a great many US-only roles
 * describe themselves as fully remote.
 */
const GLOBAL_PATTERNS: readonly RegExp[] = [
  /\bremote\s*[-—:]?\s*(?:world ?wide|globally?|anywhere)\b/i,
  /\bwork from anywhere\b/i,
  /\banywhere in the world\b/i,
  /\bglobally distributed\b/i,
  /\bno location requirement\b/i,
];

/** Phrases that say a restriction exists, even when the place is unclear. */
const RESTRICTION_MARKERS: readonly RegExp[] = [
  /\bmust (?:be|reside|live) (?:located |based )?in\b/i,
  /\bauthori[sz]ed to work in\b/i,
  /\bresidents? of\b/i,
  /\bwithin\b[^.]{0,20}\b(?:hours|time ?zones?)\b/i,
  /\bonly\b[^.]{0,30}\b(?:candidates|applicants)\b/i,
];

const TIMEZONE_PATTERN =
  /\b(?:utc|gmt)\s*([+-]\s*\d{1,2})(?:\s*(?:to|–|-|through)\s*(?:utc|gmt)?\s*([+-]?\s*\d{1,2}))?/gi;

const HYBRID_DAYS_PATTERN =
  /\b(\d)\s*(?:\+)?\s*days?\s*(?:per week\s*)?(?:in (?:the )?office|on[- ]?site)\b/i;

export interface ReachInput {
  /** The normalised arrangement from enrichment. */
  arrangement: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  /** Location string as the posting wrote it. */
  locationText: string | null;
  /** Full description, where restrictions are usually buried. */
  description: string | null;
  /** Structured country codes from enrichment, when it found any. */
  knownCountries?: readonly string[];
}

/**
 * Reads the hiring geography out of a posting.
 *
 * The order of the checks matters: an explicit global statement wins, then
 * explicit countries, then regions, then time zones, and silence is the last
 * resort rather than the first assumption.
 */
export function extractRemoteReach(input: ReachInput): RemoteGeography {
  const haystack = [input.locationText ?? '', input.description ?? ''].join('\n');

  if (input.arrangement === 'onsite') {
    return remoteGeographySchema.parse({
      arrangement: 'onsite',
      reach: 'UNSPECIFIED',
      officeLocation: input.locationText,
      evidence: input.locationText,
      confidence: 0.8,
    });
  }

  if (input.arrangement === 'hybrid') {
    const days = HYBRID_DAYS_PATTERN.exec(haystack);

    return remoteGeographySchema.parse({
      arrangement: 'hybrid',
      reach: 'UNSPECIFIED',
      onsiteDaysPerWeek: days ? Number(days[1]) : null,
      officeLocation: input.locationText,
      evidence: days?.[0] ?? input.locationText,
      confidence: days ? 0.8 : 0.5,
    });
  }

  if (input.arrangement !== 'remote') {
    return remoteGeographySchema.parse({
      arrangement: 'unknown',
      reach: 'UNSPECIFIED',
      evidence: input.locationText,
      confidence: 0.2,
    });
  }

  // ── Remote from here on ──────────────────────────────────────────────────

  for (const pattern of GLOBAL_PATTERNS) {
    const match = pattern.exec(haystack);

    if (match) {
      return remoteGeographySchema.parse({
        arrangement: 'remote',
        reach: 'GLOBAL',
        evidence: match[0],
        confidence: 0.85,
      });
    }
  }

  /*
   * Structured countries from enrichment are trusted above anything read out of
   * prose — they came from a field the publisher filled in deliberately.
   */
  const structured = [...(input.knownCountries ?? [])];

  if (structured.length > 0) {
    return remoteGeographySchema.parse({
      arrangement: 'remote',
      reach: 'COUNTRY_RESTRICTED',
      countries: structured.map((code) => code.toUpperCase()),
      evidence: `Structured location data: ${structured.join(', ')}`,
      confidence: 0.9,
    });
  }

  const restricted = RESTRICTION_MARKERS.some((pattern) => pattern.test(haystack));

  const countries = COUNTRY_PATTERNS.filter((entry) => entry.pattern.test(haystack)).map(
    (entry) => entry.code,
  );

  const regions = REGION_PATTERNS.filter((entry) => entry.pattern.test(haystack)).map(
    (entry) => entry.region,
  );

  /*
   * A named place only counts as a restriction when the posting also says
   * something restrictive. Mentioning Germany is not the same as hiring only
   * from Germany — a company headquartered in Berlin can hire anywhere, and
   * treating every mention as a boundary would reject most of the market.
   */
  if (restricted && countries.length > 0) {
    return remoteGeographySchema.parse({
      arrangement: 'remote',
      reach: 'COUNTRY_RESTRICTED',
      countries,
      regions,
      evidence: haystack.match(RESTRICTION_MARKERS.find((p) => p.test(haystack))!)?.[0] ?? null,
      confidence: 0.75,
    });
  }

  if (restricted && regions.length > 0) {
    return remoteGeographySchema.parse({
      arrangement: 'remote',
      reach: 'REGION_RESTRICTED',
      regions,
      countries,
      evidence: `Restricted to ${regions.join(', ')}`,
      confidence: 0.7,
    });
  }

  const offsets: number[] = [];
  TIMEZONE_PATTERN.lastIndex = 0;

  for (const match of haystack.matchAll(TIMEZONE_PATTERN)) {
    const start = Number(match[1]?.replace(/\s+/g, ''));
    if (Number.isFinite(start)) offsets.push(start);

    if (match[2]) {
      const end = Number(match[2].replace(/\s+/g, ''));
      if (Number.isFinite(end)) offsets.push(end);
    }
  }

  if (offsets.length > 0) {
    return remoteGeographySchema.parse({
      arrangement: 'remote',
      reach: 'TIMEZONE_RESTRICTED',
      timezoneOffsets: offsets,
      regions,
      evidence: `Time-zone overlap required (UTC ${offsets.join(' to UTC ')})`,
      confidence: 0.65,
    });
  }

  /*
   * The honest default.
   *
   * Most remote postings say nothing about where they hire from. Calling that
   * GLOBAL would invent an eligibility the posting never offered; calling it
   * restricted would reject most of the remote market on no evidence. It stays
   * unresolved, and the candidate is told that is what it is.
   */
  return remoteGeographySchema.parse({
    arrangement: 'remote',
    reach: 'UNSPECIFIED',
    regions,
    countries,
    evidence: input.locationText,
    confidence: 0.35,
  });
}
