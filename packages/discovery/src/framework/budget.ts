import {
  discoveryBudgetSchema,
  type BudgetKey,
  type BudgetUsage,
  type DiscoveryBudget,
} from '@job-intel/contracts';

/**
 * Discovery budget enforcement.
 *
 * A budget is only a budget if something checks it *before* spending. This
 * tracker is consulted at each spend point — before a request, before a search
 * API call, before a model call — and returns a refusal the caller must act on.
 *
 * The distinction that matters operationally: running out of budget is a
 * **normal, expected outcome**, not an error. A cycle that stops after 100
 * search calls has done its job correctly. So exhaustion produces a recorded
 * reason and a graceful stop, never an exception, and never a silent
 * continuation.
 */

export interface SpendDecision {
  allowed: boolean;
  reason: string | null;
  /** Remaining allowance after this spend, for logging. */
  remaining: number;
}

export interface BudgetSnapshot {
  budget: DiscoveryBudget;
  usage: BudgetUsage;
  perSourceRequests: Record<string, number>;
  exhausted: BudgetKey[];
  /** Every refusal, so a thin run can be explained afterwards. */
  refusals: Array<{ key: BudgetKey; reason: string; at: Date }>;
}

const LIMIT_FOR: Readonly<Record<BudgetKey, keyof DiscoveryBudget>> = {
  requests: 'maxRequestsPerCycle',
  queries: 'maxQueriesPerHour',
  searchApiCalls: 'maxSearchApiCalls',
  classificationCalls: 'maxClassificationCalls',
  embeddingCalls: 'maxEmbeddingCalls',
  pageFetches: 'maxPageFetches',
  costUsd: 'maxCostUsd',
};

export class DiscoveryBudgetTracker {
  private readonly budget: DiscoveryBudget;
  private readonly usage: BudgetUsage = {
    requests: 0,
    queries: 0,
    searchApiCalls: 0,
    classificationCalls: 0,
    embeddingCalls: 0,
    pageFetches: 0,
    costUsd: 0,
  };
  private readonly perSource = new Map<string, number>();
  private readonly refusals: BudgetSnapshot['refusals'] = [];

  constructor(budget?: Partial<DiscoveryBudget>) {
    this.budget = discoveryBudgetSchema.parse(budget ?? {});
  }

  /**
   * Asks permission to spend, without spending.
   *
   * Separate from `spend` so a caller can check a whole unit of work is
   * affordable before starting it — enqueueing a crawl that will die halfway
   * through its budget wastes the requests it already made.
   */
  check(key: BudgetKey, amount = 1, sourceId?: string): SpendDecision {
    const limit = this.budget[LIMIT_FOR[key]] as number;
    const used = this.usage[key];

    if (used + amount > limit) {
      return {
        allowed: false,
        reason: `${key} budget exhausted: ${used}/${limit} used`,
        remaining: Math.max(0, limit - used),
      };
    }

    if (sourceId && key === 'requests') {
      const sourceUsed = this.perSource.get(sourceId) ?? 0;
      if (sourceUsed + amount > this.budget.maxRequestsPerSource) {
        return {
          allowed: false,
          reason: `per-source request budget exhausted for ${sourceId}: ${sourceUsed}/${this.budget.maxRequestsPerSource}`,
          remaining: Math.max(0, this.budget.maxRequestsPerSource - sourceUsed),
        };
      }
    }

    return { allowed: true, reason: null, remaining: limit - used - amount };
  }

  /** Checks and, if permitted, records. Returns the same decision shape. */
  spend(key: BudgetKey, amount = 1, sourceId?: string): SpendDecision {
    const decision = this.check(key, amount, sourceId);

    if (!decision.allowed) {
      this.refusals.push({ key, reason: decision.reason!, at: new Date() });
      return decision;
    }

    this.usage[key] += amount;
    if (sourceId && key === 'requests') {
      this.perSource.set(sourceId, (this.perSource.get(sourceId) ?? 0) + amount);
    }

    return decision;
  }

  /**
   * Records spend that already happened.
   *
   * The HTTP client counts its own requests, and a connector may make several
   * inside one logical operation. Reconciling afterwards keeps the tracker
   * honest without threading it through every fetch.
   */
  record(key: BudgetKey, amount: number, sourceId?: string): void {
    this.usage[key] += amount;
    if (sourceId && key === 'requests') {
      this.perSource.set(sourceId, (this.perSource.get(sourceId) ?? 0) + amount);
    }
  }

  /** Keys whose allowance is gone. Empty means the cycle ran to completion. */
  exhausted(): BudgetKey[] {
    return (Object.keys(LIMIT_FOR) as BudgetKey[]).filter(
      (key) => this.usage[key] >= (this.budget[LIMIT_FOR[key]] as number),
    );
  }

  /** True when nothing further can usefully be spent. */
  isSpent(): boolean {
    return this.usage.requests >= this.budget.maxRequestsPerCycle ||
      this.usage.costUsd >= this.budget.maxCostUsd;
  }

  snapshot(): BudgetSnapshot {
    return {
      budget: this.budget,
      usage: { ...this.usage },
      perSourceRequests: Object.fromEntries(this.perSource),
      exhausted: this.exhausted(),
      refusals: [...this.refusals],
    };
  }
}
