import { describe, expect, it } from 'vitest';
import {
  renderedEmailSchema,
  type MaterialChangeResult,
} from '@job-intel/contracts';
import { evaluateQuietHours, evaluateWeekend, isDigestDue, localClock } from './scheduling/schedule';
import { evaluateAlertRules, priorityForScore } from './rules/alert-rules';
import { evaluateSourceHealth, buildSourceHealthAlert } from './rules/source-health-alerts';
import { decideNotifications, selectDigestJobs, toDecisionRows } from './decision/notification-decider';
import { buildJobCard, formatAge, formatSalary, resolveApplyUrl } from './templates/job-card-builder';
import {
  renderAlert,
  renderDigest,
  renderSystemAlert,
  renderWeeklySummary,
} from './templates/renderer';
import { safeUrl, escapeHtml } from './templates/components';
import { MemoryEmailProvider, NullEmailProvider } from './provider/email-provider';
import { canAttempt, nextRetry } from './delivery/retry';
import {
  createPreferenceToken,
  preferenceUrl,
  verifyPreferenceToken,
} from './preferences/preference-link';
import {
  FIXTURE_NOW,
  makeAlertData,
  makeCandidate,
  makeDigestData,
  makeJobCard,
  makePreferences,
  makeSystemAlertData,
  makeWeeklySummaryData,
} from './testing/fixtures';

/**
 * Notification tests.
 *
 * The twenty scenarios the brief names, plus the properties that make the
 * system trustworthy rather than merely functional: it stays quiet, it says
 * why, and it never sends the same thing twice.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SECRET = 'a-test-secret-at-least-16-chars-long';

const materialChange = (significance: number, explanation: string): MaterialChangeResult => ({
  changed: true,
  changes: [
    {
      field: 'salary',
      before: '$150,000/yr',
      after: '$175,000/yr',
      significance,
      direction: 'improved',
      summary: explanation,
    },
  ],
  maxSignificance: significance,
  explanation,
});

describe('timezone handling', () => {
  // 17
  it('reads the wall clock in the candidate zone, not the server zone', () => {
    // 09:30 UTC is 11:30 in Berlin (summer) and 05:30 in New York.
    const berlin = localClock(FIXTURE_NOW, 'Europe/Berlin');
    const newYork = localClock(FIXTURE_NOW, 'America/New_York');
    const utc = localClock(FIXTURE_NOW, 'UTC');

    expect(berlin.hour).toBe(11);
    expect(newYork.hour).toBe(5);
    expect(utc.hour).toBe(9);
  });

  it('falls back to UTC on an unknown zone rather than throwing', () => {
    // A bad timezone in stored preferences must not stop every notification.
    const clock = localClock(FIXTURE_NOW, 'Mars/Olympus_Mons');
    expect(clock.timeZone).toBe('UTC');
    expect(clock.hour).toBe(9);
  });

  it('sends a daily digest at the configured local hour', () => {
    const preferences = makePreferences({
      digestFrequency: 'daily',
      digestTime: '11:00',
      timezone: 'Europe/Berlin',
    });

    // 11:30 Berlin — past 11:00 locally, though only 09:30 UTC.
    expect(isDigestDue(preferences, null, FIXTURE_NOW).due).toBe(true);

    const earlier = new Date('2026-08-18T06:00:00Z'); // 08:00 Berlin
    expect(isDigestDue(preferences, null, earlier).due).toBe(false);
  });
});

describe('digest cadence', () => {
  // 2
  it('is due when the interval has elapsed and not before', () => {
    const preferences = makePreferences({ digestFrequency: 'hourly' });
    expect(isDigestDue(preferences, new Date(FIXTURE_NOW.getTime() - 90 * 60_000), FIXTURE_NOW).due).toBe(true);
    expect(isDigestDue(preferences, new Date(FIXTURE_NOW.getTime() - 20 * 60_000), FIXTURE_NOW).due).toBe(false);
  });

  it('is never due when digests are switched off', () => {
    const preferences = makePreferences({ digestEnabled: false });
    expect(isDigestDue(preferences, null, FIXTURE_NOW).due).toBe(false);
  });

  it('honours the configured weekday for a weekly digest', () => {
    // 2026-08-18 is a Tuesday.
    const tuesday = makePreferences({
      digestFrequency: 'weekly',
      digestDayOfWeek: 2,
      digestTime: '09:00',
      timezone: 'UTC',
    });
    const friday = makePreferences({ ...tuesday, digestDayOfWeek: 5 });
    expect(isDigestDue(tuesday, null, FIXTURE_NOW).due).toBe(true);
    expect(isDigestDue(friday, null, FIXTURE_NOW).due).toBe(false);
  });
});

describe('quiet hours', () => {
  // 3
  it('recognises a window that crosses midnight', () => {
    const quiet = { enabled: true, start: '23:00', end: '07:00', allowUrgentOverride: true };

    // 01:00 and 23:30 UTC are inside; 12:00 is not.
    expect(evaluateQuietHours(new Date('2026-08-18T01:00:00Z'), quiet, 'UTC').active).toBe(true);
    expect(evaluateQuietHours(new Date('2026-08-18T23:30:00Z'), quiet, 'UTC').active).toBe(true);
    expect(evaluateQuietHours(new Date('2026-08-18T12:00:00Z'), quiet, 'UTC').active).toBe(false);
  });

  it('reports when the window ends', () => {
    const verdict = evaluateQuietHours(
      new Date('2026-08-18T01:00:00Z'),
      { enabled: true, start: '23:00', end: '07:00', allowUrgentOverride: true },
      'UTC',
    );
    expect(verdict.until?.toISOString()).toBe('2026-08-18T07:00:00.000Z');
  });

  it('is evaluated in the candidate zone', () => {
    const quiet = { enabled: true, start: '23:00', end: '07:00', allowUrgentOverride: true };
    // 22:00 UTC is midnight in Berlin — quiet there, not quiet in UTC.
    const at = new Date('2026-08-18T22:00:00Z');
    expect(evaluateQuietHours(at, quiet, 'UTC').active).toBe(false);
    expect(evaluateQuietHours(at, quiet, 'Europe/Berlin').active).toBe(true);
  });
});

describe('weekend behaviour', () => {
  it('applies the configured policy only at the weekend', () => {
    const saturday = new Date('2026-08-22T12:00:00Z');
    const tuesday = new Date('2026-08-18T12:00:00Z');

    expect(evaluateWeekend(saturday, 'silent', 'UTC').allowImmediate).toBe(false);
    expect(evaluateWeekend(saturday, 'urgent_only', 'UTC').urgentOnly).toBe(true);
    expect(evaluateWeekend(saturday, 'digest_only', 'UTC').allowImmediate).toBe(false);
    expect(evaluateWeekend(tuesday, 'silent', 'UTC').allowImmediate).toBe(true);
  });
});

describe('alert rules', () => {
  const facts = {
    recommendationScore: 94,
    matchScore: 96,
    confidence: 0.91,
    qualityScore: 92,
    freshnessHours: 0.2,
    salaryAnnualUsd: 190_000,
    scamRisk: 0.01,
    applicationUrlVerified: true,
    applicationUrlPresent: true,
    visaSponsorshipOffered: false,
    salaryMeetsTarget: true,
    remote: true,
    lifecycleActive: true,
    fromAuthoritativeSource: true,
    sourceId: 'greenhouse',
  };

  it('fires the highest-priority matching rule and records why', () => {
    const result = evaluateAlertRules(facts, makePreferences().alertRules);
    expect(result.match?.priority).toBe('URGENT');
    expect(result.match?.matched.join(' ')).toMatch(/recommendationScore/);
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('records why each rule did not fire', () => {
    const result = evaluateAlertRules(
      { ...facts, applicationUrlVerified: false },
      makePreferences().alertRules,
    );
    expect(result.match?.priority).toBe('HIGH');
    expect(result.rejections.some((r) => r.reason.includes('applicationUrlVerified'))).toBe(true);
  });

  // Missing data must fail a condition, never be skipped.
  it('does not fire a salary rule on a job with no stated salary', () => {
    const rules = [
      {
        id: 'salary-rule',
        name: 'High salary',
        enabled: true,
        priority: 'HIGH' as const,
        conditions: [{ field: 'salaryAnnualUsd' as const, operator: 'gte' as const, value: 150_000 }],
        requireFlags: [],
        forbidFlags: [],
        sourceIds: [],
        overridesQuietHours: false,
      },
    ];
    expect(evaluateAlertRules({ ...facts, salaryAnnualUsd: null }, rules).match).toBeNull();
    expect(evaluateAlertRules(facts, rules).match?.ruleId).toBe('salary-rule');
  });

  // 21 — source-specific rules
  it('restricts a rule to the configured sources', () => {
    const rules = [
      {
        id: 'careers-only',
        name: 'Company careers only',
        enabled: true,
        priority: 'URGENT' as const,
        conditions: [],
        requireFlags: [],
        forbidFlags: [],
        sourceIds: ['company-careers'],
        overridesQuietHours: true,
      },
    ];
    expect(evaluateAlertRules(facts, rules).match).toBeNull();
    expect(evaluateAlertRules({ ...facts, sourceId: 'company-careers' }, rules).match).not.toBeNull();
  });

  it('grades priority by score when no rule fires', () => {
    expect(priorityForScore(95)).toBe('URGENT');
    expect(priorityForScore(86)).toBe('HIGH');
    expect(priorityForScore(72)).toBe('NORMAL');
    expect(priorityForScore(40)).toBe('LOW');
  });
});

describe('notification decisions', () => {
  const at = new Date('2026-08-18T12:00:00Z');

  // 1
  it('sends an immediate alert for an exceptional match', () => {
    const result = decideNotifications([makeCandidate()], {
      preferences: makePreferences(),
      alertsSentToday: 0,
      now: at,
    });
    expect(result.immediate).toHaveLength(1);
    expect(result.immediate[0]?.outcome).toBe('SENT_IMMEDIATE_ALERT');
    expect(result.immediate[0]?.priority).toBe('URGENT');
  });

  // 2 — ordinary matches wait
  it('queues an ordinary match for the digest instead of alerting', () => {
    const result = decideNotifications(
      [makeCandidate({ recommendationScore: 76, matchScore: 78, confidence: 0.6 })],
      { preferences: makePreferences(), alertsSentToday: 0, now: at },
    );
    expect(result.immediate).toHaveLength(0);
    expect(result.digest[0]?.outcome).toBe('QUEUED_FOR_DIGEST');
  });

  // 3 — quiet hours defer
  it('defers a non-urgent alert during quiet hours', () => {
    const preferences = makePreferences({
      timezone: 'UTC',
      quietHours: { enabled: true, start: '23:00', end: '07:00', allowUrgentOverride: true },
    });
    const result = decideNotifications(
      [makeCandidate({ recommendationScore: 87, applicationUrlVerified: false })],
      { preferences, alertsSentToday: 0, now: new Date('2026-08-18T02:00:00Z') },
    );
    expect(result.immediate).toHaveLength(0);
    expect(result.digest[0]?.outcome).toBe('DEFERRED_QUIET_HOURS');
    expect(result.digest[0]?.deferredUntil).not.toBeNull();
  });

  // 4 — urgent overrides quiet hours
  it('lets an urgent alert override quiet hours when the candidate allows it', () => {
    const preferences = makePreferences({
      timezone: 'UTC',
      quietHours: { enabled: true, start: '23:00', end: '07:00', allowUrgentOverride: true },
    });
    const night = new Date('2026-08-18T02:00:00Z');

    const allowed = decideNotifications([makeCandidate()], {
      preferences,
      alertsSentToday: 0,
      now: night,
    });
    expect(allowed.immediate[0]?.outcome).toBe('SENT_IMMEDIATE_ALERT');
    expect(allowed.immediate[0]?.reason).toMatch(/overriding quiet hours/);

    // Two switches: the rule may override, but only if the candidate agrees.
    const refused = decideNotifications([makeCandidate()], {
      preferences: makePreferences({
        timezone: 'UTC',
        quietHours: { enabled: true, start: '23:00', end: '07:00', allowUrgentOverride: false },
      }),
      alertsSentToday: 0,
      now: night,
    });
    expect(refused.immediate).toHaveLength(0);
    expect(refused.digest[0]?.outcome).toBe('DEFERRED_QUIET_HOURS');
  });

  // 5 — daily limit
  it('stops alerting past the daily limit and keeps the strongest', () => {
    const candidates = [70, 95, 88, 91].map((score, index) =>
      makeCandidate({
        jobId: `00000000-0000-4000-8000-00000000000${index + 1}`,
        canonicalJobId: `00000000-0000-4000-8000-00000000000${index + 1}`,
        recommendationScore: score,
        matchScore: score,
      }),
    );

    const result = decideNotifications(candidates, {
      preferences: makePreferences({ maxAlertsPerDay: 2 }),
      alertsSentToday: 0,
      now: at,
    });

    expect(result.immediate).toHaveLength(2);
    // The budget runs out on the weakest, not on whichever arrived last.
    expect(result.immediate.map((d) => d.candidate.recommendationScore)).toEqual([95, 91]);
    expect(result.digest.some((d) => d.outcome === 'SUPPRESSED_DAILY_LIMIT')).toBe(true);
  });

  it('respects alerts already sent earlier today', () => {
    const result = decideNotifications([makeCandidate()], {
      preferences: makePreferences({ maxAlertsPerDay: 5 }),
      alertsSentToday: 5,
      now: at,
    });
    expect(result.immediate).toHaveLength(0);
    expect(result.digest[0]?.outcome).toBe('SUPPRESSED_DAILY_LIMIT');
  });

  // 6 — duplicate prevention
  it('never re-notifies a job that has not materially changed', () => {
    const result = decideNotifications(
      [makeCandidate({ notifiedAt: new Date(at.getTime() - 5 * DAY), materialChange: null })],
      { preferences: makePreferences(), alertsSentToday: 0, now: at },
    );
    expect(result.suppressed[0]?.outcome).toBe('SUPPRESSED_ALREADY_NOTIFIED');
  });

  // 7 — material change
  it('re-notifies when the job materially changed, marked as an update', () => {
    const result = decideNotifications(
      [
        makeCandidate({
          notifiedAt: new Date(at.getTime() - 5 * DAY),
          materialChange: materialChange(0.9, 'Salary rose by 17%'),
        }),
      ],
      { preferences: makePreferences(), alertsSentToday: 0, now: at },
    );
    expect(result.immediate).toHaveLength(1);
    // The update note is what stops the email reading as a brand-new job.
    expect(result.immediate[0]?.updateNote).toMatch(/Salary rose/);
  });

  // 8 — previously rejected
  it('never notifies a job the candidate rejected, however good', () => {
    const result = decideNotifications(
      [makeCandidate({ previouslyRejected: true, recommendationScore: 99 })],
      { preferences: makePreferences(), alertsSentToday: 0, now: at },
    );
    expect(result.suppressed[0]?.outcome).toBe('SUPPRESSED_USER_REJECTED');
  });

  // 9 — expired/stale
  it('never notifies a stale or closed job', () => {
    const result = decideNotifications([makeCandidate({ lifecycleActive: false })], {
      preferences: makePreferences(),
      alertsSentToday: 0,
      now: at,
    });
    expect(result.suppressed[0]?.outcome).toBe('SUPPRESSED_STALE');
  });

  // 15 — suppression reasons are always recorded
  it('records a reason for every suppression', () => {
    const result = decideNotifications(
      [
        makeCandidate({ jobId: '00000000-0000-4000-8000-000000000011', previouslyRejected: true }),
        makeCandidate({ jobId: '00000000-0000-4000-8000-000000000012', lifecycleActive: false }),
        makeCandidate({ jobId: '00000000-0000-4000-8000-000000000013', isDuplicate: true }),
        makeCandidate({
          jobId: '00000000-0000-4000-8000-000000000014',
          recommendationScore: 10,
          matchScore: 10,
        }),
        makeCandidate({
          jobId: '00000000-0000-4000-8000-000000000015',
          applicationUrlPresent: false,
        }),
      ],
      { preferences: makePreferences(), alertsSentToday: 0, now: at },
    );

    expect(result.suppressed).toHaveLength(5);
    // Nothing is silently discarded.
    for (const decision of result.suppressed) {
      expect(decision.reason.length).toBeGreaterThan(5);
      expect(decision.outcome.startsWith('SUPPRESSED_')).toBe(true);
    }
    expect(result.suppressed.map((d) => d.outcome)).toEqual(
      expect.arrayContaining([
        'SUPPRESSED_USER_REJECTED',
        'SUPPRESSED_STALE',
        'SUPPRESSED_DUPLICATE',
        'SUPPRESSED_BELOW_THRESHOLD',
        'SUPPRESSED_NO_APPLICATION_URL',
      ]),
    );
  });

  it('honours an excluded source', () => {
    const result = decideNotifications([makeCandidate({ sourceId: 'noisy-aggregator' })], {
      preferences: makePreferences({ excludedSourceIds: ['noisy-aggregator'] }),
      alertsSentToday: 0,
      now: at,
    });
    expect(result.suppressed[0]?.outcome).toBe('SUPPRESSED_SOURCE_EXCLUDED');
  });

  it('routes a source configured for digest-only away from alerts', () => {
    const result = decideNotifications([makeCandidate({ sourceId: 'jobicy' })], {
      preferences: makePreferences({
        sourceRules: [{ sourceId: 'jobicy', immediate: false, digest: true }],
      }),
      alertsSentToday: 0,
      now: at,
    });
    expect(result.immediate).toHaveLength(0);
    expect(result.digest[0]?.outcome).toBe('QUEUED_FOR_DIGEST');
  });

  // 13, 14 — multiple recommendations, digest ranking
  it('ranks the digest by priority then score, and caps it', () => {
    const candidates = [60, 82, 91, 74, 88, 79].map((score, index) =>
      makeCandidate({
        jobId: `00000000-0000-4000-8000-00000000002${index}`,
        canonicalJobId: `00000000-0000-4000-8000-00000000002${index}`,
        companyKey: `company-${index}`,
        recommendationScore: score,
        matchScore: score,
        confidence: 0.65,
        applicationUrlVerified: false,
      }),
    );

    const decisions = decideNotifications(candidates, {
      preferences: makePreferences({ immediateAlertsEnabled: false, minimumMatchScore: 50 }),
      alertsSentToday: 0,
      now: at,
    });

    const { selected, held } = selectDigestJobs(
      decisions.digest,
      makePreferences({ maxJobsPerDigest: 3 }),
    );

    expect(selected).toHaveLength(3);
    expect(selected.map((d) => d.candidate.recommendationScore)).toEqual([91, 88, 82]);
    expect(selected.every((d) => d.outcome === 'INCLUDED_IN_DIGEST')).toBe(true);
    expect(held.every((d) => d.outcome === 'SUPPRESSED_DIGEST_CAP')).toBe(true);
  });

  it('caps jobs per company inside one digest', () => {
    const candidates = [90, 88, 86, 84].map((score, index) =>
      makeCandidate({
        jobId: `00000000-0000-4000-8000-00000000003${index}`,
        canonicalJobId: `00000000-0000-4000-8000-00000000003${index}`,
        companyKey: 'megacorp',
        recommendationScore: score,
        applicationUrlVerified: false,
      }),
    );

    const decisions = decideNotifications(candidates, {
      preferences: makePreferences({ immediateAlertsEnabled: false }),
      alertsSentToday: 0,
      now: at,
    });
    const { selected, held } = selectDigestJobs(
      decisions.digest,
      makePreferences({ maxPerCompanyPerDigest: 2 }),
    );

    expect(selected).toHaveLength(2);
    expect(held.some((d) => d.outcome === 'SUPPRESSED_COMPANY_CAP')).toBe(true);
  });

  // 27 — the trace
  it('produces a trace row for every candidate', () => {
    const result = decideNotifications(
      [
        makeCandidate({ jobId: '00000000-0000-4000-8000-000000000041' }),
        makeCandidate({ jobId: '00000000-0000-4000-8000-000000000042', previouslyRejected: true }),
      ],
      { preferences: makePreferences(), alertsSentToday: 0, now: at },
    );

    const rows = toDecisionRows(result.all, at);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.reason.length > 0)).toBe(true);
    expect(rows.every((row) => row.canonicalJobId !== null)).toBe(true);
  });
});

describe('job cards', () => {
  // 19 — canonical application URL
  it('prefers an ATS link and labels the destination honestly', () => {
    const ats = resolveApplyUrl({
      applyUrl: 'https://boards.greenhouse.io/x/jobs/1',
      canonicalUrl: null,
      sourceUrl: 'https://aggregator.example/1',
      atsVendor: 'greenhouse',
      applicationUrlVerified: true,
      sourceAuthority: 'medium',
    } as never);
    expect(ats.kind).toBe('ats');
    expect(ats.verified).toBe(true);

    const aggregator = resolveApplyUrl({
      applyUrl: 'https://aggregator.example/apply/1',
      canonicalUrl: null,
      sourceUrl: 'https://aggregator.example/1',
      atsVendor: null,
      applicationUrlVerified: false,
      sourceAuthority: 'low',
    } as never);
    expect(aggregator.kind).toBe('aggregator');
  });

  it('never fabricates a URL when none is known', () => {
    const fallback = resolveApplyUrl({
      applyUrl: null,
      canonicalUrl: null,
      sourceUrl: 'https://source.example/jobs/9',
      atsVendor: null,
      applicationUrlVerified: false,
      sourceAuthority: 'low',
    } as never);
    expect(fallback.url).toBe('https://source.example/jobs/9');
    expect(fallback.kind).toBe('unverified');
  });

  // 20 — malformed data
  it('renders an unstated salary as absent rather than inventing one', () => {
    expect(
      formatSalary({
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        salaryPeriod: null,
      } as never),
    ).toBeNull();

    expect(
      formatSalary({
        salaryMin: 80_000,
        salaryMax: 100_000,
        salaryCurrency: 'EUR',
        salaryPeriod: 'year',
      } as never),
    ).toBe('EUR 80,000–EUR 100,000/year');
  });

  it('survives a job with almost no data', () => {
    const card = buildJobCard({
      jobId: '00000000-0000-4000-8000-0000000000ff',
      title: 'Engineer',
      company: 'Unknown',
      city: null, region: null, countryCode: null, remoteType: null,
      salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
      matchScore: 50, confidence: 0.2, recommendationScore: 40, tier: 'LOW_PRIORITY',
      rankReasons: [], concerns: [], matchedRequirements: [], missingRequirements: [],
      sourceId: 'x', sourceLabel: 'X', sourceAuthority: 'low',
      postedAt: null, firstSeenAt: FIXTURE_NOW,
      applyUrl: null, canonicalUrl: null, sourceUrl: 'https://x.example/1',
      applicationUrlVerified: false, atsVendor: null,
      updateNote: null, appUrl: 'http://localhost:3000', now: FIXTURE_NOW,
    });

    expect(card.salary).toBeNull();
    expect(card.location).toBeNull();
    expect(card.workArrangement).toBeNull();
    expect(card.postedAgo).toBe('moments ago');
  });

  it('formats age without inventing a time', () => {
    expect(formatAge(null, FIXTURE_NOW)).toBe('at an unknown time');
    expect(formatAge(new Date(FIXTURE_NOW.getTime() - 12 * 60_000), FIXTURE_NOW)).toBe('12 minutes ago');
    expect(formatAge(new Date(FIXTURE_NOW.getTime() - 3 * DAY), FIXTURE_NOW)).toBe('3 days ago');
  });
});

describe('rendering', () => {
  const options = { scope: 'test' };

  it('renders a digest with HTML and text', () => {
    const email = renderDigest(makeDigestData(), options);
    expect(renderedEmailSchema.safeParse(email).success).toBe(true);
    expect(email.html).toContain('Your Job Intelligence Digest');
    expect(email.html).toContain('Senior Frontend Engineer');
    // Text is not optional: some clients prefer it and filters read it.
    expect(email.text).toContain('YOUR JOB INTELLIGENCE DIGEST');
    expect(email.text.length).toBeGreaterThan(200);
  });

  it('marks an update rather than presenting it as a new job', () => {
    const email = renderDigest(makeDigestData(), options);
    expect(email.html).toContain('Update to a job you previously received');
    expect(email.text).toContain('UPDATE to a job you previously received');
  });

  it('names the destination beside every apply button', () => {
    const email = renderDigest(makeDigestData(), options);
    expect(email.html).toContain('goes to');
    expect(email.html).toContain('an aggregator, not the employer');
  });

  it('renders an individual alert with the concern shown', () => {
    const email = renderAlert(makeAlertData(), options);
    expect(email.html).toContain('Exceptional match');
    expect(email.html).toContain('Potential concerns');
    expect(email.html).toContain('Visa sponsorship is not explicitly stated');
    expect(email.text).toContain('URGENT');
  });

  it('renders a system alert and a weekly summary', () => {
    const system = renderSystemAlert(makeSystemAlertData(), options);
    expect(system.html).toContain('LinkedIn discovery is failing');
    expect(system.text).toContain('[WARNING]');

    const weekly = renderWeeklySummary(makeWeeklySummaryData(), options);
    expect(weekly.html).toContain('Your Week in Job Intelligence');
    expect(weekly.text).toContain('Discovered: 1284');
  });

  it('produces a responsive, script-free document', () => {
    const email = renderDigest(makeDigestData(), options);
    expect(email.html).toContain('viewport');
    expect(email.html).toContain('@media (max-width:600px)');
    expect(email.html).toContain('prefers-color-scheme: dark');
    // JavaScript is stripped by every client and must not be depended on.
    expect(email.html).not.toContain('<script');
  });

  it('escapes hostile content from third-party postings', () => {
    const email = renderDigest(
      makeDigestData({
        sections: [
          {
            key: 'exceptional',
            icon: '🔥',
            title: 'Exceptional matches',
            jobs: [
              makeJobCard({
                title: '<img src=x onerror=alert(1)>',
                company: '"><script>alert(2)</script>',
                applyUrl: 'javascript:alert(3)',
              }),
            ],
          },
        ],
      }),
      options,
    );

    // The property that matters is that hostile markup is inert, not that the
    // characters are absent: an escaped `&lt;img … onerror=…&gt;` is text.
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('&lt;img src=x');
    // A `javascript:` URL from a job board is stored XSS in any client that
    // renders it, so the scheme is checked, not merely escaped.
    expect(email.html).not.toContain('javascript:alert(3)');
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
    expect(safeUrl('javascript:alert(1)')).toBe('#');
    expect(safeUrl('https://ok.example/a?b=1')).toContain('https://ok.example');
  });

  // 12 — idempotency
  it('produces a stable key for identical content and a different one otherwise', () => {
    const a = renderDigest(makeDigestData(), { scope: 'digest:p1:2026-08-18' });
    const b = renderDigest(makeDigestData(), { scope: 'digest:p1:2026-08-18' });
    const c = renderDigest(makeDigestData(), { scope: 'digest:p1:2026-08-19' });

    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).not.toBe(c.idempotencyKey);
  });
});

describe('provider, retry and idempotency', () => {
  // 10 — email failure
  it('reports a failure without throwing', async () => {
    const provider = new MemoryEmailProvider();
    provider.failNext = 1;

    const result = await provider.sendEmail({
      to: 'a@example.com',
      from: 'b@example.com',
      fromName: 'Test',
      email: renderAlert(makeAlertData(), { scope: 'x' }),
    });

    expect(result.accepted).toBe(false);
    expect(result.retryable).toBe(true);
    expect(provider.sent).toHaveLength(0);
  });

  // 11 — retry with backoff
  it('backs off exponentially and gives up at the cap', () => {
    const config = { maxAttempts: 5, baseRetryDelayMs: 1000, maxRetryDelayMs: 60_000 };
    // Full jitter, so the delay is bounded by the exponential, not equal to it.
    expect(nextRetry(1, true, config, () => 1).delayMs).toBe(1000);
    expect(nextRetry(3, true, config, () => 1).delayMs).toBe(4000);
    expect(nextRetry(5, true, config, () => 1).retry).toBe(false);
    // A malformed address will never succeed; retrying it forever fills a queue.
    expect(nextRetry(1, false, config, () => 1).retry).toBe(false);
  });

  it('refuses a second attempt on an already-sent delivery', () => {
    expect(canAttempt({ status: 'sent', attempts: 1, maxAttempts: 5 }).allowed).toBe(false);
    expect(canAttempt({ status: 'queued', attempts: 5, maxAttempts: 5 }).allowed).toBe(false);
    expect(canAttempt({ status: 'queued', attempts: 1, maxAttempts: 5 }).allowed).toBe(true);
  });

  // 12 — no duplicate emails on retry
  it('does not send twice for the same idempotency key', async () => {
    const provider = new MemoryEmailProvider();
    const email = renderAlert(makeAlertData(), { scope: 'alert:p1:job1' });
    const message = { to: 'a@example.com', from: 'b@example.com', fromName: 'Test', email };

    await provider.sendEmail(message);
    await provider.sendEmail(message);

    expect(provider.sent).toHaveLength(1);
  });

  it('refuses everything when no provider is configured', async () => {
    const provider = new NullEmailProvider();
    expect(provider.isAvailable()).toBe(false);
    const result = await provider.sendEmail();
    expect(result.accepted).toBe(false);
    expect(result.retryable).toBe(false);
  });
});

describe('source health alerts', () => {
  const base = {
    sourceId: 'linkedin-alerts',
    displayName: 'LinkedIn alerts',
    lastError: 'HTTP 429',
    lastSuccessAt: new Date(FIXTURE_NOW.getTime() - 19 * HOUR),
    enabled: true,
    lastAlertedAtFailures: null,
  };

  // 16
  it('escalates log → warn → notify rather than alerting on every failure', () => {
    expect(evaluateSourceHealth({ ...base, consecutiveFailures: 1 }).escalation).toBe('log');
    expect(evaluateSourceHealth({ ...base, consecutiveFailures: 3 }).escalation).toBe('warn');
    expect(evaluateSourceHealth({ ...base, consecutiveFailures: 1 }).shouldNotify).toBe(false);
    expect(evaluateSourceHealth({ ...base, consecutiveFailures: 3 }).shouldNotify).toBe(false);

    const notify = evaluateSourceHealth({ ...base, consecutiveFailures: 5 });
    expect(notify.escalation).toBe('notify');
    expect(notify.shouldNotify).toBe(true);
  });

  it('does not re-alert about a source that is simply still down', () => {
    const again = evaluateSourceHealth({
      ...base,
      consecutiveFailures: 8,
      lastAlertedAtFailures: 5,
    });
    expect(again.shouldNotify).toBe(false);

    // Far worse than when we last spoke: worth saying again.
    const worse = evaluateSourceHealth({
      ...base,
      consecutiveFailures: 40,
      lastAlertedAtFailures: 5,
    });
    expect(worse.shouldNotify).toBe(true);
    expect(worse.severity).toBe('critical');
  });

  it('says nothing about a disabled source', () => {
    expect(
      evaluateSourceHealth({ ...base, consecutiveFailures: 99, enabled: false }).shouldNotify,
    ).toBe(false);
  });

  it('builds an actionable alert', () => {
    const verdict = evaluateSourceHealth({ ...base, consecutiveFailures: 5 });
    const alert = buildSourceHealthAlert({ ...base, consecutiveFailures: 5 }, verdict, 'http://x', FIXTURE_NOW);
    expect(alert.facts.map((f) => f.label)).toContain('Consecutive failures');
    expect(alert.suggestedAction).toBeTruthy();
  });
});

describe('preference links', () => {
  // 18, 23
  it('signs a link that cannot be edited into another account', () => {
    const token = createPreferenceToken({ profileId: 'profile-1', scope: 'manage' }, SECRET, FIXTURE_NOW);
    const verified = verifyPreferenceToken(token, SECRET);
    expect(verified.valid).toBe(true);
    expect(verified.token?.profileId).toBe('profile-1');

    // Swapping the payload for another profile breaks the signature.
    const [, signature] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ profileId: 'someone-else', scope: 'manage', expiresAt: Date.now() + 1000 })).toString('base64url')}.${signature}`;
    expect(verifyPreferenceToken(forged, SECRET).valid).toBe(false);
  });

  it('rejects a token signed with a different secret, and an expired one', () => {
    const token = createPreferenceToken({ profileId: 'p' }, SECRET, FIXTURE_NOW);
    expect(verifyPreferenceToken(token, 'another-secret-at-least-16-chars').valid).toBe(false);

    const expired = createPreferenceToken(
      { profileId: 'p', ttlDays: -1 },
      SECRET,
      new Date(Date.now() - 2 * DAY),
    );
    expect(verifyPreferenceToken(expired, SECRET).reason).toMatch(/expired/);
  });

  it('degrades to a plain settings URL without a secret', () => {
    const url = preferenceUrl('http://localhost:3000', { profileId: 'p' }, null);
    expect(url).toBe('http://localhost:3000/settings/notifications');
    expect(url).not.toContain('token');
  });

  it('refuses to sign with a weak secret', () => {
    expect(() => createPreferenceToken({ profileId: 'p' }, 'short')).toThrow(/16 characters/);
  });
});
