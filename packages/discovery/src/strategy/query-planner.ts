import { createHash } from 'node:crypto';
import {
  STRENGTH_SCORES,
  discoveryQuerySchema,
  queryPlanConfigSchema,
  queryPlanSchema,
  type CandidatePreferences,
  type DiscoveryQuery,
  type QueryKind,
  type QueryPlan,
  type QueryPlanConfig,
  type QueryPriority,
} from '@job-intel/contracts';

/**
 * The search strategy engine.
 *
 * Turns *structured candidate data* into discovery queries. The distinction the
 * brief draws is the whole point: `"React jobs Germany"` must never appear in a
 * source's configuration, because the moment the candidate stops wanting
 * Germany, that string keeps being searched and nobody notices. A generated
 * plan changes the instant a preference row changes.
 *
 * The hard problem here is not generating queries — it is *not* generating
 * them. Six titles × five technologies × four locations × three seniorities is
 * 360 queries, each one a paid search call, and most of them near-duplicates
 * ("Senior Frontend Engineer Berlin" vs "Frontend Engineer Berlin senior").
 * Four mechanisms keep that under control:
 *
 *   1. **Semantic deduplication.** The query id is a hash of the normalised
 *      terms, not of the rendered string, so two orderings of the same intent
 *      collapse into one.
 *   2. **Per-dimension caps.** No single title or location may consume the plan.
 *   3. **Priority tiers with reserved shares.** Truncation removes exploratory
 *      breadth before it removes the candidate's stated titles.
 *   4. **A hard `maxQueries`.** Whatever survives, the plan is bounded.
 *
 * Everything dropped is counted and explained, so a thin plan is visible rather
 * than mysterious.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * Title synonyms.
 *
 * Deliberately small and curated. A large generated synonym set produces
 * queries for roles the candidate never asked for, and the cost of a wrong
 * synonym is a whole search call spent on irrelevant results. These are the
 * pairs where the industry genuinely uses two names for one job.
 */
const TITLE_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  'frontend engineer': ['front end developer', 'frontend developer', 'ui engineer'],
  'front end engineer': ['frontend engineer', 'frontend developer'],
  'frontend developer': ['frontend engineer', 'front end developer'],
  'backend engineer': ['back end developer', 'backend developer', 'server engineer'],
  'backend developer': ['backend engineer', 'back end developer'],
  'full stack engineer': ['fullstack developer', 'full-stack engineer', 'full stack developer'],
  'software engineer': ['software developer', 'developer'],
  'software developer': ['software engineer', 'developer'],
  'data engineer': ['analytics engineer', 'data platform engineer'],
  'devops engineer': ['platform engineer', 'site reliability engineer', 'infrastructure engineer'],
  'site reliability engineer': ['sre', 'platform engineer'],
  'mobile engineer': ['ios engineer', 'android engineer', 'mobile developer'],
  'machine learning engineer': ['ml engineer', 'ai engineer'],
  'product manager': ['product owner'],
  'qa engineer': ['test engineer', 'quality engineer', 'sdet'],
};

/** Technology aliases, for the same reason and with the same restraint. */
const TECH_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  javascript: ['js'],
  typescript: ['ts'],
  react: ['react.js', 'reactjs'],
  'next.js': ['nextjs', 'next js'],
  vue: ['vue.js', 'vuejs'],
  node: ['node.js', 'nodejs'],
  postgres: ['postgresql'],
  kubernetes: ['k8s'],
  'c#': ['csharp', '.net'],
  golang: ['go'],
};

/**
 * Country aliases used in job listings.
 *
 * Boards are inconsistent: some say "Germany", some "Deutschland", some "DE",
 * and remote-first boards say "EU" or "EMEA". Searching only the ISO code finds
 * a fraction of what exists.
 */
const LOCATION_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  DE: ['Germany', 'Deutschland', 'Berlin', 'Munich'],
  NL: ['Netherlands', 'Nederland', 'Amsterdam'],
  GB: ['United Kingdom', 'UK', 'London'],
  IE: ['Ireland', 'Dublin'],
  FR: ['France', 'Paris'],
  ES: ['Spain', 'España', 'Madrid', 'Barcelona'],
  PT: ['Portugal', 'Lisbon'],
  PL: ['Poland', 'Warsaw'],
  SE: ['Sweden', 'Stockholm'],
  DK: ['Denmark', 'Copenhagen'],
  NO: ['Norway', 'Oslo'],
  FI: ['Finland', 'Helsinki'],
  CH: ['Switzerland', 'Zurich'],
  AT: ['Austria', 'Vienna'],
  BE: ['Belgium', 'Brussels'],
  IT: ['Italy', 'Milan'],
  CA: ['Canada', 'Toronto'],
  US: ['United States', 'USA', 'Remote US'],
  NG: ['Nigeria', 'Lagos', 'Abuja'],
  ZA: ['South Africa', 'Cape Town'],
  KE: ['Kenya', 'Nairobi'],
  GH: ['Ghana', 'Accra'],
  AE: ['United Arab Emirates', 'Dubai'],
  IN: ['India', 'Bangalore'],
  AU: ['Australia', 'Sydney'],
};

const SENIORITY_TERMS: Readonly<Record<string, readonly string[]>> = {
  intern: ['intern', 'internship'],
  junior: ['junior', 'graduate', 'entry level'],
  mid: ['mid level'],
  senior: ['senior'],
  staff: ['staff'],
  principal: ['principal'],
  lead: ['lead', 'tech lead'],
  manager: ['engineering manager'],
  director: ['director'],
};

/** Domains worth restricting a query to — ATS boards carry dense job content. */
export const ATS_SEARCH_DOMAINS = [
  'boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
  'apply.workable.com',
  'jobs.smartrecruiters.com',
] as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

const normalise = (value: string): string => value.toLowerCase().trim().replace(/\s+/g, ' ');

function quote(value: string): string {
  return value.includes(' ') ? `"${value}"` : value;
}

/**
 * Semantic identity of a query.
 *
 * Hashes the *sorted, normalised terms* rather than the rendered text, so
 * "React Berlin" and "Berlin React" are one query and are planned once.
 */
function queryId(terms: DiscoveryQuery['terms']): string {
  const material = [
    terms.title && normalise(terms.title),
    terms.technology && normalise(terms.technology),
    terms.location && normalise(terms.location),
    terms.seniority && normalise(terms.seniority),
    terms.site && normalise(terms.site),
    terms.remoteOnly ? 'remote' : null,
  ]
    .filter((part): part is string => Boolean(part))
    .sort()
    .join('|');

  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/** Weight of one preference entry, floored so `neutral` still contributes. */
function strengthWeight(strength: keyof typeof STRENGTH_SCORES): number {
  return Math.max(0, STRENGTH_SCORES[strength]);
}

interface Weighted {
  value: string;
  weight: number;
}

/** Preference entries the candidate actually wants, strongest first. */
function wanted(
  entries: ReadonlyArray<{ value: string; strength: keyof typeof STRENGTH_SCORES }>,
  limit: number,
): Weighted[] {
  return entries
    .map((entry) => ({ value: entry.value.trim(), weight: strengthWeight(entry.strength) }))
    .filter((entry) => entry.value.length > 0 && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

export function locationVariants(value: string): string[] {
  const upper = value.toUpperCase();
  if (upper.length === 2 && LOCATION_VARIANTS[upper]) {
    return [...LOCATION_VARIANTS[upper]!];
  }
  return [value];
}

export function titleVariants(value: string): string[] {
  const key = normalise(value);
  const synonyms = TITLE_SYNONYMS[key] ?? [];
  return [value, ...synonyms];
}

export function techVariants(value: string): string[] {
  const key = normalise(value);
  const synonyms = TECH_SYNONYMS[key] ?? [];
  return [value, ...synonyms];
}

// ── Planning ────────────────────────────────────────────────────────────────

interface Candidate {
  terms: DiscoveryQuery['terms'];
  kind: QueryKind;
  priority: QueryPriority;
  score: number;
  rationale: string;
}

function renderQuery(terms: DiscoveryQuery['terms']): string {
  const parts: string[] = [];
  if (terms.seniority) parts.push(terms.seniority);
  if (terms.title) parts.push(quote(terms.title));
  if (terms.technology) parts.push(quote(terms.technology));
  if (terms.location) parts.push(quote(terms.location));
  if (terms.remoteOnly) parts.push('remote');
  if (terms.site) parts.push(`site:${terms.site}`);
  return parts.join(' ').trim();
}

/**
 * Generates a prioritised, deduplicated, bounded query plan.
 *
 * Priority follows the brief: an exact stated title in a stated location is
 * HIGH, a technology-led search is MEDIUM, and broad exploration is LOW. The
 * numeric `score` breaks ties *within* a tier using the candidate's own
 * preference strengths, so a `required` title outranks a `preferred` one
 * without needing a fourth tier.
 */
export function planQueries(input: {
  profileId: string;
  preferences: CandidatePreferences;
  preferenceVersion?: number | null;
  config?: Partial<QueryPlanConfig>;
  /** Restricts some queries to these hosts, for company-targeted discovery. */
  targetDomains?: readonly string[];
  /**
   * The candidate's current job title, used only when they have stated no
   * target titles.
   *
   * Without this a profile that has filled in "Software Engineer" but never
   * curated a preference list generates *zero* title queries — and therefore
   * zero HIGH-priority discovery — while looking perfectly configured. The
   * fallback is labelled as inferred in the rationale so the coverage report
   * and the UI can show that it was not something the candidate stated.
   */
  fallbackTitle?: string | null;
}): QueryPlan {
  const config = queryPlanConfigSchema.parse(input.config ?? {});
  const preferences = input.preferences;

  const statedTitles = wanted(preferences.titles, config.maxTitles);
  const inferredTitle = statedTitles.length === 0 && input.fallbackTitle?.trim();
  const titles: Weighted[] = inferredTitle
    ? [{ value: input.fallbackTitle!.trim(), weight: 0.5 }]
    : statedTitles;
  const technologies = wanted(preferences.technologies, config.maxTechnologies);
  const countries = wanted(preferences.countries, config.maxLocations);
  const cities = wanted(preferences.cities, config.maxLocations);
  const remoteWanted =
    preferences.workArrangement === 'REMOTE_ONLY' ||
    preferences.workArrangement === 'REMOTE_PREFERRED' ||
    preferences.workArrangement === 'ANY';

  const seniorities = config.includeSeniorityVariants
    ? preferences.seniorityLevels.flatMap((level) => SENIORITY_TERMS[level] ?? [level]).slice(0, 3)
    : [];

  // Locations: cities are more specific and therefore more valuable than the
  // country they sit in, so they carry a small bonus.
  const locations: Weighted[] = [
    ...cities.map((city) => ({ value: city.value, weight: city.weight + 0.1 })),
    ...countries.flatMap((country) =>
      locationVariants(country.value).map((variant, index) => ({
        value: variant,
        // Later variants are aliases; they matter, but less than the primary.
        weight: country.weight - index * 0.05,
      })),
    ),
  ]
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, config.maxLocations * 2);

  const candidates: Candidate[] = [];
  const perTitle = new Map<string, number>();
  const perLocation = new Map<string, number>();
  const dropped: string[] = [];
  let droppedCount = 0;

  const push = (candidate: Candidate, titleKey: string | null, locationKey: string | null): void => {
    if (titleKey) {
      const used = perTitle.get(titleKey) ?? 0;
      if (used >= config.maxPerTitle) {
        droppedCount += 1;
        dropped.push(`per-title cap reached for "${titleKey}"`);
        return;
      }
      perTitle.set(titleKey, used + 1);
    }
    if (locationKey) {
      const used = perLocation.get(locationKey) ?? 0;
      if (used >= config.maxPerLocation) {
        droppedCount += 1;
        dropped.push(`per-location cap reached for "${locationKey}"`);
        return;
      }
      perLocation.set(locationKey, used + 1);
    }
    candidates.push(candidate);
  };

  // ── HIGH: stated title × stated location ─────────────────────────────────
  for (const title of titles) {
    for (const variant of titleVariants(title.value)) {
      const isPrimary = normalise(variant) === normalise(title.value);
      for (const location of locations) {
        push(
          {
            terms: {
              title: variant,
              technology: null,
              location: location.value,
              countryCode: location.value.length === 2 ? location.value.toUpperCase() : null,
              seniority: null,
              remoteOnly: false,
              site: null,
            },
            kind: 'title_location',
            priority: 'HIGH',
            // Alias variants score below the exact stated title.
            score: Math.round((title.weight * 60 + location.weight * 40) * (isPrimary ? 1 : 0.85)),
            rationale: inferredTitle
              ? `Inferred from your current title "${title.value}" — you have not stated target titles`
              : isPrimary
                ? `You listed "${title.value}" and this location`
                : `Common alternative wording for "${title.value}"`,
          },
          normalise(title.value),
          normalise(location.value),
        );
      }

      if (remoteWanted) {
        push(
          {
            terms: {
              title: variant,
              technology: null,
              location: null,
              countryCode: null,
              seniority: null,
              remoteOnly: true,
              site: null,
            },
            kind: 'title_remote',
            priority: 'HIGH',
            score: Math.round(title.weight * 85 * (isPrimary ? 1 : 0.85)),
            rationale: inferredTitle
              ? `You accept remote work; title inferred from "${title.value}"`
              : `You accept remote work and listed "${title.value}"`,
          },
          normalise(title.value),
          null,
        );
      }
    }
  }

  // ── HIGH: title alone, when no location is stated ────────────────────────
  //
  // A title-only query is normally exploratory breadth. But when the candidate
  // has named no locations at all, it is the *most specific* query their stated
  // preferences support — and leaving it in the LOW tier meant a profile with a
  // title and no location produced a plan with no high-priority queries
  // whatsoever, which reads as "we are barely looking for you".
  if (locations.length === 0) {
    for (const title of titles) {
      push(
        {
          terms: {
            title: title.value,
            technology: null,
            location: null,
            countryCode: null,
            seniority: null,
            remoteOnly: false,
            site: null,
          },
          kind: 'title_only',
          priority: 'HIGH',
          score: Math.round(title.weight * 75),
          rationale: inferredTitle
            ? `Title inferred from your profile; you have stated no locations`
            : `You listed "${title.value}" and no location constraint`,
        },
        normalise(title.value),
        null,
      );
    }
  }

  // ── HIGH: seniority-qualified titles ─────────────────────────────────────
  for (const title of titles.slice(0, 3)) {
    for (const seniority of seniorities) {
      const location = locations[0];
      push(
        {
          terms: {
            title: title.value,
            technology: null,
            location: location?.value ?? null,
            countryCode: null,
            seniority,
            remoteOnly: false,
            site: null,
          },
          kind: 'title_location',
          priority: 'HIGH',
          score: Math.round(title.weight * 70),
          rationale: `You are targeting ${seniority} roles`,
        },
        // Keyed separately from the plain title queries. The per-title cap
        // exists to stop one title flooding the plan with location variants;
        // sharing the key with those meant the cap was always exhausted before
        // any seniority query was reached, and the candidate's stated seniority
        // was never searched at all.
        `${normalise(title.value)}|seniority`,
        location ? normalise(location.value) : null,
      );
    }
  }

  // ── MEDIUM: technology-led ───────────────────────────────────────────────
  if (config.includeTechnologyPairs) {
    for (const technology of technologies) {
      for (const variant of techVariants(technology.value).slice(0, 2)) {
        for (const location of locations.slice(0, 2)) {
          push(
            {
              terms: {
                title: null,
                technology: variant,
                location: location.value,
                countryCode: null,
                seniority: null,
                remoteOnly: false,
                site: null,
              },
              kind: 'technology_location',
              priority: 'MEDIUM',
              score: Math.round(technology.weight * 50 + location.weight * 30),
              rationale: `You work with ${technology.value}`,
            },
            null,
            normalise(location.value),
          );
        }

        // Title × technology: the most precise query the planner can build, but
        // capped hard because it is also the biggest source of near-duplicates.
        const title = titles[0];
        if (title) {
          push(
            {
              terms: {
                title: title.value,
                technology: variant,
                location: null,
                countryCode: null,
                seniority: null,
                remoteOnly: remoteWanted,
                site: null,
              },
              kind: 'technology_only',
              priority: 'MEDIUM',
              score: Math.round(title.weight * 40 + technology.weight * 40),
              rationale: `"${title.value}" roles using ${technology.value}`,
            },
            normalise(title.value),
            null,
          );
        }
      }
    }
  }

  // ── MEDIUM: domain-restricted (Part 7) ───────────────────────────────────
  const domains = input.targetDomains ?? [];
  for (const domain of domains.slice(0, 8)) {
    const title = titles[0];
    push(
      {
        terms: {
          title: title?.value ?? null,
          technology: title ? null : (technologies[0]?.value ?? null),
          location: null,
          countryCode: null,
          seniority: null,
          remoteOnly: false,
          site: domain,
        },
        kind: 'domain_restricted',
        priority: 'MEDIUM',
        score: Math.round((title?.weight ?? 0.5) * 55),
        rationale: `Restricted to ${domain}, where postings are dense and structured`,
      },
      // Deliberately exempt from the per-title cap. That cap exists to stop one
      // title flooding the plan with near-duplicates; a `site:` query is not a
      // near-duplicate of anything — it reaches a different corpus entirely,
      // and letting the cap eat it silently removed ATS coverage.
      null,
      null,
    );
  }

  // ── LOW: exploratory ─────────────────────────────────────────────────────
  if (config.includeExploratory) {
    for (const title of titles.slice(0, 2)) {
      push(
        {
          terms: {
            title: title.value,
            technology: null,
            location: null,
            countryCode: null,
            seniority: null,
            remoteOnly: false,
            site: null,
          },
          kind: 'title_only',
          priority: 'LOW',
          score: Math.round(title.weight * 30),
          rationale: 'Broad sweep, in case a good role is somewhere unexpected',
        },
        normalise(title.value),
        null,
      );
    }

    for (const technology of technologies.slice(0, 2)) {
      push(
        {
          terms: {
            title: null,
            technology: technology.value,
            location: null,
            countryCode: null,
            seniority: null,
            remoteOnly: remoteWanted,
            site: null,
          },
          kind: 'exploratory',
          priority: 'LOW',
          score: Math.round(technology.weight * 25),
          rationale: `Exploratory ${technology.value} sweep`,
        },
        null,
        null,
      );
    }
  }

  // ── Deduplicate, then truncate by tier ───────────────────────────────────
  const byId = new Map<string, DiscoveryQuery>();

  for (const candidate of candidates) {
    const text = renderQuery(candidate.terms);
    if (!text) continue;

    const id = queryId(candidate.terms);
    const existing = byId.get(id);
    if (existing) {
      // Keep the higher-scoring framing of the same intent.
      if (candidate.score <= existing.score) {
        droppedCount += 1;
        continue;
      }
    }

    const parsed = discoveryQuerySchema.safeParse({
      id,
      text,
      kind: candidate.kind,
      priority: candidate.priority,
      score: Math.min(100, Math.max(0, candidate.score)),
      terms: candidate.terms,
      rationale: candidate.rationale,
    });

    if (parsed.success) byId.set(id, parsed.data);
    else droppedCount += 1;
  }

  const all = [...byId.values()];
  const tier = (priority: QueryPriority) =>
    all.filter((query) => query.priority === priority).sort((a, b) => b.score - a.score);

  const high = tier('HIGH');
  const medium = tier('MEDIUM');
  const low = tier('LOW');

  // Reserved shares, then backfill: a plan with few HIGH queries should not
  // waste its remaining budget, but a plan with many must not crowd out
  // everything else.
  const highQuota = Math.max(1, Math.floor(config.maxQueries * config.highShare));
  const mediumQuota = Math.max(0, Math.floor(config.maxQueries * config.mediumShare));

  const selected = [
    ...high.slice(0, highQuota),
    ...medium.slice(0, mediumQuota),
    ...low.slice(0, Math.max(0, config.maxQueries - highQuota - mediumQuota)),
  ];

  const remaining = config.maxQueries - selected.length;
  if (remaining > 0) {
    const chosen = new Set(selected.map((query) => query.id));
    for (const query of [...high, ...medium, ...low]) {
      if (selected.length >= config.maxQueries) break;
      if (chosen.has(query.id)) continue;
      chosen.add(query.id);
      selected.push(query);
    }
  }

  const truncated = all.length - selected.length;
  if (truncated > 0) {
    droppedCount += truncated;
    dropped.push(`${truncated} query(ies) beyond the ${config.maxQueries}-query plan limit`);
  }

  return queryPlanSchema.parse({
    profileId: input.profileId,
    preferenceVersion: input.preferenceVersion ?? null,
    queries: selected.sort(
      (a, b) =>
        ['HIGH', 'MEDIUM', 'LOW'].indexOf(a.priority) -
          ['HIGH', 'MEDIUM', 'LOW'].indexOf(b.priority) || b.score - a.score,
    ),
    droppedCount,
    // Reasons are deduplicated: "per-title cap" forty times is one finding.
    dropReasons: [...new Set(dropped)].slice(0, 20),
  });
}

/**
 * Re-orders a plan using observed results.
 *
 * The brief's example: if Germany + React has been producing excellent jobs,
 * prioritise those queries. This applies a bounded multiplier rather than a
 * replacement score, so history *tilts* the plan without ever overriding what
 * the candidate explicitly asked for — the same rule the matching engine holds
 * to for behavioural signals.
 */
export function prioritiseByHistory(
  plan: QueryPlan,
  history: ReadonlyMap<string, { matchedJobs: number; discoveredJobs: number }>,
  options: { maxBoost?: number } = {},
): QueryPlan {
  const maxBoost = options.maxBoost ?? 0.3;

  const rescored = plan.queries.map((query) => {
    const stats = history.get(query.id);
    if (!stats || stats.discoveredJobs === 0) return query;

    // Yield is matched-per-discovered: a query returning 200 irrelevant jobs is
    // worse than one returning 5 good ones, and raw volume would say otherwise.
    const yieldRate = stats.matchedJobs / stats.discoveredJobs;
    const multiplier = 1 + Math.min(maxBoost, yieldRate * maxBoost * 2);

    return {
      ...query,
      score: Math.min(100, Math.round(query.score * multiplier)),
      rationale:
        `${query.rationale} · previously produced ${stats.matchedJobs} match(es) ` +
        `from ${stats.discoveredJobs} job(s)`,
    };
  });

  return {
    ...plan,
    queries: rescored.sort(
      (a, b) =>
        ['HIGH', 'MEDIUM', 'LOW'].indexOf(a.priority) -
          ['HIGH', 'MEDIUM', 'LOW'].indexOf(b.priority) || b.score - a.score,
    ),
  };
}
