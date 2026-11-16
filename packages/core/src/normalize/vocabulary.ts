import type { EmploymentType, RemoteType, SeniorityLevel } from '@job-intel/contracts';

/**
 * Term vocabularies used to map source-specific wording onto the internal
 * enums.
 *
 * These are *defaults*, not constants: every map is passed into the normalizer
 * as an override-able option so the vocabulary becomes a runtime-configurable
 * value (see the architecture's configurable-decisions list) rather than
 * something that requires a release to extend.
 *
 * Matching is deliberately conservative. A term only maps when it is
 * unambiguous — "hybrid remote" must not resolve to `remote`, and a stray
 * "remote" inside a sentence must not override an explicit on-site statement.
 */

export interface TermRule<T> {
  value: T;
  /** Matched case-insensitively against normalized whitespace. */
  patterns: RegExp[];
  /** Higher wins when several rules match. */
  weight: number;
}

/**
 * Order matters only through `weight`. Hybrid outranks both remote and onsite
 * because postings routinely say "hybrid — 2 days remote", and reading that as
 * fully remote is the single most common normalization error in this domain.
 */
export const REMOTE_TERM_RULES: ReadonlyArray<TermRule<RemoteType>> = [
  {
    value: 'hybrid',
    weight: 30,
    patterns: [/\bhybrid\b/i, /\bpartially?\s+remote\b/i, /\b\d\s*days?\s+(?:in|at)\s+(?:the\s+)?office\b/i],
  },
  {
    value: 'remote',
    weight: 20,
    patterns: [
      /\bfully?[\s-]remote\b/i,
      /\b100\s*%\s*remote\b/i,
      /\bremote[\s-](?:first|only|friendly)\b/i,
      /\bwork\s+from\s+home\b/i,
      /\bwork[\s-]from[\s-]anywhere\b/i,
      /\bwfh\b/i,
      /\btelecommut(?:e|ing)\b/i,
      /\bhome[\s-]based\b/i,
      /\bdistributed\s+team\b/i,
      /^\s*remote\s*$/i,
      /\bremote\b/i,
    ],
  },
  {
    value: 'onsite',
    weight: 10,
    patterns: [
      /\bon[\s-]?site\b/i,
      /\bin[\s-]office\b/i,
      /\boffice[\s-]based\b/i,
      /\bno\s+remote\b/i,
      /\bnot\s+(?:a\s+)?remote\b/i,
    ],
  },
];

export const EMPLOYMENT_TERM_RULES: ReadonlyArray<TermRule<EmploymentType>> = [
  {
    value: 'full_time',
    weight: 10,
    patterns: [/\bfull[\s_-]?time\b/i, /\bpermanent\b/i, /\bfestanstellung\b/i, /\bvollzeit\b/i, /\bfte\b/i],
  },
  {
    value: 'part_time',
    weight: 10,
    patterns: [/\bpart[\s_-]?time\b/i, /\bteilzeit\b/i],
  },
  {
    value: 'contract',
    weight: 10,
    patterns: [/\bcontract(?:or|ing)?\b/i, /\bb2b\b/i, /\bfixed[\s-]term\b/i, /\bconsultant\b/i],
  },
  {
    value: 'internship',
    weight: 10,
    patterns: [/\bintern(?:ship)?\b/i, /\bpraktikum\b/i, /\bindustrial\s+training\b/i, /\bsiwes\b/i],
  },
  {
    value: 'temporary',
    weight: 10,
    patterns: [/\btemporary\b/i, /\btemp\b/i, /\bseasonal\b/i, /\blocum\b/i],
  },
  {
    value: 'freelance',
    weight: 10,
    patterns: [/\bfreelance(?:r)?\b/i, /\bgig\b/i],
  },
  {
    value: 'apprenticeship',
    weight: 10,
    patterns: [/\bapprentice(?:ship)?\b/i, /\bausbildung\b/i, /\btrainee\b/i, /\bnysc\b/i],
  },
];

/**
 * Seniority inference from a job title.
 *
 * Titles are far more reliable than descriptions here, so the normalizer only
 * consults the title and reports a confidence alongside the value.
 */
export const SENIORITY_TERM_RULES: ReadonlyArray<TermRule<SeniorityLevel>> = [
  { value: 'intern', weight: 60, patterns: [/\bintern(?:ship)?\b/i, /\btrainee\b/i, /\bnysc\b/i] },
  { value: 'executive', weight: 55, patterns: [/\b(?:chief|c[teoif]o)\b/i, /\bvp\b/i, /\bvice\s+president\b/i, /\bhead\s+of\b/i] },
  { value: 'director', weight: 50, patterns: [/\bdirector\b/i] },
  { value: 'manager', weight: 45, patterns: [/\bmanager\b/i, /\bmanagement\b/i] },
  { value: 'principal', weight: 42, patterns: [/\bprincipal\b/i, /\bdistinguished\b/i, /\barchitect\b/i] },
  { value: 'staff', weight: 40, patterns: [/\bstaff\b/i] },
  { value: 'lead', weight: 38, patterns: [/\blead\b/i, /\bteam\s+lead\b/i, /\btech\s+lead\b/i] },
  { value: 'senior', weight: 35, patterns: [/\bsenior\b/i, /\bsr\.?\b/i, /\bexperienced\b/i, /\bIII\b/] },
  { value: 'junior', weight: 25, patterns: [/\bjunior\b/i, /\bjr\.?\b/i, /\bI\b(?!I)/] },
  { value: 'entry', weight: 20, patterns: [/\bentry[\s-]level\b/i, /\bgraduate\b/i, /\bfresher\b/i] },
  { value: 'mid', weight: 15, patterns: [/\bmid[\s-]?(?:level|senior)?\b/i, /\bintermediate\b/i, /\bII\b/] },
];

/**
 * Currency symbols and codes seen in salary strings.
 * `₦` matters here — Nigerian boards state salaries in naira far more often
 * than they state them in anything else.
 */
export const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  $: 'USD',
  'US$': 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '₦': 'NGN',
  '₹': 'INR',
  '¥': 'JPY',
  'C$': 'CAD',
  'A$': 'AUD',
  R: 'ZAR',
  'CHF': 'CHF',
  'kr': 'SEK',
  'zł': 'PLN',
};

/** Multipliers projecting a stated period onto an annual figure. */
export const PERIOD_MULTIPLIERS: Readonly<Record<string, number>> = {
  hour: 2080,
  day: 260,
  week: 52,
  month: 12,
  year: 1,
};

/**
 * Indicative FX rates, used only to produce a comparable annual USD figure.
 *
 * Deliberately approximate and deliberately overridable: this exists so a
 * salary floor can be compared across currencies at all, not to be accurate to
 * the cent. A live FX provider replaces this map without touching the callers.
 */
export const DEFAULT_FX_TO_USD: Readonly<Record<string, number>> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  CAD: 0.73,
  AUD: 0.66,
  CHF: 1.12,
  SEK: 0.095,
  NOK: 0.093,
  DKK: 0.145,
  PLN: 0.25,
  CZK: 0.043,
  INR: 0.012,
  JPY: 0.0066,
  ZAR: 0.055,
  NGN: 0.00065,
  KES: 0.0077,
  GHS: 0.068,
  EGP: 0.021,
  BRL: 0.18,
  MXN: 0.05,
  SGD: 0.74,
  AED: 0.27,
};

/** Country names and demonyms → ISO 3166-1 alpha-2. Extended via options. */
export const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  nigeria: 'NG',
  ng: 'NG',
  'united states': 'US',
  usa: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  america: 'US',
  'united kingdom': 'GB',
  uk: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  germany: 'DE',
  deutschland: 'DE',
  netherlands: 'NL',
  holland: 'NL',
  ireland: 'IE',
  france: 'FR',
  spain: 'ES',
  portugal: 'PT',
  italy: 'IT',
  poland: 'PL',
  canada: 'CA',
  australia: 'AU',
  india: 'IN',
  'south africa': 'ZA',
  kenya: 'KE',
  ghana: 'GH',
  egypt: 'EG',
  brazil: 'BR',
  mexico: 'MX',
  singapore: 'SG',
  japan: 'JP',
  switzerland: 'CH',
  sweden: 'SE',
  norway: 'NO',
  denmark: 'DK',
  finland: 'FI',
  belgium: 'BE',
  austria: 'AT',
  'czech republic': 'CZ',
  czechia: 'CZ',
  romania: 'RO',
  ukraine: 'UA',
  turkey: 'TR',
  'united arab emirates': 'AE',
  uae: 'AE',
};

/** Nigerian states/cities, so "Lekki, Lagos" resolves to a country at all. */
export const NIGERIAN_LOCATIONS: ReadonlySet<string> = new Set([
  'lagos',
  'abuja',
  'fct',
  'port harcourt',
  'ibadan',
  'kano',
  'kaduna',
  'benin city',
  'enugu',
  'abeokuta',
  'onitsha',
  'warri',
  'jos',
  'ilorin',
  'owerri',
  'uyo',
  'calabar',
  'akure',
  'oyo',
  'ogun',
  'rivers',
  'delta',
  'anambra',
  'imo',
  'edo',
  'kwara',
  'osun',
  'ondo',
  'ekiti',
  'abia',
  'lekki',
  'ikeja',
  'victoria island',
  'yaba',
  'surulere',
]);

/**
 * Phrases indicating the posting is not a location at all.
 * Used to avoid inventing a city from "Worldwide" or "Anywhere".
 */
export const NON_LOCATION_TERMS: ReadonlySet<string> = new Set([
  'anywhere',
  'worldwide',
  'global',
  'remote',
  'fully remote',
  'work from home',
  'wfh',
  'n/a',
  'na',
  'unspecified',
  'various',
  'multiple locations',
]);
