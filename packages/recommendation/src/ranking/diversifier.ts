import {
  diversificationConfigSchema,
  type DiversificationConfig,
} from '@job-intel/contracts';

/**
 * Diversification.
 *
 * Ten near-identical Senior React Engineer postings from one company are ten
 * copies of one decision. Presenting them as ten recommendations wastes the
 * whole list on a choice the candidate makes once.
 *
 * The mechanism is a **greedy re-rank with a decaying penalty**, not a filter.
 * Nothing is removed; a job that shares a company with earlier picks is pushed
 * down and can still surface if it is genuinely better than the alternatives.
 * That distinction matters — a hard filter would hide the second-best job at
 * the candidate's favourite employer, which is precisely the job they want.
 *
 * Penalties decay with each repetition rather than accumulating linearly: the
 * second job from a company is mildly redundant, the fifth is very, and the
 * tenth is not meaningfully worse than the ninth.
 *
 * Hard caps sit on top as a *heavy additional penalty*, not an exclusion. That
 * distinction was found the hard way: excluding capped items and appending them
 * after everything else banished a company's fourth-best job below fourteen
 * pieces of aggregator filler, which is worse than the crowding the cap exists
 * to prevent. A capped job is demoted into the middle of the list, where it
 * belongs.
 *
 * The total penalty saturates smoothly toward `maxPenalty` rather than being
 * clipped at it. Clipping made every heavily-penalised item tie, at which point
 * ordering silently fell back to raw score — undoing the diversification.
 *
 * **Only the head of the list is diversified.** Greedy re-ranking is O(n²), and
 * over ten thousand jobs that is a hundred million comparisons for the sake of
 * ordering results nobody will scroll to. Beyond `horizon` the tail is appended
 * in score order, which is both correct and free.
 */

export interface DiversifiableItem {
  jobId: string;
  score: number;
  companyKey: string;
  sourceId: string;
  roleKey: string;
  technologies: string[];
}

export interface DiversifiedItem<T extends DiversifiableItem> {
  item: T;
  originalScore: number;
  penalty: number;
  penalizedScore: number;
  reason: string;
  /** Set when the item was held back by a hard cap rather than a penalty. */
  cappedBy: 'company' | 'source' | 'role' | null;
}

interface Counters {
  company: Map<string, number>;
  source: Map<string, number>;
  role: Map<string, number>;
  technology: Map<string, number>;
}

/** 1, 0.6, 0.36 … so repetition matters less the more of it there already is. */
function decayed(base: number, seen: number): number {
  if (seen <= 0) return 0;
  let total = 0;
  for (let i = 0; i < seen; i += 1) total += base * Math.pow(0.6, i);
  return total;
}

export function diversify<T extends DiversifiableItem>(
  items: readonly T[],
  config: Partial<DiversificationConfig> = {},
): Array<DiversifiedItem<T>> {
  const cfg = diversificationConfigSchema.parse(config);

  const sorted = [...items].sort((a, b) => b.score - a.score);
  const pool = sorted.slice(0, cfg.horizon);
  const tail = sorted.slice(cfg.horizon).map((item) => ({
    item,
    originalScore: item.score,
    penalty: 0,
    penalizedScore: item.score,
    reason: `beyond the top ${cfg.horizon}; not diversified`,
    cappedBy: null as null,
  }));
  if (!cfg.enabled) {
    return sorted.map((item) => ({
      item,
      originalScore: item.score,
      penalty: 0,
      penalizedScore: item.score,
      reason: 'diversification disabled',
      cappedBy: null,
    }));
  }

  const counters: Counters = {
    company: new Map(),
    source: new Map(),
    role: new Map(),
    technology: new Map(),
  };

  const selected: Array<DiversifiedItem<T>> = [];
  const remaining = new Set(pool);

  while (remaining.size > 0) {
    let best: DiversifiedItem<T> | null = null;

    for (const item of remaining) {
      const companySeen = counters.company.get(item.companyKey) ?? 0;
      const sourceSeen = counters.source.get(item.sourceId) ?? 0;
      const roleSeen = counters.role.get(item.roleKey) ?? 0;

      const cappedBy =
        companySeen >= cfg.maxPerCompany
          ? ('company' as const)
          : sourceSeen >= cfg.maxPerSource
            ? ('source' as const)
            : roleSeen >= cfg.maxPerRole
              ? ('role' as const)
              : null;

      const techSeen = item.technologies.reduce(
        (max, tech) => Math.max(max, counters.technology.get(tech) ?? 0),
        0,
      );

      const reasons: string[] = [];
      let penalty = 0;

      if (companySeen > 0) {
        penalty += decayed(cfg.companyPenalty, companySeen);
        reasons.push(`${companySeen} earlier pick(s) from this company`);
      }
      if (sourceSeen > 0) {
        penalty += decayed(cfg.sourcePenalty, sourceSeen);
        reasons.push(`${sourceSeen} earlier pick(s) from this source`);
      }
      if (roleSeen > 0) {
        penalty += decayed(cfg.rolePenalty, roleSeen);
        reasons.push(`${roleSeen} earlier pick(s) with this role`);
      }
      if (techSeen > 0) {
        penalty += decayed(cfg.technologyPenalty, techSeen);
        reasons.push('overlapping technology with earlier picks');
      }

      // Hard caps are expressed as penalty, so a capped-but-excellent job
      // still competes rather than being dropped to the end of the list.
      if (cappedBy) {
        penalty += cfg.maxPenalty;
        reasons.push(`per-${cappedBy} cap reached`);
      }

      // Smooth saturation: approaches maxPenalty (or twice it, once a hard cap
      // applies) without ever tying two differently-penalised items together.
      const ceiling = cappedBy ? cfg.maxPenalty * 2 : cfg.maxPenalty;
      penalty = ceiling * (1 - Math.exp(-penalty / Math.max(1, ceiling)));

      const candidate: DiversifiedItem<T> = {
        item,
        originalScore: item.score,
        penalty: Math.round(penalty * 100) / 100,
        penalizedScore: Math.round(Math.max(0, item.score - penalty) * 100) / 100,
        reason: reasons.length === 0 ? 'no overlap with earlier picks' : reasons.join('; '),
        cappedBy,
      };

      if (!best || candidate.penalizedScore > best.penalizedScore) best = candidate;
    }

    // Every remaining item is always a candidate now, so `best` is only null
    // when the pool is empty — which the loop condition already excludes.
    if (!best) break;

    selected.push(best);
    remaining.delete(best.item);

    counters.company.set(best.item.companyKey, (counters.company.get(best.item.companyKey) ?? 0) + 1);
    counters.source.set(best.item.sourceId, (counters.source.get(best.item.sourceId) ?? 0) + 1);
    counters.role.set(best.item.roleKey, (counters.role.get(best.item.roleKey) ?? 0) + 1);
    for (const tech of best.item.technologies) {
      counters.technology.set(tech, (counters.technology.get(tech) ?? 0) + 1);
    }
  }

  return [...selected, ...tail];
}
