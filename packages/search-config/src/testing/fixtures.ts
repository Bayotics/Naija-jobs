import {
  candidatePreferencesSchema,
  searchProfileSchema,
  searchStateSchema,
  type CandidatePreferences,
  type SearchProfile,
  type SearchState,
} from '@job-intel/contracts';

/**
 * Fixtures for the configuration layer.
 *
 * The starting profile is the one the brief's end-to-end scenario names —
 * remote, Nigeria, frontend, React and TypeScript, hourly, three sources — so
 * the test that transforms it into "hybrid or onsite in Germany, €70k, senior
 * frontend, LinkedIn and career pages only" is exercising the real journey
 * rather than a convenient one.
 */

export const CANDIDATE_ID = '11111111-2222-4333-8444-555555555555';
export const PROFILE_ID = '22222222-3333-4444-8555-666666666666';
export const SECOND_PROFILE_ID = '33333333-4444-4555-8666-777777777777';
export const NOW = new Date('2025-06-15T12:00:00Z');

export const AVAILABLE_SOURCES = [
  'linkedin',
  'reddit',
  'x',
  'company-career-pages',
  'greenhouse',
  'lever',
  'hotnigerianjobs',
  'indeed',
];

/** The scenario's starting point, verbatim from Part 50. */
export function startingProfile(overrides: Partial<SearchProfile> = {}): SearchProfile {
  return searchProfileSchema.parse({
    id: PROFILE_ID,
    candidateId: CANDIDATE_ID,
    profileName: 'Frontend Nigeria',
    state: 'active',
    enabled: true,

    roles: [
      { title: 'Frontend Engineer', priority: 'primary', rank: 0, alternatives: [] },
      { title: 'Frontend Developer', priority: 'secondary', rank: 1, alternatives: [] },
    ],

    locations: [{ kind: 'country', value: 'NG', label: 'Nigeria', priority: 'primary' }],
    locationStrictness: 'preferred',
    remotePreference: 'REMOTE_ONLY',

    seniorityLevels: ['mid', 'senior'],

    salary: {
      minimum: null,
      currency: 'USD',
      period: 'year',
      strictness: 'flexible',
      acceptUnstated: true,
    },

    skills: [
      { value: 'react', label: 'React', tier: 'required' },
      { value: 'typescript', label: 'TypeScript', tier: 'required' },
    ],

    sources: [
      { sourceId: 'linkedin', enabled: true, priority: 'high' },
      { sourceId: 'reddit', enabled: true, priority: 'medium' },
      { sourceId: 'x', enabled: true, priority: 'medium' },
      { sourceId: 'company-career-pages', enabled: true, priority: 'very_high' },
    ],

    searchFrequency: 'hourly',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

/** A second, overlapping strategy — for the multi-profile tests. */
export function secondProfile(overrides: Partial<SearchProfile> = {}): SearchProfile {
  return searchProfileSchema.parse({
    id: SECOND_PROFILE_ID,
    candidateId: CANDIDATE_ID,
    profileName: 'Cloud Europe',
    roles: [{ title: 'Platform Engineer', priority: 'primary', rank: 0, alternatives: [] }],
    locations: [{ kind: 'region', value: 'eu', label: 'European Union', priority: 'primary' }],
    remotePreference: 'REMOTE_OR_HYBRID',
    seniorityLevels: ['senior', 'staff'],
    skills: [
      { value: 'kubernetes', label: 'Kubernetes', tier: 'required' },
      { value: 'terraform', label: 'Terraform', tier: 'preferred' },
    ],
    sources: [{ sourceId: 'greenhouse', enabled: true, priority: 'high' }],
    searchFrequency: 'every_6_hours',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

/** General preferences, with one hard constraint to exercise precedence. */
export function preferences(overrides: Partial<CandidatePreferences> = {}): CandidatePreferences {
  return candidatePreferencesSchema.parse({
    titles: [{ value: 'Frontend Engineer', strength: 'strongly_preferred', hard: false, source: 'explicit' }],
    seniorityLevels: ['senior'],
    salary: {
      minimum: 40_000,
      target: 60_000,
      currency: 'USD',
      period: 'year',
      // Not hard by default; individual tests turn this on.
      minimumIsHard: false,
    },
    technologies: [
      { value: 'React', strength: 'strongly_preferred', hard: false, source: 'explicit' },
      // A hard exclusion, so the resolver has something to merge.
      { value: 'PHP', strength: 'excluded', hard: true, source: 'explicit' },
    ],
    excludedKeywords: ['unpaid'],
    ...overrides,
  });
}

export function state(overrides: Partial<SearchState> = {}): SearchState {
  return searchStateSchema.parse({ candidateId: CANDIDATE_ID, ...overrides });
}

/** The instruction the brief's end-to-end scenario issues. */
export const SCENARIO_INSTRUCTION =
  'Stop searching remote jobs. I want hybrid or onsite jobs in Germany, minimum €70,000, ' +
  'focused on Senior Frontend Engineer roles. Disable Reddit and X. ' +
  'Keep LinkedIn and company career pages.';

/** The follow-up that creates a temporary override. */
export const TEMPORARY_INSTRUCTION =
  'For the next 48 hours, also include remote jobs paying over €100,000.';
