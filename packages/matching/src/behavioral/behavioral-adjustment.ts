import type { ComponentScore, LearnedSignal } from '@job-intel/contracts';
import type { ScorerInput } from '../types';
import { clamp, notApplicable, round, score } from '../scoring/util';

/**
 * Behavioural signals.
 *
 * The rule that shapes this whole module: **behaviour informs, it never
 * overrules.** What the candidate clicked is weak evidence about a person who
 * has also told us in words what they want. So this produces a small, bounded
 * nudge applied *after* aggregation, and any signal that contradicts a stated
 * preference is discarded here and surfaced to the candidate elsewhere — the
 * fix for "you keep saving on-site roles but said remote-only" is to ask, not
 * to quietly start recommending on-site work.
 */

/** Dimensions of a job that a learned signal can attach to. */
function jobValues(input: ScorerInput): Record<string, string[]> {
  const e = input.job.enrichment;
  return {
    countries: e.location.countryCode ? [e.location.countryCode] : [],
    workArrangement: e.workArrangement.mode === 'unknown' ? [] : [e.workArrangement.mode],
    companies: input.job.companyName ? [input.job.companyName] : [],
    jobFunction: [e.classification.jobFunction],
    seniority: e.seniority ? [e.seniority] : [],
    technologies: e.skills.map((s) => s.slug),
    industries: e.classification.industries,
  };
}

export interface BehavioralResult {
  component: ComponentScore;
  /** Points to add to the aggregated score, already clamped to the budget. */
  adjustment: number;
  /** Signals ignored because they contradict a stated preference. */
  suppressed: LearnedSignal[];
}

/**
 * @param maxAdjustment Points of headroom, from configuration. Setting it to 0
 *   disables behavioural influence entirely without removing the code path.
 */
export function scoreBehavioral(input: ScorerInput, maxAdjustment: number): BehavioralResult {
  const signals = input.candidate.learnedSignals;
  const suppressed: LearnedSignal[] = [];

  if (signals.length === 0 || maxAdjustment <= 0) {
    return {
      component: notApplicable(
        'behavioral',
        maxAdjustment <= 0 ? 'Behavioural influence is disabled' : 'No behavioural history yet',
      ),
      adjustment: 0,
      suppressed,
    };
  }

  const values = jobValues(input);
  const matched: Array<{ signal: LearnedSignal; value: string }> = [];

  for (const signal of signals) {
    const candidates = values[signal.dimension] ?? [];
    const hit = candidates.find(
      (v) => v.trim().toLowerCase() === signal.value.trim().toLowerCase(),
    );
    if (!hit) continue;
    if (signal.conflictsWithExplicit) {
      suppressed.push(signal);
      continue;
    }
    matched.push({ signal, value: hit });
  }

  if (matched.length === 0) {
    return {
      component: notApplicable(
        'behavioral',
        suppressed.length > 0
          ? `${suppressed.length} behavioural signal(s) ignored: they contradict your stated preferences`
          : 'No behavioural signal applies to this job',
      ),
      adjustment: 0,
      suppressed,
    };
  }

  // Confidence-weighted mean affinity, so twenty observations outweigh two.
  let weighted = 0;
  let weight = 0;
  for (const { signal } of matched) {
    weighted += signal.affinity * signal.confidence;
    weight += signal.confidence;
  }
  const affinity = weight === 0 ? 0 : clamp(weighted / weight, -1, 1);
  const adjustment = round(affinity * maxAdjustment, 2);

  const evidence = matched
    .slice(0, 6)
    .map(
      ({ signal, value }) =>
        `${signal.dimension}:${value} ${signal.affinity > 0 ? '+' : ''}${signal.affinity} ` +
        `(${signal.observations} obs)`,
    );

  return {
    component: score(
      'behavioral',
      // Reported on the same 0-100 scale as every other dimension so the UI can
      // render it uniformly, even though it is applied as an adjustment.
      (affinity + 1) * 50,
      weight / matched.length,
      affinity >= 0
        ? `Your past activity leans towards jobs like this (+${adjustment.toFixed(1)} points)`
        : `Your past activity leans away from jobs like this (${adjustment.toFixed(1)} points)`,
      evidence,
    ),
    adjustment,
    suppressed,
  };
}
