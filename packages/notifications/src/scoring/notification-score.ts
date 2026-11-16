import {
  DEFAULT_SCORE_WEIGHTS,
  URGENCY_RANK,
  deadlineAssessmentSchema,
  notificationScoreSchema,
  opportunityValueSchema,
  rarityAssessmentSchema,
  type ApplicationRecommendation,
  type ClosingRisk,
  type DeadlineAssessment,
  type DeadlineBucket,
  type NotificationIntelligenceConfig,
  type NotificationScore,
  type NotificationScoreFactor,
  type OpportunityValue,
  type RarityAssessment,
  type UrgencyLevel,
} from '@job-intel/contracts';

/**
 * The notification score.
 *
 * A third number, deliberately, alongside match score and application value.
 * Each answers a different question:
 *
 *   match       — does this job suit this person?
 *   application — is applying worth an hour?
 *   notification — is this worth interrupting them for, right now?
 *
 * The third depends on things the first two do not consider at all: how rare
 * the combination is, whether it is about to close, what was sent this morning,
 * and how much attention the candidate has left. A job can be a 95% match and
 * not worth an email, because they were emailed about four just like it
 * yesterday.
 *
 * The aggregation is a weighted mean over *applicable* factors, not an average
 * over all of them. A posting with no salary should not be scored as paying
 * badly, and the same reasoning applies to every factor here — silence drops
 * out of the denominator rather than counting as zero.
 */

export interface ScoringInput {
  /** 0–100 from the matching engine. Read, never written. */
  matchScore: number | null;
  matchConfidence: number | null;
  /** 0–100 from the application intelligence layer. */
  applicationValueScore: number | null;
  recommendation: ApplicationRecommendation | null;

  /** 0–1 from the enrichment layer. */
  jobQuality: number | null;
  scamRisk: number | null;
  /** How long ago the posting appeared. */
  freshnessHours: number | null;

  salaryAnnualUsd: number | null;
  candidateSalaryTarget: number | null;

  /** 0–100 career alignment from application intelligence. */
  careerAlignment: number | null;
  careerAlignmentApplicable: boolean;

  /** -1..1, and bounded downstream. Never decisive. */
  behavioralAffinity: number | null;
  behavioralConflictsWithExplicit: boolean;

  /** 0–100 friction. Inverted when scored: less effort is more value. */
  frictionScore: number | null;
  /** LOW / MEDIUM / HIGH / UNKNOWN from the competitiveness assessment. */
  competition: string | null;
  /** 0–1 source authority. */
  sourceQuality: number | null;

  deadline: DeadlineAssessment;
  rarity: RarityAssessment;

  /** Matched favourites, already resolved by the caller. */
  favouriteBoosts: Array<{ label: string; points: number }>;

  /** Alerts already sent in the rolling day. Drives the history penalty. */
  alertsSentToday: number;
  maxAlertsPerDay: number;

  config: NotificationIntelligenceConfig;
}

interface FactorInput {
  factor: NotificationScoreFactor;
  raw: number | null;
  detail: string;
}

const clamp = (value: number, min = 0, max = 100): number =>
  Math.max(min, Math.min(max, value));

/** Maps a recommendation onto a 0–100 contribution. */
function recommendationScore(recommendation: ApplicationRecommendation | null): number | null {
  if (recommendation === null) return null;

  switch (recommendation) {
    case 'APPLY_NOW':
      return 100;
    case 'APPLY':
      return 85;
    case 'CONSIDER':
      return 55;
    case 'SKIP':
      return 10;
    /*
     * Blocked and unknown score at the floor rather than dropping out.
     *
     * A blocked job is a real answer — the candidate cannot be hired for it —
     * and letting it become inapplicable would remove the strongest available
     * evidence against sending an email about it.
     */
    case 'BLOCKED':
      return 0;
    default:
      return 20;
  }
}

/**
 * Freshness, curved.
 *
 * A job twenty minutes old is genuinely more actionable than one from last
 * week, and the curve is steep early for that reason. But it flattens rather
 * than falling to zero: plenty of good roles stay open for a month, and a
 * freshness factor that decays to nothing would quietly bury them.
 */
function freshnessScore(hours: number | null): number | null {
  if (hours === null) return null;
  if (hours <= 1) return 100;
  if (hours <= 6) return 92;
  if (hours <= 24) return 82;
  if (hours <= 72) return 68;
  if (hours <= 168) return 52;
  if (hours <= 336) return 40;
  return 32;
}

/** Deadline pressure as a 0–100 contribution. */
function deadlineScore(bucket: DeadlineBucket, risk: ClosingRisk): number | null {
  switch (bucket) {
    case 'expired':
      return 0;
    case 'under_24h':
      return 100;
    case 'one_to_three_days':
      return 88;
    case 'three_to_seven_days':
      return 70;
    case 'over_seven_days':
      return 45;
    default:
      // No stated deadline. Fall back to the estimate, which is usually UNKNOWN
      // and therefore drops out of the score entirely.
      if (risk === 'HIGH') return 62;
      if (risk === 'MEDIUM') return 48;
      if (risk === 'LOW') return 35;
      return null;
  }
}

function salaryScore(actual: number | null, target: number | null): number | null {
  if (actual === null) return null;
  if (target === null || target <= 0) return 55;

  const ratio = actual / target;
  if (ratio >= 1.25) return 100;
  if (ratio >= 1.05) return 88;
  if (ratio >= 0.95) return 72;
  if (ratio >= 0.8) return 50;
  return 25;
}

function competitionScore(level: string | null): number | null {
  if (level === null || level === 'UNKNOWN') return null;
  // Less competition is more worth hearing about early.
  if (level === 'LOW') return 85;
  if (level === 'MEDIUM') return 55;
  return 30;
}

/**
 * How much has already been sent today.
 *
 * The only factor that is purely about the candidate's attention rather than
 * the job. It enters as a penalty: the fifth alert of the day has to be better
 * than the first to be worth sending, because by then the marginal value of an
 * interruption has fallen and the marginal cost has not.
 */
function historyScore(sentToday: number, maxPerDay: number): number | null {
  if (maxPerDay <= 0) return null;
  const used = sentToday / maxPerDay;
  if (used <= 0.2) return 100;
  if (used <= 0.5) return 80;
  if (used <= 0.8) return 55;
  if (used < 1) return 30;
  return 0;
}

/**
 * Opportunity value (Part 6).
 *
 * Deliberately a narrower question than the application layer's value score:
 * *is this worth knowing about*, not *is this worth an hour*. A stretch role
 * with a long application form scores lower there and can score well here.
 */
export function computeOpportunityValue(input: ScoringInput): OpportunityValue {
  const components: OpportunityValue['components'] = [];

  const add = (
    name: string,
    score: number | null,
    weight: number,
    detail: string,
  ): void => {
    components.push({
      name,
      score: score === null ? 0 : clamp(score),
      weight,
      applicable: score !== null,
      detail: detail.slice(0, 300),
    });
  };

  add('fit', input.matchScore, 30, input.matchScore === null ? 'Not matched yet.' : `Match score ${Math.round(input.matchScore)}.`);
  add(
    'career_relevance',
    input.careerAlignmentApplicable ? input.careerAlignment : null,
    20,
    input.careerAlignmentApplicable ? 'Career alignment from your trajectory.' : 'Career direction could not be assessed.',
  );
  add(
    'compensation',
    salaryScore(input.salaryAnnualUsd, input.candidateSalaryTarget),
    15,
    input.salaryAnnualUsd === null ? 'No salary stated.' : 'Compared against your target.',
  );
  add(
    'application_value',
    input.applicationValueScore,
    20,
    input.applicationValueScore === null ? 'Not analysed yet.' : 'From the application analysis.',
  );
  add(
    'job_quality',
    input.jobQuality === null ? null : input.jobQuality * 100,
    15,
    input.jobQuality === null ? 'Posting not enriched.' : 'Completeness and specificity of the posting.',
  );

  const applicable = components.filter((entry) => entry.applicable);
  const totalWeight = applicable.reduce((sum, entry) => sum + entry.weight, 0);

  const score =
    totalWeight === 0
      ? 0
      : applicable.reduce((sum, entry) => sum + entry.score * entry.weight, 0) / totalWeight;

  /*
   * Confidence tracks how much of the picture was available.
   *
   * A value score resting on two of five components is a guess, and the caller
   * needs to be able to tell that from one resting on all five.
   */
  const coverage = components.length === 0 ? 0 : applicable.length / components.length;

  return opportunityValueSchema.parse({
    score: Math.round(score),
    components,
    confidence: Math.round(coverage * (input.matchConfidence ?? 0.5) * 100) / 100,
    explanation:
      applicable.length === 0
        ? 'Nothing is known about this opportunity yet.'
        : `Built from ${applicable.length} of ${components.length} components: ${applicable
            .map((entry) => entry.name.replace(/_/g, ' '))
            .join(', ')}.`,
  });
}

/**
 * Urgency (Part 5).
 *
 * Independent of quality by construction — it reads the clock, not the fit.
 * `CRITICAL` additionally requires the opportunity to be worth the interruption,
 * because the whole point of a level that can wake someone at 3am is that it
 * almost never does.
 */
export function computeUrgency(input: {
  deadline: DeadlineAssessment;
  freshnessHours: number | null;
  opportunityValue: number;
  recommendation: ApplicationRecommendation | null;
}): { urgency: UrgencyLevel; reason: string } {
  const { deadline } = input;

  if (deadline.bucket === 'expired') {
    return { urgency: 'LOW', reason: 'This posting has closed.' };
  }

  const strong = input.opportunityValue >= 70 && input.recommendation !== 'SKIP' && input.recommendation !== 'BLOCKED';

  if (deadline.bucket === 'under_24h') {
    return strong
      ? { urgency: 'CRITICAL', reason: 'Strong opportunity closing within 24 hours.' }
      : { urgency: 'HIGH', reason: 'Closes within 24 hours.' };
  }

  if (deadline.bucket === 'one_to_three_days') {
    return strong
      ? { urgency: 'CRITICAL', reason: 'Strong opportunity closing within three days.' }
      : { urgency: 'HIGH', reason: 'Closes within three days.' };
  }

  if (deadline.bucket === 'three_to_seven_days') {
    return { urgency: strong ? 'HIGH' : 'MEDIUM', reason: 'Closes within a week.' };
  }

  /*
   * No deadline. Closing risk can still raise urgency, but never to CRITICAL —
   * that level is reserved for something the system actually knows, and closing
   * risk is an inference from job age and source behaviour.
   */
  if (deadline.closingRisk === 'HIGH' && deadline.closingRiskConfidence >= 0.4) {
    return { urgency: strong ? 'HIGH' : 'MEDIUM', reason: deadline.explanation || 'Likely to close soon.' };
  }

  if (input.freshnessHours !== null && input.freshnessHours <= 6 && strong) {
    return { urgency: 'MEDIUM', reason: 'Strong opportunity, posted in the last few hours.' };
  }

  return { urgency: 'LOW', reason: 'No time pressure identified.' };
}

/**
 * The notification score.
 *
 * Weighted mean over applicable factors, then explicit boosts, then the
 * behavioural adjustment — in that order, and the order matters. Boosts are
 * things the candidate asked for and are applied unconditionally; the
 * behavioural adjustment is an inference and is applied last, bounded, and
 * refused outright where it contradicts something explicit.
 */
export function computeNotificationScore(input: ScoringInput): NotificationScore {
  const weights = { ...DEFAULT_SCORE_WEIGHTS, ...input.config.weights };

  const opportunityValue = computeOpportunityValue(input);

  const raw: FactorInput[] = [
    {
      factor: 'fit',
      raw: input.matchScore,
      detail: input.matchScore === null ? 'Not matched yet.' : `Match score ${Math.round(input.matchScore)}.`,
    },
    {
      factor: 'application_recommendation',
      raw: recommendationScore(input.recommendation),
      detail: input.recommendation ? `Application analysis says ${input.recommendation}.` : 'Not analysed.',
    },
    {
      factor: 'job_quality',
      raw: input.jobQuality === null ? null : input.jobQuality * 100,
      detail: input.jobQuality === null ? 'Posting not enriched.' : 'Posting completeness.',
    },
    {
      factor: 'freshness',
      raw: freshnessScore(input.freshnessHours),
      detail:
        input.freshnessHours === null
          ? 'No posting date.'
          : `Posted about ${Math.round(input.freshnessHours)} hours ago.`,
    },
    {
      factor: 'salary',
      raw: salaryScore(input.salaryAnnualUsd, input.candidateSalaryTarget),
      detail: input.salaryAnnualUsd === null ? 'No salary stated.' : 'Compared against your target.',
    },
    {
      factor: 'career_relevance',
      raw: input.careerAlignmentApplicable ? input.careerAlignment : null,
      detail: input.careerAlignmentApplicable ? 'From your career trajectory.' : 'Not assessable.',
    },
    {
      factor: 'company_affinity',
      raw: input.favouriteBoosts.some((entry) => entry.label.startsWith('company:')) ? 100 : null,
      detail: 'Whether this is a company you starred.',
    },
    {
      factor: 'deadline',
      raw: deadlineScore(input.deadline.bucket, input.deadline.closingRisk),
      detail: input.deadline.explanation || 'No deadline stated.',
    },
    {
      factor: 'competition',
      raw: competitionScore(input.competition),
      detail: input.competition === null ? 'Not estimated.' : `Estimated ${input.competition} competition.`,
    },
    {
      factor: 'source_quality',
      raw: input.sourceQuality === null ? null : input.sourceQuality * 100,
      detail: 'How authoritative the source is.',
    },
    {
      factor: 'application_friction',
      // Inverted: a short application is worth more, not less.
      raw: input.frictionScore === null ? null : 100 - input.frictionScore,
      detail: input.frictionScore === null ? 'Process unknown.' : 'How much work applying looks like.',
    },
    {
      factor: 'rarity',
      raw: input.rarity.sufficientHistory ? input.rarity.rarityScore * 100 : null,
      detail: input.rarity.explanation || 'Not enough discovery history to judge rarity.',
    },
    {
      factor: 'notification_history',
      raw: historyScore(input.alertsSentToday, input.maxAlertsPerDay),
      detail: `${input.alertsSentToday} of ${input.maxAlertsPerDay} alerts used today.`,
    },
  ];

  const factors: NotificationScore['factors'] = raw.map((entry) => ({
    factor: entry.factor,
    raw: entry.raw === null ? 0 : clamp(entry.raw),
    weight: weights[entry.factor] ?? 0,
    applicable: entry.raw !== null,
    detail: entry.detail.slice(0, 300),
  }));

  const contributing = factors.filter((entry) => entry.applicable && entry.weight > 0);
  const totalWeight = contributing.reduce((sum, entry) => sum + entry.weight, 0);

  let score =
    totalWeight === 0
      ? 0
      : contributing.reduce((sum, entry) => sum + entry.raw * entry.weight, 0) / totalWeight;

  /*
   * How much of the score is actually about the candidate.
   *
   * Dropping inapplicable factors is right — a posting with no salary must not
   * be scored as paying badly — but it has a failure mode that showed up
   * immediately against the live database. When `fit` is missing, its weight of
   * 26 leaves the denominator, and the remaining factors are all properties of
   * the *posting*: how complete it is, how recently it appeared, how short the
   * application looks. Those are decent for almost everything.
   *
   * The result was an unmatched "Marketing Operations Manager" scoring 72 while
   * a genuinely matched web-developer role scored 70. A job the system knows
   * nothing about must not outrank one it has actually assessed.
   *
   * So the score is damped by how much candidate-bearing weight could be
   * evaluated. Scaled rather than zeroed: partial information is still
   * information, and the confidence figure says how partial.
   */
  const relationalFactors: NotificationScoreFactor[] = [
    'fit',
    'application_recommendation',
    'career_relevance',
  ];

  const relationalTotal = relationalFactors.reduce((sum, name) => sum + (weights[name] ?? 0), 0);
  const relationalApplicable = factors
    .filter((entry) => relationalFactors.includes(entry.factor) && entry.applicable)
    .reduce((sum, entry) => sum + entry.weight, 0);

  const relationalCoverage = relationalTotal === 0 ? 1 : relationalApplicable / relationalTotal;

  if (relationalCoverage < 1) {
    score *= 0.6 + relationalCoverage * 0.4;
  }

  // ── Explicit boosts ─────────────────────────────────────────────────────
  const boostPoints = input.favouriteBoosts.reduce((sum, entry) => sum + entry.points, 0);
  const boost = Math.min(30, boostPoints);
  const boostReasons = input.favouriteBoosts.map((entry) => entry.label.slice(0, 200));

  score += boost;

  // ── Behavioural adjustment, last and bounded ────────────────────────────
  let behavioural = 0;

  if (
    input.config.calibrationEnabled &&
    input.behavioralAffinity !== null &&
    /*
     * The absolute rule, at the point it would be broken.
     *
     * A signal that contradicts an explicit preference is dropped entirely
     * rather than damped — damping it would still let behaviour move a score
     * the candidate has already spoken about, which is the thing that must not
     * happen.
     */
    !input.behavioralConflictsWithExplicit
  ) {
    behavioural = input.behavioralAffinity * input.config.maxBehavioralAdjustment;
    score += behavioural;
  }

  score = clamp(score);

  // ── Urgency ─────────────────────────────────────────────────────────────
  const urgency = computeUrgency({
    deadline: input.deadline,
    freshnessHours: input.freshnessHours,
    opportunityValue: opportunityValue.score,
    recommendation: input.recommendation,
  });

  // ── Confidence ──────────────────────────────────────────────────────────
  const coverage = factors.length === 0 ? 0 : contributing.length / factors.filter((e) => e.weight > 0).length;
  let confidence = coverage * 0.6 + (input.matchConfidence ?? 0.3) * 0.4;
  if (input.matchScore === null) confidence = Math.min(confidence, 0.25);
  if (input.recommendation === null) confidence = Math.min(confidence, 0.4);

  // ── Explanation (Part 30) ───────────────────────────────────────────────
  const top = [...contributing]
    .filter((entry) => entry.raw >= 70)
    .sort((a, b) => b.raw * b.weight - a.raw * a.weight)
    .slice(0, 3);

  const parts: string[] = [];

  if (top.length > 0) {
    parts.push(top.map((entry) => entry.detail).join(' '));
  }

  if (boostReasons.length > 0) {
    parts.push(`Boosted because ${boostReasons.join(', ')}.`);
  }

  if (urgency.urgency !== 'LOW') {
    parts.push(urgency.reason);
  }

  if (input.rarity.sufficientHistory && input.rarity.rarityScore >= 0.7) {
    parts.push(input.rarity.explanation);
  }

  if (behavioural !== 0) {
    parts.push(
      `Your past engagement ${behavioural > 0 ? 'supports' : 'runs against'} alerts like this ` +
        `(${behavioural > 0 ? '+' : ''}${behavioural.toFixed(1)} points).`,
    );
  }

  if (input.behavioralConflictsWithExplicit) {
    parts.push('Your activity suggests otherwise, but your stated preferences take precedence.');
  }

  return notificationScoreSchema.parse({
    score: Math.round(score),
    urgency: urgency.urgency,
    opportunityValue,
    factors,
    boost,
    boostReasons,
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100,
    deadline: input.deadline,
    rarity: input.rarity,
    explanation: (parts.join(' ') || 'Scored from the available signals.').slice(0, 600),
  });
}

/** Whether one urgency clears a configured minimum. */
export function meetsUrgency(actual: UrgencyLevel, minimum: UrgencyLevel): boolean {
  return URGENCY_RANK[actual] >= URGENCY_RANK[minimum];
}

/** An empty deadline assessment, for jobs with no date information at all. */
export function noDeadline(): DeadlineAssessment {
  return deadlineAssessmentSchema.parse({});
}

/** An empty rarity assessment, for callers without discovery history. */
export function noRarity(): RarityAssessment {
  return rarityAssessmentSchema.parse({});
}
