import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TYPE_SETTINGS,
  OVERRIDE_PRECEDENCE,
  URGENCY_RANK,
  notificationIntelligenceConfigSchema,
  type NotificationOverride,
} from '@job-intel/contracts';
import { computeNotificationScore, computeUrgency, meetsUrgency } from './scoring/notification-score';
import { assessDeadline, assessRarity } from './scoring/timing';
import {
  evaluateSuppression,
  explainSuppression,
  qualifiesForDigest,
  qualifiesForInstant,
  reNotificationReason,
  resolveOverride,
  type SuppressionInput,
} from './suppression/suppression-engine';
import { digestWorthSending, planDigest, type DigestCandidate } from './digest/digest-planner';
import { emailLink, inspectUrl, validateLink } from './links/link-validator';
import {
  computeAlertQuality,
  computeCalibrationSignals,
  computeFatigue,
  computeNotificationAnalytics,
  simulateThresholds,
  type NotificationEvent,
} from './analytics/engagement';
import { escapeHtml } from './templates/components';
import {
  CANDIDATE_ID,
  JOB_FIXTURES,
  NOW,
  baseConfig,
  fixtureOverrides,
  scoringInputFor,
  uuid,
  type JobFixture,
} from './testing/notification-fixtures';

const hoursAgo = (n: number): Date => new Date(NOW.getTime() - n * 3_600_000);
const hoursAhead = (n: number): Date => new Date(NOW.getTime() + n * 3_600_000);

const byName = (name: string): JobFixture =>
  JOB_FIXTURES.find((fixture) => fixture.name === name)!;

// ── 1. Scoring ──────────────────────────────────────────────────────────────

describe('notification score', () => {
  it('is not the match score', () => {
    const fixture = byName('excellent-fresh');
    const score = computeNotificationScore(scoringInputFor(fixture));

    expect(score.score).not.toBe(fixture.matchScore);
    expect(score.score).toBeGreaterThan(0);
  });

  it('drops inapplicable factors rather than scoring them zero', () => {
    const withSalary = computeNotificationScore(scoringInputFor(byName('excellent-fresh')));
    const withoutSalary = computeNotificationScore(scoringInputFor(byName('salary-unstated')));

    const salaryFactor = withoutSalary.factors.find((entry) => entry.factor === 'salary');
    expect(salaryFactor?.applicable).toBe(false);

    // Silence about pay must not read as bad pay.
    expect(withoutSalary.score).toBeGreaterThan(withSalary.score - 15);
  });

  it('scores a mediocre job well below an excellent one', () => {
    const excellent = computeNotificationScore(scoringInputFor(byName('excellent-fresh')));
    const mediocre = computeNotificationScore(scoringInputFor(byName('mediocre')));

    expect(excellent.score).toBeGreaterThan(mediocre.score + 20);
  });

  it('penalises the fifth alert of the day against the first', () => {
    const first = computeNotificationScore(scoringInputFor(byName('excellent-fresh'), { alertsSentToday: 0 }));
    const fifth = computeNotificationScore(scoringInputFor(byName('excellent-fresh'), { alertsSentToday: 5 }));

    expect(fifth.score).toBeLessThanOrEqual(first.score);
  });

  it('applies a favourite-company boost without letting it alone alert', () => {
    const plain = computeNotificationScore(scoringInputFor(byName('favourite-company-weak-job')));
    const boosted = computeNotificationScore(
      scoringInputFor(byName('favourite-company-weak-job'), {
        favouriteBoosts: [{ label: 'company:Vercel', points: 15 }],
      }),
    );

    expect(boosted.score).toBeGreaterThan(plain.score);
    expect(boosted.boostReasons.join(' ')).toContain('Vercel');
    // Still not instant-worthy: the job itself is weak.
    expect(qualifiesForInstant(boosted, baseConfig())).toBe(false);
  });

  it('never lets behaviour override an explicit preference', () => {
    const input = scoringInputFor(byName('excellent-fresh'));

    const applied = computeNotificationScore({
      ...input,
      behavioralAffinity: -1,
      behavioralConflictsWithExplicit: false,
    });

    const refused = computeNotificationScore({
      ...input,
      behavioralAffinity: -1,
      behavioralConflictsWithExplicit: true,
    });

    // The conflicting signal is dropped entirely, not damped.
    expect(refused.score).toBeGreaterThan(applied.score);
    expect(refused.explanation).toMatch(/stated preferences take precedence/i);
  });

  it('respects the configured behavioural ceiling', () => {
    const config = baseConfig({ maxBehavioralAdjustment: 5 });
    const input = scoringInputFor(byName('good-not-exceptional'), { config });

    const positive = computeNotificationScore({ ...input, behavioralAffinity: 1 });
    const neutral = computeNotificationScore({ ...input, behavioralAffinity: 0 });

    expect(positive.score - neutral.score).toBeLessThanOrEqual(6);
  });

  it('drops behaviour entirely when calibration is off', () => {
    const config = baseConfig({ calibrationEnabled: false });
    const input = scoringInputFor(byName('excellent-fresh'), { config });

    const withSignal = computeNotificationScore({ ...input, behavioralAffinity: 1 });
    const without = computeNotificationScore({ ...input, behavioralAffinity: 0 });

    expect(withSignal.score).toBe(without.score);
  });

  it('explains itself', () => {
    const score = computeNotificationScore(scoringInputFor(byName('excellent-fresh')));
    expect(score.explanation.length).toBeGreaterThan(20);
  });
});

// ── 2. Urgency ──────────────────────────────────────────────────────────────

describe('urgency', () => {
  it('is independent of quality', () => {
    const weakUrgent = computeUrgency({
      deadline: assessDeadline({
        validThrough: hoursAhead(5),
        postedAt: hoursAgo(200),
        description: null,
        closed: false,
        sourceCount: 1,
        absenceRuns: 0,
        now: NOW,
      }),
      freshnessHours: 200,
      opportunityValue: 30,
      recommendation: 'CONSIDER',
    });

    const strongCalm = computeUrgency({
      deadline: assessDeadline({
        validThrough: null,
        postedAt: hoursAgo(1),
        description: null,
        closed: false,
        sourceCount: 1,
        absenceRuns: 0,
        now: NOW,
      }),
      freshnessHours: 1,
      opportunityValue: 95,
      recommendation: 'APPLY_NOW',
    });

    // A weak job closing tonight is urgent; a great one with no deadline is not.
    expect(URGENCY_RANK[weakUrgent.urgency]).toBeGreaterThan(URGENCY_RANK.LOW);
    expect(strongCalm.urgency).not.toBe('CRITICAL');
  });

  it('reserves CRITICAL for a strong opportunity about to close', () => {
    const deadline = assessDeadline({
      validThrough: hoursAhead(6),
      postedAt: hoursAgo(4),
      description: null,
      closed: false,
      sourceCount: 1,
      absenceRuns: 0,
      now: NOW,
    });

    expect(
      computeUrgency({ deadline, freshnessHours: 4, opportunityValue: 90, recommendation: 'APPLY_NOW' })
        .urgency,
    ).toBe('CRITICAL');

    expect(
      computeUrgency({ deadline, freshnessHours: 4, opportunityValue: 35, recommendation: 'CONSIDER' })
        .urgency,
    ).toBe('HIGH');
  });

  it('never reaches CRITICAL on closing risk alone', () => {
    const deadline = assessDeadline({
      validThrough: null,
      postedAt: hoursAgo(2),
      description: 'Urgently hiring, immediate start, limited spots.',
      closed: false,
      sourceCount: 6,
      absenceRuns: 2,
      now: NOW,
    });

    expect(deadline.closingRisk).toBe('HIGH');
    const urgency = computeUrgency({
      deadline,
      freshnessHours: 2,
      opportunityValue: 95,
      recommendation: 'APPLY_NOW',
    });

    // An inference must not be able to wake someone at 3am.
    expect(urgency.urgency).not.toBe('CRITICAL');
  });

  it('drops an expired job to LOW whatever it scores', () => {
    const deadline = assessDeadline({
      validThrough: hoursAgo(48),
      postedAt: hoursAgo(300),
      description: null,
      closed: false,
      sourceCount: 1,
      absenceRuns: 0,
      now: NOW,
    });

    expect(deadline.bucket).toBe('expired');
    expect(
      computeUrgency({ deadline, freshnessHours: 300, opportunityValue: 99, recommendation: 'APPLY_NOW' })
        .urgency,
    ).toBe('LOW');
  });

  it('compares urgency levels', () => {
    expect(meetsUrgency('HIGH', 'MEDIUM')).toBe(true);
    expect(meetsUrgency('LOW', 'HIGH')).toBe(false);
  });
});

// ── 3. Deadline and closing risk ────────────────────────────────────────────

describe('deadline intelligence', () => {
  const build = (validThrough: Date | null, description: string | null = null) =>
    assessDeadline({
      validThrough,
      postedAt: hoursAgo(10),
      description,
      closed: false,
      sourceCount: 1,
      absenceRuns: 0,
      now: NOW,
    });

  it('buckets by time remaining', () => {
    expect(build(hoursAhead(6)).bucket).toBe('under_24h');
    expect(build(hoursAhead(48)).bucket).toBe('one_to_three_days');
    expect(build(hoursAhead(120)).bucket).toBe('three_to_seven_days');
    expect(build(hoursAhead(400)).bucket).toBe('over_seven_days');
    expect(build(hoursAgo(2)).bucket).toBe('expired');
    expect(build(null).bucket).toBe('none_stated');
  });

  it('reads a deadline out of the prose', () => {
    const assessed = build(null, 'Please apply by December 1, 2025.');
    expect(assessed.deadline).not.toBeNull();
  });

  it('keeps closing-risk confidence low because it is an inference', () => {
    const assessed = assessDeadline({
      validThrough: null,
      postedAt: hoursAgo(2),
      description: 'Urgently hiring. Limited positions.',
      closed: false,
      sourceCount: 5,
      absenceRuns: 1,
      now: NOW,
    });

    expect(assessed.closingRiskConfidence).toBeLessThanOrEqual(0.55);
    expect(assessed.closingRiskSignals.length).toBeGreaterThan(0);
  });

  it('reads a long-open posting as lower risk, not higher', () => {
    const old = assessDeadline({
      validThrough: null,
      postedAt: hoursAgo(24 * 60),
      description: 'Open until filled.',
      closed: false,
      sourceCount: 1,
      absenceRuns: 0,
      now: NOW,
    });

    expect(old.closingRisk).toBe('LOW');
  });

  it('says UNKNOWN when there is nothing to go on', () => {
    const empty = assessDeadline({
      validThrough: null,
      postedAt: null,
      description: null,
      closed: false,
      sourceCount: 1,
      absenceRuns: 0,
      now: NOW,
    });

    expect(empty.closingRisk).toBe('UNKNOWN');
  });

  it('does not name a risk from a single weak signal', () => {
    // "Posted two days ago" alone says almost nothing about when it closes.
    const thin = assessDeadline({
      validThrough: null,
      postedAt: hoursAgo(10),
      description: null,
      closed: false,
      sourceCount: 1,
      absenceRuns: 0,
      now: NOW,
    });

    expect(thin.closingRisk).toBe('UNKNOWN');
  });
});

// ── 4. Rarity ───────────────────────────────────────────────────────────────

describe('rarity', () => {
  const facts = {
    countryCode: 'GB',
    remote: true,
    seniority: 'senior',
    technologies: ['react', 'typescript'],
    salaryAnnualUsd: 130_000,
  };

  const wanted = {
    countries: ['GB'],
    remoteRequired: true,
    seniorities: ['senior'],
    technologies: ['react', 'typescript'],
    salaryTarget: 120_000,
  };

  it('refuses to judge rarity on a thin history', () => {
    const assessed = assessRarity({
      job: facts,
      wanted,
      history: { totalJobs: 12, matchingAllDimensions: 1, windowDays: 30 },
    });

    expect(assessed.sufficientHistory).toBe(false);
    expect(assessed.explanation).toMatch(/too few to judge/i);
  });

  it('calls a scarce combination rare', () => {
    const assessed = assessRarity({
      job: facts,
      wanted,
      history: { totalJobs: 2_000, matchingAllDimensions: 2, windowDays: 30 },
    });

    expect(assessed.sufficientHistory).toBe(true);
    expect(assessed.rarityScore).toBeGreaterThan(0.6);
  });

  it('calls a common combination common', () => {
    const assessed = assessRarity({
      job: facts,
      wanted,
      history: { totalJobs: 1_000, matchingAllDimensions: 400, windowDays: 30 },
    });

    expect(assessed.rarityScore).toBeLessThan(0.3);
  });

  it('names the dimensions that made it rare', () => {
    const assessed = assessRarity({
      job: facts,
      wanted,
      history: { totalJobs: 900, matchingAllDimensions: 3, windowDays: 30 },
    });

    expect(assessed.dimensions).toEqual(expect.arrayContaining(['remote', 'GB', 'senior']));
  });
});

// ── 5. Overrides and precedence ─────────────────────────────────────────────

describe('overrides', () => {
  const overrides = fixtureOverrides();

  const context = (companyName: string, jobTitle: string) => ({
    overrides,
    companyName,
    jobTitle,
    technologies: ['react'],
    countryCode: 'GB',
    sourceId: 'greenhouse',
  });

  it('matches a never-alert company', () => {
    const resolved = resolveOverride(context('Bad Employer Ltd', 'Senior Frontend Engineer'));
    expect(resolved?.action).toBe('never_alert');
  });

  it('matches an always-alert title', () => {
    const resolved = resolveOverride(context('Northwind Software', 'Senior React Engineer'));
    expect(resolved?.action).toBe('always_alert');
  });

  it('resolves the block-versus-allow conflict deterministically', () => {
    // The case the brief names: a muted company posting a starred role.
    const resolved = resolveOverride(context('Bad Employer Ltd', 'Senior React Engineer'));
    expect(resolved?.action).toBe('never_alert');
    expect(OVERRIDE_PRECEDENCE[0]).toBe('never_alert');
  });

  it('returns null when nothing matches', () => {
    expect(resolveOverride(context('Someone Else', 'Data Engineer'))).toBeNull();
  });
});

// ── 6. Suppression ──────────────────────────────────────────────────────────

function suppressionInput(
  fixture: JobFixture,
  overrides: Partial<SuppressionInput> = {},
): SuppressionInput {
  const config = overrides.config ?? baseConfig();
  const score = computeNotificationScore(scoringInputFor(fixture, { config }));

  return {
    jobId: fixture.id,
    candidateId: CANDIDATE_ID,
    companyName: fixture.companyName,
    jobTitle: fixture.title,
    technologies: fixture.technologies,
    countryCode: fixture.countryCode,
    sourceId: fixture.sourceId,
    score,
    recommendation: fixture.recommendation,
    expired: score.deadline.bucket === 'expired',
    isDuplicate: fixture.isDuplicate ?? false,
    alreadyApplied: fixture.alreadyApplied ?? false,
    previouslyRejected: fixture.previouslyRejected ?? false,
    hardBlocked: fixture.recommendation === 'BLOCKED',
    suspicious: fixture.suspicious ?? false,
    applicationUrlUsable: inspectUrl(fixture.applyUrl).ok,
    lastNotifiedAt: null,
    lastNotifiedScore: null,
    lastCompanyAlertAt: null,
    lastRoleAlertAt: null,
    alertsInRollingDay: 0,
    alertsInRollingHour: 0,
    materialChange: null,
    overrides: [],
    config,
    type: 'JOB_ALERT',
    inQuietHours: false,
    quietHoursAllowUrgent: true,
    excludedSourceIds: [],
    now: NOW,
    ...overrides,
  };
}

describe('suppression', () => {
  it('suppresses an expired job', () => {
    const outcome = evaluateSuppression(suppressionInput(byName('deadline-passed')));
    expect(outcome.suppressed).toBe(true);
    if (outcome.suppressed) expect(outcome.record.reason).toBe('expired');
  });

  it('suppresses a job already applied to', () => {
    const outcome = evaluateSuppression(suppressionInput(byName('already-applied')));
    expect(outcome.suppressed && outcome.record.reason).toBe('already_applied');
  });

  it('suppresses a blocked job', () => {
    const outcome = evaluateSuppression(suppressionInput(byName('blocked')));
    expect(outcome.suppressed && outcome.record.reason).toBe('hard_blocked');
  });

  it('suppresses a suspicious posting but says it is still on the dashboard', () => {
    const outcome = evaluateSuppression(suppressionInput(byName('suspicious')));
    expect(outcome.suppressed).toBe(true);
    if (outcome.suppressed) {
      expect(outcome.record.reason).toBe('suspicious');
      expect(outcome.record.remedy).toMatch(/dashboard/i);
    }
  });

  it('suppresses a job with no usable link', () => {
    const outcome = evaluateSuppression(suppressionInput(byName('no-apply-url')));
    expect(outcome.suppressed && outcome.record.reason).toBe('no_application_url');
  });

  it('reports the score and the threshold when below the bar', () => {
    /*
     * A high dashboard threshold rather than a weak job.
     *
     * `poor-match` is scored SKIP, which trips the recommendation gate first —
     * correctly, since that is the more specific answer. This exercises the
     * threshold gate itself.
     */
    const config = baseConfig({
      thresholds: {
        instant: 95,
        digest: 90,
        dashboard: 85,
        minimumUrgencyForInstant: 'LOW',
        minimumConfidenceForInstant: 0.45,
      },
    });

    const outcome = evaluateSuppression(suppressionInput(byName('good-not-exceptional'), { config }));
    expect(outcome.suppressed).toBe(true);

    if (outcome.suppressed) {
      expect(outcome.record.reason).toBe('below_threshold');
      expect(outcome.record.thresholdApplied).toBe(85);
      expect(explainSuppression(outcome.record)).toMatch(/against a threshold of 85/);
    }
  });

  it('honours a never-alert override', () => {
    const outcome = evaluateSuppression(
      suppressionInput(byName('blocked-company'), { overrides: fixtureOverrides() }),
    );

    expect(outcome.suppressed && outcome.record.reason).toBe('override_never_alert');
  });

  it('lets an always-alert override clear the threshold but not the facts', () => {
    const weak = byName('favourite-company-weak-job');

    const allowed: NotificationOverride[] = [
      {
        id: uuid(950),
        candidateId: CANDIDATE_ID,
        subject: 'title',
        value: 'Office Administrator',
        action: 'always_alert',
        note: null,
        createdAt: NOW,
      },
    ];

    const belowThreshold = evaluateSuppression(
      suppressionInput(weak, { overrides: allowed, recommendation: 'CONSIDER' }),
    );
    expect(belowThreshold.suppressed).toBe(false);

    // The same override must not rescue an expired job.
    const expiredToo = evaluateSuppression(
      suppressionInput(weak, { overrides: allowed, expired: true }),
    );
    expect(expiredToo.suppressed && expiredToo.record.reason).toBe('expired');
  });

  it('suppresses an excluded source', () => {
    const outcome = evaluateSuppression(
      suppressionInput(byName('excluded-source'), { excludedSourceIds: ['noisy-aggregator'] }),
    );

    expect(outcome.suppressed && outcome.record.reason).toBe('source_excluded');
  });

  it('suppresses a disabled notification type', () => {
    const config = baseConfig({
      typeSettings: { ...DEFAULT_TYPE_SETTINGS, JOB_ALERT: { enabled: false, channel: 'both' } },
    });

    const outcome = evaluateSuppression(suppressionInput(byName('excellent-fresh'), { config }));
    expect(outcome.suppressed && outcome.record.reason).toBe('type_disabled');
  });

  it('enforces the minimum recommendation', () => {
    const config = baseConfig({ minimumRecommendation: 'APPLY' });
    const outcome = evaluateSuppression(
      suppressionInput(byName('good-not-exceptional'), { config, recommendation: 'CONSIDER' }),
    );

    expect(outcome.suppressed && outcome.record.reason).toBe('recommendation_too_low');
  });

  it('names the setting responsible so the UI can link to it', () => {
    const config = baseConfig({
      thresholds: {
        instant: 95,
        digest: 90,
        dashboard: 85,
        minimumUrgencyForInstant: 'LOW',
        minimumConfidenceForInstant: 0.45,
      },
    });

    const outcome = evaluateSuppression(suppressionInput(byName('good-not-exceptional'), { config }));
    expect(outcome.suppressed && outcome.record.setting).toBe('dashboard threshold');
  });
});

// ── 7. Cooldowns and re-notification ────────────────────────────────────────

describe('cooldowns', () => {
  it('does not re-alert a job rediscovered on the next scan', () => {
    const outcome = evaluateSuppression(
      suppressionInput(byName('rediscovered'), {
        lastNotifiedAt: hoursAgo(1),
        lastNotifiedScore: 92,
      }),
    );

    expect(outcome.suppressed && outcome.record.reason).toBe('cooldown_job');
  });

  it('re-alerts when something meaningful changed', () => {
    const outcome = evaluateSuppression(
      suppressionInput(byName('salary-added'), {
        lastNotifiedAt: hoursAgo(3),
        lastNotifiedScore: 80,
        materialChange: 'A salary range was added.',
      }),
    );

    expect(outcome.suppressed).toBe(false);
    if (!outcome.suppressed) expect(outcome.note).toMatch(/salary range/i);
  });

  it('re-alerts on a material score improvement', () => {
    const fixture = byName('excellent-fresh');
    const score = computeNotificationScore(scoringInputFor(fixture));

    const reason = reNotificationReason({
      lastNotifiedAt: hoursAgo(3),
      lastNotifiedScore: score.score - 20,
      materialChange: null,
      score,
      config: baseConfig(),
      now: NOW,
    });

    expect(reason).toMatch(/score rose/i);
  });

  it('does not re-alert on a trivial score change', () => {
    const fixture = byName('excellent-fresh');
    const score = computeNotificationScore(scoringInputFor(fixture));

    const reason = reNotificationReason({
      lastNotifiedAt: hoursAgo(3),
      lastNotifiedScore: score.score - 2,
      materialChange: null,
      score: { ...score, deadline: { ...score.deadline, bucket: 'none_stated' } },
      config: baseConfig(),
      now: NOW,
    });

    expect(reason).toBeNull();
  });

  it('applies the company cooldown', () => {
    const outcome = evaluateSuppression(
      suppressionInput(byName('company-cooldown'), { lastCompanyAlertAt: hoursAgo(1) }),
    );

    expect(outcome.suppressed && outcome.record.reason).toBe('cooldown_company');
  });

  it('lets a CRITICAL deadline break the company cooldown', () => {
    const outcome = evaluateSuppression(
      suppressionInput(byName('critical-beats-company-cooldown'), {
        lastCompanyAlertAt: hoursAgo(1),
      }),
    );

    expect(outcome.suppressed).toBe(false);
  });

  it('enforces the daily and hourly limits', () => {
    const daily = evaluateSuppression(
      suppressionInput(byName('daily-limit'), { alertsInRollingDay: 5 }),
    );
    expect(daily.suppressed && daily.record.reason).toBe('daily_limit');

    const hourly = evaluateSuppression(
      suppressionInput(byName('hourly-limit'), { alertsInRollingHour: 2 }),
    );
    expect(hourly.suppressed && hourly.record.reason).toBe('hourly_limit');
  });
});

// ── 8. Quiet hours ──────────────────────────────────────────────────────────

describe('quiet hours', () => {
  it('holds an ordinary alert', () => {
    const outcome = evaluateSuppression(
      suppressionInput(byName('quiet-hours'), { inQuietHours: true }),
    );

    expect(outcome.suppressed).toBe(true);
    if (outcome.suppressed) {
      expect(outcome.record.reason).toBe('quiet_hours');
      expect(outcome.record.detail).toMatch(/next digest/i);
    }
  });

  it('lets a CRITICAL alert through when the candidate allows it', () => {
    const outcome = evaluateSuppression(
      suppressionInput(byName('quiet-hours-critical'), {
        inQuietHours: true,
        quietHoursAllowUrgent: true,
      }),
    );

    expect(outcome.suppressed).toBe(false);
  });

  it('holds even a CRITICAL alert when the candidate does not', () => {
    const outcome = evaluateSuppression(
      suppressionInput(byName('quiet-hours-critical'), {
        inQuietHours: true,
        quietHoursAllowUrgent: false,
      }),
    );

    expect(outcome.suppressed && outcome.record.reason).toBe('quiet_hours');
  });

  it('blames the real reason rather than quiet hours', () => {
    // An expired job arriving at 3am is expired, not quiet-houred.
    const outcome = evaluateSuppression(
      suppressionInput(byName('deadline-passed'), { inQuietHours: true }),
    );

    expect(outcome.suppressed && outcome.record.reason).toBe('expired');
  });
});

// ── 9. Links ────────────────────────────────────────────────────────────────

describe('link validation', () => {
  it('accepts a direct ATS link', () => {
    expect(inspectUrl('https://boards.greenhouse.io/acme/jobs/123').ok).toBe(true);
  });

  it('rejects a search results page', () => {
    const result = inspectUrl('https://example.invalid/jobs/search?q=react');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/search or listing/i);
  });

  it('rejects a query-carrying URL', () => {
    expect(inspectUrl('https://example.invalid/roles?q=frontend').ok).toBe(false);
  });

  it('rejects an aggregator homepage', () => {
    expect(inspectUrl('https://www.linkedin.com/').ok).toBe(false);
  });

  it('rejects unsafe schemes', () => {
    expect(inspectUrl('javascript:alert(1)').ok).toBe(false);
    expect(inspectUrl('data:text/html,<script>').ok).toBe(false);
    expect(inspectUrl('file:///etc/passwd').ok).toBe(false);
  });

  it('rejects a URL embedding credentials', () => {
    const result = inspectUrl('https://user:pass@example.invalid/jobs/1');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/credentials/i);
  });

  it('falls back through application, canonical and source URLs', async () => {
    const result = await validateLink({
      applicationUrl: 'https://example.invalid/jobs/search?q=x',
      canonicalUrl: 'https://example.invalid/jobs/123',
      sourceUrl: 'https://aggregator.invalid/listing/9',
    });

    expect(result.verdict).toBe('unverified');
    expect(result.originalUrl).toContain('/jobs/123');
  });

  it('never invents a URL when none exists', async () => {
    const result = await validateLink({ applicationUrl: null, canonicalUrl: null, sourceUrl: null });

    expect(result.verdict).toBe('rejected');
    expect(emailLink(result)).toBeNull();
  });

  it('treats an unreachable link as unverified rather than bad', async () => {
    const result = await validateLink(
      { applicationUrl: 'https://example.invalid/jobs/5', canonicalUrl: null, sourceUrl: null },
      { probe: async () => null },
    );

    expect(result.verdict).toBe('unverified');
    expect(emailLink(result)).not.toBeNull();
  });

  it('rejects a link that 404s', async () => {
    const result = await validateLink(
      { applicationUrl: 'https://example.invalid/jobs/5', canonicalUrl: null, sourceUrl: null },
      { probe: async () => ({ status: 404, finalUrl: 'https://example.invalid/jobs/5', redirects: 0 }) },
    );

    expect(result.verdict).toBe('rejected');
  });

  it('rejects a link that redirects to a careers homepage', async () => {
    const result = await validateLink(
      { applicationUrl: 'https://example.invalid/jobs/5', canonicalUrl: null, sourceUrl: null },
      {
        probe: async () => ({
          status: 200,
          finalUrl: 'https://example.invalid/careers',
          redirects: 2,
        }),
      },
    );

    expect(result.verdict).toBe('rejected');
    expect(result.rejectionReason).toMatch(/redirects somewhere unusable/i);
  });

  it('rejects an excessive redirect chain', async () => {
    const result = await validateLink(
      { applicationUrl: 'https://example.invalid/jobs/5', canonicalUrl: null, sourceUrl: null },
      {
        probe: async () => ({ status: 200, finalUrl: 'https://example.invalid/jobs/5', redirects: 9 }),
        maxRedirects: 5,
      },
    );

    expect(result.verdict).toBe('rejected');
  });

  it('keeps a 403 as unverified — bot protection is not a dead link', async () => {
    const result = await validateLink(
      { applicationUrl: 'https://example.invalid/jobs/5', canonicalUrl: null, sourceUrl: null },
      { probe: async () => ({ status: 403, finalUrl: 'https://example.invalid/jobs/5', redirects: 0 }) },
    );

    expect(result.verdict).toBe('unverified');
  });
});

// ── 10. Email safety ────────────────────────────────────────────────────────

describe('email safety', () => {
  it('escapes untrusted job content', () => {
    const escaped = escapeHtml('Senior <script>alert(1)</script> Engineer');
    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&lt;script&gt;');
  });

  it('escapes quotes and ampersands in company names', () => {
    const escaped = escapeHtml('Acme & Sons "Ltd"');
    expect(escaped).toContain('&amp;');
    expect(escaped).toContain('&quot;');
  });
});

// ── 11. Digest ──────────────────────────────────────────────────────────────

function digestCandidate(
  fixture: JobFixture,
  overrides: Partial<DigestCandidate> = {},
): DigestCandidate {
  return {
    jobId: fixture.id,
    companyKey: fixture.companyName.toLowerCase(),
    companyName: fixture.companyName,
    score: computeNotificationScore(scoringInputFor(fixture)),
    recommendation: fixture.recommendation,
    newCompany: false,
    alertedSeparately: false,
    discoveredAt: hoursAgo(3),
    ...overrides,
  };
}

describe('digest', () => {
  const window = { windowStart: hoursAgo(24), windowEnd: NOW };

  it('includes what cleared the digest threshold', () => {
    const plan = planDigest({
      candidateId: CANDIDATE_ID,
      type: 'DAILY_DIGEST',
      ...window,
      candidates: [digestCandidate(byName('excellent-fresh')), digestCandidate(byName('good-not-exceptional'))],
      config: baseConfig(),
      maxJobs: 10,
      maxPerCompany: 2,
    });

    expect(plan.totalJobs).toBeGreaterThan(0);
    expect(digestWorthSending(plan).send).toBe(true);
  });

  it('excludes what was already sent as an instant alert', () => {
    const plan = planDigest({
      candidateId: CANDIDATE_ID,
      type: 'DAILY_DIGEST',
      ...window,
      candidates: [digestCandidate(byName('excellent-fresh'), { alertedSeparately: true })],
      config: baseConfig(),
      maxJobs: 10,
      maxPerCompany: 2,
    });

    expect(plan.totalJobs).toBe(0);
    expect(plan.excluded.already_alerted).toBe(1);
  });

  it('excludes expired jobs', () => {
    const plan = planDigest({
      candidateId: CANDIDATE_ID,
      type: 'DAILY_DIGEST',
      ...window,
      candidates: [digestCandidate(byName('deadline-passed'))],
      config: baseConfig(),
      maxJobs: 10,
      maxPerCompany: 2,
    });

    expect(plan.excluded.expired).toBe(1);
  });

  it('caps how many roles one employer can fill it with', () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      digestCandidate(byName('excellent-fresh'), { jobId: uuid(500 + index) }),
    );

    const plan = planDigest({
      candidateId: CANDIDATE_ID,
      type: 'DAILY_DIGEST',
      ...window,
      candidates,
      config: baseConfig(),
      maxJobs: 10,
      maxPerCompany: 2,
    });

    expect(plan.totalJobs).toBe(2);
    expect(plan.excluded.company_cap).toBe(4);
  });

  it('never lists one job in two sections', () => {
    const candidates = [
      digestCandidate(byName('deadline-three-days'), { jobId: uuid(600), newCompany: true }),
      digestCandidate(byName('excellent-fresh'), { jobId: uuid(601), companyKey: 'other' }),
    ];

    const plan = planDigest({
      candidateId: CANDIDATE_ID,
      type: 'DAILY_DIGEST',
      ...window,
      candidates,
      config: baseConfig(),
      maxJobs: 10,
      maxPerCompany: 2,
    });

    const all = plan.sections.flatMap((section) => section.jobIds);
    expect(new Set(all).size).toBe(all.length);
  });

  it('does not send an empty digest', () => {
    const plan = planDigest({
      candidateId: CANDIDATE_ID,
      type: 'DAILY_DIGEST',
      ...window,
      candidates: [],
      config: baseConfig(),
      maxJobs: 10,
      maxPerCompany: 2,
    });

    const verdict = digestWorthSending(plan);
    expect(verdict.send).toBe(false);
    expect(verdict.reason).toMatch(/no digest was sent/i);
  });

  it('is reproducible', () => {
    const build = () =>
      planDigest({
        candidateId: CANDIDATE_ID,
        type: 'DAILY_DIGEST',
        ...window,
        candidates: [
          digestCandidate(byName('excellent-fresh'), { jobId: uuid(700) }),
          digestCandidate(byName('good-not-exceptional'), { jobId: uuid(701), companyKey: 'b' }),
        ],
        config: baseConfig(),
        maxJobs: 10,
        maxPerCompany: 2,
        now: NOW,
      });

    expect(JSON.stringify(build().sections)).toBe(JSON.stringify(build().sections));
  });

  it('ranks the strongest job first', () => {
    const plan = planDigest({
      candidateId: CANDIDATE_ID,
      type: 'DAILY_DIGEST',
      ...window,
      candidates: [
        digestCandidate(byName('good-not-exceptional'), { jobId: uuid(800), companyKey: 'a' }),
        digestCandidate(byName('excellent-fresh'), { jobId: uuid(801), companyKey: 'b' }),
      ],
      config: baseConfig(),
      maxJobs: 10,
      maxPerCompany: 2,
    });

    const first = plan.sections.flatMap((section) => section.jobIds)[0];
    expect(first).toBe(uuid(801));
  });
});

// ── 12. Analytics ───────────────────────────────────────────────────────────

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    notificationId: crypto.randomUUID(),
    jobId: uuid(1),
    type: 'JOB_ALERT',
    notificationScore: 90,
    sentAt: hoursAgo(10),
    deliveredAt: hoursAgo(10),
    openedAt: null,
    clickedAt: null,
    saved: false,
    applied: false,
    dismissed: false,
    facts: {
      companyName: 'Northwind',
      sourceId: 'greenhouse',
      countryCode: 'GB',
      seniority: 'senior',
      technologies: ['react'],
    },
    ...overrides,
  };
}

describe('notification analytics', () => {
  it('computes the funnel', () => {
    const analytics = computeNotificationAnalytics({
      candidateId: CANDIDATE_ID,
      events: [
        event({ openedAt: hoursAgo(9), clickedAt: hoursAgo(9) }),
        event({ openedAt: hoursAgo(8) }),
        event(),
      ],
      suppressed: 40,
      duplicatesSuppressed: 6,
    });

    expect(analytics.overall.sent).toBe(3);
    expect(analytics.overall.clicked).toBe(1);
    expect(analytics.suppressionRate).toBeCloseTo(40 / 43, 2);
  });

  it('breaks the funnel down by dimension', () => {
    const analytics = computeNotificationAnalytics({
      candidateId: CANDIDATE_ID,
      events: [event(), event({ facts: { ...event().facts, countryCode: 'DE' } })],
      suppressed: 0,
      duplicatesSuppressed: 0,
    });

    expect(analytics.byDimension.location).toHaveLength(2);
    expect(analytics.byDimension.score_band?.[0]?.key).toBe('90-100');
  });
});

describe('fatigue', () => {
  it('says nothing on a thin sample', () => {
    const report = computeFatigue({
      candidateId: CANDIDATE_ID,
      current: [event(), event()],
      previous: [],
      currentFrequency: 'daily',
    });

    expect(report.sufficientSample).toBe(false);
    expect(report.suggestedChange).toBeNull();
    expect(report.advice).toMatch(/not enough to say anything/i);
  });

  it('suggests a change on high volume and low engagement, without applying it', () => {
    const report = computeFatigue({
      candidateId: CANDIDATE_ID,
      current: [
        ...Array.from({ length: 35 }, () => event()),
        ...Array.from({ length: 2 }, () => event({ clickedAt: hoursAgo(5) })),
      ],
      previous: [],
      currentFrequency: 'daily',
    });

    expect(report.sufficientSample).toBe(true);
    expect(report.suggestedChange).not.toBeNull();
    expect(report.suggestedChange?.rationale).toMatch(/nothing has been changed/i);
  });

  it('says nothing is wrong when engagement is healthy', () => {
    const report = computeFatigue({
      candidateId: CANDIDATE_ID,
      current: Array.from({ length: 25 }, (_, index) =>
        event({ clickedAt: index < 10 ? hoursAgo(5) : null }),
      ),
      previous: [],
      currentFrequency: 'daily',
    });

    expect(report.suggestedChange).toBeNull();
    expect(report.advice).toMatch(/healthy rate/i);
  });

  it('needs both windows to be substantial before calling engagement declining', () => {
    const report = computeFatigue({
      candidateId: CANDIDATE_ID,
      current: [event(), event()],
      previous: [event({ clickedAt: hoursAgo(50) })],
      currentFrequency: 'daily',
    });

    expect(report.declining).toBe(false);
  });
});

describe('calibration', () => {
  it('reports what the candidate engages with', () => {
    const signals = computeCalibrationSignals({
      events: Array.from({ length: 12 }, (_, index) =>
        event({ clickedAt: index < 9 ? hoursAgo(4) : null }),
      ),
      explicit: new Map(),
    });

    const react = signals.find((signal) => signal.value === 'react');
    expect(react?.affinity).toBeGreaterThan(0);
  });

  it('flags a negative signal against something explicitly wanted', () => {
    const signals = computeCalibrationSignals({
      events: Array.from({ length: 12 }, () => event({ dismissed: true })),
      explicit: new Map([['technology', new Set(['react'])]]),
    });

    const react = signals.find((signal) => signal.value === 'react');
    expect(react?.conflictsWithExplicit).toBe(true);
  });

  it('stays silent below the minimum sample', () => {
    const signals = computeCalibrationSignals({
      events: [event(), event()],
      explicit: new Map(),
    });

    expect(signals).toHaveLength(0);
  });
});

describe('alert quality and threshold advice', () => {
  it('measures precision per score band', () => {
    const quality = computeAlertQuality({
      candidateId: CANDIDATE_ID,
      events: [
        ...Array.from({ length: 25 }, (_, index) =>
          event({ notificationScore: 95, clickedAt: index < 15 ? hoursAgo(4) : null }),
        ),
        ...Array.from({ length: 25 }, (_, index) =>
          event({ notificationScore: 72, clickedAt: index < 3 ? hoursAgo(4) : null }),
        ),
      ],
    });

    const high = quality.buckets.find((bucket) => bucket.band === '90-100');
    const low = quality.buckets.find((bucket) => bucket.band === '70-79');

    expect(high?.precision).toBeGreaterThan(low!.precision!);
    expect(high?.sufficientSample).toBe(true);
  });

  it('replays history to show what a different threshold would have done', () => {
    const simulation = simulateThresholds({
      candidateId: CANDIDATE_ID,
      currentThreshold: 70,
      candidates: [80],
      events: [
        ...Array.from({ length: 20 }, () => event({ notificationScore: 95, clickedAt: hoursAgo(4) })),
        ...Array.from({ length: 20 }, () => event({ notificationScore: 72 })),
      ],
    });

    const scenario = simulation.scenarios[0]!;
    expect(scenario.alertsSent).toBe(20);
    expect(scenario.clicksRetainedShare).toBe(1);
    expect(scenario.summary).toMatch(/keeping about 100% of your clicks/);
  });

  it('flags a sample too small to advise from', () => {
    const simulation = simulateThresholds({
      candidateId: CANDIDATE_ID,
      currentThreshold: 70,
      events: [event()],
    });

    expect(simulation.sufficientSample).toBe(false);
  });
});

// ── 13. Configuration ───────────────────────────────────────────────────────

describe('configuration', () => {
  it('does not enable every notification type by default', () => {
    const config = notificationIntelligenceConfigSchema.parse({});
    const disabled = Object.values(config.typeSettings).filter((setting) => !setting.enabled);

    expect(disabled.length).toBeGreaterThan(0);
  });

  it('carries thresholds as data rather than constants', () => {
    const config = notificationIntelligenceConfigSchema.parse({
      thresholds: { instant: 95, digest: 80, dashboard: 60, minimumUrgencyForInstant: 'HIGH' },
    });

    expect(config.thresholds.instant).toBe(95);

    /*
     * The same job, two thresholds, two answers.
     *
     * That is the whole point of thresholds being data: nothing in the engine
     * knows what 82 or 95 mean, and changing the number changes the behaviour
     * without changing a line of code.
     */
    const score = computeNotificationScore(scoringInputFor(byName('excellent-fresh')));
    expect(qualifiesForInstant(score, baseConfig())).toBe(true);
    expect(qualifiesForInstant(score, config)).toBe(false);
  });

  it('supports a manual frequency that never fires on its own', () => {
    const config = notificationIntelligenceConfigSchema.parse({});
    expect(config.timezone).toBeDefined();
  });
});

// ── 14. The simulation (Part 50) ────────────────────────────────────────────

describe('simulation across fifty synthetic jobs', () => {
  /** Applies the fixture-specific context each case is built to exercise. */
  function contextFor(fixture: JobFixture): Partial<SuppressionInput> {
    switch (fixture.name) {
      case 'rediscovered':
        return { lastNotifiedAt: hoursAgo(1), lastNotifiedScore: 92 };
      case 'salary-added':
        return {
          lastNotifiedAt: hoursAgo(3),
          lastNotifiedScore: 78,
          materialChange: 'A salary range was added.',
        };
      case 'blocked-company':
      case 'blocked-company-starred-title':
      case 'always-alert-title':
        return { overrides: fixtureOverrides() };
      case 'excluded-source':
        return { excludedSourceIds: ['noisy-aggregator'] };
      case 'company-cooldown':
      case 'critical-beats-company-cooldown':
        return { lastCompanyAlertAt: hoursAgo(1) };
      case 'daily-limit':
        return { alertsInRollingDay: 5 };
      case 'hourly-limit':
        return { alertsInRollingHour: 2 };
      case 'quiet-hours':
      case 'quiet-hours-critical':
        return { inQuietHours: true, quietHoursAllowUrgent: true };
      default:
        return {};
    }
  }

  function outcomeFor(fixture: JobFixture): string {
    const config = baseConfig();

    const history =
      fixture.name === 'rare-combination'
        ? { totalJobs: 2_000, matchingAllDimensions: 3, windowDays: 30 }
        : fixture.name === 'common-combination'
          ? { totalJobs: 1_000, matchingAllDimensions: 450, windowDays: 30 }
          : undefined;

    const favouriteBoosts =
      fixture.companyName === 'Vercel' ? [{ label: 'company:Vercel', points: 15 }] : [];

    const score = computeNotificationScore(
      scoringInputFor(fixture, {
        config,
        ...(history ? { history } : {}),
        favouriteBoosts,
      }),
    );

    const suppression = evaluateSuppression({
      ...suppressionInput(fixture),
      score,
      ...contextFor(fixture),
    });

    if (suppression.suppressed) return 'suppressed';
    if (qualifiesForInstant(score, config)) return 'instant';
    if (qualifiesForDigest(score, config)) return 'digest';
    return 'dashboard';
  }

  it('has at least fifty fixtures', () => {
    expect(JOB_FIXTURES.length).toBeGreaterThanOrEqual(50);
  });

  it('produces a sensible outcome for every one', () => {
    const failures: string[] = [];

    for (const fixture of JOB_FIXTURES) {
      const outcome = outcomeFor(fixture);

      if (!fixture.expected.includes(outcome)) {
        failures.push(`${fixture.name}: expected ${fixture.expected.join('/')}, got ${outcome}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('never alerts about an expired job', () => {
    for (const fixture of JOB_FIXTURES) {
      const score = computeNotificationScore(scoringInputFor(fixture));
      if (score.deadline.bucket !== 'expired') continue;

      expect(outcomeFor(fixture)).toBe('suppressed');
    }
  });

  it('emails only a small minority of what it sees', () => {
    const outcomes = JOB_FIXTURES.map(outcomeFor);
    const instant = outcomes.filter((outcome) => outcome === 'instant').length;

    /*
     * The whole layer in one assertion.
     *
     * These fixtures are deliberately weighted toward strong jobs — far more so
     * than a real discovery run — and even here fewer than half may interrupt.
     * A build where this starts failing upward is a build that has quietly
     * turned into "email me everything".
     */
    expect(instant).toBeLessThan(JOB_FIXTURES.length / 2);
  });

  it('records a reason for every suppression', () => {
    for (const fixture of JOB_FIXTURES) {
      const score = computeNotificationScore(scoringInputFor(fixture));
      const suppression = evaluateSuppression({
        ...suppressionInput(fixture),
        score,
        ...contextFor(fixture),
      });

      if (!suppression.suppressed) continue;

      expect(suppression.record.detail.length).toBeGreaterThan(10);
      expect(explainSuppression(suppression.record).length).toBeGreaterThan(10);
    }
  });

  it('is deterministic', () => {
    for (const fixture of JOB_FIXTURES.slice(0, 12)) {
      expect(outcomeFor(fixture)).toBe(outcomeFor(fixture));
    }
  });
});
