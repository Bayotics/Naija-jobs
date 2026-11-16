import {
  EVENT_POLARITY,
  type BehavioralEvent,
  type CandidatePreferences,
  type LearnedSignal,
  type WeightedPreference,
} from '@job-intel/contracts';

/**
 * Behavioural learning.
 *
 * The governing rule: **learned signals never become preferences.** They live
 * in their own store, are computed on read, and can be surfaced as suggestions
 * — but only an explicit action by the candidate writes to
 * `candidate_preferences`. One click must never silently rewrite what someone
 * told the system.
 *
 * The aggregation is deliberately simple and explainable: a polarity-weighted
 * average per (dimension, value), with confidence rising as observations
 * accumulate. Anything cleverer would be harder to justify to the person whose
 * preferences it is second-guessing.
 */

export interface ObservedEvent {
  event: BehavioralEvent;
  /** The job's structured attributes at the time of the event. */
  attributes: {
    countryCode: string | null;
    workMode: string | null;
    companyName: string | null;
    jobFunction: string | null;
    seniority: string | null;
    technologies: readonly string[];
    industries: readonly string[];
  };
  occurredAt: Date;
}

export interface AggregationOptions {
  /** Events below this count produce a signal, but a low-confidence one. */
  minObservations?: number;
  /** Older events count less; this is the half-life in days. */
  halfLifeDays?: number;
  now?: Date;
}

/**
 * Turns raw events into per-value affinities.
 *
 * Recency decay matters: a candidate who spent March saving fintech roles and
 * has ignored them since is not still a fintech candidate, and an undecayed
 * average would keep insisting they are.
 */
export function aggregateSignals(
  events: readonly ObservedEvent[],
  preferences: CandidatePreferences,
  options: AggregationOptions = {},
): LearnedSignal[] {
  const minObservations = options.minObservations ?? 3;
  const halfLifeDays = options.halfLifeDays ?? 60;
  const now = options.now ?? new Date();

  const buckets = new Map<string, { weighted: number; weight: number; count: number }>();

  const record = (dimension: string, value: string | null, polarity: number, decay: number): void => {
    if (!value) return;
    const key = `${dimension}::${value}`;
    const bucket = buckets.get(key) ?? { weighted: 0, weight: 0, count: 0 };
    bucket.weighted += polarity * decay;
    bucket.weight += decay;
    bucket.count += 1;
    buckets.set(key, bucket);
  };

  for (const event of events) {
    const polarity = EVENT_POLARITY[event.event] ?? 0;
    if (polarity === 0) continue;

    const ageDays = Math.max(0, (now.getTime() - event.occurredAt.getTime()) / 86_400_000);
    const decay = Math.pow(0.5, ageDays / halfLifeDays);

    record('countries', event.attributes.countryCode, polarity, decay);
    record('workArrangement', event.attributes.workMode, polarity, decay);
    record('companies', event.attributes.companyName, polarity, decay);
    record('jobFunction', event.attributes.jobFunction, polarity, decay);
    record('seniority', event.attributes.seniority, polarity, decay);
    for (const tech of event.attributes.technologies) record('technologies', tech, polarity, decay);
    for (const industry of event.attributes.industries) record('industries', industry, polarity, decay);
  }

  const signals: LearnedSignal[] = [];
  for (const [key, bucket] of buckets) {
    const [dimension, value] = key.split('::');
    if (!dimension || !value || bucket.weight === 0) continue;

    const affinity = clamp(bucket.weighted / bucket.weight, -1, 1);
    // Confidence saturates: 3 observations is weak, 20 is about as sure as this
    // method can justify.
    const confidence = clamp(bucket.count / 20, 0, 1) * (bucket.count >= minObservations ? 1 : 0.4);

    signals.push({
      dimension,
      value,
      affinity: round(affinity),
      observations: bucket.count,
      confidence: round(confidence),
      conflictsWithExplicit: conflicts(dimension, value, affinity, preferences),
    });
  }

  return signals.sort((a, b) => Math.abs(b.affinity) * b.confidence - Math.abs(a.affinity) * a.confidence);
}

/**
 * Whether a learned signal contradicts what the candidate explicitly said.
 *
 * Surfaced rather than acted on. "You keep saving on-site roles but told us
 * remote-only" is useful information for the candidate; silently flipping the
 * preference would not be.
 */
function conflicts(
  dimension: string,
  value: string,
  affinity: number,
  preferences: CandidatePreferences,
): boolean {
  const lists: Record<string, readonly WeightedPreference[]> = {
    countries: preferences.countries,
    companies: preferences.companies,
    technologies: preferences.technologies,
    industries: preferences.industries,
  };
  const list = lists[dimension];
  if (list) {
    const explicit = list.find((p) => p.value.trim().toLowerCase() === value.trim().toLowerCase());
    if (!explicit) return false;
    const positive = ['required', 'strongly_preferred', 'preferred'].includes(explicit.strength);
    const negative = ['undesirable', 'excluded'].includes(explicit.strength);
    return (positive && affinity < -0.3) || (negative && affinity > 0.3);
  }

  if (dimension === 'workArrangement') {
    const p = preferences.workArrangement;
    if (p === 'REMOTE_ONLY' && value === 'onsite' && affinity > 0.3) return true;
    if (p === 'ONSITE_PREFERRED' && value === 'remote' && affinity > 0.3) return true;
  }
  return false;
}

/**
 * Turns strong learned signals into *suggestions* the UI can offer.
 *
 * Returns proposals in the same shape the natural-language layer produces, so
 * they flow through the identical validate-then-confirm path. Nothing is
 * applied here.
 */
export function suggestFromSignals(
  signals: readonly LearnedSignal[],
  preferences: CandidatePreferences,
  options: { minConfidence?: number; minAffinity?: number } = {},
): Array<{ path: string; operation: 'add'; value: unknown; summary: string; confidence: number }> {
  const minConfidence = options.minConfidence ?? 0.5;
  const minAffinity = options.minAffinity ?? 0.5;

  const dimensions = new Set(['countries', 'technologies', 'industries', 'companies']);

  return signals
    .filter(
      (s) =>
        dimensions.has(s.dimension) &&
        s.confidence >= minConfidence &&
        Math.abs(s.affinity) >= minAffinity,
    )
    .filter((s) => {
      // Never suggest something the candidate already stated an opinion on.
      const list = (preferences as unknown as Record<string, WeightedPreference[]>)[s.dimension];
      return !list?.some((p) => p.value.trim().toLowerCase() === s.value.trim().toLowerCase());
    })
    .slice(0, 10)
    .map((s) => ({
      path: s.dimension,
      operation: 'add' as const,
      value: {
        value: s.value,
        strength: s.affinity > 0 ? 'preferred' : 'undesirable',
        hard: false,
        note: `Suggested from ${s.observations} interactions`,
        // Marked `suggested`, never `explicit`, so provenance survives.
        source: 'suggested',
      },
      summary:
        s.affinity > 0
          ? `You have engaged positively with ${s.value} ${s.observations} times — add it as preferred?`
          : `You have repeatedly dismissed ${s.value} — mark it undesirable?`,
      confidence: s.confidence,
    }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
