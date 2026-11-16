import { qualityAssessmentSchema, type QualityAssessment } from '@job-intel/contracts';
import type { RecommendationInput } from '../engine/recommendation-engine';
import type { DedupCandidate } from '../dedup/signals';

/**
 * A realistic corpus.
 *
 * Fifty-six postings built to look like what the live sources actually return:
 * a handful of genuinely excellent roles, a long tail of mediocre ones, several
 * copies of the same job across different boards, a company that posted twenty
 * near-identical openings, some month-old listings, two advance-fee scams and
 * one job whose application URL has died.
 *
 * The point is not coverage for its own sake. A ranking engine looks correct
 * against a handful of hand-picked fixtures and falls apart the moment the
 * corpus is *mostly mediocre*, which is the shape of every real one. This
 * fixture is mostly mediocre.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function ago(ms: number, now = FIXTURE_NOW): Date {
  return new Date(now.getTime() - ms);
}

/** Fixed so score expectations are reproducible. */
export const FIXTURE_NOW = new Date('2026-08-18T12:00:00Z');

function quality(overrides: Partial<QualityAssessment> = {}): QualityAssessment {
  return qualityAssessmentSchema.parse({
    qualityScore: 0.7,
    scamScore: 0.02,
    qualityConfidence: 0.8,
    flags: [],
    components: {},
    ...overrides,
  });
}

export interface FixtureOptions {
  jobId: string;
  title: string;
  companyName: string;
  sourceId: string;
  sourceType: string;
  matchScore: number;
  matchConfidence?: number;
  matchEligible?: boolean;
  ageMs?: number;
  applyUrl?: string | null;
  postingUrl?: string | null;
  salaryAnnualUsd?: number | null;
  descriptionLength?: number;
  description?: string | null;
  enrichmentQuality?: QualityAssessment;
  companyId?: string | null;
  roleSlug?: string | null;
  technologies?: string[];
  duplicateOf?: string | null;
  duplicateSourceCount?: number;
  validThrough?: Date | null;
  absenceRuns?: number;
  verification?: { outcome: string; httpStatus: number | null } | null;
  applicationUrlReachable?: boolean | null;
  exposure?: RecommendationInput['exposure'];
  materialChange?: RecommendationInput['materialChange'];
  sightings?: Date[];
  contentHashes?: string[];
  claimedPostingDates?: Date[];
  contactEmails?: string[];
  minYearsExperience?: number | null;
  copiedDescriptionCount?: number;
  behavioralAffinity?: number;
}

export function makeRecommendationInput(options: FixtureOptions): RecommendationInput {
  const age = options.ageMs ?? 2 * DAY;
  const postedAt = ago(age);
  const description =
    options.description ??
    'We are hiring an engineer to build and maintain our platform. '.repeat(
      Math.max(1, Math.round((options.descriptionLength ?? 1400) / 60)),
    );

  return {
    jobId: options.jobId,
    title: options.title,
    companyName: options.companyName,
    companyId: options.companyId === undefined ? `company-${options.companyName}` : options.companyId,
    companyDomain: `${options.companyName.toLowerCase().replace(/\W+/g, '')}.example`,
    roleSlug: options.roleSlug ?? null,
    technologies: options.technologies ?? ['typescript', 'react'],
    sourceId: options.sourceId,
    sourceType: options.sourceType,

    matchScore: options.matchScore,
    matchConfidence: options.matchConfidence ?? 0.7,
    matchEligible: options.matchEligible ?? true,
    matchExplanation: `Match ${options.matchScore}/100 for ${options.title} at ${options.companyName}.`,
    matchedRequirements: ['typescript', 'react'],
    concerns: [],

    enrichmentQuality: options.enrichmentQuality ?? quality(),
    description,
    descriptionLength: description.length,
    requirements: ['5 years experience', 'TypeScript', 'React'],
    responsibilities: ['Build features', 'Review code'],
    salaryAnnualUsd: options.salaryAnnualUsd === undefined ? 120_000 : options.salaryAnnualUsd,
    minYearsExperience: options.minYearsExperience ?? 5,
    contactEmails: options.contactEmails ?? [],

    applyUrl:
      options.applyUrl === undefined
        ? `https://${options.sourceId}.example/apply/${options.jobId}`
        : options.applyUrl,
    /*
     * Null by default, so a fixture that explicitly sets `applyUrl: null` still
     * exercises the no-application-path branch. A default posting URL here
     * would make that branch unreachable from the fixtures.
     */
    postingUrl: options.postingUrl ?? null,
    applicationUrlReachable: options.applicationUrlReachable ?? null,
    verification: options.verification ?? null,

    postedAt,
    validThrough: options.validThrough ?? null,
    updatedAt: postedAt,
    firstSeenAt: postedAt,
    lastSeenAt: ago(HOUR),
    lastVerifiedAt: null,
    absenceRuns: options.absenceRuns ?? 0,
    removedFromSource: false,

    duplicateSourceCount: options.duplicateSourceCount ?? 1,
    duplicateOf: options.duplicateOf ?? null,
    copiedDescriptionCount: options.copiedDescriptionCount ?? 0,

    sightings: options.sightings ?? [postedAt, ago(HOUR)],
    contentHashes: options.contentHashes ?? [`hash-${options.jobId}`],
    claimedPostingDates: options.claimedPostingDates ?? [postedAt],

    exposure: options.exposure ?? null,
    materialChange: options.materialChange ?? null,
    ...(options.behavioralAffinity !== undefined
      ? { behavioralAffinity: options.behavioralAffinity }
      : {}),
  };
}

/** A dedup candidate with realistic defaults. */
export function makeDedupCandidate(overrides: Partial<DedupCandidate> & { jobId: string }): DedupCandidate {
  return {
    sourceId: 'source-a',
    externalId: null,
    // Per-source hosts, as in reality: the same job on LinkedIn and on a
    // careers page lives on different domains, and treating two paths on one
    // fake shared host as a conflict was an artefact of the fixture.
    sourceUrl: `https://${overrides.sourceId ?? 'source-a'}.test/jobs/${overrides.jobId}`,
    canonicalUrl: null,
    applyUrl: null,
    companyName: 'Acme Corp',
    companyDomain: 'acme.example',
    title: 'Senior Frontend Engineer',
    city: 'Berlin',
    countryCode: 'DE',
    remoteType: 'hybrid',
    salaryAnnualUsd: null,
    postedAt: ago(2 * DAY),
    description:
      'We are looking for a senior frontend engineer to own our design system, ' +
      'mentor the team and ship a large React and TypeScript application used by ' +
      'thousands of customers every day across Europe and North America.',
    requirements: ['5 years of React', 'TypeScript', 'Design systems'],
    atsVendor: null,
    atsSlug: null,
    simhash: null,
    ...overrides,
  };
}

const SCAM_DESCRIPTION =
  'URGENT HIRING! Work from home data entry. Immediate start. ' +
  'A one-time registration fee of $150 is required to process your application. ' +
  'Send payment via Bitcoin to secure your slot. Limited slots available! ' +
  'Contact recruiter.jobs2026@gmail.com with your bank account details.';

/**
 * The corpus.
 *
 * Composition is deliberate and documented so a test can assert on shape:
 * 3 excellent · 5 strong · 12 middling · 14 weak · 4 duplicate members ·
 * 5 stale/old · 2 scams · 1 dead URL · 20-job company cluster (8 included) ·
 * 2 previously notified · 1 reposted.
 */
export function buildFixtureCorpus(): RecommendationInput[] {
  const jobs: RecommendationInput[] = [];
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

  // ── The genuinely excellent: fresh, authoritative, well-paid ─────────────
  jobs.push(
    makeRecommendationInput({
      jobId: id(),
      title: 'Staff Frontend Engineer',
      companyName: 'Northwind',
      sourceId: 'greenhouse',
      sourceType: 'ats',
      matchScore: 94,
      matchConfidence: 0.86,
      ageMs: 40 * 60_000,
      salaryAnnualUsd: 185_000,
      applicationUrlReachable: true,
      roleSlug: 'frontend-engineer',
      enrichmentQuality: quality({ qualityScore: 0.94, qualityConfidence: 0.9 }),
    }),
    makeRecommendationInput({
      jobId: id(),
      title: 'Principal Engineer, Platform',
      companyName: 'Helios',
      sourceId: 'lever',
      sourceType: 'ats',
      matchScore: 91,
      matchConfidence: 0.82,
      ageMs: 3 * HOUR,
      salaryAnnualUsd: 200_000,
      applicationUrlReachable: true,
      roleSlug: 'platform-engineer',
      enrichmentQuality: quality({ qualityScore: 0.92, qualityConfidence: 0.88 }),
    }),
    makeRecommendationInput({
      jobId: id(),
      title: 'Senior React Engineer',
      companyName: 'Cobalt',
      sourceId: 'company-careers',
      sourceType: 'html_page',
      matchScore: 89,
      matchConfidence: 0.8,
      ageMs: 8 * HOUR,
      salaryAnnualUsd: 165_000,
      duplicateSourceCount: 3,
      roleSlug: 'frontend-engineer',
      enrichmentQuality: quality({ qualityScore: 0.9, qualityConfidence: 0.85 }),
    }),
  );

  // ── Strong but each flawed in one specific way ───────────────────────────
  jobs.push(
    // High match, but three weeks old.
    makeRecommendationInput({
      jobId: id(),
      title: 'Senior Frontend Engineer',
      companyName: 'Vega',
      sourceId: 'greenhouse',
      sourceType: 'ats',
      matchScore: 96,
      matchConfidence: 0.88,
      ageMs: 22 * DAY,
      salaryAnnualUsd: 170_000,
      roleSlug: 'frontend-engineer',
    }),
    // Slightly lower match but posted minutes ago on an authoritative source.
    makeRecommendationInput({
      jobId: id(),
      title: 'Frontend Engineer',
      companyName: 'Lumen',
      sourceId: 'company-careers',
      sourceType: 'html_page',
      matchScore: 88,
      matchConfidence: 0.84,
      ageMs: 22 * 60_000,
      salaryAnnualUsd: 150_000,
      applicationUrlReachable: true,
      roleSlug: 'frontend-engineer',
    }),
    makeRecommendationInput({
      jobId: id(),
      title: 'Full Stack Engineer',
      companyName: 'Praxis',
      sourceId: 'remotive',
      sourceType: 'job_api',
      matchScore: 84,
      ageMs: 12 * HOUR,
      salaryAnnualUsd: 140_000,
      roleSlug: 'fullstack-engineer',
    }),
    makeRecommendationInput({
      jobId: id(),
      title: 'Software Engineer, Frontend',
      companyName: 'Ardent',
      sourceId: 'jobicy',
      sourceType: 'job_api',
      matchScore: 82,
      ageMs: 30 * HOUR,
      salaryAnnualUsd: null,
      roleSlug: 'frontend-engineer',
    }),
    makeRecommendationInput({
      jobId: id(),
      title: 'Senior TypeScript Engineer',
      companyName: 'Quill',
      sourceId: 'arbeitnow',
      sourceType: 'job_api',
      matchScore: 80,
      ageMs: 2 * DAY,
      salaryAnnualUsd: 130_000,
      roleSlug: 'frontend-engineer',
    }),
  );

  // ── The company that posted twenty near-identical roles ──────────────────
  for (let i = 0; i < 8; i += 1) {
    jobs.push(
      makeRecommendationInput({
        jobId: id(),
        title: `Senior React Engineer ${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'][i]}`,
        companyName: 'Megacorp',
        companyId: 'company-Megacorp',
        sourceId: 'megacorp-careers',
        sourceType: 'html_page',
        matchScore: 86 - i,
        matchConfidence: 0.78,
        ageMs: (6 + i) * HOUR,
        salaryAnnualUsd: 155_000,
        roleSlug: 'frontend-engineer',
      }),
    );
  }

  // ── The noisy aggregator: many jobs, none special ────────────────────────
  for (let i = 0; i < 14; i += 1) {
    jobs.push(
      makeRecommendationInput({
        jobId: id(),
        title: `Web Developer ${i + 1}`,
        companyName: `Agency ${i + 1}`,
        sourceId: 'noisy-aggregator',
        sourceType: 'search_discovery',
        matchScore: 62 - i,
        matchConfidence: 0.45,
        ageMs: (4 + i) * DAY,
        salaryAnnualUsd: null,
        descriptionLength: 400,
        enrichmentQuality: quality({ qualityScore: 0.42, qualityConfidence: 0.5 }),
      }),
    );
  }

  // ── Merged duplicates of job #3 ─────────────────────────────────────────
  const cobaltId = jobs[2]!.jobId;
  for (const source of ['linkedin-alerts', 'noisy-aggregator', 'reddit-dev-jobs', 'jobicy']) {
    jobs.push(
      makeRecommendationInput({
        jobId: id(),
        title: 'Senior React Engineer',
        companyName: 'Cobalt',
        sourceId: source,
        sourceType: source === 'reddit-dev-jobs' ? 'social' : 'job_api',
        matchScore: 89,
        ageMs: 10 * HOUR,
        duplicateOf: cobaltId,
        roleSlug: 'frontend-engineer',
      }),
    );
  }

  // ── Stale, expired and dead ─────────────────────────────────────────────
  jobs.push(
    makeRecommendationInput({
      jobId: id(),
      title: 'Lead Frontend Engineer',
      companyName: 'Obsidian',
      sourceId: 'hotnigerianjobs',
      sourceType: 'html_page',
      matchScore: 87,
      ageMs: 70 * DAY,
      absenceRuns: 4,
      roleSlug: 'frontend-engineer',
    }),
    makeRecommendationInput({
      jobId: id(),
      title: 'Frontend Developer',
      companyName: 'Petra',
      sourceId: 'arbeitnow',
      sourceType: 'job_api',
      matchScore: 83,
      ageMs: 40 * DAY,
      validThrough: ago(5 * DAY),
      roleSlug: 'frontend-engineer',
    }),
    makeRecommendationInput({
      jobId: id(),
      title: 'React Engineer',
      companyName: 'Solstice',
      sourceId: 'jobicy',
      sourceType: 'job_api',
      matchScore: 90,
      ageMs: 6 * DAY,
      verification: { outcome: 'not_found', httpStatus: 404 },
      applicationUrlReachable: false,
      roleSlug: 'frontend-engineer',
    }),
    makeRecommendationInput({
      jobId: id(),
      title: 'Senior Engineer',
      companyName: 'Tessera',
      sourceId: 'weworkremotely-programming',
      sourceType: 'rss_feed',
      matchScore: 79,
      ageMs: 15 * DAY,
      description:
        'Thank you for your interest. This position has been filled and we are no longer accepting applications.',
      roleSlug: 'backend-engineer',
    }),
    makeRecommendationInput({
      jobId: id(),
      title: 'Frontend Engineer (Contract)',
      companyName: 'Kestrel',
      sourceId: 'noisy-aggregator',
      sourceType: 'search_discovery',
      matchScore: 76,
      ageMs: 55 * DAY,
      applyUrl: null,
      roleSlug: 'frontend-engineer',
    }),
  );

  // ── Scams ───────────────────────────────────────────────────────────────
  jobs.push(
    makeRecommendationInput({
      jobId: id(),
      title: 'Remote Data Entry Specialist — Earn $200k',
      companyName: 'Confidential',
      companyId: null,
      sourceId: 'noisy-aggregator',
      sourceType: 'search_discovery',
      matchScore: 71,
      ageMs: 2 * HOUR,
      salaryAnnualUsd: 200_000,
      minYearsExperience: 0,
      description: SCAM_DESCRIPTION,
      contactEmails: ['recruiter.jobs2026@gmail.com'],
      enrichmentQuality: quality({ qualityScore: 0.2, scamScore: 0.7, qualityConfidence: 0.6 }),
    }),
    makeRecommendationInput({
      jobId: id(),
      title: 'Work From Home Package Handler',
      companyName: 'Our Client',
      companyId: null,
      sourceId: 'reddit-dev-jobs',
      sourceType: 'social',
      matchScore: 55,
      ageMs: 5 * HOUR,
      description:
        'Immediate start! Contact us on WhatsApp +1 555 0100 to begin. ' +
        'A small processing fee applies. Send your passport copy and bank details.',
      contactEmails: ['hr.dept@yahoo.com'],
      enrichmentQuality: quality({ qualityScore: 0.15, scamScore: 0.8, qualityConfidence: 0.6 }),
    }),
  );

  // ── Previously notified, one with a real change ─────────────────────────
  jobs.push(
    makeRecommendationInput({
      jobId: id(),
      title: 'Senior Frontend Engineer',
      companyName: 'Ferrous',
      sourceId: 'greenhouse',
      sourceType: 'ats',
      matchScore: 90,
      ageMs: 9 * DAY,
      salaryAnnualUsd: 175_000,
      roleSlug: 'frontend-engineer',
      exposure: {
        state: 'notified',
        timesShown: 1,
        firstShownAt: ago(8 * DAY),
        lastShownAt: ago(8 * DAY),
        notifiedAt: ago(8 * DAY),
        notifiedContentHash: 'old-hash',
        notifiedScore: 82,
      },
      materialChange: {
        changed: true,
        changes: [
          {
            field: 'salary',
            before: '$150,000/yr',
            after: '$175,000/yr',
            significance: 0.9,
            direction: 'improved',
            summary: 'Salary rose by 17%',
          },
        ],
        maxSignificance: 0.9,
        explanation: 'Salary rose by 17%',
      },
    }),
    makeRecommendationInput({
      jobId: id(),
      title: 'Frontend Engineer',
      companyName: 'Onyx',
      sourceId: 'lever',
      sourceType: 'ats',
      matchScore: 85,
      ageMs: 11 * DAY,
      roleSlug: 'frontend-engineer',
      exposure: {
        state: 'notified',
        timesShown: 1,
        firstShownAt: ago(10 * DAY),
        lastShownAt: ago(10 * DAY),
        notifiedAt: ago(10 * DAY),
        notifiedContentHash: 'same-hash',
        notifiedScore: 80,
      },
      materialChange: {
        changed: false,
        changes: [],
        maxSignificance: 0,
        explanation: 'No material change; only formatting or metadata moved',
      },
    }),
  );

  // ── Candidate verdicts ──────────────────────────────────────────────────
  jobs.push(
    makeRecommendationInput({
      jobId: id(),
      title: 'Senior Frontend Engineer',
      companyName: 'Basalt',
      sourceId: 'greenhouse',
      sourceType: 'ats',
      matchScore: 92,
      ageMs: 4 * HOUR,
      salaryAnnualUsd: 180_000,
      roleSlug: 'frontend-engineer',
      exposure: {
        state: 'rejected',
        timesShown: 2,
        firstShownAt: ago(3 * DAY),
        lastShownAt: ago(2 * DAY),
        notifiedAt: null,
        notifiedContentHash: null,
        notifiedScore: null,
      },
    }),
    makeRecommendationInput({
      jobId: id(),
      title: 'Backend Engineer',
      companyName: 'Cinder',
      sourceId: 'remotive',
      sourceType: 'job_api',
      matchScore: 74,
      ageMs: 3 * DAY,
      matchEligible: false,
      roleSlug: 'backend-engineer',
    }),
  );

  // ── A repost ────────────────────────────────────────────────────────────
  jobs.push(
    makeRecommendationInput({
      jobId: id(),
      title: 'Senior Frontend Engineer',
      companyName: 'Marlow',
      sourceId: 'jobicy',
      sourceType: 'job_api',
      matchScore: 85,
      ageMs: 2 * DAY,
      roleSlug: 'frontend-engineer',
      sightings: [ago(50 * DAY), ago(45 * DAY), ago(2 * DAY)],
      contentHashes: ['h1', 'h1', 'h1'],
      claimedPostingDates: [ago(50 * DAY), ago(20 * DAY), ago(2 * DAY)],
    }),
  );

  // ── Filler: the long mediocre tail every real corpus has ─────────────────
  const fillerRoles = ['QA Engineer', 'Support Engineer', 'Data Analyst', 'Project Manager'];
  for (let i = 0; i < 4; i += 1) {
    jobs.push(
      makeRecommendationInput({
        jobId: id(),
        title: fillerRoles[i] as string,
        companyName: `Filler ${i + 1}`,
        sourceId: 'arbeitnow',
        sourceType: 'job_api',
        matchScore: 45 - i * 5,
        matchConfidence: 0.35,
        ageMs: (10 + i * 3) * DAY,
        salaryAnnualUsd: null,
        descriptionLength: 600,
        enrichmentQuality: quality({ qualityScore: 0.5, qualityConfidence: 0.55 }),
        roleSlug: 'other',
      }),
    );
  }

  return jobs;
}

export const FIXTURE_COMPOSITION = {
  total: 50,
  duplicates: 4,
  scams: 2,
  staleOrClosed: 5,
  companyCluster: 8,
  noisySource: 14,
  previouslyNotified: 2,
} as const;
