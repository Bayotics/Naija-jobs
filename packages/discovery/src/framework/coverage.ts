import {
  STRENGTH_SCORES,
  coverageReportSchema,
  type CandidatePreferences,
  type CoverageDimension,
  type CoverageGap,
  type CoverageItem,
  type CoverageReport,
  type QueryPlan,
} from '@job-intel/contracts';
import { locationVariants, techVariants, titleVariants } from '../strategy/query-planner';

/**
 * Search coverage.
 *
 * The brief is emphatic that this system must not claim to search the internet,
 * and it is right — the claim is unfalsifiable and therefore worthless. What
 * *is* meaningful, and what this module produces, is coverage of the
 * candidate's own stated search space: of the titles, locations and
 * technologies you asked for, which did we actually look for, from how many
 * sources, and what came back.
 *
 * The two failure modes are kept apart deliberately:
 *
 *  - **We never looked.** No query was planned or executed for this preference.
 *    That is a planner or budget problem and is fixable today.
 *  - **We looked and found nothing.** Queries ran and returned no jobs. That is
 *    a *market* signal, or a source-coverage gap, and needs a different fix.
 *
 * Collapsing both into one percentage would hide the only distinction an
 * operator can act on.
 */

export interface CoverageObservation {
  /** Query ids that actually ran, with what they produced. */
  executedQueries: ReadonlyMap<string, { discovered: number; matched: number; sourcesSearched: number; at: Date }>;
  sourcesAvailable: number;
  /** Sources that produced at least one job in the window. */
  sourcesProductive: number;
  /** Preference values with no source capable of searching them. */
  uncoveredByCapability?: ReadonlyArray<{ dimension: CoverageDimension; value: string; detail: string }>;
}

function strengthWeight(strength: keyof typeof STRENGTH_SCORES): number {
  return Math.max(0, STRENGTH_SCORES[strength]);
}

/** Every preference the candidate actually wants, as coverage rows. */
function preferenceItems(preferences: CandidatePreferences): CoverageItem[] {
  const items: CoverageItem[] = [];

  const add = (dimension: CoverageDimension, value: string, weight: number): void => {
    if (!value.trim() || weight <= 0) return;
    items.push({
      dimension,
      value: value.trim(),
      weight,
      queriesPlanned: 0,
      queriesExecuted: 0,
      sourcesSearched: 0,
      jobsDiscovered: 0,
      jobsMatched: 0,
      lastSearchedAt: null,
    });
  };

  for (const title of preferences.titles) add('title', title.value, strengthWeight(title.strength));
  for (const country of preferences.countries) {
    add('location', country.value, strengthWeight(country.strength));
  }
  for (const city of preferences.cities) add('location', city.value, strengthWeight(city.strength));
  for (const tech of preferences.technologies) {
    add('technology', tech.value, strengthWeight(tech.strength));
  }
  for (const level of preferences.seniorityLevels) add('seniority', level, 0.5);

  return items;
}

/** Case-insensitive containment, used to attribute a query to a preference. */
function mentions(haystack: string | null, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Does this query cover this preference?
 *
 * Attribution must use the *same* expansion the planner used, or the report
 * lies in the most damaging direction: the planner turns `DE` into "Germany",
 * "Berlin" and "Munich", and a naive substring check then finds no query
 * mentioning "DE" and reports the candidate's strongest location preference as
 * NEVER_SEARCHED — while queries for it were in fact running.
 */
function covers(item: CoverageItem, query: QueryPlan['queries'][number]): boolean {
  switch (item.dimension) {
    case 'title':
      return titleVariants(item.value).some((variant) => mentions(query.terms.title, variant));

    case 'location': {
      if (
        query.terms.countryCode !== null &&
        query.terms.countryCode.toUpperCase() === item.value.toUpperCase()
      ) {
        return true;
      }
      return locationVariants(item.value).some((variant) =>
        mentions(query.terms.location, variant),
      );
    }

    case 'technology':
      return techVariants(item.value).some((variant) => mentions(query.terms.technology, variant));

    case 'seniority':
      return mentions(query.terms.seniority, item.value);

    default:
      return false;
  }
}

/**
 * Builds the coverage report.
 *
 * Attribution walks the plan rather than the results: a query is credited to
 * every preference whose value appears in its terms, because "Senior Frontend
 * Engineer Berlin" genuinely covers the title, the seniority and the location
 * at once. Crediting only one would understate coverage of the other two.
 */
export function buildCoverage(input: {
  profileId: string;
  preferences: CandidatePreferences;
  plan: QueryPlan;
  observation: CoverageObservation;
  windowHours: number;
  now?: Date;
}): CoverageReport {
  const now = input.now ?? new Date();
  const items = preferenceItems(input.preferences);

  let queriesExecuted = 0;
  let uniqueJobs = 0;

  for (const query of input.plan.queries) {
    const executed = input.observation.executedQueries.get(query.id);
    if (executed) {
      queriesExecuted += 1;
      uniqueJobs += executed.discovered;
    }

    for (const item of items) {
      if (!covers(item, query)) continue;

      item.queriesPlanned += 1;
      if (executed) {
        item.queriesExecuted += 1;
        item.jobsDiscovered += executed.discovered;
        item.jobsMatched += executed.matched;
        item.sourcesSearched = Math.max(item.sourcesSearched, executed.sourcesSearched);
        item.lastSearchedAt =
          item.lastSearchedAt === null || executed.at > item.lastSearchedAt
            ? executed.at
            : item.lastSearchedAt;
      }
    }
  }

  const gaps = detectGaps(items, input.observation, input.windowHours, now);

  const searched = items.filter((item) => item.queriesExecuted > 0).length;
  const productive = items.filter((item) => item.jobsDiscovered > 0).length;

  return coverageReportSchema.parse({
    profileId: input.profileId,
    windowHours: input.windowHours,
    items,
    gaps,
    sourcesSearched: input.observation.sourcesProductive,
    sourcesAvailable: input.observation.sourcesAvailable,
    queriesExecuted,
    uniqueJobsDiscovered: uniqueJobs,
    searchedShare: items.length > 0 ? searched / items.length : 0,
    productiveShare: items.length > 0 ? productive / items.length : 0,
    generatedAt: now,
  });
}

/**
 * Finds the gaps.
 *
 * Severity follows the candidate's own weighting: an unsearched `required`
 * title is a high-severity gap, an unsearched `preferred` technology is low.
 * Ranking gaps by our own notion of importance rather than theirs would surface
 * the wrong ones first.
 */
export function detectGaps(
  items: readonly CoverageItem[],
  observation: CoverageObservation,
  windowHours: number,
  now = new Date(),
): CoverageGap[] {
  const gaps: CoverageGap[] = [];

  const severityFor = (weight: number): 'low' | 'medium' | 'high' =>
    weight >= 0.75 ? 'high' : weight >= 0.5 ? 'medium' : 'low';

  for (const uncovered of observation.uncoveredByCapability ?? []) {
    gaps.push({
      kind: 'NO_CAPABLE_SOURCE',
      dimension: uncovered.dimension,
      value: uncovered.value,
      severity: 'high',
      detail: uncovered.detail,
      suggestion:
        'Add a source that covers this, or supply credentials for one that is registered but unavailable.',
    });
  }

  for (const item of items) {
    if (item.queriesPlanned === 0) {
      gaps.push({
        kind: 'NEVER_SEARCHED',
        dimension: item.dimension,
        value: item.value,
        severity: severityFor(item.weight),
        detail: `No discovery query was generated for "${item.value}" in the last ${windowHours}h.`,
        suggestion:
          'Raise the query-plan limit, or raise this preference’s strength so it survives truncation.',
      });
      continue;
    }

    if (item.queriesExecuted === 0) {
      gaps.push({
        kind: 'NOT_SEARCHED_RECENTLY',
        dimension: item.dimension,
        value: item.value,
        severity: severityFor(item.weight),
        detail: `${item.queriesPlanned} query(ies) were planned for "${item.value}" but none ran.`,
        suggestion: 'Check the discovery budget and whether the capable sources are enabled.',
      });
      continue;
    }

    // Searched, but nothing came back. This is the LOW_DISCOVERY_COVERAGE case
    // the brief names — and it is deliberately *not* reported as a failure,
    // because "no German React jobs were posted this week" is a valid answer.
    if (item.jobsDiscovered === 0) {
      gaps.push({
        kind: 'LOW_DISCOVERY_COVERAGE',
        dimension: item.dimension,
        value: item.value,
        severity: item.weight >= 0.75 ? 'medium' : 'low',
        detail:
          `${item.queriesExecuted} query(ies) ran for "${item.value}" across ` +
          `${item.sourcesSearched} source(s) and discovered nothing.`,
        suggestion:
          'Either no such roles were posted in this window, or no configured source covers this ' +
          'market. Add a regional or specialist source to distinguish the two.',
      });
      continue;
    }

    const stale =
      item.lastSearchedAt !== null &&
      now.getTime() - item.lastSearchedAt.getTime() > windowHours * 3_600_000;

    if (stale) {
      gaps.push({
        kind: 'NOT_SEARCHED_RECENTLY',
        dimension: item.dimension,
        value: item.value,
        severity: 'low',
        detail: `"${item.value}" was last searched ${item.lastSearchedAt!.toISOString().slice(0, 10)}.`,
        suggestion: 'Increase the cadence of the sources that cover it.',
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  return gaps.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 50);
}
