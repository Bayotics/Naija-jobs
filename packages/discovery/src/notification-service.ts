import { createHash } from 'node:crypto';
import {
  notificationEngineConfigSchema,
  type AlertData,
  type AlertPriority,
  type DigestData,
  type DigestSection,
  type JobCardData,
  type NotificationEngineConfig,
  type NotificationPreferences,
  type NotificationType,
  type RenderedEmail,
  type SystemAlertData,
  type WeeklySummaryData,
} from '@job-intel/contracts';
import type {
  CandidateRepository,
  NotificationRepository,
  ProfileRepository,
  RecommendationRepository,
  SourceRepository,
} from '@job-intel/db';
import type { EventRecorder, Logger } from '@job-intel/observability';
import {
  MemoryEmailProvider,
  NullEmailProvider,
  buildJobCard,
  buildSourceHealthAlert,
  canAttempt,
  decideNotifications,
  evaluateSourceHealth,
  isDigestDue,
  nextRetry,
  periodLabel,
  preferenceUrl,
  renderAlert,
  renderDigest,
  renderSystemAlert,
  renderWeeklySummary,
  selectDigestJobs,
  toDecisionRows,
  type CandidateDecision,
  type EmailProvider,
  type NotificationCandidate,
} from '@job-intel/notifications';

/**
 * Notification orchestration.
 *
 * Walks the chain the brief lays out — recommendation → eligibility → decision
 * → event → queue → render → provider → tracking — and owns the only place in
 * the system that touches an email provider.
 *
 * Two properties hold structurally rather than by discipline:
 *
 *  - **Nothing upstream can send an email.** The provider is constructed here
 *    and never handed out. The recommendation engine has no reference to reach.
 *  - **Rendering happens once, before queueing.** The rendered payload is
 *    stored on the event, so a retry re-sends bytes rather than re-deriving
 *    them — which is what makes the idempotency key stable across attempts.
 */

export interface NotificationServiceDependencies {
  notifications: NotificationRepository;
  recommendations: RecommendationRepository;
  candidates: CandidateRepository;
  profiles: ProfileRepository;
  sources: SourceRepository;
  logger: Logger;
  events: EventRecorder;
  provider?: EmailProvider;
  config?: Partial<NotificationEngineConfig>;
  /** For signed preference links. Null degrades to a plain settings URL. */
  preferenceSecret?: string | null;
  fromEmail?: string | null;
  now?: () => Date;
}

export interface NotificationRunResult {
  profileId: string;
  considered: number;
  immediateAlerts: number;
  digestJobs: number;
  digestSent: boolean;
  suppressed: number;
  decisionsRecorded: number;
  byOutcome: Record<string, number>;
  durationMs: number;
}

export interface DeliveryRunResult {
  attempted: number;
  sent: number;
  retrying: number;
  failed: number;
  skipped: number;
}

const SECTION_ORDER: Array<{ key: string; icon: string; title: string; minScore: number }> = [
  { key: 'exceptional', icon: '🔥', title: 'Exceptional matches', minScore: 88 },
  { key: 'strong', icon: '🟢', title: 'Strong matches', minScore: 72 },
  { key: 'worth', icon: '🟡', title: 'Worth considering', minScore: 0 },
];

export class NotificationService {
  private readonly provider: EmailProvider;
  readonly config: NotificationEngineConfig;

  constructor(private readonly deps: NotificationServiceDependencies) {
    this.config = notificationEngineConfigSchema.parse(deps.config ?? {});
    this.provider = deps.provider ?? new NullEmailProvider();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ── Decision pass ─────────────────────────────────────────────────────────

  /**
   * Decides what to do about every ranked job, then acts.
   *
   * Cost control lives at the top: the pool is filtered in SQL to eligible,
   * above-threshold recommendations before anything is loaded, so a job that
   * could never be notified never reaches the renderer.
   */
  async processCandidate(
    profileId: string,
    options: { forceDigest?: boolean; reason?: string } = {},
  ): Promise<NotificationRunResult> {
    const startedAt = Date.now();
    const now = this.now();

    const { preferences, lastDigestAt } = await this.deps.notifications.getPreferences(profileId);
    const candidates = await this.loadCandidates(profileId, preferences);

    // Local midnight, so the daily cap resets where the candidate lives.
    const alertsSentToday = await this.deps.notifications.countAlertsSince(
      profileId,
      startOfLocalDay(now, preferences.timezone),
    );

    const decision = decideNotifications(candidates, { preferences, alertsSentToday, now });

    const result: NotificationRunResult = {
      profileId,
      considered: candidates.length,
      immediateAlerts: 0,
      digestJobs: 0,
      digestSent: false,
      suppressed: decision.suppressed.length,
      decisionsRecorded: 0,
      byOutcome: {},
      durationMs: 0,
    };

    // ── Immediate alerts ────────────────────────────────────────────────────
    for (const alert of decision.immediate) {
      const eventId = await this.createAlertEvent(profileId, preferences, alert, now);
      if (eventId) result.immediateAlerts += 1;
    }

    // ── Digest ──────────────────────────────────────────────────────────────
    const due = isDigestDue(preferences, lastDigestAt, now);
    const shouldSendDigest = options.forceDigest === true || due.due;

    let digestDecisions: CandidateDecision[] = [];
    let heldDecisions: CandidateDecision[] = [];

    if (shouldSendDigest && decision.digest.length > 0) {
      const selection = selectDigestJobs(decision.digest, preferences);
      digestDecisions = selection.selected;
      heldDecisions = selection.held;

      if (digestDecisions.length > 0) {
        const sent = await this.createDigestEvent(
          profileId,
          preferences,
          digestDecisions,
          lastDigestAt,
          candidates.length,
          now,
        );
        result.digestSent = sent;
        result.digestJobs = digestDecisions.length;
      }
    } else if (!shouldSendDigest) {
      this.deps.logger.debug('Digest not due', { profileId, reason: due.reason });
    }

    // ── Trace ───────────────────────────────────────────────────────────────
    const allDecisions = [
      ...decision.immediate,
      ...(digestDecisions.length > 0 ? digestDecisions : decision.digest),
      ...heldDecisions,
      ...decision.suppressed,
    ];

    for (const item of allDecisions) {
      result.byOutcome[item.outcome] = (result.byOutcome[item.outcome] ?? 0) + 1;
    }

    result.decisionsRecorded = await this.deps.notifications.recordDecisions(
      profileId,
      toDecisionRows(allDecisions, now),
    );

    result.durationMs = Date.now() - startedAt;

    await this.deps.events.emit('NOTIFICATIONS_PROCESSED', {
      message: `${result.immediateAlerts} alert(s), digest ${result.digestSent ? 'sent' : 'not sent'}`,
      data: { ...result, reason: options.reason ?? 'scheduled' },
    });

    return result;
  }

  // ── Event creation ────────────────────────────────────────────────────────

  private async createAlertEvent(
    profileId: string,
    preferences: NotificationPreferences,
    decision: CandidateDecision,
    now: Date,
  ): Promise<string | null> {
    const card = await this.buildCard(profileId, decision, now);
    if (!card) return null;

    const data: AlertData = {
      subject: `${priorityIcon(decision.priority)} ${card.title} — ${card.company} (${Math.round(card.recommendationScore)})`,
      priority: decision.priority,
      headline:
        decision.priority === 'URGENT' ? 'Exceptional match' : 'Strong match worth a look now',
      job: card,
      ruleName: decision.rule?.ruleName ?? 'threshold',
      preferencesUrl: this.preferencesUrl(profileId, now),
      generatedAt: now,
    };

    const email = renderAlert(data, {
      // Scoped on the canonical id, so the same job cannot produce two alerts
      // even if the ranking pass runs twice.
      scope: `alert:${profileId}:${decision.candidate.canonicalJobId}`,
    });

    return this.queue(profileId, 'JOB_ALERT', decision.priority, email, {
      jobIds: [decision.candidate.jobId],
      canonicalJobIds: [decision.candidate.canonicalJobId],
      payload: data as unknown as Record<string, unknown>,
      entries: [
        {
          canonicalJobId: decision.candidate.canonicalJobId,
          priority: decision.priority,
          score: decision.candidate.recommendationScore,
          fingerprint: fingerprintOf(card),
        },
      ],
      now,
      preferences,
    });
  }

  private async createDigestEvent(
    profileId: string,
    preferences: NotificationPreferences,
    decisions: readonly CandidateDecision[],
    since: Date | null,
    discovered: number,
    now: Date,
  ): Promise<boolean> {
    const cards: Array<{ card: JobCardData; decision: CandidateDecision }> = [];
    for (const decision of decisions) {
      const card = await this.buildCard(profileId, decision, now);
      if (card) cards.push({ card, decision });
    }
    if (cards.length === 0) return false;

    const sections: DigestSection[] = SECTION_ORDER.map((section, index) => {
      const upper = index === 0 ? Infinity : (SECTION_ORDER[index - 1] as { minScore: number }).minScore;
      return {
        key: section.key,
        icon: section.icon,
        title: section.title,
        jobs: cards
          .filter(
            ({ card }) =>
              card.recommendationScore >= section.minScore && card.recommendationScore < upper,
          )
          .map(({ card }) => card),
      };
    }).filter((section) => section.jobs.length > 0);

    const data: DigestData = {
      subject: `Your job digest — ${cards.length} opportunit${cards.length === 1 ? 'y' : 'ies'}`,
      periodLabel: periodLabel(since, now),
      jobsDiscovered: discovered,
      highQualityMatches: cards.filter((c) => c.card.recommendationScore >= 72).length,
      sections,
      preferencesUrl: this.preferencesUrl(profileId, now),
      generatedAt: now,
    };

    // Scoped to the period, so re-running the digest job inside one window is
    // a no-op rather than a second email.
    const email = renderDigest(data, {
      scope: `digest:${profileId}:${digestWindowKey(now, preferences)}`,
    });

    const eventId = await this.queue(profileId, 'JOB_DIGEST', 'NORMAL', email, {
      jobIds: cards.map((c) => c.decision.candidate.jobId),
      canonicalJobIds: cards.map((c) => c.decision.candidate.canonicalJobId),
      payload: data as unknown as Record<string, unknown>,
      entries: cards.map((c) => ({
        canonicalJobId: c.decision.candidate.canonicalJobId,
        priority: c.decision.priority,
        score: c.decision.candidate.recommendationScore,
        fingerprint: fingerprintOf(c.card),
      })),
      now,
      preferences,
    });

    if (eventId) await this.deps.notifications.recordDigestSent(profileId, now);
    return eventId !== null;
  }

  /** Operational alert. Shares the channel with job mail but never the dedup. */
  async sendSystemAlert(
    profileId: string,
    data: Omit<SystemAlertData, 'preferencesUrl' | 'generatedAt'>,
    type: NotificationType = 'SYSTEM_ALERT',
  ): Promise<string | null> {
    const now = this.now();
    const { preferences } = await this.deps.notifications.getPreferences(profileId);
    if (!preferences.systemAlertsEnabled) {
      this.deps.logger.debug('System alerts disabled', { profileId });
      return null;
    }

    const full: SystemAlertData = {
      ...data,
      preferencesUrl: this.preferencesUrl(profileId, now),
      generatedAt: now,
    };
    // Hour-scoped: a source failing continuously produces one alert per hour at
    // most, whatever the caller does.
    const email = renderSystemAlert(full, {
      scope: `system:${profileId}:${data.title}:${now.toISOString().slice(0, 13)}`,
    });

    return this.queue(profileId, type, data.severity === 'critical' ? 'URGENT' : 'HIGH', email, {
      jobIds: [],
      canonicalJobIds: [],
      payload: full as unknown as Record<string, unknown>,
      entries: [],
      now,
      preferences,
    });
  }

  /** Checks every source and alerts on the ones that crossed the threshold. */
  async processSourceHealth(profileId: string): Promise<{ checked: number; alerted: number }> {
    const sources = await this.deps.sources.list({ includeArchived: false });
    const { preferences } = await this.deps.notifications.getPreferences(profileId);
    let alerted = 0;

    for (const source of sources) {
      const state = await this.deps.notifications.getSourceAlertState(source.id);

      const verdict = evaluateSourceHealth(
        {
          sourceId: source.id,
          displayName: source.displayName,
          consecutiveFailures: source.consecutiveFailures,
          lastError: source.lastErrorMessage ?? null,
          lastSuccessAt: source.lastSuccessfulRunAt ?? null,
          enabled: source.enabled,
          lastAlertedAtFailures: state?.alertedAtFailures ?? null,
        },
        { logAt: 1, warnAt: 3, notifyAt: preferences.sourceFailureAlertThreshold, reAlertEvery: 20 },
      );

      // A source that recovered clears its alert state, so the next failure run
      // alerts again rather than being suppressed by a stale record.
      if (verdict.escalation === 'none' && state?.alertedAtFailures !== null && state) {
        await this.deps.notifications.recordSourceRecovery(source.id);
        continue;
      }

      if (!verdict.shouldNotify) continue;

      const alert = buildSourceHealthAlert(
        {
          sourceId: source.id,
          displayName: source.displayName,
          consecutiveFailures: source.consecutiveFailures,
          lastError: source.lastErrorMessage ?? null,
          lastSuccessAt: source.lastSuccessfulRunAt ?? null,
          enabled: source.enabled,
          lastAlertedAtFailures: state?.alertedAtFailures ?? null,
        },
        verdict,
        this.preferencesUrl(profileId, this.now()),
        this.now(),
      );

      const eventId = await this.sendSystemAlert(profileId, alert, 'SOURCE_FAILURE');
      if (eventId) {
        await this.deps.notifications.recordSourceAlert({
          sourceId: source.id,
          failures: source.consecutiveFailures,
          severity: verdict.severity,
        });
        alerted += 1;
      }
    }

    return { checked: sources.length, alerted };
  }

  async sendWeeklySummary(
    profileId: string,
    data: Omit<WeeklySummaryData, 'preferencesUrl' | 'generatedAt'>,
  ): Promise<string | null> {
    const now = this.now();
    const { preferences } = await this.deps.notifications.getPreferences(profileId);
    if (!preferences.weeklySummaryEnabled) return null;

    const full: WeeklySummaryData = {
      ...data,
      preferencesUrl: this.preferencesUrl(profileId, now),
      generatedAt: now,
    };
    const email = renderWeeklySummary(full, {
      scope: `weekly:${profileId}:${now.toISOString().slice(0, 10)}`,
    });

    const eventId = await this.queue(profileId, 'WEEKLY_SUMMARY', 'LOW', email, {
      jobIds: [],
      canonicalJobIds: [],
      payload: full as unknown as Record<string, unknown>,
      entries: [],
      now,
      preferences,
    });

    if (eventId) await this.deps.notifications.recordWeeklySummarySent(profileId, now);
    return eventId;
  }

  // ── Delivery ──────────────────────────────────────────────────────────────

  /**
   * Attempts pending deliveries.
   *
   * Separate from decision-making on purpose: a provider outage must not stop
   * the system deciding, and a decision run must not block on SMTP. The queue
   * between them is the whole reason both remain useful when one is broken.
   */
  async processDeliveries(limit?: number): Promise<DeliveryRunResult> {
    const result: DeliveryRunResult = { attempted: 0, sent: 0, retrying: 0, failed: 0, skipped: 0 };

    if (!this.config.enabled) {
      this.deps.logger.debug('Notification sending is disabled by configuration');
      return result;
    }
    if (!this.provider.isAvailable()) {
      this.deps.logger.warn('No email provider configured; deliveries stay queued');
      return result;
    }

    const pending = await this.deps.notifications.pendingDeliveries(
      limit ?? this.config.batchSize,
    );

    for (const { delivery, event } of pending) {
      const gate = canAttempt({
        status: delivery.status,
        attempts: delivery.attempts,
        maxAttempts: delivery.maxAttempts,
      });
      if (!gate.allowed) {
        result.skipped += 1;
        continue;
      }

      result.attempted += 1;

      const outcome = await this.provider.sendEmail({
        to: delivery.recipient,
        from: this.deps.fromEmail ?? 'notifications@localhost',
        fromName: this.config.fromName,
        // Bytes rendered at decision time, replayed unchanged. Re-rendering
        // here would risk a different idempotency key on every retry.
        email: {
          subject: event.subject,
          html: event.html,
          text: event.textBody,
          idempotencyKey: event.idempotencyKey,
        },
        tags: { type: event.type, eventId: event.id },
      });

      if (outcome.accepted) {
        await this.deps.notifications.recordAttempt({
          deliveryId: delivery.id,
          status: 'sent',
          providerId: this.provider.id,
          providerMessageId: outcome.providerMessageId,
        });
        result.sent += 1;
        continue;
      }

      const retry = nextRetry(delivery.attempts + 1, outcome.retryable, this.config);
      await this.deps.notifications.recordAttempt({
        deliveryId: delivery.id,
        status: retry.retry ? 'queued' : 'failed',
        providerId: this.provider.id,
        error: `${outcome.error ?? 'send failed'} (${retry.reason})`,
        nextAttemptAt: retry.retry ? new Date(Date.now() + retry.delayMs) : null,
      });

      if (retry.retry) result.retrying += 1;
      else result.failed += 1;
    }

    this.deps.logger.info('Delivery pass complete', { ...result, provider: this.provider.id });
    return result;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Persists an event plus its delivery, and marks the jobs notified.
   *
   * Returns null when the idempotency key already existed — the "we already did
   * this" path, which must be silent rather than an error.
   */
  private async queue(
    profileId: string,
    type: NotificationType,
    priority: AlertPriority,
    email: RenderedEmail,
    input: {
      jobIds: string[];
      canonicalJobIds: string[];
      payload: Record<string, unknown>;
      entries: Array<{
        canonicalJobId: string;
        priority: AlertPriority;
        score: number;
        fingerprint: string | null;
      }>;
      now: Date;
      preferences: NotificationPreferences;
    },
  ): Promise<string | null> {
    const recipient = input.preferences.email;
    if (!recipient) {
      this.deps.logger.warn('No notification email configured; nothing queued', { profileId });
      return null;
    }

    const created = await this.deps.notifications.createEvent({
      profileId,
      type,
      priority,
      email,
      recipient,
      jobIds: input.jobIds,
      canonicalJobIds: input.canonicalJobIds,
      payload: input.payload,
      maxAttempts: this.config.maxAttempts,
    });

    if (!created.created) {
      this.deps.logger.debug('Notification already exists for this content', {
        profileId,
        type,
        idempotencyKey: email.idempotencyKey.slice(0, 12),
      });
      return null;
    }

    if (input.entries.length > 0) {
      await this.deps.notifications.markNotified(
        profileId,
        input.entries.map((entry) => ({ ...entry, eventId: created.eventId })),
        input.now,
      );
    }

    return created.eventId;
  }

  private preferencesUrl(profileId: string, now: Date): string {
    return preferenceUrl(
      this.config.appUrl,
      { profileId, scope: 'manage' },
      this.deps.preferenceSecret ?? null,
      now,
    );
  }

  /** Loads the job row a card needs. Returns null rather than inventing one. */
  private async buildCard(
    profileId: string,
    decision: CandidateDecision,
    now: Date,
  ): Promise<JobCardData | null> {
    const row = await this.deps.recommendations.getRecommendation(
      profileId,
      decision.candidate.jobId,
    );
    if (!row) return null;

    const signals = row.signals;
    return buildJobCard({
      jobId: row.job.id,
      title: row.job.title,
      company: row.job.companyNameRaw,
      city: row.job.city,
      region: row.job.region,
      countryCode: row.job.countryCode,
      remoteType: row.job.remoteType,
      salaryMin: row.job.salaryMin === null ? null : Number(row.job.salaryMin),
      salaryMax: row.job.salaryMax === null ? null : Number(row.job.salaryMax),
      salaryCurrency: row.job.salaryCurrency,
      salaryPeriod: row.job.salaryPeriod,
      matchScore: row.recommendation.matchScore,
      confidence: row.recommendation.matchConfidence,
      recommendationScore: row.recommendation.finalScore,
      tier: row.recommendation.tier,
      rankReasons: row.recommendation.rankReasons,
      concerns: row.recommendation.notificationBlockers,
      matchedRequirements: [],
      missingRequirements: [],
      sourceId: row.job.sourceId,
      sourceLabel: row.job.sourceId,
      sourceAuthority: signals?.sourceAuthority ?? 'medium',
      postedAt: row.job.postedAt,
      firstSeenAt: row.job.firstSeenAt,
      applyUrl: row.job.applyUrl,
      canonicalUrl: row.job.canonicalUrl,
      sourceUrl: row.job.sourceUrl,
      applicationUrlVerified: row.job.lastVerifiedAt !== null,
      atsVendor: null,
      updateNote: decision.updateNote,
      appUrl: this.config.appUrl,
      now,
    });
  }

  /**
   * The notification pool.
   *
   * Two requirements pull against each other here, and the margin is how they
   * are reconciled:
   *
   *  - **Cost control** says do not process what can never be notified.
   *  - **The decision trace** says record why every candidate was suppressed,
   *    and "below your threshold" is the single most useful of those reasons.
   *
   * So the SQL filter sits a margin *below* the candidate's threshold rather
   * than at it. Jobs just under the line are loaded and recorded as
   * SUPPRESSED_BELOW_THRESHOLD — which is what makes "why didn't I hear about
   * this?" answerable — while the long tail far below never reaches the
   * decider, let alone the renderer. Filtering exactly at the threshold made
   * the trace silent about precisely the jobs someone would ask about.
   */
  private static readonly TRACE_MARGIN = 20;

  private async loadCandidates(
    profileId: string,
    preferences: NotificationPreferences,
  ): Promise<NotificationCandidate[]> {
    const [rows, notified] = await Promise.all([
      this.deps.recommendations.topRecommendations({
        profileId,
        limit: 200,
        minimumScore: Math.max(
          0,
          preferences.minimumRecommendationScore - NotificationService.TRACE_MARGIN,
        ),
      }),
      this.deps.notifications.loadNotifiedJobs(profileId),
    ]);

    const exposures = await this.deps.recommendations.loadExposures(profileId);

    return rows.map((row) => {
      const signals = row.signals;
      const exposure = exposures.get(row.job.id);
      const canonicalJobId = row.job.jobGroupId ? row.job.id : row.job.id;
      const priorNotification = notified.get(canonicalJobId);

      return {
        jobId: row.job.id,
        canonicalJobId,
        companyKey: row.job.companyNameRaw.trim().toLowerCase(),
        sourceId: row.job.sourceId,

        recommendationScore: row.recommendation.finalScore,
        matchScore: row.recommendation.matchScore,
        confidence: row.recommendation.matchConfidence,
        qualityScore: signals?.qualityScore ?? 50,
        freshnessHours: signals?.freshnessAgeHours ?? 0,
        scamRisk: signals?.scamRisk ?? 0,
        salaryAnnualUsd:
          row.job.salaryNormalizedAnnualUsd === null
            ? null
            : Number(row.job.salaryNormalizedAnnualUsd),

        notificationEligible: row.recommendation.notificationEligible,
        notificationBlockers: row.recommendation.notificationBlockers,
        /*
         * A job with no signals row has not been assessed — it is not a job
         * known to be closed.
         *
         * This previously read `signals?.lifecycleStatus === 'ACTIVE' || ... ===
         * 'UNKNOWN'`, so a missing row made both comparisons false and the
         * posting was suppressed as stale. The intent is visible in the second
         * comparison: `UNKNOWN` is explicitly allowed through, because not
         * knowing whether a job is open is not grounds for hiding it. A missing
         * row is *less* evidence than `UNKNOWN`, and it was being treated as
         * more.
         *
         * The cost was total. Signals are written by a stage that had not been
         * wired into the scheduler, so every job discovered after the last
         * manual run was silently unnotifiable — 294 of 422 — while every
         * notification pass reported success.
         *
         * Only a *stated* non-active status suppresses now. The staleness
         * detector remains the only thing that can call a job stale.
         */
        lifecycleActive: signals ? signals.lifecycleStatus !== 'STALE' &&
          signals.lifecycleStatus !== 'EXPIRED' &&
          signals.lifecycleStatus !== 'CLOSED' : true,
        isDuplicate: false,

        applicationUrlPresent: row.job.applyUrl !== null || row.job.canonicalUrl !== null,
        applicationUrlVerified: row.job.lastVerifiedAt !== null,
        visaSponsorshipOffered: row.job.visaSponsorship === 'offered',
        salaryMeetsTarget: false,
        remote: row.job.remoteType === 'remote',
        fromAuthoritativeSource:
          signals?.sourceAuthority === 'authoritative' || signals?.sourceAuthority === 'high',

        previouslyRejected: exposure?.state === 'rejected' || exposure?.state === 'dismissed',
        notifiedAt: priorNotification?.lastNotifiedAt ?? null,
        materialChange: null,
      } satisfies NotificationCandidate;
    });
  }
}

/** Content hash of what was sent, so a later material change is detectable. */
function fingerprintOf(card: JobCardData): string {
  return createHash('sha256')
    .update(
      [card.title, card.company, card.location, card.workArrangement, card.salary, card.applyUrl]
        .map((v) => v ?? '')
        .join('|'),
    )
    .digest('hex')
    .slice(0, 32);
}

function priorityIcon(priority: AlertPriority): string {
  return { URGENT: '🚨', HIGH: '🔥', NORMAL: '🟢', LOW: '⚪' }[priority];
}

/** Midnight in the candidate's zone, so the daily cap resets where they live. */
function startOfLocalDay(at: Date, timeZone: string): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  try {
    const date = formatter.format(at);
    return new Date(`${date}T00:00:00Z`);
  } catch {
    return new Date(at.getTime() - 24 * 3_600_000);
  }
}

/** Identifies the digest window, so re-running inside one is a no-op. */
function digestWindowKey(now: Date, preferences: NotificationPreferences): string {
  const iso = now.toISOString();
  switch (preferences.digestFrequency) {
    case 'weekly':
      return iso.slice(0, 10);
    case 'daily':
      return iso.slice(0, 10);
    case 'every_6_hours':
      return `${iso.slice(0, 13)}-${Math.floor(now.getUTCHours() / 6)}`;
    case 'every_2_hours':
      return `${iso.slice(0, 13)}-${Math.floor(now.getUTCHours() / 2)}`;
    case 'hourly':
      return iso.slice(0, 13);
    default:
      return `${iso.slice(0, 16)}`;
  }
}

/** Re-exported so a caller can construct the in-memory provider for previews. */
export { MemoryEmailProvider };
