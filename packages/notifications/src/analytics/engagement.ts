import {
  alertQualitySchema,
  calibrationSignalSchema,
  engagementCountsSchema,
  fatigueReportSchema,
  notificationAnalyticsSchema,
  thresholdSimulationSchema,
  type AlertQuality,
  type CalibrationSignal,
  type EngagementCounts,
  type FatigueReport,
  type NotificationAnalytics,
  type ThresholdSimulation,
} from '@job-intel/contracts';

/**
 * Notification analytics, fatigue and calibration.
 *
 * Everything here is measurement, and none of it changes a setting. That is the
 * brief's requirement and also the right design: a system that quietly turns
 * down someone's alerts because they had a busy week has taken a decision that
 * was not its to take, and the person will not know why the job they were
 * waiting for never arrived.
 *
 * The other discipline is sample size. A job search produces small numbers for
 * a long time, and "you opened 2 of 9 alerts" is not a 22% open rate — it is
 * two opens. Every rate carries `sufficientSample` so the UI can show the
 * number without inviting a conclusion from it.
 *
 * One measurement note that shapes the whole module: **clicks are the signal,
 * opens are a hint.** Image proxying and privacy protection make open tracking
 * unreliable in both directions, so nothing important is decided on it.
 */

/** Below this, a rate is reported but not believed. */
export const MIN_NOTIFICATIONS_FOR_INFERENCE = 20;

/** Below this, a per-dimension calibration signal says nothing. */
export const MIN_SIGNALS_FOR_CALIBRATION = 8;

export interface NotificationEvent {
  notificationId: string;
  jobId: string | null;
  type: string;
  notificationScore: number | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  /** Behaviour recorded after the click, from the feedback loop. */
  saved: boolean;
  applied: boolean;
  dismissed: boolean;
  /** Job facts, for the dimensional breakdowns. */
  facts: {
    companyName: string | null;
    sourceId: string | null;
    countryCode: string | null;
    seniority: string | null;
    technologies: readonly string[];
  };
}

function countsFor(events: readonly NotificationEvent[]): EngagementCounts {
  return engagementCountsSchema.parse({
    sent: events.filter((event) => event.sentAt !== null).length,
    delivered: events.filter((event) => event.deliveredAt !== null).length,
    opened: events.filter((event) => event.openedAt !== null).length,
    clicked: events.filter((event) => event.clickedAt !== null).length,
    saved: events.filter((event) => event.saved).length,
    applied: events.filter((event) => event.applied).length,
    dismissed: events.filter((event) => event.dismissed).length,
  });
}

const rate = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

// ── Analytics (Part 45) ─────────────────────────────────────────────────────

export function computeNotificationAnalytics(input: {
  candidateId: string;
  events: readonly NotificationEvent[];
  suppressed: number;
  duplicatesSuppressed: number;
  windowDays?: number;
  now?: Date;
}): NotificationAnalytics {
  const overall = countsFor(input.events);

  const groupBy = (
    key: (event: NotificationEvent) => string | null,
  ): Array<{ key: string; counts: EngagementCounts }> => {
    const groups = new Map<string, NotificationEvent[]>();

    for (const event of input.events) {
      const value = key(event);
      if (!value) continue;
      const list = groups.get(value) ?? [];
      list.push(event);
      groups.set(value, list);
    }

    return [...groups.entries()]
      .map(([value, events]) => ({ key: value, counts: countsFor(events) }))
      .sort((a, b) => b.counts.sent - a.counts.sent)
      .slice(0, 40);
  };

  /** Score bands, so alert quality can be read per band. */
  const band = (score: number | null): string | null => {
    if (score === null) return null;
    if (score >= 90) return '90-100';
    if (score >= 80) return '80-89';
    if (score >= 70) return '70-79';
    if (score >= 60) return '60-69';
    return 'under-60';
  };

  const totalConsidered = overall.sent + input.suppressed;

  return notificationAnalyticsSchema.parse({
    candidateId: input.candidateId,
    windowDays: input.windowDays ?? 30,
    overall,
    suppressed: input.suppressed,
    duplicatesSuppressed: input.duplicatesSuppressed,
    deliveryRate: rate(overall.delivered, overall.sent),
    openRate: rate(overall.opened, overall.delivered || overall.sent),
    clickRate: rate(overall.clicked, overall.delivered || overall.sent),
    applicationRate: rate(overall.applied, overall.sent),
    suppressionRate: rate(input.suppressed, totalConsidered),
    byDimension: {
      type: groupBy((event) => event.type),
      company: groupBy((event) => event.facts.companyName),
      source: groupBy((event) => event.facts.sourceId),
      location: groupBy((event) => event.facts.countryCode),
      seniority: groupBy((event) => event.facts.seniority),
      score_band: groupBy((event) => band(event.notificationScore)),
    },
    computedAt: input.now ?? new Date(),
  });
}

// ── Fatigue (Part 28) ───────────────────────────────────────────────────────

/**
 * Whether the candidate is drowning.
 *
 * The advice is phrased as a question, never as a change. Someone receiving
 * thirty-seven alerts and opening eight might be overwhelmed, or might be
 * skimming subject lines perfectly happily and clicking the one that matters —
 * and only they know which. The system's job is to notice and ask.
 */
export function computeFatigue(input: {
  candidateId: string;
  current: readonly NotificationEvent[];
  /** The equivalent window immediately before, for the trend. */
  previous: readonly NotificationEvent[];
  windowDays?: number;
  currentFrequency: string;
  now?: Date;
}): FatigueReport {
  const windowDays = input.windowDays ?? 7;
  const counts = countsFor(input.current);

  const denominator = counts.delivered || counts.sent;
  const openRate = rate(counts.opened, denominator);
  const clickRate = rate(counts.clicked, denominator);

  const sufficientSample = counts.sent >= MIN_NOTIFICATIONS_FOR_INFERENCE;

  // ── Trend ───────────────────────────────────────────────────────────────
  const previous = countsFor(input.previous);
  const previousDenominator = previous.delivered || previous.sent;
  const previousClickRate = rate(previous.clicked, previousDenominator);

  /*
   * Declining engagement needs both windows to be substantial.
   *
   * Comparing this week's three alerts against last week's two produces a
   * dramatic-looking percentage change that means nothing at all.
   */
  const comparable =
    counts.sent >= MIN_NOTIFICATIONS_FOR_INFERENCE &&
    previous.sent >= MIN_NOTIFICATIONS_FOR_INFERENCE;

  const declining =
    comparable &&
    clickRate !== null &&
    previousClickRate !== null &&
    clickRate < previousClickRate * 0.6;

  // ── Advice ──────────────────────────────────────────────────────────────
  const parts: string[] = [];
  let suggestedChange: FatigueReport['suggestedChange'] = null;

  if (!sufficientSample) {
    parts.push(
      `You have had ${counts.sent} notification${counts.sent === 1 ? '' : 's'} in the last ${windowDays} days — ` +
        'not enough to say anything about how they are landing.',
    );
  } else {
    parts.push(
      `You have had ${counts.sent} notifications in the last ${windowDays} days and opened ${counts.opened}, ` +
        `clicking through on ${counts.clicked}.`,
    );

    /*
     * The threshold for suggesting a change is deliberately high.
     *
     * A low click rate is normal — most alerts are for jobs someone reads and
     * decides against, which is the system working. Only a very low rate on a
     * high volume suggests the volume itself is the problem.
     */
    if (clickRate !== null && clickRate < 0.15 && counts.sent >= 25) {
      parts.push('That is a low proportion for the number being sent.');

      suggestedChange = {
        setting: 'digestFrequency',
        from: input.currentFrequency,
        to: input.currentFrequency === 'daily' ? 'weekly' : 'daily',
        rationale:
          'Fewer, fuller digests often get read more carefully than frequent ones. ' +
          'Nothing has been changed — this is only a suggestion.',
      };
    } else if (clickRate !== null && clickRate >= 0.3) {
      parts.push('That is a healthy rate, so nothing looks wrong with the current volume.');
    }

    if (declining) {
      parts.push('Engagement has fallen noticeably against the previous period.');
    }
  }

  parts.push('Open tracking is unreliable, so clicks are the number worth reading.');

  return fatigueReportSchema.parse({
    candidateId: input.candidateId,
    windowDays,
    counts,
    openRate,
    clickRate,
    sufficientSample,
    declining,
    advice: parts.join(' ').slice(0, 600),
    suggestedChange,
    computedAt: input.now ?? new Date(),
  });
}

// ── Calibration (Part 29) ───────────────────────────────────────────────────

/**
 * What the candidate actually engages with.
 *
 * A secondary signal by construction. `conflictsWithExplicit` is computed by
 * the caller — which holds the preferences — and any signal carrying it is
 * reported and then refused by the scorer. Behaviour informs; it does not
 * decide.
 */
export function computeCalibrationSignals(input: {
  events: readonly NotificationEvent[];
  /** Values the candidate has stated explicitly, per dimension. */
  explicit: ReadonlyMap<string, ReadonlySet<string>>;
  minimumSignals?: number;
}): CalibrationSignal[] {
  const minimum = input.minimumSignals ?? MIN_SIGNALS_FOR_CALIBRATION;
  const signals: CalibrationSignal[] = [];

  const dimensions: Array<{ name: string; extract: (event: NotificationEvent) => string[] }> = [
    { name: 'technology', extract: (event) => [...event.facts.technologies].slice(0, 6) },
    { name: 'country', extract: (event) => (event.facts.countryCode ? [event.facts.countryCode] : []) },
    { name: 'company', extract: (event) => (event.facts.companyName ? [event.facts.companyName] : []) },
    { name: 'seniority', extract: (event) => (event.facts.seniority ? [event.facts.seniority] : []) },
  ];

  for (const dimension of dimensions) {
    const groups = new Map<string, NotificationEvent[]>();

    for (const event of input.events) {
      if (event.sentAt === null) continue;
      for (const value of dimension.extract(event)) {
        const list = groups.get(value) ?? [];
        list.push(event);
        groups.set(value, list);
      }
    }

    for (const [value, events] of groups) {
      if (events.length < minimum) continue;

      const counts = countsFor(events);

      /*
       * Affinity from clicks and outcomes, not opens.
       *
       * A save or an application is a much stronger statement than a click, and
       * a dismissal is the clearest negative available — someone actively told
       * the system this was not wanted.
       */
      const positive = counts.clicked + counts.saved * 2 + counts.applied * 3;
      const negative = counts.dismissed * 2;
      const total = positive + negative;

      const affinity = total === 0 ? 0 : Math.max(-1, Math.min(1, (positive - negative) / total));

      const explicitValues = input.explicit.get(dimension.name);
      const stated = explicitValues?.has(value.toLowerCase()) ?? false;

      signals.push(
        calibrationSignalSchema.parse({
          dimension: dimension.name,
          value,
          counts,
          affinity: Math.round(affinity * 100) / 100,
          confidence: Math.min(0.8, events.length / 40),
          // A negative signal on something the candidate explicitly wants is a
          // contradiction worth surfacing and refusing to act on.
          conflictsWithExplicit: stated && affinity < -0.2,
        }),
      );
    }
  }

  return signals.sort((a, b) => Math.abs(b.affinity) - Math.abs(a.affinity)).slice(0, 40);
}

// ── Alert quality (Part 46) ─────────────────────────────────────────────────

export function computeAlertQuality(input: {
  candidateId: string;
  events: readonly NotificationEvent[];
  windowDays?: number;
  now?: Date;
}): AlertQuality {
  const bands = ['90-100', '80-89', '70-79', '60-69', 'under-60'];

  const bandOf = (score: number | null): string | null => {
    if (score === null) return null;
    if (score >= 90) return '90-100';
    if (score >= 80) return '80-89';
    if (score >= 70) return '70-79';
    if (score >= 60) return '60-69';
    return 'under-60';
  };

  const buckets = bands
    .map((band) => {
      const events = input.events.filter((event) => bandOf(event.notificationScore) === band);
      const counts = countsFor(events);

      return {
        band,
        counts,
        /*
         * Precision as "did the interruption lead anywhere".
         *
         * A click, a save or an application all count — the candidate did
         * something with it. An alert that was opened and ignored is not a
         * success, which is why opens are excluded from this number.
         */
        precision:
          counts.sent === 0
            ? null
            : Math.min(1, (counts.clicked + counts.saved + counts.applied) / counts.sent),
        sufficientSample: counts.sent >= MIN_NOTIFICATIONS_FOR_INFERENCE,
      };
    })
    .filter((bucket) => bucket.counts.sent > 0);

  const total = buckets.reduce((sum, bucket) => sum + bucket.counts.sent, 0);
  const usable = buckets.filter((bucket) => bucket.sufficientSample);

  const note =
    total === 0
      ? 'No alerts have been sent yet.'
      : usable.length === 0
        ? `${total} alerts sent, but no score band has the ${MIN_NOTIFICATIONS_FOR_INFERENCE} needed to read precision from it.`
        : `Precision measured across ${usable.length} score band${usable.length === 1 ? '' : 's'} with enough history.`;

  return alertQualitySchema.parse({
    candidateId: input.candidateId,
    windowDays: input.windowDays ?? 30,
    buckets,
    note,
    computedAt: input.now ?? new Date(),
  });
}

// ── Threshold optimisation (Part 47) ────────────────────────────────────────

/**
 * What a different threshold would have done.
 *
 * Replayed from history rather than modelled, which keeps it honest: these are
 * the alerts that were actually sent and the clicks that actually happened, so
 * the counterfactual is arithmetic rather than prediction.
 *
 * Advisory only. The brief is firm that thresholds are never changed
 * automatically, and this exists to make the trade legible — fewer
 * interruptions against the clicks that would have been lost.
 */
export function simulateThresholds(input: {
  candidateId: string;
  events: readonly NotificationEvent[];
  currentThreshold: number;
  candidates?: readonly number[];
  now?: Date;
}): ThresholdSimulation {
  const sent = input.events.filter(
    (event) => event.sentAt !== null && event.notificationScore !== null,
  );

  const totalClicks = sent.filter((event) => event.clickedAt !== null).length;
  const sufficientSample = sent.length >= MIN_NOTIFICATIONS_FOR_INFERENCE;

  const thresholds =
    input.candidates ??
    [input.currentThreshold - 10, input.currentThreshold - 5, input.currentThreshold + 5, input.currentThreshold + 10]
      .filter((value) => value >= 0 && value <= 100);

  const scenarios = thresholds.map((threshold) => {
    const kept = sent.filter((event) => (event.notificationScore ?? 0) >= threshold);
    const keptClicks = kept.filter((event) => event.clickedAt !== null).length;

    const alertsChange =
      sent.length === 0 ? 0 : Math.round(((kept.length - sent.length) / sent.length) * 100);

    const clicksRetainedShare = totalClicks === 0 ? null : keptClicks / totalClicks;

    const summary =
      sent.length === 0
        ? 'No history to replay against.'
        : `At ${threshold}, you would have had ${kept.length} alerts instead of ${sent.length} ` +
          `(${alertsChange >= 0 ? '+' : ''}${alertsChange}%)` +
          (clicksRetainedShare === null
            ? ' — no clicks in the window to compare.'
            : `, keeping about ${Math.round(clicksRetainedShare * 100)}% of your clicks.`);

    return {
      threshold,
      alertsSent: kept.length,
      alertsChange,
      clicksRetained: keptClicks,
      clicksRetainedShare,
      summary: summary.slice(0, 400),
    };
  });

  return thresholdSimulationSchema.parse({
    candidateId: input.candidateId,
    currentThreshold: input.currentThreshold,
    scenarios,
    sufficientSample,
    computedAt: input.now ?? new Date(),
  });
}
