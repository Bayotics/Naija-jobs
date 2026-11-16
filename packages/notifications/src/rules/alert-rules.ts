import {
  PRIORITY_RANK,
  type AlertPriority,
  type AlertRule,
  type AlertRuleCondition,
  type AlertRuleMatch,
  type RuleField,
  type RuleFlag,
} from '@job-intel/contracts';

/**
 * Alert rules.
 *
 * Configurable thresholds, evaluated against a fixed vocabulary of structured
 * facts. Deliberately **not** an expression language: a rule DSL loaded from
 * stored configuration and evaluated at runtime is an injection surface, and
 * every rule anyone has actually asked for — "95 and confident and verified",
 * "98 and sponsorship and salary" — is a conjunction of comparisons.
 *
 * Rules are additive. Several can match; the highest priority wins, and each
 * match records exactly which conditions it satisfied so a surprising alert is
 * traceable to the rule that fired it.
 */

/** The structured facts a rule may compare against. */
export interface AlertFacts {
  recommendationScore: number;
  matchScore: number;
  confidence: number;
  qualityScore: number;
  freshnessHours: number;
  salaryAnnualUsd: number | null;
  scamRisk: number;

  applicationUrlVerified: boolean;
  applicationUrlPresent: boolean;
  visaSponsorshipOffered: boolean;
  salaryMeetsTarget: boolean;
  remote: boolean;
  lifecycleActive: boolean;
  fromAuthoritativeSource: boolean;

  sourceId: string;
}

function fieldValue(facts: AlertFacts, field: RuleField): number | null {
  switch (field) {
    case 'recommendationScore':
      return facts.recommendationScore;
    case 'matchScore':
      return facts.matchScore;
    case 'confidence':
      return facts.confidence;
    case 'qualityScore':
      return facts.qualityScore;
    case 'freshnessHours':
      return facts.freshnessHours;
    case 'salaryAnnualUsd':
      return facts.salaryAnnualUsd;
    case 'scamRisk':
      return facts.scamRisk;
    default:
      return null;
  }
}

function flagValue(facts: AlertFacts, flag: RuleFlag): boolean {
  return facts[flag];
}

function describe(condition: AlertRuleCondition, actual: number): string {
  const symbol = { gte: '≥', lte: '≤', gt: '>', lt: '<', eq: '=' }[condition.operator];
  const format = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  return `${condition.field} ${format(actual)} ${symbol} ${format(condition.value)}`;
}

function satisfies(condition: AlertRuleCondition, actual: number): boolean {
  switch (condition.operator) {
    case 'gte':
      return actual >= condition.value;
    case 'lte':
      return actual <= condition.value;
    case 'gt':
      return actual > condition.value;
    case 'lt':
      return actual < condition.value;
    case 'eq':
      return actual === condition.value;
    default:
      return false;
  }
}

export interface RuleEvaluation {
  /** The winning rule, or null when nothing fired. */
  match: AlertRuleMatch | null;
  /** Every rule that fired, strongest first. */
  matches: AlertRuleMatch[];
  /** Why each non-matching rule did not fire — the debugging half. */
  rejections: Array<{ ruleId: string; reason: string }>;
}

/**
 * Evaluates every rule.
 *
 * A missing numeric fact (an unstated salary, say) fails its condition rather
 * than being skipped. A rule reading "salary ≥ 150000" must not fire on a job
 * whose salary is unknown — that is exactly the false-positive an alert channel
 * cannot afford.
 */
export function evaluateAlertRules(
  facts: AlertFacts,
  rules: readonly AlertRule[],
): RuleEvaluation {
  const matches: AlertRuleMatch[] = [];
  const rejections: Array<{ ruleId: string; reason: string }> = [];

  for (const rule of rules) {
    if (!rule.enabled) {
      rejections.push({ ruleId: rule.id, reason: 'rule disabled' });
      continue;
    }

    if (rule.sourceIds.length > 0 && !rule.sourceIds.includes(facts.sourceId)) {
      rejections.push({
        ruleId: rule.id,
        reason: `restricted to ${rule.sourceIds.join(', ')}; job came from ${facts.sourceId}`,
      });
      continue;
    }

    const satisfied: string[] = [];
    let failure: string | null = null;

    for (const condition of rule.conditions) {
      const actual = fieldValue(facts, condition.field);
      if (actual === null) {
        failure = `${condition.field} is not stated for this job`;
        break;
      }
      if (!satisfies(condition, actual)) {
        failure = describe(condition, actual).replace('≥', '<').replace('≤', '>');
        break;
      }
      satisfied.push(describe(condition, actual));
    }

    if (!failure) {
      for (const flag of rule.requireFlags) {
        if (!flagValue(facts, flag)) {
          failure = `${flag} is not true`;
          break;
        }
        satisfied.push(flag);
      }
    }

    if (!failure) {
      for (const flag of rule.forbidFlags) {
        if (flagValue(facts, flag)) {
          failure = `${flag} is true but the rule forbids it`;
          break;
        }
      }
    }

    if (failure) {
      rejections.push({ ruleId: rule.id, reason: failure });
      continue;
    }

    matches.push({
      ruleId: rule.id,
      ruleName: rule.name,
      priority: rule.priority,
      overridesQuietHours: rule.overridesQuietHours,
      matched: satisfied,
    });
  }

  matches.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
  return { match: matches[0] ?? null, matches, rejections };
}

/**
 * Priority for a job no rule matched.
 *
 * Used for digest entries, which still carry a priority so the renderer can
 * order sections. Thresholds sit beside the tiers the ranking layer produced
 * rather than duplicating them.
 */
export function priorityForScore(
  recommendationScore: number,
  thresholds: { urgent: number; high: number; normal: number } = {
    urgent: 92,
    high: 84,
    normal: 70,
  },
): AlertPriority {
  if (recommendationScore >= thresholds.urgent) return 'URGENT';
  if (recommendationScore >= thresholds.high) return 'HIGH';
  if (recommendationScore >= thresholds.normal) return 'NORMAL';
  return 'LOW';
}
