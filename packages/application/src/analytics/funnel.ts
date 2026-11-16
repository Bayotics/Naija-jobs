import {
  INTERVIEW_STATUSES,
  MIN_SAMPLE_FOR_INFERENCE,
  RESPONDED_STATUSES,
  applicationAnalyticsSchema,
  calibrationReportSchema,
  funnelRatesSchema,
  resumePerformanceSchema,
  type ApplicationAnalytics,
  type ApplicationRecommendation,
  type ApplicationRecord,
  type CalibrationReport,
  type FunnelRates,
  type ResumePerformance,
} from '@job-intel/contracts';

/**
 * Application analytics.
 *
 * The whole module is organised around one discipline: **a rate computed from a
 * handful of applications is not a rate.** Someone twelve applications into a
 * job search who sees "8% response rate, Frontend resume outperforming Cloud
 * resume 3:1" will change their strategy on noise, and the change will feel
 * evidence-based.
 *
 * So every funnel carries `sufficientSample`, computed against a threshold the
 * caller can see, and every comparison between resumes refuses to name a winner
 * until both sides clear it. The numbers are always shown — they are the
 * candidate's own history and hiding them would be worse — but the system never
 * draws the conclusion for them until it can.
 */

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

/** Whether an application has had any employer response at all. */
export function hasResponded(record: ApplicationRecord): boolean {
  if (record.firstResponseAt !== null) return true;
  return RESPONDED_STATUSES.includes(record.status);
}

export function reachedInterview(record: ApplicationRecord): boolean {
  return INTERVIEW_STATUSES.includes(record.status);
}

export function computeFunnel(
  records: readonly ApplicationRecord[],
  minSample = MIN_SAMPLE_FOR_INFERENCE,
): FunnelRates {
  const applications = records.length;
  const responses = records.filter(hasResponded).length;
  const interviews = records.filter(reachedInterview).length;
  const offers = records.filter((record) => record.status === 'offer').length;
  const rejections = records.filter((record) => record.status === 'rejected').length;

  const sufficient = applications >= minSample;

  const daysToResponse = records
    .filter((record) => record.firstResponseAt !== null)
    .map(
      (record) =>
        (record.firstResponseAt!.getTime() - record.appliedAt.getTime()) / 86_400_000,
    )
    .filter((days) => days >= 0);

  return funnelRatesSchema.parse({
    applications,
    responses,
    interviews,
    offers,
    rejections,
    /*
     * Rates are computed regardless of sample size and flagged separately.
     *
     * Returning null below the threshold would hide the candidate's own
     * numbers from them, which is patronising. Returning them unflagged would
     * invite a conclusion. Both, labelled, is the honest option.
     */
    responseRate: applications === 0 ? null : responses / applications,
    interviewRate: applications === 0 ? null : interviews / applications,
    offerRate: applications === 0 ? null : offers / applications,
    sufficientSample: sufficient,
    medianDaysToResponse: median(daysToResponse),
  });
}

export interface AnalyticsInput {
  candidateId: string;
  records: readonly ApplicationRecord[];
  /** Job facts needed to split the funnel, keyed by job id. */
  jobFacts: ReadonlyMap<
    string,
    {
      companyName: string | null;
      sourceId: string | null;
      seniority: string | null;
      countryCode: string | null;
      roleSlug: string | null;
    }
  >;
  documentLabels: ReadonlyMap<string, string>;
  now?: Date;
}

/**
 * The funnel, whole and split several ways.
 *
 * Each split carries its own sample flag, because the overall figure clearing
 * the threshold says nothing about whether the four applications sent through
 * one particular source do.
 */
export function computeAnalytics(input: AnalyticsInput): ApplicationAnalytics {
  const groupBy = (
    key: (record: ApplicationRecord) => string | null,
  ): Array<{ key: string; rates: FunnelRates }> => {
    const groups = new Map<string, ApplicationRecord[]>();

    for (const record of input.records) {
      const value = key(record);
      if (!value) continue;
      const list = groups.get(value) ?? [];
      list.push(record);
      groups.set(value, list);
    }

    return [...groups.entries()]
      .map(([value, records]) => ({ key: value, rates: computeFunnel(records) }))
      .sort((a, b) => b.rates.applications - a.rates.applications)
      .slice(0, 40);
  };

  const facts = (record: ApplicationRecord) => input.jobFacts.get(record.jobId) ?? null;

  return applicationAnalyticsSchema.parse({
    candidateId: input.candidateId,
    overall: computeFunnel(input.records),
    byDimension: {
      company: groupBy((record) => facts(record)?.companyName ?? null),
      source: groupBy((record) => facts(record)?.sourceId ?? null),
      seniority: groupBy((record) => facts(record)?.seniority ?? null),
      location: groupBy((record) => facts(record)?.countryCode ?? null),
      role: groupBy((record) => facts(record)?.roleSlug ?? null),
      resume: groupBy((record) =>
        record.documentId ? (input.documentLabels.get(record.documentId) ?? record.documentId) : null,
      ),
      recommendation: groupBy((record) => record.recommendationAtApply),
    },
    computedAt: input.now ?? new Date(),
  });
}

/**
 * Resume performance (Part 43).
 *
 * `comparedToBest` stays null until both the resume in question and the best
 * performer have enough applications to compare. The brief asks for this
 * explicitly and it is the right call: "Frontend resume: 30 applications, 7
 * responses. Full Stack resume: 20 applications, 1 response" looks like a
 * finding, and at those numbers the difference could easily be luck.
 */
export function computeResumePerformance(input: {
  records: readonly ApplicationRecord[];
  documentLabels: ReadonlyMap<string, string>;
  minSample?: number;
}): ResumePerformance[] {
  const minSample = input.minSample ?? MIN_SAMPLE_FOR_INFERENCE;
  const groups = new Map<string, ApplicationRecord[]>();

  for (const record of input.records) {
    if (!record.documentId) continue;
    const list = groups.get(record.documentId) ?? [];
    list.push(record);
    groups.set(record.documentId, list);
  }

  const entries = [...groups.entries()].map(([documentId, records]) => ({
    documentId,
    label: input.documentLabels.get(documentId) ?? 'Unlabelled resume',
    rates: computeFunnel(records, minSample),
  }));

  // The best performer among those with enough data to be called one.
  const comparable = entries.filter((entry) => entry.rates.sufficientSample);
  const best =
    comparable.length > 0
      ? comparable.reduce((top, entry) =>
          (entry.rates.responseRate ?? 0) > (top.rates.responseRate ?? 0) ? entry : top,
        )
      : null;

  return entries
    .map((entry) => {
      const canCompare =
        best !== null && entry.rates.sufficientSample && entry.documentId !== best.documentId;

      const delta =
        canCompare && best.rates.responseRate !== null && entry.rates.responseRate !== null
          ? entry.rates.responseRate - best.rates.responseRate
          : null;

      const note = entry.rates.sufficientSample
        ? entry.documentId === best?.documentId
          ? 'Your best-performing resume so far.'
          : delta === null
            ? 'Enough applications to report, not enough to compare.'
            : `${Math.abs(delta * 100).toFixed(0)} points ${delta >= 0 ? 'above' : 'below'} your best performer.`
        : `Only ${entry.rates.applications} application${entry.rates.applications === 1 ? '' : 's'} — too few to read anything into. ` +
          `${minSample} is roughly where a difference starts to mean something.`;

      return resumePerformanceSchema.parse({
        documentId: entry.documentId,
        label: entry.label,
        rates: entry.rates,
        comparedToBest: delta,
        note,
      });
    })
    .sort((a, b) => b.rates.applications - a.rates.applications);
}

/**
 * Calibration (Part 45).
 *
 * Asks whether the recommendations are any good, using the only ground truth
 * available: what the candidate did, and what happened next.
 *
 * The most valuable row is `appliedAgainstAdviceResponses` — applications the
 * system said to skip that got a response. Those are the system being wrong in
 * the direction that costs the candidate opportunities, and they should be
 * visible rather than buried.
 */
export function computeCalibration(input: {
  candidateId: string;
  /** Every recommendation made, with what the candidate did about it. */
  decisions: ReadonlyArray<{
    recommendation: ApplicationRecommendation;
    applied: boolean;
    skipped: boolean;
    responded: boolean;
    interviewed: boolean;
  }>;
  minSample?: number;
  now?: Date;
}): CalibrationReport {
  const minSample = input.minSample ?? MIN_SAMPLE_FOR_INFERENCE;
  const byRecommendation = new Map<ApplicationRecommendation, typeof input.decisions[number][]>();

  for (const decision of input.decisions) {
    const list = byRecommendation.get(decision.recommendation) ?? [];
    list.push(decision);
    byRecommendation.set(decision.recommendation, list);
  }

  const buckets = [...byRecommendation.entries()].map(([recommendation, decisions]) => {
    const applied = decisions.filter((entry) => entry.applied).length;

    return {
      recommendation,
      recommended: decisions.length,
      applied,
      skipped: decisions.filter((entry) => entry.skipped).length,
      responses: decisions.filter((entry) => entry.responded).length,
      interviews: decisions.filter((entry) => entry.interviewed).length,
      followRate: decisions.length === 0 ? null : applied / decisions.length,
      sufficientSample: decisions.length >= minSample,
    };
  });

  const against = input.decisions.filter(
    (entry) => entry.applied && (entry.recommendation === 'SKIP' || entry.recommendation === 'BLOCKED'),
  );

  const againstResponses = against.filter((entry) => entry.responded).length;

  const notes: string[] = [];

  if (against.length > 0) {
    notes.push(
      `You applied to ${against.length} job${against.length === 1 ? '' : 's'} this system advised against` +
        (againstResponses > 0
          ? `, and ${againstResponses} got a response. That is worth knowing — the recommendation was wrong there.`
          : '.'),
    );
  }

  const thin = buckets.filter((bucket) => !bucket.sufficientSample);
  if (thin.length > 0) {
    notes.push(
      `${thin.length} recommendation band${thin.length === 1 ? ' has' : 's have'} fewer than ${minSample} decisions, ` +
        'so their follow rates are not yet meaningful.',
    );
  }

  return calibrationReportSchema.parse({
    candidateId: input.candidateId,
    buckets,
    appliedAgainstAdvice: against.length,
    appliedAgainstAdviceResponses: againstResponses,
    note: notes.join(' '),
    computedAt: input.now ?? new Date(),
  });
}

/**
 * Skill gaps that keep recurring across a candidate's opportunities.
 *
 * Counted across the requirements the profile could not answer, so the output
 * is "eleven of your last forty jobs asked for Kubernetes and your profile does
 * not mention it" — which is a learning plan, not a rejection.
 */
export function commonGaps(
  perJobUnknowns: ReadonlyArray<{ jobId: string; requirements: readonly string[] }>,
  limit = 15,
): Array<{ requirement: string; jobs: number; share: number }> {
  const counts = new Map<string, number>();

  for (const entry of perJobUnknowns) {
    // Counted once per job: a posting that names Kubernetes four times is one
    // job that wants Kubernetes.
    for (const requirement of new Set(entry.requirements)) {
      counts.set(requirement, (counts.get(requirement) ?? 0) + 1);
    }
  }

  const total = Math.max(1, perJobUnknowns.length);

  return [...counts.entries()]
    .map(([requirement, jobs]) => ({
      requirement,
      jobs,
      share: Math.round((jobs / total) * 100) / 100,
    }))
    .sort((a, b) => b.jobs - a.jobs)
    .slice(0, limit);
}
