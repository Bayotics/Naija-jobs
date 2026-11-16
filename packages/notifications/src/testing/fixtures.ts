import {
  notificationPreferencesSchema,
  type AlertData,
  type DigestData,
  type JobCardData,
  type NotificationPreferences,
  type SystemAlertData,
  type WeeklySummaryData,
} from '@job-intel/contracts';
import type { NotificationCandidate } from '../decision/notification-decider';

/**
 * Notification fixtures.
 *
 * Realistic enough that a rendered preview is worth looking at: real-looking
 * salaries, honest caveats, a mix of tiers, and one job carrying an update
 * note. A preview built from `title: 'Job 1'` tells you the template compiles
 * and nothing about whether the email is readable.
 */

export const FIXTURE_NOW = new Date('2026-08-18T09:30:00Z');
const PROFILE = '00000000-0000-4000-8000-0000000000c0';

export function makePreferences(
  overrides: Record<string, unknown> = {},
): NotificationPreferences {
  return notificationPreferencesSchema.parse({
    email: 'candidate@example.com',
    timezone: 'Europe/Berlin',
    ...overrides,
  });
}

export function makeJobCard(overrides: Partial<JobCardData> = {}): JobCardData {
  return {
    jobId: '00000000-0000-4000-8000-000000000001',
    title: 'Senior Frontend Engineer',
    company: 'Northwind',
    location: 'Berlin, DE',
    workArrangement: 'Remote',
    salary: 'EUR 80,000–100,000/year',

    matchScore: 96,
    confidence: 0.91,
    recommendationScore: 94,
    tier: 'EXCEPTIONAL',

    whyItMatches: [
      '96% candidate match (91% confidence)',
      'Posted 12 minutes ago',
      'From greenhouse, an authoritative source',
      'Application URL verified reachable',
      'Covers React, TypeScript, Next.js',
    ],
    concerns: ['Visa sponsorship is not explicitly stated'],
    matchedSkills: ['React', 'TypeScript', 'Next.js', 'GraphQL'],
    missingRequirements: [],

    sourceId: 'greenhouse',
    sourceLabel: 'Company Careers',
    postedAgo: '12 minutes ago',
    applyUrl: 'https://boards.greenhouse.io/northwind/jobs/4821',
    applyUrlKind: 'ats',
    applyUrlVerified: true,
    viewUrl: 'http://localhost:3000/matches/00000000-0000-4000-8000-000000000001',
    updateNote: null,
    ...overrides,
  };
}

export function makeCandidate(
  overrides: Partial<NotificationCandidate> = {},
): NotificationCandidate {
  return {
    jobId: '00000000-0000-4000-8000-000000000001',
    canonicalJobId: '00000000-0000-4000-8000-000000000001',
    companyKey: 'northwind',
    sourceId: 'greenhouse',

    recommendationScore: 94,
    matchScore: 96,
    confidence: 0.91,
    qualityScore: 92,
    freshnessHours: 0.2,
    scamRisk: 0.01,
    salaryAnnualUsd: 190_000,

    notificationEligible: true,
    notificationBlockers: [],
    lifecycleActive: true,
    isDuplicate: false,

    applicationUrlPresent: true,
    applicationUrlVerified: true,
    visaSponsorshipOffered: false,
    salaryMeetsTarget: true,
    remote: true,
    fromAuthoritativeSource: true,

    previouslyRejected: false,
    notifiedAt: null,
    materialChange: null,
    ...overrides,
  };
}

export function makeDigestData(overrides: Partial<DigestData> = {}): DigestData {
  return {
    subject: 'Your job digest — 5 opportunities',
    periodLabel: 'the last 24 hours',
    jobsDiscovered: 312,
    highQualityMatches: 5,
    sections: [
      {
        key: 'exceptional',
        icon: '🔥',
        title: 'Exceptional matches',
        jobs: [makeJobCard()],
      },
      {
        key: 'strong',
        icon: '🟢',
        title: 'Strong matches',
        jobs: [
          makeJobCard({
            jobId: '00000000-0000-4000-8000-000000000002',
            title: 'Staff Engineer, Platform',
            company: 'Helios',
            location: 'Amsterdam, NL',
            workArrangement: 'Hybrid',
            salary: 'EUR 95,000–115,000/year',
            matchScore: 88,
            confidence: 0.84,
            recommendationScore: 81,
            tier: 'STRONG',
            whyItMatches: [
              '88% candidate match (84% confidence)',
              'Posted 3 hours ago',
              'Corroborated across 2 sources',
            ],
            concerns: ['Requires 2 office days per week'],
            matchedSkills: ['TypeScript', 'Node.js', 'PostgreSQL'],
            missingRequirements: ['Kubernetes'],
            sourceId: 'lever',
            sourceLabel: 'Lever',
            postedAgo: '3 hours ago',
            applyUrl: 'https://jobs.lever.co/helios/2f91',
          }),
          makeJobCard({
            jobId: '00000000-0000-4000-8000-000000000003',
            title: 'Senior React Engineer',
            company: 'Cobalt',
            location: 'Remote (EU)',
            salary: null,
            matchScore: 84,
            confidence: 0.72,
            recommendationScore: 76,
            tier: 'STRONG',
            whyItMatches: ['84% candidate match (72% confidence)', 'Posted 8 hours ago'],
            concerns: ['Salary not stated', 'Visa sponsorship not mentioned'],
            matchedSkills: ['React', 'TypeScript'],
            sourceId: 'company-careers',
            sourceLabel: 'Cobalt Careers',
            postedAgo: '8 hours ago',
            applyUrl: 'https://cobalt.example/careers/react-engineer',
            applyUrlKind: 'company',
            applyUrlVerified: false,
            // The case worth previewing: an update to something already sent.
            updateNote: 'Salary rose by 17% since we last told you about this job',
          }),
        ],
      },
      {
        key: 'worth',
        icon: '🟡',
        title: 'Worth considering',
        jobs: [
          makeJobCard({
            jobId: '00000000-0000-4000-8000-000000000004',
            title: 'Frontend Developer',
            company: 'Agency Nine',
            location: 'Lagos, NG',
            workArrangement: 'On-site',
            salary: null,
            matchScore: 71,
            confidence: 0.55,
            recommendationScore: 66,
            tier: 'WORTH_CONSIDERING',
            whyItMatches: ['71% candidate match (55% confidence)', 'Posted 2 days ago'],
            concerns: ['Posting is thin', 'Application destination not confirmed'],
            matchedSkills: ['JavaScript'],
            missingRequirements: ['TypeScript', 'Testing'],
            sourceId: 'noisy-aggregator',
            sourceLabel: 'Aggregator',
            postedAgo: '2 days ago',
            applyUrl: 'https://aggregator.example/jobs/9931',
            applyUrlKind: 'aggregator',
            applyUrlVerified: false,
          }),
        ],
      },
    ],
    preferencesUrl: 'http://localhost:3000/settings/notifications?token=preview',
    generatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function makeAlertData(overrides: Partial<AlertData> = {}): AlertData {
  return {
    subject: '🚨 Senior Frontend Engineer — Northwind (94)',
    priority: 'URGENT',
    headline: 'Exceptional match',
    job: makeJobCard(),
    ruleName: 'Exceptional match with a verified application URL',
    preferencesUrl: 'http://localhost:3000/settings/notifications?token=preview',
    generatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function makeSystemAlertData(
  overrides: Partial<SystemAlertData> = {},
): SystemAlertData {
  return {
    subject: '[warning] LinkedIn discovery has failed 5 times',
    severity: 'warning',
    title: 'LinkedIn discovery is failing',
    summary:
      'The LinkedIn discovery connector has failed 5 consecutive times. Jobs from this source ' +
      'are not being discovered, so your recommendations may be missing openings.',
    facts: [
      { label: 'Source', value: 'linkedin-alerts' },
      { label: 'Consecutive failures', value: '5' },
      { label: 'Last success', value: '19 hours ago' },
      { label: 'Last error', value: 'HTTP 429: rate limited' },
    ],
    suggestedAction:
      'Check the source health page. If the connector needs credentials, disable the source ' +
      'until it is fixed so it stops consuming run budget.',
    preferencesUrl: 'http://localhost:3000/settings/notifications?token=preview',
    generatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function makeWeeklySummaryData(
  overrides: Partial<WeeklySummaryData> = {},
): WeeklySummaryData {
  return {
    subject: 'Your week in job intelligence',
    periodLabel: '11–18 August 2026',
    stats: {
      jobsDiscovered: 1284,
      jobsRecommended: 96,
      jobsNotified: 14,
      jobsSaved: 6,
      jobsClicked: 21,
      jobsApplied: 3,
      duplicatesMerged: 48,
      staleJobs: 62,
      averageMatchScore: 63.4,
    },
    topCompanies: [
      { label: 'Northwind', count: 6 },
      { label: 'Helios', count: 4 },
      { label: 'Cobalt', count: 3 },
    ],
    topLocations: [
      { label: 'Remote (EU)', count: 31 },
      { label: 'Berlin, DE', count: 18 },
      { label: 'Lagos, NG', count: 11 },
    ],
    topTechnologies: [
      { label: 'TypeScript', count: 74 },
      { label: 'React', count: 61 },
      { label: 'Node.js', count: 38 },
    ],
    bestSources: [
      { label: 'greenhouse', count: 12, averageScore: 78.2 },
      { label: 'lever', count: 9, averageScore: 71.5 },
      { label: 'arbeitnow', count: 44, averageScore: 51.8 },
    ],
    preferencesUrl: 'http://localhost:3000/settings/notifications?token=preview',
    generatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

export const FIXTURE_PROFILE_ID = PROFILE;
