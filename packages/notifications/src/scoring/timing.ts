import {
  deadlineAssessmentSchema,
  rarityAssessmentSchema,
  type ClosingRisk,
  type DeadlineAssessment,
  type DeadlineBucket,
  type RarityAssessment,
} from '@job-intel/contracts';

/**
 * Deadline intelligence, closing risk and rarity.
 *
 * Three assessments that share one discipline: they say what they know, and
 * where they are guessing they say that too.
 *
 * Closing risk is inference. Nothing here can see an employer's hiring pipeline,
 * so an estimate built from job age and source behaviour is exactly that, and
 * it carries a confidence that stays modest by construction. `UNKNOWN` is the
 * honest and common answer.
 *
 * Rarity is measured against what has actually been discovered rather than
 * against a figure someone made up. It refuses to say anything until the
 * observation window holds enough jobs to support a claim — a system that calls
 * the third posting it ever saw "a rare find" is measuring its own youth.
 */

const HOUR_MS = 3_600_000;

/** Deadline phrases postings actually use. */
const DEADLINE_PATTERNS: readonly RegExp[] = [
  /\b(?:apply|applications?)\s+(?:by|before|until|close[sd]?\s+on)\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/i,
  /\b(?:deadline|closing\s+date)\s*[:-]?\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/i,
];

const OPEN_UNTIL_FILLED =
  /\b(open\s+until\s+filled|until\s+the\s+position\s+is\s+filled|rolling\s+basis|no\s+(fixed\s+)?deadline)\b/i;

const URGENT_LANGUAGE =
  /\b(urgent(ly)?\s+(hiring|needed)|immediate\s+start|start\s+asap|limited\s+(spots|positions)|first\s+come)\b/i;

export interface DeadlineInput {
  validThrough: Date | null;
  postedAt: Date | null;
  description: string | null;
  /** True when the lifecycle layer has already closed it. */
  closed: boolean;
  /** How many distinct sources carried it. High syndication closes faster. */
  sourceCount: number;
  /** Consecutive scans where the posting was absent from its source. */
  absenceRuns: number;
  now: Date;
}

function bucketFor(hoursUntil: number | null): DeadlineBucket {
  if (hoursUntil === null) return 'none_stated';
  if (hoursUntil < 0) return 'expired';
  if (hoursUntil < 24) return 'under_24h';
  if (hoursUntil < 72) return 'one_to_three_days';
  if (hoursUntil < 168) return 'three_to_seven_days';
  return 'over_seven_days';
}

export function assessDeadline(input: DeadlineInput): DeadlineAssessment {
  const { now } = input;

  let deadline = input.validThrough;

  if (!deadline && input.description) {
    for (const pattern of DEADLINE_PATTERNS) {
      const match = pattern.exec(input.description);
      if (!match?.[1]) continue;
      const parsed = new Date(match[1]);
      if (!Number.isNaN(parsed.getTime())) {
        deadline = parsed;
        break;
      }
    }
  }

  const hoursUntilDeadline =
    deadline === null ? null : (deadline.getTime() - now.getTime()) / HOUR_MS;

  const bucket = input.closed ? 'expired' : bucketFor(hoursUntilDeadline);

  // ── Closing risk, only where there is no stated deadline ────────────────
  const signals: string[] = [];
  let risk: ClosingRisk = 'UNKNOWN';
  let riskConfidence = 0;

  if (bucket === 'none_stated' && !input.closed) {
    let pressure = 0;
    let weight = 0;

    const ageDays =
      input.postedAt === null ? null : (now.getTime() - input.postedAt.getTime()) / 86_400_000;

    if (ageDays !== null) {
      if (ageDays > 45) {
        /*
         * Old and still listed cuts both ways.
         *
         * Either it is genuinely hard to fill — in which case it will stay open
         * and there is no rush — or the source has stopped updating and it
         * closed weeks ago. Both readings argue against urgency, which is why
         * this lowers rather than raises risk.
         */
        pressure -= 0.5;
        weight += 0.5;
        signals.push(`Listed for about ${Math.round(ageDays)} days and still open.`);
      } else if (ageDays <= 2) {
        pressure -= 0.3;
        weight += 0.4;
        signals.push('Posted in the last two days.');
      }
    }

    if (input.absenceRuns > 0) {
      // Missing from its own source's last scan. The strongest available hint
      // that a posting is on its way out.
      pressure += 0.9;
      weight += 1;
      signals.push(
        `Absent from its source on the last ${input.absenceRuns} scan${input.absenceRuns === 1 ? '' : 's'}.`,
      );
    }

    if (input.sourceCount >= 4) {
      pressure += 0.4;
      weight += 0.5;
      signals.push(`Carried by ${input.sourceCount} sources, so it has had wide exposure.`);
    }

    if (input.description && URGENT_LANGUAGE.test(input.description)) {
      pressure += 0.5;
      weight += 0.6;
      signals.push('The posting uses urgent hiring language.');
    }

    if (input.description && OPEN_UNTIL_FILLED.test(input.description)) {
      pressure -= 0.4;
      weight += 0.5;
      signals.push('States it is open until filled.');
    }

    /*
     * One weak signal is not an estimate.
     *
     * "Posted two days ago" on its own says almost nothing about when a role
     * closes, and naming a risk on the strength of it turns UNKNOWN — the
     * honest answer for most postings — into a number that looks computed.
     * Either two signals must agree, or one must be strong enough to carry it.
     */
    const strongEnough = signals.length >= 2 || weight >= 0.9;

    if (weight > 0 && strongEnough) {
      const normalised = pressure / weight;
      risk = normalised > 0.3 ? 'HIGH' : normalised < -0.2 ? 'LOW' : 'MEDIUM';
      /*
       * Confidence stays low on purpose.
       *
       * These are proxies for something none of them observes. Capped where an
       * honest reading of the evidence puts it, so nothing downstream treats a
       * guess about closing dates as a fact.
       */
      riskConfidence = Math.min(0.55, 0.15 + signals.length * 0.1);
    }
  }

  // ── Explanation ─────────────────────────────────────────────────────────
  let explanation: string;

  if (bucket === 'expired') {
    explanation = input.closed
      ? 'This posting has been closed at its source.'
      : `The application deadline passed ${Math.abs(Math.round(hoursUntilDeadline ?? 0) / 24).toFixed(0)} days ago.`;
  } else if (hoursUntilDeadline !== null) {
    explanation =
      hoursUntilDeadline < 24
        ? `Closes in about ${Math.max(1, Math.round(hoursUntilDeadline))} hours.`
        : `Closes in about ${Math.round(hoursUntilDeadline / 24)} days.`;
  } else if (risk !== 'UNKNOWN') {
    explanation = `No stated deadline. Estimated ${risk.toLowerCase()} closing risk: ${signals[0] ?? ''}`.trim();
  } else {
    explanation = 'No deadline stated and nothing indicates when it might close.';
  }

  return deadlineAssessmentSchema.parse({
    bucket,
    deadline,
    hoursUntilDeadline,
    closingRisk: risk,
    closingRiskConfidence: Math.round(riskConfidence * 100) / 100,
    closingRiskSignals: signals.slice(0, 8),
    explanation: explanation.slice(0, 300),
  });
}

// ── Rarity (Part 10) ────────────────────────────────────────────────────────

/**
 * The dimensions rarity is measured across.
 *
 * Chosen because they are the ones candidates actually combine into a hard
 * search — "remote, Germany, React, senior, €80k+" — and because each is a
 * field the discovery history can be counted on.
 */
export interface RarityFacts {
  countryCode: string | null;
  remote: boolean;
  seniority: string | null;
  technologies: readonly string[];
  salaryAnnualUsd: number | null;
}

export interface RarityInput {
  job: RarityFacts;
  /** The candidate's stated wants, so rarity is measured against them. */
  wanted: {
    countries: readonly string[];
    remoteRequired: boolean;
    seniorities: readonly string[];
    technologies: readonly string[];
    salaryTarget: number | null;
  };
  /**
   * Discovery history: how many jobs in the window matched each dimension, and
   * how many were seen in total. Supplied by the repository — this module does
   * no counting of its own so it stays pure and testable.
   */
  history: {
    totalJobs: number;
    matchingAllDimensions: number;
    windowDays: number;
  };
  /** Below this, the window is too thin to support any claim. */
  minimumSample?: number;
}

export function assessRarity(input: RarityInput): RarityAssessment {
  const minimumSample = input.minimumSample ?? 100;
  const { history } = input;

  const dimensions: string[] = [];

  if (input.wanted.remoteRequired && input.job.remote) dimensions.push('remote');
  if (input.job.countryCode && input.wanted.countries.includes(input.job.countryCode)) {
    dimensions.push(input.job.countryCode);
  }
  if (input.job.seniority && input.wanted.seniorities.includes(input.job.seniority)) {
    dimensions.push(input.job.seniority);
  }

  const matchedTech = input.job.technologies.filter((slug) =>
    input.wanted.technologies.includes(slug),
  );
  dimensions.push(...matchedTech.slice(0, 3));

  if (
    input.wanted.salaryTarget !== null &&
    input.job.salaryAnnualUsd !== null &&
    input.job.salaryAnnualUsd >= input.wanted.salaryTarget
  ) {
    dimensions.push('salary at or above your target');
  }

  /*
   * Not enough history to say anything.
   *
   * Returned as a first-class outcome rather than a zero, so the scorer can
   * drop rarity from the weighted mean entirely instead of scoring every job as
   * common while the system is still new.
   */
  if (history.totalJobs < minimumSample) {
    return rarityAssessmentSchema.parse({
      rarityScore: 0,
      matchingJobs: history.matchingAllDimensions,
      sampleSize: history.totalJobs,
      windowDays: history.windowDays,
      dimensions,
      sufficientHistory: false,
      explanation: `Only ${history.totalJobs} jobs discovered in the last ${history.windowDays} days — too few to judge how rare this is.`,
    });
  }

  const share = history.matchingAllDimensions / history.totalJobs;

  /*
   * Rarity as the inverse of observed frequency, on a log scale.
   *
   * Linear inversion makes everything look rare: at a 2% share, `1 - share` is
   * 0.98 and so is 1% and 0.5%, which are meaningfully different. The log form
   * keeps those apart where the distinction matters.
   */
  const rarityScore =
    share <= 0 ? 1 : Math.max(0, Math.min(1, Math.log10(1 / Math.max(share, 0.0005)) / Math.log10(2000)));

  const perWeek = (history.matchingAllDimensions / history.windowDays) * 7;

  const explanation =
    history.matchingAllDimensions === 0
      ? `Nothing matching ${dimensions.slice(0, 4).join(' + ')} has appeared in the last ${history.windowDays} days.`
      : `About ${perWeek < 1 ? 'less than one' : Math.round(perWeek)} job${perWeek >= 2 ? 's' : ''} a week match ${dimensions.slice(0, 4).join(' + ')}.`;

  return rarityAssessmentSchema.parse({
    rarityScore: Math.round(rarityScore * 100) / 100,
    matchingJobs: history.matchingAllDimensions,
    sampleSize: history.totalJobs,
    windowDays: history.windowDays,
    dimensions: dimensions.slice(0, 8),
    sufficientHistory: true,
    explanation: explanation.slice(0, 300),
  });
}
