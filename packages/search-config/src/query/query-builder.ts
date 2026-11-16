import type { EffectiveSearchConfig, SearchProfile } from '@job-intel/contracts';
import { titleSynonyms } from '../titles/title-synonyms';

/**
 * Dynamic query generation.
 *
 * Nothing here is a hardcoded search string. Every query is assembled from the
 * effective configuration, which means changing "Nigeria" to "Germany" in the
 * control centre changes what gets searched on the next pass — no deploy, no
 * code change, no restart.
 *
 * The rule that constrains everything: **exclusions are honoured during
 * generation, not after.** If PHP is excluded, no query containing PHP is ever
 * built. Filtering it out downstream would still have spent the request, the
 * rate-limit budget and — on a metered search API — the money.
 *
 * Source-specific syntax lives behind `SourceQueryBuilder` rather than in here.
 * A connector knows that its API wants `location=` and another wants a
 * `site:` operator; the generic engine must not, or every new source means
 * editing a shared file.
 */

export interface GeneratedQuery {
  /** The query text, ready for a source that takes free text. */
  text: string;
  /** Structured form, for sources with real parameters. */
  terms: {
    title: string | null;
    skills: string[];
    location: string | null;
    remote: boolean;
    seniority: string | null;
  };
  /** `high` runs first and most often. */
  priority: 'high' | 'medium' | 'low';
  /** Why this query exists, for the coverage report. */
  rationale: string;
  /** Stable id, so the same profile produces the same query identities. */
  queryId: string;
}

export interface QueryGenerationOptions {
  maxQueries?: number;
  maxTitles?: number;
  maxSkills?: number;
  maxLocations?: number;
  /** Include seniority-qualified variants. */
  includeSeniority?: boolean;
}

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Region names expanded into the countries a search can actually name. */
const REGION_COUNTRIES: Readonly<Record<string, readonly string[]>> = {
  eu: ['DE', 'NL', 'FR', 'ES', 'IT', 'PL', 'IE', 'SE', 'DK', 'FI', 'AT', 'BE', 'PT'],
  'european union': ['DE', 'NL', 'FR', 'ES', 'IT', 'PL', 'IE', 'SE', 'DK', 'FI', 'AT', 'BE', 'PT'],
  europe: ['DE', 'NL', 'FR', 'ES', 'IT', 'PL', 'IE', 'SE', 'DK', 'FI', 'AT', 'BE', 'PT', 'GB', 'CH', 'NO'],
  emea: ['DE', 'NL', 'FR', 'GB', 'ES', 'IT', 'PL', 'ZA', 'NG', 'KE', 'AE'],
  dach: ['DE', 'AT', 'CH'],
  benelux: ['NL', 'BE', 'LU'],
  nordics: ['SE', 'DK', 'NO', 'FI'],
  apac: ['SG', 'AU', 'JP', 'IN'],
  americas: ['US', 'CA', 'BR', 'MX'],
};

/** Country codes rendered as the words people search with. */
const COUNTRY_LABELS: Readonly<Record<string, string>> = {
  DE: 'Germany',
  NL: 'Netherlands',
  NG: 'Nigeria',
  GB: 'United Kingdom',
  US: 'United States',
  IE: 'Ireland',
  FR: 'France',
  ES: 'Spain',
  PT: 'Portugal',
  PL: 'Poland',
  CA: 'Canada',
  AU: 'Australia',
  CH: 'Switzerland',
  AT: 'Austria',
  BE: 'Belgium',
  SE: 'Sweden',
  DK: 'Denmark',
  NO: 'Norway',
  FI: 'Finland',
  IT: 'Italy',
  KE: 'Kenya',
  ZA: 'South Africa',
  GH: 'Ghana',
  IN: 'India',
  SG: 'Singapore',
};

/** Every term the profile forbids, lowercased. */
export function forbiddenTerms(profile: SearchProfile): Set<string> {
  return new Set(
    [
      ...profile.excludedSkills,
      ...profile.keywords.mustNotContain,
      ...profile.industries.excluded,
      ...profile.companies.excluded,
    ].map((term) => term.toLowerCase().trim()),
  );
}

/** Whether a query is safe to run given the profile's exclusions. */
export function isPermitted(text: string, forbidden: ReadonlySet<string>): boolean {
  const haystack = ` ${text.toLowerCase()} `;

  for (const term of forbidden) {
    if (term.length < 2) continue;

    /*
     * Word-boundary matching, built by hand.
     *
     * `\b` does not work for terms containing `+`, `#` or `.`, and "C#" and
     * "Node.js" are exactly the exclusions a naive check gets wrong — letting a
     * query through that the candidate explicitly banned.
     */
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9+#])${escaped}([^a-z0-9+#]|$)`, 'i').test(haystack)) {
      return false;
    }
  }

  return true;
}

/** Locations the profile wants, expanded into searchable names. */
function locationTerms(profile: SearchProfile, limit: number): Array<{ term: string; priority: number }> {
  const terms: Array<{ term: string; priority: number }> = [];
  const excluded = new Set(
    profile.excludedLocations.map((entry) => entry.value.toLowerCase()),
  );

  const weightOf = (priority: string): number =>
    priority === 'primary' ? 1 : priority === 'secondary' ? 0.7 : 0.4;

  for (const location of profile.locations) {
    if (excluded.has(location.value.toLowerCase())) continue;

    if (location.kind === 'city' || location.kind === 'state') {
      terms.push({ term: location.label ?? location.value, priority: weightOf(location.priority) + 0.1 });
      continue;
    }

    if (location.kind === 'country') {
      const label = COUNTRY_LABELS[location.value.toUpperCase()] ?? location.label ?? location.value;
      terms.push({ term: label, priority: weightOf(location.priority) });
      continue;
    }

    if (location.kind === 'region') {
      const countries = REGION_COUNTRIES[location.value.toLowerCase()] ?? [];

      // The region name itself, plus its members — postings say both.
      terms.push({ term: location.label ?? location.value, priority: weightOf(location.priority) });

      for (const code of countries.slice(0, 5)) {
        const label = COUNTRY_LABELS[code];
        if (label) terms.push({ term: label, priority: weightOf(location.priority) - 0.2 });
      }
    }
  }

  return terms
    .sort((a, b) => b.priority - a.priority)
    .filter((entry, index, all) => all.findIndex((other) => other.term === entry.term) === index)
    .slice(0, limit);
}

/**
 * Generates the query plan for one profile.
 *
 * Priority follows what actually finds jobs: a stated title in a stated place
 * is the highest-yield query anyone can run, a technology-led search is next,
 * and broad exploration last.
 */
export function generateQueries(
  config: EffectiveSearchConfig,
  options: QueryGenerationOptions = {},
): GeneratedQuery[] {
  const profile = config.profile;
  const forbidden = forbiddenTerms(profile);

  const maxQueries = options.maxQueries ?? 40;
  const maxTitles = options.maxTitles ?? 4;
  const maxSkills = options.maxSkills ?? 5;
  const maxLocations = options.maxLocations ?? 4;

  const queries: GeneratedQuery[] = [];
  const seen = new Set<string>();

  const push = (
    text: string,
    terms: GeneratedQuery['terms'],
    priority: GeneratedQuery['priority'],
    rationale: string,
  ): void => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length < 3) return;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;

    // The exclusion gate, applied before the query exists rather than after.
    if (!isPermitted(cleaned, forbidden)) return;

    seen.add(key);
    queries.push({
      text: cleaned,
      terms,
      priority,
      rationale,
      queryId: slug(cleaned),
    });
  };

  // ── Titles ──────────────────────────────────────────────────────────────
  const roles = [...profile.roles].sort((a, b) => {
    const rank: Record<string, number> = { primary: 0, secondary: 1, exploratory: 2 };
    const byPriority = (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3);
    return byPriority !== 0 ? byPriority : a.rank - b.rank;
  });

  const titles: string[] = [];

  for (const role of roles.slice(0, maxTitles)) {
    titles.push(role.title);
    // The user's own alternatives first — they know their market.
    for (const alternative of role.alternatives.slice(0, 2)) titles.push(alternative);
    // Then the canonical vocabulary, which only expands when confident.
    for (const synonym of titleSynonyms(role.title, 3)) titles.push(synonym);
  }

  const uniqueTitles = [...new Set(titles)].slice(0, maxTitles * 2);

  const skills = profile.skills
    .filter((skill) => skill.tier === 'required' || skill.tier === 'preferred')
    .sort((a, b) => (a.tier === 'required' ? -1 : 1) - (b.tier === 'required' ? -1 : 1))
    .map((skill) => skill.label ?? skill.value)
    .slice(0, maxSkills);

  const locations = locationTerms(profile, maxLocations);
  const remoteWanted = ['REMOTE_ONLY', 'REMOTE_OR_HYBRID', 'REMOTE_OR_ONSITE', 'ANY'].includes(
    profile.remotePreference,
  );

  const seniority = options.includeSeniority === false ? null : (profile.seniorityLevels[0] ?? null);

  // ── HIGH: title + location ──────────────────────────────────────────────
  for (const title of uniqueTitles) {
    for (const location of locations) {
      push(
        `${title} ${location.term}`,
        { title, skills: [], location: location.term, remote: false, seniority },
        'high',
        'A stated role in a stated location.',
      );
    }

    /*
     * A remote query is only generated when the profile accepts remote work.
     *
     * Otherwise the crawler spends its budget finding jobs the filter will
     * discard — which is the cost this whole generation-time exclusion exists
     * to avoid.
     */
    if (remoteWanted) {
      push(
        `${title} remote`,
        { title, skills: [], location: null, remote: true, seniority },
        'high',
        'A stated role, remote.',
      );
    }

    if (locations.length === 0 && !remoteWanted) {
      push(
        title,
        { title, skills: [], location: null, remote: false, seniority },
        'high',
        'A stated role with no location stated.',
      );
    }
  }

  // ── MEDIUM: skills + location ───────────────────────────────────────────
  const topSkills = skills.slice(0, 3);

  if (topSkills.length >= 2) {
    const pair = topSkills.slice(0, 2).join(' ');

    for (const location of locations.slice(0, 2)) {
      push(
        `${pair} ${location.term}`,
        { title: null, skills: topSkills.slice(0, 2), location: location.term, remote: false, seniority },
        'medium',
        'Technology-led search in a stated location.',
      );
    }

    if (remoteWanted) {
      push(
        `${pair} remote`,
        { title: null, skills: topSkills.slice(0, 2), location: null, remote: true, seniority },
        'medium',
        'Technology-led remote search.',
      );
    }
  }

  // ── MEDIUM: seniority-qualified titles ──────────────────────────────────
  if (seniority && options.includeSeniority !== false) {
    for (const title of uniqueTitles.slice(0, 2)) {
      // Skip when the title already carries the level, to avoid "senior senior".
      if (title.toLowerCase().includes(seniority.toLowerCase())) continue;

      for (const location of locations.slice(0, 2)) {
        push(
          `${seniority} ${title} ${location.term}`,
          { title, skills: [], location: location.term, remote: false, seniority },
          'medium',
          'Seniority-qualified role in a stated location.',
        );
      }
    }
  }

  // ── LOW: must-have keywords ─────────────────────────────────────────────
  for (const keyword of profile.keywords.mustContain.slice(0, 3)) {
    const title = uniqueTitles[0];
    push(
      title ? `${title} ${keyword}` : keyword,
      { title: title ?? null, skills: [keyword], location: null, remote: remoteWanted, seniority },
      'low',
      'A keyword the profile requires.',
    );
  }

  // ── LOW: named companies ────────────────────────────────────────────────
  for (const company of profile.companies.favourites.slice(0, 5)) {
    const title = uniqueTitles[0];
    push(
      title ? `${company} ${title}` : company,
      { title: title ?? null, skills: [], location: null, remote: false, seniority },
      'low',
      'A company the profile follows.',
    );
  }

  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };

  return queries
    .sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3))
    .slice(0, maxQueries);
}

// ── Source-specific builders (Part 47) ──────────────────────────────────────

/**
 * How one source wants its queries shaped.
 *
 * The interface exists so that a board's syntax lives with its connector.
 * Putting a `site:` operator or a `location=` parameter into the generic engine
 * would mean every new source edits a shared file, and the file would slowly
 * become a list of special cases nobody dares touch.
 */
export interface SourceQueryBuilder {
  readonly sourceId: string;
  /** Whether this source can serve the profile at all. */
  supports(config: EffectiveSearchConfig): boolean;
  buildQueries(config: EffectiveSearchConfig, base: readonly GeneratedQuery[]): string[];
}

/** Free-text sources: the generated text is already what they want. */
export const plainTextQueryBuilder = (sourceId: string): SourceQueryBuilder => ({
  sourceId,
  supports: () => true,
  buildQueries: (_config, base) => base.map((query) => query.text),
});

/**
 * Search engines that support site restriction.
 *
 * Restricting to ATS hosts is what turns a general web search into a job
 * search: the same words without it return listicles and recruiter spam.
 */
export const siteRestrictedQueryBuilder = (
  sourceId: string,
  domains: readonly string[],
): SourceQueryBuilder => ({
  sourceId,
  supports: () => domains.length > 0,
  buildQueries: (config, base) => {
    const forbidden = forbiddenTerms(config.profile);

    return base
      .filter((query) => query.priority !== 'low')
      .slice(0, 12)
      .flatMap((query) =>
        domains.slice(0, 4).map((domain) => `${query.text} site:${domain}`),
      )
      .filter((text) => isPermitted(text, forbidden));
  },
});

/**
 * Sources that take structured parameters rather than a search box.
 *
 * Serialised as a query string here so the connector receives one shape,
 * whatever its transport.
 */
export const structuredQueryBuilder = (sourceId: string): SourceQueryBuilder => ({
  sourceId,
  supports: () => true,
  buildQueries: (config, base) =>
    base.slice(0, 20).map((query) => {
      const params = new URLSearchParams();

      if (query.terms.title) params.set('q', query.terms.title);
      if (query.terms.location) params.set('location', query.terms.location);
      if (query.terms.remote) params.set('remote', 'true');
      if (query.terms.seniority) params.set('level', query.terms.seniority);
      if (query.terms.skills.length > 0) params.set('skills', query.terms.skills.join(','));

      const salary = config.profile.salary.minimum;
      if (salary !== null) params.set('salary_min', String(salary));

      return params.toString();
    }),
});

/** Picks the builder for a source, falling back to plain text. */
export function builderFor(
  sourceId: string,
  builders: readonly SourceQueryBuilder[],
): SourceQueryBuilder {
  return (
    builders.find((builder) => builder.sourceId === sourceId) ?? plainTextQueryBuilder(sourceId)
  );
}

/** Every query, per source, for one resolved configuration. */
export function planForSources(
  config: EffectiveSearchConfig,
  builders: readonly SourceQueryBuilder[],
  options: QueryGenerationOptions = {},
): Array<{ sourceId: string; queries: string[] }> {
  if (!config.searchEnabled) return [];

  const base = generateQueries(config, options);

  return config.resolvedSources
    .map((source) => {
      const builder = builderFor(source.sourceId, builders);
      if (!builder.supports(config)) return { sourceId: source.sourceId, queries: [] };

      return { sourceId: source.sourceId, queries: builder.buildQueries(config, base) };
    })
    .filter((entry) => entry.queries.length > 0);
}
