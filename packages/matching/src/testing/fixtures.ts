import {
  candidatePreferencesSchema,
  candidateProfilePayloadSchema,
  jobEnrichmentSchema,
  type JobEnrichment,
} from '@job-intel/contracts';
import { SkillGraph } from '@job-intel/candidate';
import type { MatchCandidateContext, MatchJobContext } from '../types';

/**
 * Test fixtures.
 *
 * Built by deep-merging overrides into a schema-validated baseline, so a test
 * states only the fact it cares about ("this job is on-site in Berlin") and
 * every other field remains realistic. Fixtures that spell out forty fields per
 * scenario are unreadable, and the reader cannot tell which of them mattered.
 *
 * The baseline is deliberately *neutral*: a candidate with no stated
 * preferences and a job that omits everything optional. A scenario that
 * produces a strong or weak match therefore does so because of what the test
 * set, not because of a fixture default nobody read.
 */

type Deep<T> = { [K in keyof T]?: T[K] extends object | null ? Deep<NonNullable<T[K]>> : T[K] };

function merge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      result[key] = merge(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

const BASE_ENRICHMENT = {
  enrichmentVersion: 1,
  normalizedTitle: 'Software Engineer',
  titleConfidence: 0.9,
  roleSlug: 'software-engineer',
  seniority: null,
  seniorityConfidence: 0,
  seniorityEvidence: null,
  seniorityConflict: null,
  experience: {
    minimumYears: null,
    maximumYears: null,
    confidence: 0,
    method: 'default',
    rawText: null,
    qualitativeOnly: false,
  },
  employmentTypes: [],
  workArrangement: {
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
  },
  location: {
    raw: null,
    city: null,
    region: null,
    countryCode: null,
    timezoneHint: null,
    confidence: 0,
    method: 'default',
  },
  compensation: {
    stated: false,
    minimum: null,
    maximum: null,
    currency: null,
    period: null,
    isOpenEnded: false,
    isEstimated: false,
    rawText: null,
    components: [],
    confidence: 0,
    method: 'default',
    conversion: null,
  },
  workAuthorization: {
    sponsorship: 'not_mentioned',
    sponsorshipConfidence: 0.5,
    sponsorshipEvidence: null,
    workAuthorizationRequirement: null,
    citizenshipRequired: null,
    securityClearanceRequired: null,
    securityClearanceLevel: null,
    relocationSupport: 'not_mentioned',
    relocationEvidence: null,
  },
  education: {
    level: null,
    requirement: 'not_specified',
    fields: [],
    certifications: [],
    confidence: 0,
    method: 'default',
    evidence: null,
  },
  classification: {
    jobFunction: 'software_engineering',
    functionConfidence: 0.8,
    industries: [],
    industryConfidence: 0,
    method: 'default',
    evidence: null,
  },
  quality: {
    qualityScore: 0.8,
    scamScore: 0.02,
    qualityConfidence: 0.8,
    flags: [],
    components: {},
  },
  applicationTarget: {
    sourceUrl: 'https://example.com/jobs/1',
    canonicalJobUrl: null,
    applicationUrl: null,
    atsVendor: null,
    atsSlug: null,
    confidence: 0.5,
    kind: 'source',
    candidates: [],
  },
  skills: [],
  responsibilities: [],
  requirements: [],
  preferredQualifications: [],
  benefits: [],
  cleanedDescription: null,
  cleaningRemovedChars: 0,
  applicationDeadline: null,
  stageReports: [],
  aiUsed: false,
  aiModel: null,
  aiInputTokens: null,
  aiOutputTokens: null,
  aiCostUsd: null,
  aiError: null,
  totalDurationMs: 5,
} satisfies Record<string, unknown>;

/** A schema-validated enrichment with everything optional left unstated. */
export function makeEnrichment(overrides: Record<string, unknown> = {}): JobEnrichment {
  return jobEnrichmentSchema.parse(merge(BASE_ENRICHMENT, overrides));
}

/** Convenience for the common case of a required-skill list. */
export function makeSkills(
  entries: Array<[slug: string, requirement?: 'required' | 'preferred' | 'optional' | 'inferred']>,
): Array<Record<string, unknown>> {
  return entries.map(([slug, requirement = 'required']) => ({
    slug,
    displayName: slug,
    category: 'language',
    requirement,
    confidence: 0.9,
    method: 'taxonomy',
    matchedText: slug,
    evidence: null,
  }));
}

export interface CandidateFixtureOptions {
  preferences?: Record<string, unknown>;
  professional?: Record<string, unknown>;
  skills?: MatchCandidateContext['skills'];
  learnedSignals?: MatchCandidateContext['learnedSignals'];
  embedding?: MatchCandidateContext['embedding'];
  skillGraph?: SkillGraph;
  profileVersion?: number;
  preferenceVersion?: number;
}

export function makeCandidateContext(
  options: CandidateFixtureOptions = {},
): MatchCandidateContext {
  return {
    profileId: '00000000-0000-4000-8000-0000000000c0',
    profileVersion: options.profileVersion ?? 1,
    preferenceVersion: options.preferenceVersion ?? 1,
    profile: candidateProfilePayloadSchema.parse({
      identity: { fullName: 'Test Candidate', email: 'candidate@example.com' },
      professional: options.professional ?? {},
    }),
    preferences: candidatePreferencesSchema.parse(options.preferences ?? {}),
    skills: options.skills ?? [],
    skillGraph: options.skillGraph ?? new SkillGraph(),
    embedding: options.embedding ?? null,
    learnedSignals: options.learnedSignals ?? [],
  };
}

export interface JobFixtureOptions {
  jobId?: string;
  title?: string;
  companyName?: string;
  description?: string | null;
  enrichment?: Record<string, unknown>;
  embedding?: MatchJobContext['embedding'];
}

export function makeJobContext(options: JobFixtureOptions = {}): MatchJobContext {
  return {
    jobId: options.jobId ?? '00000000-0000-4000-8000-0000000000a1',
    jobVersion: 1,
    title: options.title ?? 'Software Engineer',
    companyName: options.companyName ?? 'Example Co',
    description: options.description ?? 'We build software.',
    enrichment: makeEnrichment(options.enrichment ?? {}),
    embedding: options.embedding ?? null,
  };
}

/** A candidate skill entry with sensible defaults. */
export function makeCandidateSkill(
  name: string,
  overrides: Partial<MatchCandidateContext['skills'][number]> = {},
): MatchCandidateContext['skills'][number] {
  return {
    name,
    slug: name.toLowerCase(),
    category: null,
    proficiency: null,
    yearsOfExperience: null,
    lastUsedYear: null,
    importance: 'secondary',
    evidence: null,
    source: 'explicit',
    ...overrides,
  };
}

export type DeepPartialEnrichment = Deep<JobEnrichment>;
