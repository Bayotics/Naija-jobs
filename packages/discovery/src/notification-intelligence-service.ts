import { createHash } from 'node:crypto';
import {
  URGENCY_RANK,
  type ApplicationRecommendation,
  type FatigueReport,
  type NotificationAnalytics,
  type NotificationIntelligenceConfig,
  type NotificationScore,
  type SuppressionRecord,
  type ThresholdSimulation,
} from '@job-intel/contracts';
import type {
  ApplicationRepository,
  CandidateRepository,
  EnrichmentRepository,
  JobRepository,
  MatchRepository,
  NotificationIntelligenceRepository,
} from '@job-intel/db';
import type { EventRecorder, Logger } from '@job-intel/observability';
import {
  assessDeadline,
  assessRarity,
  computeAlertQuality,
  computeCalibrationSignals,
  computeFatigue,
  computeNotificationAnalytics,
  computeNotificationScore,
  digestWorthSending,
  emailLink,
  evaluateSuppression,
  planDigest,
  qualifiesForDigest,
  qualifiesForInstant,
  simulateThresholds,
  validateLink,
  type DigestCandidate,
  type NotificationEvent,
} from '@job-intel/notifications';

/**
 * The notification intelligence service.
 *
 * Sits between application intelligence and the existing delivery machinery.
 * Its whole job is to decide what deserves an interruption, and the pipeline is
 * the one the brief lays out:
 *
 *   score → suppress → decide channel → queue
 *
 * Note where the boundary is. This service scores and suppresses; the prompt-8
 * decider and scheduler still own when a digest fires and how an email is sent.
 * Building a second delivery path would have meant two systems that both think
 * they own the candidate's inbox, and they would disagree within a week.
 */

export interface NotificationIntelligenceDependencies {
  notifications: NotificationIntelligenceRepository;
  applications: ApplicationRepository;
  matches: MatchRepository;
  jobs: JobRepository;
  enrichments: EnrichmentRepository;
  candidates: CandidateRepository;
  logger: Logger;
  events: EventRecorder;
  /** SSRF-hardened probe. Absent means links are structurally checked only. */
  linkProbe?: (url: string) => Promise<{ status: number; finalUrl: string; redirects: number } | null>;
}

export interface ScoreJobResult {
  jobId: string;
  score: NotificationScore;
  decision: 'instant' | 'digest' | 'dashboard' | 'suppressed';
  suppression: SuppressionRecord | null;
  /** Set when this is a re-notification and something changed. */
  updateNote: string | null;
}

export interface NotificationScoringRunResult {
  candidateId: string;
  considered: number;
  instant: number;
  digest: number;
  dashboard: number;
  suppressed: number;
  suppressionReasons: Record<string, number>;
  durationMs: number;
}

const dedupeKey = (...parts: Array<string | number | null>): string =>
  createHash('sha256').update(parts.filter((part) => part !== null).join('|')).digest('hex').slice(0, 40);

export class NotificationIntelligenceService {
  constructor(private readonly deps: NotificationIntelligenceDependencies) {}

  async getConfig(candidateId: string): Promise<NotificationIntelligenceConfig> {
    return this.deps.notifications.getConfig(candidateId);
  }

  async setConfig(candidateId: string, config: NotificationIntelligenceConfig) {
    return this.deps.notifications.setConfig(candidateId, config);
  }

  /**
   * Scores one job and decides what happens to it.
   *
   * Every input is loaded best-effort. A job with no enrichment, no match and
   * no application analysis still gets a score — a low one, with low confidence
   * and a stated reason — rather than throwing. Silence caused by an exception
   * is indistinguishable from silence caused by a decision, and only one of
   * those is acceptable.
   */
  async scoreJob(
    candidateId: string,
    jobId: string,
    options: { now?: Date; history?: Awaited<ReturnType<NotificationIntelligenceRepository['notificationHistory']>> } = {},
  ): Promise<ScoreJobResult | null> {
    const now = options.now ?? new Date();

    const job = await this.deps.jobs.getById(jobId);
    if (!job) return null;

    const [config, overrides, enrichment, match, intelligence, preferences, discoveryHistory] =
      await Promise.all([
        this.deps.notifications.getConfig(candidateId),
        this.deps.notifications.listOverrides(candidateId),
        this.deps.enrichments.getEnrichment(jobId).catch(() => null),
        this.deps.matches.get(jobId, candidateId).catch(() => null),
        this.deps.applications.getIntelligence(candidateId, jobId).catch(() => null),
        this.deps.candidates.getActivePreferences(candidateId).catch(() => null),
        this.deps.notifications.discoveryHistory(candidateId, 30).catch(() => ({
          totalJobs: 0,
          matchingAllDimensions: 0,
          windowDays: 30,
        })),
      ]);

    const history =
      options.history ?? (await this.deps.notifications.notificationHistory(candidateId, now));

    // ── Timing ────────────────────────────────────────────────────────────
    const deadline = assessDeadline({
      validThrough: job.validThrough,
      postedAt: job.postedAt,
      description: enrichment?.cleanedDescription ?? job.description,
      closed: job.status === 'closed' || job.status === 'expired',
      sourceCount: 1,
      absenceRuns: 0,
      now,
    });

    // ── Rarity ────────────────────────────────────────────────────────────
    const wantedTechnologies = (preferences?.preferences.technologies ?? [])
      .filter((entry) => entry.strength !== 'excluded')
      .map((entry) => entry.value.toLowerCase());

    const rarity = assessRarity({
      job: {
        countryCode: job.countryCode,
        remote: job.remoteType === 'remote',
        seniority: job.seniority,
        technologies: job.techStack ?? [],
        salaryAnnualUsd:
          job.salaryNormalizedAnnualUsd === null ? null : Number(job.salaryNormalizedAnnualUsd),
      },
      wanted: {
        countries: (preferences?.preferences.countries ?? [])
          .filter((entry) => entry.strength !== 'excluded')
          .map((entry) => entry.value.toUpperCase()),
        remoteRequired: preferences?.preferences.workArrangement === 'REMOTE_ONLY',
        seniorities: preferences?.preferences.seniorityLevels ?? [],
        technologies: wantedTechnologies,
        salaryTarget: preferences?.preferences.salary.target ?? null,
      },
      history: discoveryHistory,
    });

    // ── Favourites ────────────────────────────────────────────────────────
    const favouriteBoosts: Array<{ label: string; points: number }> = [];
    const favourites = config.favourites;

    const matchFavourite = (
      entries: typeof favourites.companies,
      target: string | null,
      kind: string,
    ): void => {
      if (!target) return;
      const hit = entries.find((entry) => target.toLowerCase().includes(entry.value.toLowerCase()));
      if (hit) favouriteBoosts.push({ label: `${kind}:${hit.value}`, points: hit.boost });
    };

    matchFavourite(favourites.companies, job.companyNameRaw, 'company');
    matchFavourite(favourites.titles, job.title, 'title');
    matchFavourite(favourites.locations, job.countryCode, 'location');

    for (const entry of favourites.technologies) {
      if ((job.techStack ?? []).some((slug) => slug.toLowerCase() === entry.value.toLowerCase())) {
        favouriteBoosts.push({ label: `technology:${entry.value}`, points: entry.boost });
      }
    }

    // ── Score ─────────────────────────────────────────────────────────────
    const score = computeNotificationScore({
      matchScore: match?.overallScore ?? null,
      matchConfidence: match?.confidence ?? null,
      applicationValueScore: intelligence?.applicationValueScore ?? null,
      recommendation: (intelligence?.overallRecommendation as ApplicationRecommendation) ?? null,
      jobQuality: enrichment?.quality.qualityScore ?? null,
      scamRisk: enrichment?.quality.scamScore ?? null,
      freshnessHours:
        job.postedAt === null ? null : (now.getTime() - job.postedAt.getTime()) / 3_600_000,
      salaryAnnualUsd:
        job.salaryNormalizedAnnualUsd === null ? null : Number(job.salaryNormalizedAnnualUsd),
      candidateSalaryTarget: preferences?.preferences.salary.target ?? null,
      careerAlignment: intelligence?.careerAlignment.score ?? null,
      careerAlignmentApplicable: intelligence?.careerAlignment.applicable ?? false,
      // Wired by the caller when the feedback loop has something to say.
      behavioralAffinity: null,
      behavioralConflictsWithExplicit: false,
      frictionScore: intelligence?.friction.frictionScore ?? null,
      competition: intelligence?.competitiveness.level ?? null,
      sourceQuality: null,
      deadline,
      rarity,
      favouriteBoosts,
      alertsSentToday: history.alertsInRollingDay,
      maxAlertsPerDay: config.cooldowns.maxAlertsPerRollingDay,
      config,
    });

    await this.deps.notifications.saveScore(candidateId, jobId, score);

    // ── Link validation ───────────────────────────────────────────────────
    const link = await validateLink(
      {
        applicationUrl: job.applyUrl,
        canonicalUrl: job.canonicalUrl,
        sourceUrl: job.sourceUrl,
      },
      { ...(this.deps.linkProbe ? { probe: this.deps.linkProbe } : {}) },
    );

    // ── Suppression ───────────────────────────────────────────────────────
    const lastNotified = history.lastByJob.get(jobId) ?? null;
    const lastCompanyAlert = job.companyNameRaw
      ? (history.lastByCompany.get(job.companyNameRaw.toLowerCase()) ?? null)
      : null;

    const outcome = evaluateSuppression({
      jobId,
      candidateId,
      companyName: job.companyNameRaw,
      jobTitle: job.title,
      technologies: job.techStack ?? [],
      countryCode: job.countryCode,
      sourceId: job.sourceId,
      score,
      recommendation: (intelligence?.overallRecommendation as ApplicationRecommendation) ?? null,
      expired: deadline.bucket === 'expired',
      /*
       * Duplication is decided by the application layer's own check, which
       * looks at the job group rather than a column on the row. Reading it from
       * there keeps one definition of "the same job" in the system.
       */
      isDuplicate: intelligence?.duplicate.reason === 'same_job_other_url',
      alreadyApplied: intelligence?.duplicate.reason === 'already_applied',
      previouslyRejected: false,
      hardBlocked: intelligence?.overallRecommendation === 'BLOCKED',
      suspicious: intelligence?.legitimacy.verdict === 'SUSPICIOUS',
      applicationUrlUsable: emailLink(link) !== null,
      lastNotifiedAt: lastNotified?.sentAt ?? null,
      lastNotifiedScore: lastNotified?.score ?? null,
      lastCompanyAlertAt: lastCompanyAlert,
      lastRoleAlertAt: null,
      alertsInRollingDay: history.alertsInRollingDay,
      alertsInRollingHour: history.alertsInRollingHour,
      materialChange: null,
      overrides,
      config,
      type: 'JOB_ALERT',
      // Quiet hours are applied by the scheduler, which owns the clock.
      inQuietHours: false,
      quietHoursAllowUrgent: true,
      excludedSourceIds: [],
      now,
    });

    if (outcome.suppressed) {
      await this.deps.notifications.recordSuppression(outcome.record);
      return { jobId, score, decision: 'suppressed', suppression: outcome.record, updateNote: null };
    }

    // A job that now qualifies must not stay blocked by a stale suppression row.
    await this.deps.notifications.clearSuppression(candidateId, jobId).catch(() => undefined);

    // ── Channel ───────────────────────────────────────────────────────────
    const decision: ScoreJobResult['decision'] = qualifiesForInstant(score, config)
      ? 'instant'
      : qualifiesForDigest(score, config)
        ? 'digest'
        : 'dashboard';

    if (decision === 'instant') {
      await this.deps.notifications.enqueueNotification({
        candidateId,
        jobId,
        type: 'JOB_ALERT',
        priority: score.urgency === 'CRITICAL' ? 'URGENT' : score.urgency === 'HIGH' ? 'HIGH' : 'NORMAL',
        urgency: score.urgency,
        channel: 'email',
        reason: score.explanation,
        notificationScore: score.score,
        scoreDetail: score,
        /*
         * The score is *not* in the key.
         *
         * Keying on it would mean a job whose score moved by one point on the
         * next pass produced a second "unique" alert — which is exactly the
         * duplicate the key exists to prevent. Re-notification is gated by the
         * cooldown and the material-change check instead, where it can be
         * reasoned about.
         */
        dedupeKey: dedupeKey('alert', candidateId, jobId, outcome.note ?? 'first'),
        metadata: { link: emailLink(link), linkVerdict: link.verdict },
      });
    }

    return {
      jobId,
      score,
      decision,
      suppression: null,
      updateNote: outcome.note,
    };
  }

  /**
   * Scores every job that has been matched but not yet assessed.
   *
   * One history load for the whole run rather than one per job: the cooldown
   * queries are the expensive part, and they do not change meaningfully within
   * a single pass.
   */
  async runFor(
    candidateId: string,
    options: { jobIds?: readonly string[]; limit?: number; now?: Date } = {},
  ): Promise<NotificationScoringRunResult> {
    const startedAt = Date.now();
    const now = options.now ?? new Date();

    const history = await this.deps.notifications.notificationHistory(candidateId, now);

    const jobIds =
      options.jobIds ??
      (await this.deps.applications
        .topOpportunities(candidateId, { limit: options.limit ?? 200 })
        .then((rows) => rows.map((row) => row.jobId))
        .catch(() => []));

    const result: NotificationScoringRunResult = {
      candidateId,
      considered: jobIds.length,
      instant: 0,
      digest: 0,
      dashboard: 0,
      suppressed: 0,
      suppressionReasons: {},
      durationMs: 0,
    };

    for (const jobId of jobIds) {
      try {
        const scored = await this.scoreJob(candidateId, jobId, { now, history });
        if (!scored) continue;

        if (scored.decision === 'instant') result.instant += 1;
        else if (scored.decision === 'digest') result.digest += 1;
        else if (scored.decision === 'dashboard') result.dashboard += 1;
        else {
          result.suppressed += 1;
          const reason = scored.suppression?.reason ?? 'unknown';
          result.suppressionReasons[reason] = (result.suppressionReasons[reason] ?? 0) + 1;
        }
      } catch (error) {
        this.deps.logger.warn('Notification scoring failed for one job', {
          candidateId,
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    result.durationMs = Date.now() - startedAt;

    await this.deps.events.emit('NOTIFICATION_SCORING_COMPLETED', {
      message: `Scored ${result.considered} jobs: ${result.instant} instant, ${result.digest} digest, ${result.suppressed} suppressed`,
      data: {
        candidateId,
        instant: result.instant,
        digest: result.digest,
        dashboard: result.dashboard,
        suppressed: result.suppressed,
      },
    });

    return result;
  }

  // ── Digest (Parts 19, 20, 36) ─────────────────────────────────────────────

  async buildDigest(
    candidateId: string,
    options: { windowStart: Date; windowEnd: Date; type?: 'DAILY_DIGEST' | 'WEEKLY_DIGEST' },
  ) {
    const config = await this.deps.notifications.getConfig(candidateId);

    const [scored, digestedCompanies] = await Promise.all([
      this.deps.notifications.topScored(candidateId, {
        minimum: config.thresholds.digest,
        limit: 200,
      }),
      this.deps.notifications.companiesAlreadyDigested(candidateId).catch(() => new Set<string>()),
    ]);

    const candidates: DigestCandidate[] = [];

    for (const row of scored) {
      const score = await this.deps.notifications.getScore(candidateId, row.jobId);
      if (!score) continue;

      const intelligence = await this.deps.applications
        .getIntelligence(candidateId, row.jobId)
        .catch(() => null);

      candidates.push({
        jobId: row.jobId,
        companyKey: (row.companyName ?? row.jobId).toLowerCase(),
        companyName: row.companyName,
        score,
        recommendation: (intelligence?.overallRecommendation as ApplicationRecommendation) ?? null,
        newCompany: row.companyName ? !digestedCompanies.has(row.companyName.toLowerCase()) : false,
        alertedSeparately: false,
        discoveredAt: row.computedAt,
      });
    }

    const plan = planDigest({
      candidateId,
      type: options.type ?? 'DAILY_DIGEST',
      windowStart: options.windowStart,
      windowEnd: options.windowEnd,
      candidates,
      config,
      maxJobs: 10,
      maxPerCompany: 2,
    });

    await this.deps.notifications.saveDigestPlan({
      candidateId,
      type: plan.type,
      windowStart: plan.windowStart,
      windowEnd: plan.windowEnd,
      sections: plan.sections,
      totalJobs: plan.totalJobs,
      excluded: plan.excluded,
    });

    return { plan, verdict: digestWorthSending(plan) };
  }

  // ── Transparency (Part 32) ────────────────────────────────────────────────

  async whyNoAlert(candidateId: string, jobId: string) {
    const [suppression, score] = await Promise.all([
      this.deps.notifications.suppressionFor(candidateId, jobId),
      this.deps.notifications.getScore(candidateId, jobId),
    ]);

    if (suppression) return { suppressed: true as const, suppression, score };

    if (!score) {
      return {
        suppressed: false as const,
        suppression: null,
        score: null,
        note: 'This job has not been scored for notifications yet.',
      };
    }

    const config = await this.deps.notifications.getConfig(candidateId);

    /*
     * Not suppressed, but not alerted either.
     *
     * The commonest case and the one most likely to be read as a bug: the job
     * cleared every gate and simply did not score highly enough to be worth an
     * interruption. Saying so explicitly, with both numbers, is the difference
     * between a system that looks broken and one that looks careful.
     */
    const note =
      score.score >= config.thresholds.instant
        ? 'This qualified for an instant alert.'
        : score.score >= config.thresholds.digest
          ? `It scored ${Math.round(score.score)}, which puts it in your next digest rather than an instant alert (that needs ${config.thresholds.instant}).`
          : `It scored ${Math.round(score.score)}, below your digest threshold of ${config.thresholds.digest}, so it appears on your dashboard only.`;

    return { suppressed: false as const, suppression: null, score, note };
  }

  async suppressions(candidateId: string, limit = 100) {
    return this.deps.notifications.listSuppressions(candidateId, limit);
  }

  async suppressionCounts(candidateId: string) {
    return this.deps.notifications.suppressionCounts(candidateId);
  }

  // ── Overrides (Part 33) ───────────────────────────────────────────────────

  async listOverrides(candidateId: string) {
    return this.deps.notifications.listOverrides(candidateId);
  }

  async addOverride(input: Parameters<NotificationIntelligenceRepository['addOverride']>[0]) {
    await this.deps.notifications.addOverride(input);
  }

  async removeOverride(candidateId: string, overrideId: string) {
    await this.deps.notifications.removeOverride(candidateId, overrideId);
  }

  // ── Analytics (Parts 28, 45, 46, 47) ──────────────────────────────────────

  private async events(candidateId: string, sinceDays: number): Promise<NotificationEvent[]> {
    const rows = await this.deps.notifications.engagementEvents(candidateId, sinceDays);

    return rows.map((row) => ({
      notificationId: row.notificationId,
      jobId: row.jobId,
      type: row.type,
      notificationScore: row.notificationScore,
      sentAt: row.sentAt,
      deliveredAt: row.deliveredAt,
      openedAt: row.openedAt,
      clickedAt: row.clickedAt,
      // Outcome signals come from the feedback loop; not yet joined here.
      saved: false,
      applied: false,
      dismissed: false,
      facts: {
        companyName: row.companyName,
        sourceId: row.sourceId,
        countryCode: row.countryCode,
        seniority: row.seniority,
        technologies: row.technologies ?? [],
      },
    }));
  }

  async analytics(candidateId: string, windowDays = 30): Promise<NotificationAnalytics> {
    const [events, counts] = await Promise.all([
      this.events(candidateId, windowDays),
      this.deps.notifications.suppressionCounts(candidateId),
    ]);

    const suppressed = Object.values(counts).reduce((sum, value) => sum + value, 0);

    return computeNotificationAnalytics({
      candidateId,
      events,
      suppressed,
      duplicatesSuppressed: counts.duplicate ?? 0,
      windowDays,
    });
  }

  async fatigue(candidateId: string): Promise<FatigueReport> {
    const [current, previous] = await Promise.all([
      this.events(candidateId, 7),
      this.events(candidateId, 14),
    ]);

    const cutoff = new Date(Date.now() - 7 * 86_400_000);
    const priorWindow = previous.filter(
      (event) => event.sentAt !== null && event.sentAt < cutoff,
    );

    return computeFatigue({
      candidateId,
      current,
      previous: priorWindow,
      currentFrequency: 'daily',
    });
  }

  async alertQuality(candidateId: string) {
    return computeAlertQuality({ candidateId, events: await this.events(candidateId, 30) });
  }

  async thresholdAdvice(candidateId: string): Promise<ThresholdSimulation> {
    const [events, config] = await Promise.all([
      this.events(candidateId, 60),
      this.deps.notifications.getConfig(candidateId),
    ]);

    return simulateThresholds({
      candidateId,
      events,
      currentThreshold: config.thresholds.instant,
    });
  }

  async calibration(candidateId: string) {
    const [events, preferences] = await Promise.all([
      this.events(candidateId, 60),
      this.deps.candidates.getActivePreferences(candidateId).catch(() => null),
    ]);

    const explicit = new Map<string, ReadonlySet<string>>();

    explicit.set(
      'technology',
      new Set(
        (preferences?.preferences.technologies ?? [])
          .filter((entry) => entry.strength !== 'excluded')
          .map((entry) => entry.value.toLowerCase()),
      ),
    );

    explicit.set(
      'country',
      new Set(
        (preferences?.preferences.countries ?? [])
          .filter((entry) => entry.strength !== 'excluded')
          .map((entry) => entry.value.toLowerCase()),
      ),
    );

    return computeCalibrationSignals({ events, explicit });
  }

  /** Whether an urgency clears the bar for waking someone. */
  static mayInterrupt(score: NotificationScore, config: NotificationIntelligenceConfig): boolean {
    return (
      URGENCY_RANK[score.urgency] >= URGENCY_RANK[config.thresholds.minimumUrgencyForInstant] &&
      score.urgency === 'CRITICAL'
    );
  }
}
