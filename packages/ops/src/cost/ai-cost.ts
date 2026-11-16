import {
  type AiCostSummary,
  type AiOperation,
  type AiUsageRecord,
  type ModelPrice,
} from '@job-intel/contracts';

/**
 * AI cost accounting.
 *
 * Pricing is **configuration, not code**. Providers change their rates, and a
 * hardcoded number produces a cost dashboard that is quietly wrong for months.
 * So prices are stored with an effective date and looked up against the moment
 * the usage occurred — an old row keeps costing what it actually cost, and a
 * price change does not retroactively rewrite history.
 *
 * The seed table below is a *default*, clearly dated, meant to be overridden
 * from `app_config`. It is not a source of truth about anyone's pricing.
 */

/** Indicative seed prices, USD per million tokens. Override in configuration. */
export const DEFAULT_MODEL_PRICES: ModelPrice[] = [
  {
    model: 'claude-opus-5',
    provider: 'anthropic',
    inputPerMillion: 15,
    outputPerMillion: 75,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    note: 'seed default — override in app_config',
  },
  {
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    inputPerMillion: 3,
    outputPerMillion: 15,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    note: 'seed default — override in app_config',
  },
  {
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    inputPerMillion: 1,
    outputPerMillion: 5,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    note: 'seed default — override in app_config',
  },
  {
    model: 'text-embedding-3-small',
    provider: 'openai',
    inputPerMillion: 0.02,
    outputPerMillion: 0,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    note: 'seed default — override in app_config',
  },
  {
    model: 'hashing-local-1536',
    provider: 'local',
    inputPerMillion: 0,
    outputPerMillion: 0,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    note: 'local stand-in; costs nothing',
  },
];

/**
 * The price in force for a model at a moment.
 *
 * Returns null for an unknown model rather than guessing. A fabricated rate is
 * worse than a visible gap: the gap prompts someone to add the price, the guess
 * silently understates the bill.
 */
export function priceFor(
  model: string,
  at: Date,
  prices: readonly ModelPrice[] = DEFAULT_MODEL_PRICES,
): ModelPrice | null {
  const candidates = prices
    .filter((p) => p.model === model && p.effectiveFrom.getTime() <= at.getTime())
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  return candidates[0] ?? null;
}

export interface CostResult {
  costUsd: number;
  priced: boolean;
  detail: string;
}

export function computeCost(
  input: { model: string; inputTokens: number; outputTokens: number; at: Date },
  prices: readonly ModelPrice[] = DEFAULT_MODEL_PRICES,
): CostResult {
  const price = priceFor(input.model, input.at, prices);
  if (!price) {
    return {
      costUsd: 0,
      priced: false,
      detail: `No price configured for ${input.model}; cost reported as unknown rather than guessed`,
    };
  }

  const cost =
    (input.inputTokens / 1_000_000) * price.inputPerMillion +
    (input.outputTokens / 1_000_000) * price.outputPerMillion;

  return {
    costUsd: Math.round(cost * 1_000_000) / 1_000_000,
    priced: true,
    detail: `${price.provider}/${price.model} at $${price.inputPerMillion}/$${price.outputPerMillion} per million`,
  };
}

export interface CostSummaryInput {
  records: readonly AiUsageRecord[];
  windowHours: number;
  dailyBudgetUsd?: number | null;
}

export function summariseCost(input: CostSummaryInput): AiCostSummary {
  const byOperation: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const byDayMap = new Map<string, number>();

  let totalCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  for (const record of input.records) {
    totalCalls += record.calls;
    totalInputTokens += record.inputTokens;
    totalOutputTokens += record.outputTokens;
    totalCostUsd += record.costUsd;

    byOperation[record.operation] = (byOperation[record.operation] ?? 0) + record.costUsd;
    byModel[record.model] = (byModel[record.model] ?? 0) + record.costUsd;

    const day = record.occurredAt.toISOString().slice(0, 10);
    byDayMap.set(day, (byDayMap.get(day) ?? 0) + record.costUsd);
  }

  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

  return {
    windowHours: input.windowHours,
    totalCalls,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd: round(totalCostUsd),
    byOperation: Object.fromEntries(Object.entries(byOperation).map(([k, v]) => [k, round(v)])),
    byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, round(v)])),
    byDay: [...byDayMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, costUsd]) => ({ day, costUsd: round(costUsd) })),
    dailyBudgetUsd: input.dailyBudgetUsd ?? null,
  };
}

/** Which pipeline stage an operation belongs to, for cost attribution. */
export const OPERATION_STAGE: Readonly<Record<AiOperation, string>> = {
  enrichment_extraction: 'enrichment',
  match_reasoning: 'matching',
  scam_reasoning: 'quality',
  embedding: 'matching',
  preference_parsing: 'configuration',
  other: 'other',
};

/**
 * Whether spending has passed a configured ceiling.
 *
 * Reported rather than enforced here — the budget guard lives with the callers
 * that spend, and a cost dashboard that silently disabled the AI layer would be
 * a surprising place for that decision to live.
 */
export function budgetStatus(
  spentTodayUsd: number,
  dailyBudgetUsd: number | null,
): { status: 'ok' | 'warning' | 'exceeded'; share: number; detail: string } {
  if (dailyBudgetUsd === null || dailyBudgetUsd <= 0) {
    return { status: 'ok', share: 0, detail: 'No daily budget configured' };
  }

  const share = spentTodayUsd / dailyBudgetUsd;
  if (share >= 1) {
    return {
      status: 'exceeded',
      share,
      detail: `$${spentTodayUsd.toFixed(4)} spent against a $${dailyBudgetUsd} daily budget`,
    };
  }
  if (share >= 0.8) {
    return {
      status: 'warning',
      share,
      detail: `${Math.round(share * 100)}% of today's $${dailyBudgetUsd} budget used`,
    };
  }
  return {
    status: 'ok',
    share,
    detail: `${Math.round(share * 100)}% of today's $${dailyBudgetUsd} budget used`,
  };
}
