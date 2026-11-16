import {
  notificationIntelligenceConfigSchema,
  type ApplicationRecommendation,
  type NotificationIntelligenceConfig,
  type NotificationOverride,
} from '@job-intel/contracts';
import { assessDeadline, assessRarity } from '../scoring/timing';
import type { ScoringInput } from '../scoring/notification-score';

/**
 * Synthetic jobs for exercising the notification policy.
 *
 * The point is not realism for its own sake. Each fixture is built around one
 * way a notification system plausibly gets it wrong — emailing about a job the
 * candidate already applied to, waking someone for a mediocre role that happens
 * to be expiring, alerting five times about one employer — so that running the
 * fifty together says something about the policy rather than confirming the
 * happy path works.
 */

export const CANDIDATE_ID = '11111111-2222-4333-8444-555555555555';
export const NOW = new Date('2025-06-15T12:00:00Z');

export const uuid = (n: number): string =>
  `${String(n).padStart(8, '0')}-2222-4222-8222-222222222222`;

export function baseConfig(
  overrides: Partial<NotificationIntelligenceConfig> = {},
): NotificationIntelligenceConfig {
  /*
   * Thresholds are deliberately NOT restated here.
   *
   * An earlier version pinned them at the old defaults, which meant a later
   * recalibration of those defaults never reached the simulation — the fifty
   * fixtures kept testing a policy the product no longer shipped. Letting the
   * schema supply them means the simulation exercises what candidates actually
   * get.
   */
  return notificationIntelligenceConfigSchema.parse({
    timezone: 'Europe/London',
    cooldowns: {
      sameJobHours: 24,
      sameCompanyHours: 2,
      sameRoleHours: 1,
      maxAlertsPerRollingDay: 5,
      maxAlertsPerRollingHour: 2,
    },
    minimumRecommendation: 'CONSIDER',
    ...overrides,
  });
}

const hoursAgo = (n: number): Date => new Date(NOW.getTime() - n * 3_600_000);
const hoursAhead = (n: number): Date => new Date(NOW.getTime() + n * 3_600_000);

export interface JobFixture {
  id: string;
  name: string;
  /** The failure mode this fixture is built to catch. */
  tests: string;
  title: string;
  companyName: string;
  technologies: string[];
  countryCode: string | null;
  remote: boolean;
  seniority: string | null;
  salaryAnnualUsd: number | null;
  postedAt: Date | null;
  validThrough: Date | null;
  closed: boolean;
  description: string;
  sourceId: string;
  applyUrl: string | null;

  matchScore: number | null;
  applicationValueScore: number | null;
  recommendation: ApplicationRecommendation | null;
  jobQuality: number | null;
  scamRisk: number;

  /** Job-level facts the suppression engine reads. */
  alreadyApplied?: boolean;
  isDuplicate?: boolean;
  previouslyRejected?: boolean;
  suspicious?: boolean;

  /** What the fixture expects: instant, digest, dashboard or suppressed. */
  expected: string[];
}

let counter = 1;

function job(fixture: Omit<JobFixture, 'id'>): JobFixture {
  return { id: uuid(counter++), ...fixture };
}

/** A strong, ordinary software role. Most fixtures vary one thing from this. */
const STRONG = {
  title: 'Senior Frontend Engineer',
  companyName: 'Northwind Software',
  technologies: ['react', 'typescript', 'nextjs'],
  countryCode: 'GB',
  remote: true,
  seniority: 'senior',
  salaryAnnualUsd: 130_000,
  postedAt: hoursAgo(2),
  validThrough: null,
  closed: false,
  description: 'Requirements: 5+ years React and TypeScript.',
  sourceId: 'greenhouse',
  applyUrl: 'https://boards.greenhouse.io/northwind/jobs/1',
  matchScore: 94,
  applicationValueScore: 88,
  recommendation: 'APPLY_NOW' as ApplicationRecommendation,
  jobQuality: 0.9,
  scamRisk: 0.03,
};

export const JOB_FIXTURES: readonly JobFixture[] = [
  // ── 1–6. The clear yes, and the clear no ────────────────────────────────
  job({ ...STRONG, name: 'excellent-fresh', tests: 'everything aligns and it is two hours old', expected: ['instant'] }),
  job({
    ...STRONG,
    name: 'excellent-but-old',
    tests: 'same job, three weeks old — still good, less urgent',
    postedAt: hoursAgo(504),
    expected: ['instant', 'digest'],
  }),
  job({
    ...STRONG,
    name: 'good-not-exceptional',
    tests: 'a solid job that should reach the digest, not the phone',
    matchScore: 74,
    applicationValueScore: 68,
    recommendation: 'APPLY',
    expected: ['digest', 'dashboard'],
  }),
  job({
    ...STRONG,
    name: 'mediocre',
    tests: 'the case the whole layer exists for — must not email',
    matchScore: 52,
    applicationValueScore: 44,
    recommendation: 'CONSIDER',
    jobQuality: 0.55,
    expected: ['dashboard', 'suppressed'],
  }),
  job({
    ...STRONG,
    name: 'poor-match',
    tests: 'below every threshold',
    title: 'Embedded Firmware Engineer',
    technologies: ['cpp', 'rtos'],
    matchScore: 21,
    applicationValueScore: 18,
    recommendation: 'SKIP',
    jobQuality: 0.6,
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'blocked',
    tests: 'the application layer found a hard blocker',
    recommendation: 'BLOCKED',
    applicationValueScore: 30,
    expected: ['suppressed'],
  }),

  // ── 7–12. Timing ────────────────────────────────────────────────────────
  job({
    ...STRONG,
    name: 'deadline-imminent',
    tests: 'strong job closing in six hours — the CRITICAL case',
    validThrough: hoursAhead(6),
    expected: ['instant'],
  }),
  job({
    ...STRONG,
    name: 'deadline-three-days',
    tests: 'closing within three days',
    validThrough: hoursAhead(60),
    expected: ['instant', 'digest'],
  }),
  job({
    ...STRONG,
    name: 'deadline-passed',
    tests: 'a perfect job whose deadline has gone — must never notify',
    validThrough: hoursAgo(48),
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'closed-at-source',
    tests: 'lifecycle marked it closed',
    closed: true,
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'mediocre-but-expiring',
    tests: 'urgency must not rescue a weak job',
    matchScore: 48,
    applicationValueScore: 40,
    recommendation: 'CONSIDER',
    validThrough: hoursAhead(5),
    jobQuality: 0.5,
    expected: ['dashboard', 'suppressed', 'digest'],
  }),
  job({
    ...STRONG,
    name: 'open-until-filled',
    tests: 'no deadline and says so — should not read as urgent',
    description: 'Open until filled. Requirements: 5+ years React.',
    postedAt: hoursAgo(200),
    expected: ['instant', 'digest'],
  }),

  // ── 13–18. Links ────────────────────────────────────────────────────────
  job({
    ...STRONG,
    name: 'no-apply-url',
    tests: 'nothing to link to — must not email',
    applyUrl: null,
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'search-page-url',
    tests: 'the link is a search results page, which is useless',
    applyUrl: 'https://example.invalid/jobs/search?q=frontend',
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'homepage-url',
    tests: 'the link is an aggregator homepage',
    applyUrl: 'https://www.linkedin.com/',
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'credentials-url',
    tests: 'a URL embedding credentials is a phishing shape',
    applyUrl: 'https://user:pass@example.invalid/jobs/9',
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'javascript-url',
    tests: 'an unsafe scheme must never reach an email',
    applyUrl: 'javascript:alert(1)',
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'clean-ats-url',
    tests: 'a direct ATS link is exactly what should be sent',
    applyUrl: 'https://jobs.lever.co/northwind/abc-123',
    expected: ['instant'],
  }),

  // ── 19–24. History ──────────────────────────────────────────────────────
  job({ ...STRONG, name: 'already-applied', tests: 'applied to it already', alreadyApplied: true, expected: ['suppressed'] }),
  job({ ...STRONG, name: 'duplicate', tests: 'same role from another board', isDuplicate: true, expected: ['suppressed'] }),
  job({
    ...STRONG,
    name: 'previously-rejected',
    tests: 'the candidate dismissed it and nothing changed',
    previouslyRejected: true,
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'suspicious',
    tests: 'fraud markers — never emailed, still on the dashboard',
    companyName: 'Unknown',
    description: 'Work from home! Pay a registration fee. Contact us on WhatsApp.',
    suspicious: true,
    jobQuality: 0.15,
    scamRisk: 0.85,
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'rediscovered',
    tests: 'the hourly scan found the same URL again — must not re-alert',
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'salary-added',
    tests: 'meaningfully changed since the last alert — may re-notify',
    salaryAnnualUsd: 165_000,
    expected: ['instant', 'digest'],
  }),

  // ── 25–30. Preferences and overrides ────────────────────────────────────
  job({
    ...STRONG,
    name: 'favourite-company',
    tests: 'a starred employer should be boosted, not auto-alerted',
    companyName: 'Vercel',
    expected: ['instant'],
  }),
  job({
    ...STRONG,
    name: 'favourite-company-weak-job',
    tests: 'a starred employer posting a weak role must still be judged',
    companyName: 'Vercel',
    title: 'Office Administrator',
    technologies: [],
    matchScore: 24,
    applicationValueScore: 20,
    recommendation: 'SKIP',
    expected: ['suppressed', 'dashboard'],
  }),
  job({
    ...STRONG,
    name: 'blocked-company',
    tests: 'never alert about this employer',
    companyName: 'Bad Employer Ltd',
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'blocked-company-starred-title',
    tests: 'the precedence conflict — block must win',
    companyName: 'Bad Employer Ltd',
    title: 'Senior React Engineer',
    expected: ['suppressed'],
  }),
  job({
    ...STRONG,
    name: 'always-alert-title',
    tests: 'an always-alert rule lifts a job over the threshold',
    title: 'Staff Platform Engineer',
    matchScore: 62,
    applicationValueScore: 58,
    recommendation: 'CONSIDER',
    expected: ['instant', 'digest'],
  }),
  job({
    ...STRONG,
    name: 'excluded-source',
    tests: 'a muted source',
    sourceId: 'noisy-aggregator',
    expected: ['suppressed'],
  }),

  // ── 31–36. Rate limits ──────────────────────────────────────────────────
  job({ ...STRONG, name: 'company-cooldown', tests: 'second alert from one employer within the window', expected: ['suppressed'] }),
  job({ ...STRONG, name: 'daily-limit', tests: 'the daily interruption budget is spent', expected: ['suppressed'] }),
  job({ ...STRONG, name: 'hourly-limit', tests: 'two already sent this hour', expected: ['suppressed'] }),
  job({
    ...STRONG,
    name: 'critical-beats-company-cooldown',
    tests: 'a CRITICAL deadline may break the company cooldown',
    validThrough: hoursAhead(4),
    expected: ['instant'],
  }),
  job({ ...STRONG, name: 'quiet-hours', tests: 'arrives at 3am — held for the digest', expected: ['suppressed'] }),
  job({
    ...STRONG,
    name: 'quiet-hours-critical',
    tests: 'a CRITICAL deadline may interrupt quiet hours',
    validThrough: hoursAhead(3),
    expected: ['instant'],
  }),

  // ── 37–42. Rarity and salary ────────────────────────────────────────────
  job({
    ...STRONG,
    name: 'rare-combination',
    tests: 'the exact combination the candidate wants, rarely seen',
    expected: ['instant'],
  }),
  job({
    ...STRONG,
    name: 'common-combination',
    tests: 'a combination seen constantly — rarity adds nothing',
    expected: ['instant', 'digest'],
  }),
  job({
    ...STRONG,
    name: 'salary-well-above-target',
    tests: 'strong pay should lift the score',
    salaryAnnualUsd: 200_000,
    expected: ['instant'],
  }),
  job({
    ...STRONG,
    name: 'salary-below-target',
    tests: 'weak pay lowers the score without blocking',
    salaryAnnualUsd: 55_000,
    matchScore: 78,
    applicationValueScore: 66,
    recommendation: 'APPLY',
    expected: ['digest', 'dashboard', 'instant'],
  }),
  job({
    ...STRONG,
    name: 'salary-unstated',
    tests: 'silence about pay must not be read as bad pay',
    salaryAnnualUsd: null,
    expected: ['instant', 'digest'],
  }),
  job({
    ...STRONG,
    name: 'remote-mismatch',
    tests: 'onsite in a country the candidate is not in',
    remote: false,
    countryCode: 'US',
    matchScore: 40,
    applicationValueScore: 32,
    recommendation: 'SKIP',
    expected: ['suppressed'],
  }),

  // ── 43–50. Quality, sources, edges ──────────────────────────────────────
  job({
    ...STRONG,
    name: 'thin-posting',
    tests: 'a real job with almost no description',
    description: 'Frontend dev needed.',
    jobQuality: 0.2,
    matchScore: 70,
    applicationValueScore: 55,
    recommendation: 'CONSIDER',
    expected: ['dashboard', 'digest', 'suppressed'],
  }),
  job({
    ...STRONG,
    name: 'no-match-yet',
    tests: 'discovered but not matched — low confidence, no interruption',
    matchScore: null,
    applicationValueScore: null,
    recommendation: null,
    expected: ['dashboard', 'digest', 'suppressed'],
  }),
  job({
    ...STRONG,
    name: 'no-posting-date',
    tests: 'freshness unknown — drops out rather than scoring zero',
    postedAt: null,
    expected: ['instant', 'digest'],
  }),
  job({
    ...STRONG,
    name: 'recommendation-unknown',
    tests: 'application analysis could not decide',
    recommendation: 'UNKNOWN',
    applicationValueScore: 40,
    expected: ['suppressed', 'dashboard'],
  }),
  job({
    ...STRONG,
    name: 'stretch-role',
    tests: 'a level above, still worth hearing about',
    title: 'Staff Frontend Engineer',
    seniority: 'staff',
    matchScore: 80,
    applicationValueScore: 72,
    recommendation: 'APPLY',
    expected: ['instant', 'digest'],
  }),
  job({
    ...STRONG,
    name: 'second-role-same-company',
    tests: 'one employer posting several roles',
    title: 'Senior Backend Engineer',
    expected: ['instant', 'digest', 'suppressed'],
  }),
  job({
    ...STRONG,
    name: 'unicode-title',
    tests: 'untrusted content with markup in it',
    title: 'Senior <script>alert(1)</script> Engineer',
    companyName: 'Acme & Sons "Ltd"',
    expected: ['instant', 'digest'],
  }),
  job({
    ...STRONG,
    name: 'very-long-description',
    tests: 'a posting with a wall of text',
    description: 'Requirements: 5+ years React. '.repeat(400),
    expected: ['instant', 'digest'],
  }),
];

/** Overrides used by the precedence fixtures. */
export function fixtureOverrides(): NotificationOverride[] {
  const make = (
    n: number,
    subject: NotificationOverride['subject'],
    value: string,
    action: NotificationOverride['action'],
  ): NotificationOverride => ({
    id: uuid(900 + n),
    candidateId: CANDIDATE_ID,
    subject,
    value,
    action,
    note: null,
    createdAt: NOW,
  });

  return [
    make(1, 'company', 'Bad Employer Ltd', 'never_alert'),
    make(2, 'title', 'Senior React Engineer', 'always_alert'),
    make(3, 'title', 'Staff Platform Engineer', 'always_alert'),
  ];
}

/** Builds the scoring input for one fixture. */
export function scoringInputFor(
  fixture: JobFixture,
  options: {
    config?: NotificationIntelligenceConfig;
    alertsSentToday?: number;
    /** Discovery history, so rarity can be exercised both ways. */
    history?: { totalJobs: number; matchingAllDimensions: number; windowDays: number };
    favouriteBoosts?: Array<{ label: string; points: number }>;
    now?: Date;
  } = {},
): ScoringInput {
  const now = options.now ?? NOW;
  const config = options.config ?? baseConfig();

  const deadline = assessDeadline({
    validThrough: fixture.validThrough,
    postedAt: fixture.postedAt,
    description: fixture.description,
    closed: fixture.closed,
    sourceCount: 1,
    absenceRuns: 0,
    now,
  });

  const rarity = assessRarity({
    job: {
      countryCode: fixture.countryCode,
      remote: fixture.remote,
      seniority: fixture.seniority,
      technologies: fixture.technologies,
      salaryAnnualUsd: fixture.salaryAnnualUsd,
    },
    wanted: {
      countries: ['GB'],
      remoteRequired: true,
      seniorities: ['senior', 'staff'],
      technologies: ['react', 'typescript', 'nextjs'],
      salaryTarget: 120_000,
    },
    history: options.history ?? { totalJobs: 800, matchingAllDimensions: 40, windowDays: 30 },
  });

  return {
    matchScore: fixture.matchScore,
    matchConfidence: fixture.matchScore === null ? null : 0.8,
    applicationValueScore: fixture.applicationValueScore,
    recommendation: fixture.recommendation,
    jobQuality: fixture.jobQuality,
    scamRisk: fixture.scamRisk,
    freshnessHours:
      fixture.postedAt === null ? null : (now.getTime() - fixture.postedAt.getTime()) / 3_600_000,
    salaryAnnualUsd: fixture.salaryAnnualUsd,
    candidateSalaryTarget: 120_000,
    careerAlignment: fixture.matchScore === null ? null : 70,
    careerAlignmentApplicable: fixture.matchScore !== null,
    behavioralAffinity: null,
    behavioralConflictsWithExplicit: false,
    frictionScore: 20,
    competition: 'MEDIUM',
    sourceQuality: 0.85,
    deadline,
    rarity,
    favouriteBoosts: options.favouriteBoosts ?? [],
    alertsSentToday: options.alertsSentToday ?? 0,
    maxAlertsPerDay: config.cooldowns.maxAlertsPerRollingDay,
    config,
  };
}
