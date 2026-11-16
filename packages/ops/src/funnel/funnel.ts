import type { Funnel, FunnelStep } from '@job-intel/contracts';

/**
 * The discovery-to-shortlist funnel.
 *
 * `10,000 discovered → 14 shortlisted` is only alarming if you cannot see
 * where the other 9,986 went. Each step carries its retention against the previous
 * one, so the place the corpus collapses is a number on the screen rather than
 * something to be inferred.
 *
 * Retention above 1 is possible and is not a bug: matching runs against the
 * whole stored corpus, not only what arrived this hour, so a quiet discovery
 * window can still produce more matches than it discovered. The label says so
 * rather than clamping the number into something misleading.
 */

export interface FunnelCounts {
  discovered: number;
  unique: number;
  enriched: number;
  qualityPassed: number;
  eligible: number;
  matched: number;
  recommended: number;
}

/**
 * `selective: true` marks a step whose narrowness is the *point*.
 *
 * Without this, "biggest drop" always reports the final step: the shortlist is
 * deliberately the most selective thing in the system, so it always removes the
 * largest share. Reporting that every time is noise dressed as a finding — the
 * useful question is where the corpus collapsed *unexpectedly*, which is a
 * question about the processing steps.
 */
const STEPS: Array<{
  key: keyof FunnelCounts;
  label: string;
  detail: string;
  selective?: boolean;
}> = [
  { key: 'discovered', label: 'Discovered', detail: 'raw postings retrieved from sources' },
  { key: 'unique', label: 'Unique', detail: 'after deduplication' },
  { key: 'enriched', label: 'Enriched', detail: 'structured successfully' },
  { key: 'qualityPassed', label: 'Passed quality', detail: 'not scam, not stale, has an application path' },
  { key: 'eligible', label: 'Eligible', detail: 'passed your hard constraints' },
  { key: 'matched', label: 'Matched', detail: 'scored against your profile' },
  {
    key: 'recommended',
    label: 'Recommended',
    detail: 'above your recommendation threshold — these are what the dashboard shows first',
    selective: true,
  },
];

export function buildFunnel(counts: FunnelCounts, windowHours: number, now = new Date()): Funnel {
  const steps: FunnelStep[] = [];
  let previous: number | null = null;

  for (const step of STEPS) {
    const count = Math.max(0, counts[step.key]);
    const retention = previous === null || previous === 0 ? null : count / previous;

    steps.push({
      key: step.key,
      label: step.label,
      count,
      retention: retention === null ? null : Math.round(Math.min(retention, 99) * 1000) / 1000,
      detail:
        retention !== null && retention > 1
          ? `${step.detail} — exceeds the previous step because this stage runs over the whole stored corpus, not only this window`
          : step.detail,
    });

    previous = count;
  }

  return { windowHours, steps, generatedAt: now };
}

const SELECTIVE_KEYS = new Set(STEPS.filter((s) => s.selective).map((s) => s.key as string));

/**
 * The step where the corpus collapsed most, excluding the selection stages.
 *
 * Turns "why am I only getting fourteen jobs?" into "quality analysis removed
 * 64% of what was enriched". Ranking and notification are skipped by default:
 * they are *supposed* to be narrow, so surfacing them would bury the finding
 * that actually needs attention. Pass `includeSelective` to see them anyway.
 */
export function biggestDrop(
  funnel: Funnel,
  options: { includeSelective?: boolean } = {},
): { step: FunnelStep; lost: number } | null {
  let worst: { step: FunnelStep; lost: number } | null = null;

  for (const step of funnel.steps) {
    if (step.retention === null || step.retention >= 1) continue;
    if (!options.includeSelective && SELECTIVE_KEYS.has(step.key)) continue;
    const lost = 1 - step.retention;
    if (!worst || lost > worst.lost) worst = { step, lost };
  }

  return worst;
}
