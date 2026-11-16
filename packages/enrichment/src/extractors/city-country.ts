/**
 * City → country, for postings that name a city and nothing else.
 *
 * `parseLocation` resolves a country only when the text states one, so
 * "Munich, Bayern, Germany" yields DE and a bare "Munich" yields null. That
 * null is not harmless: the on-site presence constraint refuses to judge a
 * posting whose country it cannot establish, so an unresolved city means an
 * on-site role in *any* country reaches the candidate unchecked. A Munich
 * position scored 73 and was emailed to a candidate who can only work on-site
 * in Nigeria — entirely because of this null.
 *
 * Deliberately small and hand-checked rather than a full gazetteer. These are
 * unambiguous, high-frequency hiring cities; anything genuinely ambiguous
 * across countries is left out so it stays null and the constraint reports
 * UNKNOWN rather than asserting the wrong country. A missing entry costs a
 * caveat; a wrong entry costs a false rejection. Those are not equal.
 *
 * Notable omissions, on purpose: every duplicated place name — Birmingham,
 * Cambridge and Manchester exist in both the UK and the US — plus "Sydney"
 * (Australia and Canada) and "Vancouver" (Canada and the US).
 */
const CITY_COUNTRY: Readonly<Record<string, string>> = {
  // ── Germany ──
  munich: 'DE',
  muenchen: 'DE',
  'münchen': 'DE',
  berlin: 'DE',
  hamburg: 'DE',
  frankfurt: 'DE',
  cologne: 'DE',
  'köln': 'DE',
  stuttgart: 'DE',
  'düsseldorf': 'DE',
  dusseldorf: 'DE',
  dresden: 'DE',
  leipzig: 'DE',
  nuremberg: 'DE',
  'nürnberg': 'DE',
  karlsruhe: 'DE',
  mannheim: 'DE',
  bonn: 'DE',
  braunschweig: 'DE',
  brunswick: 'DE',
  potsdam: 'DE',
  'würzburg': 'DE',
  wurzburg: 'DE',
  memmingen: 'DE',
  langenfeld: 'DE',
  'rülzheim': 'DE',
  rulzheim: 'DE',
  aachen: 'DE',
  bremen: 'DE',
  hannover: 'DE',
  ulm: 'DE',
  regensburg: 'DE',
  augsburg: 'DE',
  kiel: 'DE',
  jena: 'DE',
  darmstadt: 'DE',
  'saarbrücken': 'DE',
  ingolstadt: 'DE',
  wolfsburg: 'DE',

  // ── United Kingdom & Ireland ──
  london: 'GB',
  edinburgh: 'GB',
  glasgow: 'GB',
  bristol: 'GB',
  leeds: 'GB',
  liverpool: 'GB',
  sheffield: 'GB',
  cardiff: 'GB',
  belfast: 'GB',
  bicester: 'GB',
  reading: 'GB',
  brighton: 'GB',
  nottingham: 'GB',
  southampton: 'GB',
  newcastle: 'GB',
  dublin: 'IE',
  cork: 'IE',
  galway: 'IE',

  // ── France ──
  paris: 'FR',
  lyon: 'FR',
  marseille: 'FR',
  toulouse: 'FR',
  bordeaux: 'FR',
  nantes: 'FR',
  lille: 'FR',
  montpellier: 'FR',

  // ── Benelux ──
  amsterdam: 'NL',
  rotterdam: 'NL',
  utrecht: 'NL',
  eindhoven: 'NL',
  'the hague': 'NL',
  brussels: 'BE',
  antwerp: 'BE',
  ghent: 'BE',
  leuven: 'BE',
  luxembourg: 'LU',

  // ── Nordics ──
  stockholm: 'SE',
  gothenburg: 'SE',
  malmo: 'SE',
  'malmö': 'SE',
  copenhagen: 'DK',
  aarhus: 'DK',
  oslo: 'NO',
  bergen: 'NO',
  helsinki: 'FI',
  espoo: 'FI',
  tampere: 'FI',
  reykjavik: 'IS',

  // ── Southern Europe ──
  madrid: 'ES',
  barcelona: 'ES',
  valencia: 'ES',
  seville: 'ES',
  malaga: 'ES',
  lisbon: 'PT',
  porto: 'PT',
  rome: 'IT',
  milan: 'IT',
  turin: 'IT',
  bologna: 'IT',
  naples: 'IT',
  athens: 'GR',

  // ── Central & Eastern Europe ──
  vienna: 'AT',
  graz: 'AT',
  salzburg: 'AT',
  zurich: 'CH',
  'zürich': 'CH',
  geneva: 'CH',
  basel: 'CH',
  lausanne: 'CH',
  bern: 'CH',
  prague: 'CZ',
  brno: 'CZ',
  warsaw: 'PL',
  krakow: 'PL',
  'kraków': 'PL',
  wroclaw: 'PL',
  'wrocław': 'PL',
  gdansk: 'PL',
  poznan: 'PL',
  budapest: 'HU',
  bucharest: 'RO',
  cluj: 'RO',
  sofia: 'BG',
  zagreb: 'HR',
  belgrade: 'RS',
  ljubljana: 'SI',
  bratislava: 'SK',
  tallinn: 'EE',
  riga: 'LV',
  vilnius: 'LT',
  kyiv: 'UA',
  kiev: 'UA',
  lviv: 'UA',

  // ── North America ──
  'new york': 'US',
  'san francisco': 'US',
  'los angeles': 'US',
  chicago: 'US',
  seattle: 'US',
  austin: 'US',
  boston: 'US',
  denver: 'US',
  atlanta: 'US',
  'san diego': 'US',
  'san jose': 'US',
  'palo alto': 'US',
  'mountain view': 'US',
  'menlo park': 'US',
  sunnyvale: 'US',
  philadelphia: 'US',
  dallas: 'US',
  houston: 'US',
  miami: 'US',
  minneapolis: 'US',
  portland: 'US',
  phoenix: 'US',
  pittsburgh: 'US',
  'salt lake city': 'US',
  nashville: 'US',
  toronto: 'CA',
  montreal: 'CA',
  'montréal': 'CA',
  ottawa: 'CA',
  calgary: 'CA',
  edmonton: 'CA',
  waterloo: 'CA',
  'mexico city': 'MX',
  guadalajara: 'MX',
  monterrey: 'MX',

  // ── Africa ──
  lagos: 'NG',
  abuja: 'NG',
  'port harcourt': 'NG',
  ibadan: 'NG',
  kano: 'NG',
  'benin city': 'NG',
  enugu: 'NG',
  kaduna: 'NG',
  abeokuta: 'NG',
  ilorin: 'NG',
  nairobi: 'KE',
  mombasa: 'KE',
  accra: 'GH',
  kumasi: 'GH',
  cairo: 'EG',
  alexandria: 'EG',
  giza: 'EG',
  'cape town': 'ZA',
  johannesburg: 'ZA',
  durban: 'ZA',
  pretoria: 'ZA',
  casablanca: 'MA',
  rabat: 'MA',
  tunis: 'TN',
  algiers: 'DZ',
  'addis ababa': 'ET',
  kampala: 'UG',
  'dar es salaam': 'TZ',
  kigali: 'RW',
  dakar: 'SN',
  abidjan: 'CI',

  // ── Middle East ──
  dubai: 'AE',
  'abu dhabi': 'AE',
  sharjah: 'AE',
  riyadh: 'SA',
  jeddah: 'SA',
  dammam: 'SA',
  doha: 'QA',
  manama: 'BH',
  muscat: 'OM',
  amman: 'JO',
  'tel aviv': 'IL',
  jerusalem: 'IL',
  haifa: 'IL',
  istanbul: 'TR',
  ankara: 'TR',
  izmir: 'TR',

  // ── Asia-Pacific ──
  singapore: 'SG',
  'hong kong': 'HK',
  tokyo: 'JP',
  osaka: 'JP',
  kyoto: 'JP',
  seoul: 'KR',
  busan: 'KR',
  taipei: 'TW',
  beijing: 'CN',
  shanghai: 'CN',
  shenzhen: 'CN',
  guangzhou: 'CN',
  hangzhou: 'CN',
  bangalore: 'IN',
  bengaluru: 'IN',
  mumbai: 'IN',
  delhi: 'IN',
  'new delhi': 'IN',
  hyderabad: 'IN',
  chennai: 'IN',
  pune: 'IN',
  gurgaon: 'IN',
  gurugram: 'IN',
  noida: 'IN',
  kolkata: 'IN',
  ahmedabad: 'IN',
  bangkok: 'TH',
  jakarta: 'ID',
  'kuala lumpur': 'MY',
  manila: 'PH',
  'ho chi minh city': 'VN',
  hanoi: 'VN',
  'da nang': 'VN',
  karachi: 'PK',
  lahore: 'PK',
  islamabad: 'PK',
  dhaka: 'BD',
  colombo: 'LK',
  melbourne: 'AU',
  brisbane: 'AU',
  perth: 'AU',
  adelaide: 'AU',
  canberra: 'AU',
  auckland: 'NZ',
  wellington: 'NZ',
  christchurch: 'NZ',

  // ── South America ──
  'sao paulo': 'BR',
  'são paulo': 'BR',
  'rio de janeiro': 'BR',
  'belo horizonte': 'BR',
  curitiba: 'BR',
  recife: 'BR',
  'buenos aires': 'AR',
  cordoba: 'AR',
  santiago: 'CL',
  lima: 'PE',
  bogota: 'CO',
  'bogotá': 'CO',
  medellin: 'CO',
  'medellín': 'CO',
  montevideo: 'UY',
  quito: 'EC',
};

/**
 * Country names as postings actually write them, including in their own
 * language.
 *
 * `parseLocation` handles the common English forms; these are the ones a live
 * pass found it missing. "Langenfeld, Nordrhein-Westfalen, Duitsland" states
 * its country plainly — in Dutch — and resolving it needs no city lookup at
 * all, just the willingness to read the word.
 */
const COUNTRY_WORDS: Readonly<Record<string, string>> = {
  deutschland: 'DE',
  duitsland: 'DE',
  allemagne: 'DE',
  germany: 'DE',
  'united kingdom': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  britain: 'GB',
  nederland: 'NL',
  netherlands: 'NL',
  holland: 'NL',
  belgique: 'BE',
  belgium: 'BE',
  'österreich': 'AT',
  osterreich: 'AT',
  austria: 'AT',
  schweiz: 'CH',
  suisse: 'CH',
  switzerland: 'CH',
  france: 'FR',
  espana: 'ES',
  'españa': 'ES',
  spain: 'ES',
  italia: 'IT',
  italy: 'IT',
  polska: 'PL',
  poland: 'PL',
  sverige: 'SE',
  sweden: 'SE',
  danmark: 'DK',
  denmark: 'DK',
  norge: 'NO',
  norway: 'NO',
  suomi: 'FI',
  finland: 'FI',
  ireland: 'IE',
  portugal: 'PT',
  nigeria: 'NG',
  ghana: 'GH',
  kenya: 'KE',
  'south africa': 'ZA',
  egypt: 'EG',
  india: 'IN',
  canada: 'CA',
  australia: 'AU',
  'new zealand': 'NZ',
  singapore: 'SG',
  brasil: 'BR',
  brazil: 'BR',
};

/**
 * Every lookup key, longest first.
 *
 * Order matters: "new york" must be tested before "york" would be, and
 * "south africa" before "africa" — a shorter key that is a substring of a
 * longer one would otherwise win and resolve the wrong country.
 */
const ORDERED_KEYS: ReadonlyArray<{ key: string; code: string }> = [
  ...Object.entries(COUNTRY_WORDS).map(([key, code]) => ({ key, code })),
  ...Object.entries(CITY_COUNTRY).map(([key, code]) => ({ key, code })),
].sort((a, b) => b.key.length - a.key.length);

/**
 * Resolves a country from a location string.
 *
 * Takes the *whole* location text rather than the parsed city, and scans it for
 * any known city or country name at a word boundary.
 *
 * The first version of this required a comma-separated segment to equal a city
 * name exactly, and a live pass over what the boards actually return showed how
 * badly that fails. Real location fields look like "Berlin HQ",
 * "Frankfurt am Main", "Stuttgart Schockenriedstr. 17",
 * "LiveEO GmbH Berlin Office (Hybrid)" — none of which equals a city name. It
 * was also stripping parenthesised text, which threw away the answer outright
 * in "Hybrid (London)". Twenty-one European on-site roles stayed unresolved,
 * and every one of them would have been emailed to a candidate who can only
 * work on-site in Nigeria.
 *
 * Word-boundary anchored so "Bonn" cannot match inside "Bonnington" and "Bern"
 * cannot match inside "Berne-sur-Mer". Still returns null on anything
 * unrecognised, leaving the constraint to report UNKNOWN rather than guess.
 */
export function countryFromCity(location: string | null): string | null {
  if (!location) return null;

  /*
   * Punctuation becomes whitespace rather than being stripped, so parentheses
   * and street numbers separate tokens instead of gluing or deleting them.
   * Accented characters are kept — they are load-bearing in "München".
   */
  const haystack = ` ${location
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;

  if (haystack.trim().length === 0) return null;

  for (const { key, code } of ORDERED_KEYS) {
    if (haystack.includes(` ${key} `)) return code;
  }

  return null;
}
