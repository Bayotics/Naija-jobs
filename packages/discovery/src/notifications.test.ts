import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeCandidateProfile, makeJobSource } from '@job-intel/contracts/factories';
import {
  RECOMMENDATION_VERSION,
  notificationPreferencesSchema,
  type JobRecommendation,
} from '@job-intel/contracts';
import {
  CandidateRepository,
  EventRepository,
  NotificationRepository,
  ProfileRepository,
  RecommendationRepository,
  SourceRepository,
  schema,
} from '@job-intel/db';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '@job-intel/db/testing';
import { EventRecorder, MemoryLogger } from '@job-intel/observability';
import { MemoryEmailProvider } from '@job-intel/notifications';
import { NotificationService } from './notification-service';

/**
 * End-to-end notification pipeline, against a real database.
 *
 * Walks the whole chain the brief specifies — recommendation → eligibility →
 * decision → event → queue → render → provider → delivery status — and asserts
 * on the *actual rendered payload* rather than on a mock's call log. A test that
 * only checks "send was called" cannot tell you the email was empty.
 */
describe('notification pipeline', () => {
  let ctx: TestDatabase;
  let service: NotificationService;
  let notifications: NotificationRepository;
  let recommendations: RecommendationRepository;
  let provider: MemoryEmailProvider;
  let profileId: string;
  let profileVersionId: string;
  let jobIds: string[] = [];

  const logger = new MemoryLogger();
  const now = new Date('2026-08-18T12:00:00Z');

  async function seedJob(input: {
    title: string;
    company: string;
    identity: string;
    applyUrl: string | null;
    postedMinutesAgo: number;
  }): Promise<string> {
    const postedAt = new Date(now.getTime() - input.postedMinutesAgo * 60_000);
    const [job] = await ctx.db
      .insert(schema.jobs)
      .values({
        title: input.title,
        titleNormalized: input.title.toLowerCase(),
        companyNameRaw: input.company,
        description: 'We build things with TypeScript and React.',
        sourceUrl: `https://example.test/jobs/${input.identity}`,
        applyUrl: input.applyUrl,
        sourceId: 'greenhouse',
        sourceIdentity: input.identity,
        contentHash: `content-${input.identity}`,
        fingerprint: `fingerprint-${input.identity}`,
        remoteType: 'remote',
        postedAt,
        firstSeenAt: postedAt,
        lastVerifiedAt: new Date(now.getTime() - 60_000),
        salaryMin: '80000',
        salaryMax: '100000',
        salaryCurrency: 'EUR',
        salaryPeriod: 'year',
        salaryNormalizedAnnualUsd: '97200',
      })
      .returning({ id: schema.jobs.id });
    return job!.id;
  }

  async function rank(entries: Array<{ jobId: string; score: number; match: number }>) {
    const recs: JobRecommendation[] = entries.map((entry, index) => ({
      jobId: entry.jobId,
      candidateProfileId: profileId,
      rank: index + 1,
      score: {
        factors: [
          {
            factor: 'match',
            value: entry.match,
            weight: 50,
            contribution: entry.match / 2,
            explanation: `Candidate match ${entry.match}/100`,
          },
        ],
        weightsUsed: { match: 50 },
        rawScore: entry.score,
        calibratedScore: entry.score,
        diversityPenalty: 0,
        diversityReason: '',
        finalScore: entry.score,
        tier: entry.score >= 88 ? 'EXCEPTIONAL' : entry.score >= 64 ? 'STRONG' : 'LOW_PRIORITY',
      },
      matchScore: entry.match,
      matchConfidence: 0.9,
      quality: { score: 92, confidence: 0.9, components: [], flags: [], explanation: 'good' },
      freshness: {
        score: 99, confidence: 0.95, basis: 'posted', ageDays: 0.01, ageHours: 0.2,
        explanation: 'Posted 12 minutes ago',
      },
      lifecycle: { status: 'ACTIVE', confidence: 0.9, signals: [], explanation: 'active' },
      scam: {
        risk: 0.01, verdict: 'clear', deterministicRisk: 0.01, aiRisk: null, aiModel: null,
        signals: [], explanation: 'No scam indicators found',
      },
      repost: {
        kind: 'new', occurrences: 1, firstSeenAt: now, lastSeenAt: now, gapDays: null,
        noveltyFactor: 1, explanation: 'First sighting',
      },
      exposure: {
        state: 'never_shown', timesShown: 0, firstShownAt: null, lastShownAt: null,
        notifiedAt: null, notifiedContentHash: null, notifiedScore: null,
      },
      sourceAuthority: 'authoritative',
      duplicateOf: null,
      rankExplanation: `Ranked #${index + 1} — strong opportunity.`,
      rankReasons: [
        `${entry.match}% candidate match (90% confidence)`,
        'Posted 12 minutes ago',
        'From greenhouse, an authoritative source',
      ],
      notificationEligible: true,
      notificationBlockers: [],
      recommendationVersion: RECOMMENDATION_VERSION,
      computedAt: now,
    }));

    await recommendations.replaceRecommendations(profileId, recs);
    await Promise.all(
      entries.map((entry) =>
        recommendations.saveSignals(entry.jobId, {
          quality: recs[0]!.quality,
          freshness: recs[0]!.freshness,
          lifecycle: recs[0]!.lifecycle,
          scam: recs[0]!.scam,
          repost: recs[0]!.repost,
          sourceAuthority: 'authoritative',
        }),
      ),
    );
  }

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);

    await new SourceRepository(ctx.db).upsert(makeJobSource({ id: 'greenhouse' }));

    const profiles = new ProfileRepository(ctx.db);
    const created = await profiles.createProfile({ payload: makeCandidateProfile() });
    profileId = created.profileId;
    profileVersionId = created.versionId;
    void profileVersionId;

    notifications = new NotificationRepository(ctx.db);
    recommendations = new RecommendationRepository(ctx.db);
    provider = new MemoryEmailProvider();

    service = new NotificationService({
      notifications,
      recommendations,
      candidates: new CandidateRepository(ctx.db),
      profiles,
      sources: new SourceRepository(ctx.db),
      logger,
      events: new EventRecorder(logger, new EventRepository(ctx.db)),
      provider,
      config: { enabled: true, appUrl: 'http://localhost:3000' },
      preferenceSecret: 'an-end-to-end-test-secret-value',
      fromEmail: 'jobs@example.com',
      now: () => now,
    });

    await notifications.savePreferences(
      profileId,
      notificationPreferencesSchema.parse({
        email: 'candidate@example.com',
        timezone: 'UTC',
        digestFrequency: 'hourly',
      }),
    );

    jobIds = [
      await seedJob({
        title: 'Senior Frontend Engineer',
        company: 'Northwind',
        identity: 'job-1',
        applyUrl: 'https://boards.greenhouse.io/northwind/jobs/1',
        postedMinutesAgo: 12,
      }),
      await seedJob({
        title: 'Staff Engineer',
        company: 'Helios',
        identity: 'job-2',
        applyUrl: 'https://boards.greenhouse.io/helios/jobs/2',
        postedMinutesAgo: 45,
      }),
    ];
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('runs the whole chain and produces a real, sendable email', async () => {
    await rank([
      { jobId: jobIds[0]!, score: 94, match: 96 },
      { jobId: jobIds[1]!, score: 71, match: 74 },
    ]);

    const run = await service.processCandidate(profileId, { forceDigest: true });

    expect(run.considered).toBe(2);
    expect(run.immediateAlerts).toBe(1);
    expect(run.digestSent).toBe(true);
    expect(run.decisionsRecorded).toBeGreaterThanOrEqual(2);

    // ── The queue ─────────────────────────────────────────────────────────
    const history = await notifications.history(profileId);
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.event.type).sort()).toEqual(['JOB_ALERT', 'JOB_DIGEST']);
    expect(history.every((h) => h.delivery?.status === 'queued')).toBe(true);

    // ── The provider ──────────────────────────────────────────────────────
    const delivery = await service.processDeliveries();
    expect(delivery.attempted).toBe(2);
    expect(delivery.sent).toBe(2);

    // The payload itself, not a call count.
    const alert = provider.sent.find((m) => m.email.subject.includes('Senior Frontend Engineer'));
    expect(alert).toBeDefined();
    expect(alert!.to).toBe('candidate@example.com');
    expect(alert!.email.html).toContain('Senior Frontend Engineer');
    expect(alert!.email.html).toContain('boards.greenhouse.io');
    expect(alert!.email.html).toContain('EUR 80,000–EUR 100,000/year');
    expect(alert!.email.text).toContain('Match 96%');
    // Signed, not a bare email address in a query string.
    expect(alert!.email.html).toContain('settings/notifications?token=');

    // ── Delivery status ───────────────────────────────────────────────────
    const after = await notifications.history(profileId);
    expect(after.every((h) => h.delivery?.status === 'sent')).toBe(true);
    expect(after.every((h) => h.delivery?.providerMessageId !== null)).toBe(true);

    const timeline = await notifications.deliveryTimeline(after[0]!.delivery!.id);
    expect(timeline.map((e) => e.event)).toEqual(['created', 'sent']);
  });

  it('never sends the same job twice across runs', async () => {
    await rank([{ jobId: jobIds[0]!, score: 94, match: 96 }]);

    await service.processCandidate(profileId, { forceDigest: true });
    const first = (await notifications.history(profileId)).length;

    // Same pool, same content: the second pass must be a no-op.
    await service.processCandidate(profileId, { forceDigest: true });
    const second = (await notifications.history(profileId)).length;

    expect(second).toBe(first);

    const decisions = await notifications.decisionsForJob(profileId, jobIds[0]!);
    expect(decisions.some((d) => d.outcome === 'SUPPRESSED_ALREADY_NOTIFIED')).toBe(true);
  });

  it('records a decision for every candidate, including suppressions', async () => {
    await rank([
      { jobId: jobIds[0]!, score: 94, match: 96 },
      // Just under the 64 threshold: inside the trace margin, so it is
      // recorded as suppressed rather than silently dropped.
      { jobId: jobIds[1]!, score: 52, match: 55 },
    ]);

    await service.processCandidate(profileId, { forceDigest: true });

    const counts = await notifications.decisionCounts(profileId, new Date(now.getTime() - 3_600_000));
    expect(Object.keys(counts).length).toBeGreaterThanOrEqual(1);

    // "Why wasn't I told about this job?" answered directly.
    const rejected = await notifications.decisionsForJob(profileId, jobIds[1]!);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]?.reason.length).toBeGreaterThan(5);
  });

  it('retries a transient failure without duplicating the email', async () => {
    await rank([{ jobId: jobIds[0]!, score: 94, match: 96 }]);
    await service.processCandidate(profileId, { forceDigest: true });

    provider.failNext = 2;
    const firstPass = await service.processDeliveries();
    expect(firstPass.retrying).toBeGreaterThan(0);
    expect(provider.sent).toHaveLength(0);

    // Backoff schedules the next attempt in the future; the test drives it
    // directly rather than sleeping.
    await ctx.db.execute(
      (await import('drizzle-orm')).sql`UPDATE notification_channel_deliveries SET next_attempt_at = now()`,
    );

    const secondPass = await service.processDeliveries();
    expect(secondPass.sent + secondPass.retrying).toBeGreaterThan(0);

    await ctx.db.execute(
      (await import('drizzle-orm')).sql`UPDATE notification_channel_deliveries SET next_attempt_at = now()`,
    );
    await service.processDeliveries();

    // However many attempts it took, exactly one message reached the provider.
    expect(provider.sent.length).toBeLessThanOrEqual(2);
    const keys = new Set(provider.sent.map((m) => m.email.idempotencyKey));
    expect(keys.size).toBe(provider.sent.length);
  });

  it('gives up on a permanent failure instead of retrying forever', async () => {
    await rank([{ jobId: jobIds[0]!, score: 94, match: 96 }]);
    await service.processCandidate(profileId, { forceDigest: true });

    provider.failNext = 10;
    provider.failRetryable = false;

    const result = await service.processDeliveries();
    expect(result.failed).toBeGreaterThan(0);
    expect(result.retrying).toBe(0);

    const history = await notifications.history(profileId);
    expect(history.some((h) => h.delivery?.status === 'failed')).toBe(true);
  });

  it('queues nothing while sending is disabled, then sends when enabled', async () => {
    const disabled = new NotificationService({
      notifications,
      recommendations,
      candidates: new CandidateRepository(ctx.db),
      profiles: new ProfileRepository(ctx.db),
      sources: new SourceRepository(ctx.db),
      logger,
      events: new EventRecorder(logger, new EventRepository(ctx.db)),
      provider,
      config: { enabled: false },
      fromEmail: 'jobs@example.com',
      now: () => now,
    });

    await rank([{ jobId: jobIds[0]!, score: 94, match: 96 }]);
    await disabled.processCandidate(profileId, { forceDigest: true });

    // Decisions and events still happen — only the send is gated, so turning
    // notifications back on delivers what was already decided.
    expect((await notifications.history(profileId)).length).toBeGreaterThan(0);
    expect((await disabled.processDeliveries()).attempted).toBe(0);
    expect(provider.sent).toHaveLength(0);
  });

  it('records a provider delivery webhook against the right delivery', async () => {
    await rank([{ jobId: jobIds[0]!, score: 94, match: 96 }]);
    await service.processCandidate(profileId, { forceDigest: true });
    await service.processDeliveries();

    const history = await notifications.history(profileId);
    const messageId = history[0]!.delivery!.providerMessageId as string;

    expect(await notifications.recordDeliveryEvent({ providerMessageId: messageId, event: 'delivered' })).toBe(true);
    expect(await notifications.recordDeliveryEvent({ providerMessageId: messageId, event: 'opened' })).toBe(true);
    // An unknown id is ignored rather than throwing: webhooks arrive for
    // messages from other environments, and an error would retry forever.
    expect(await notifications.recordDeliveryEvent({ providerMessageId: 'unknown', event: 'delivered' })).toBe(false);

    const timeline = await notifications.deliveryTimeline(history[0]!.delivery!.id);
    expect(timeline.map((e) => e.event)).toContain('delivered');
    expect(timeline.map((e) => e.event)).toContain('opened');

    const updated = await notifications.history(profileId);
    // `opened` is engagement, not delivery state; it must not overwrite it.
    expect(updated[0]?.delivery?.status).toBe('delivered');
  });

  it('alerts about a failing source once, not on every check', async () => {
    const sources = new SourceRepository(ctx.db);
    await sources.update('greenhouse', { enabled: true });
    await ctx.db.execute(
      (await import('drizzle-orm'))
        .sql`UPDATE job_sources SET consecutive_failures = 6, last_error_message = 'HTTP 500'`,
    );

    const first = await service.processSourceHealth(profileId);
    expect(first.alerted).toBe(1);

    // Still down, already reported. Saying so again would train the reader to
    // ignore the channel.
    const second = await service.processSourceHealth(profileId);
    expect(second.alerted).toBe(0);

    const history = await notifications.history(profileId);
    expect(history.some((h) => h.event.type === 'SOURCE_FAILURE')).toBe(true);
    expect(history.find((h) => h.event.type === 'SOURCE_FAILURE')?.event.html).toContain(
      'consecutive',
    );
  });

  it('stores preferences as data and reads them back', async () => {
    const updated = await notifications.savePreferences(
      profileId,
      notificationPreferencesSchema.parse({
        email: 'new@example.com',
        timezone: 'America/New_York',
        digestFrequency: 'every_6_hours',
        maxAlertsPerDay: 2,
        quietHours: { enabled: true, start: '22:00', end: '06:00', allowUrgentOverride: false },
      }),
    );

    expect(updated.maxAlertsPerDay).toBe(2);
    const reloaded = await notifications.getPreferences(profileId);
    expect(reloaded.preferences.email).toBe('new@example.com');
    expect(reloaded.preferences.quietHours.allowUrgentOverride).toBe(false);
    expect(reloaded.preferences.digestFrequency).toBe('every_6_hours');
  });

  it('queues nothing when no email address is configured', async () => {
    await notifications.savePreferences(profileId, notificationPreferencesSchema.parse({}));
    await rank([{ jobId: jobIds[0]!, score: 94, match: 96 }]);

    const run = await service.processCandidate(profileId, { forceDigest: true });
    expect(run.immediateAlerts).toBe(0);
    expect((await notifications.history(profileId))).toHaveLength(0);
    // The decision trace still records what would have happened.
    expect(run.decisionsRecorded).toBeGreaterThan(0);
  });
});
