import { z } from 'zod';
import { REMOTE_TYPES, SENIORITY_LEVELS } from './common';

/**
 * The matching engine's reasoning layer.
 *
 * Prompt 6 built the scoring skeleton — hard constraints, weighted dimensions,
 * bounded LLM adjustment. This file adds the parts that decide whether a score
 * is *defensible*: what the candidate can actually demonstrate, where a remote
 * job will actually hire from, which gaps are learnable, and what a rank costs
 * in the dimensions it traded away.
 *
 * Four ideas run through it.
 *
 * **Four scores, never one.** Match quality, confidence, application readiness
 * and notification priority answer different questions and are computed from
 * different inputs. A job can fit perfectly and be unready to apply to; a job
 * can be worth an alert and be a mediocre fit. Collapsing them produces a
 * number that is wrong for every purpose.
 *
 * **Absence is not contradiction.** A posting that says nothing about salary is
 * not a posting that fails a salary test. Missing data lowers *confidence*;
 * only a stated conflict lowers the *score*. This distinction is enforced in
 * types, not left to each scorer's discretion.
 *
 * **Evidence has provenance and age.** "React" on a skills list and "React" in
 * the description of a three-year role are not the same claim, and neither is
 * the same as "React" last used in 2017. The engine ranks by what can be shown.
 *
 * **A score is a ranking, not a probability.** 90 does not mean a 90% chance of
 * being hired. It means this system ranks the job in its top band given what it
 * knows. Every surface that renders a score says so.
 */

export const MATCHING_INTELLIGENCE_VERSION = '1.0.0';

// ── Evidence strength (Parts 7, 8, 9) ───────────────────────────────────────

/**
 * How strongly the candidate can demonstrate something.
 *
 * Ordered by what a hiring manager would accept. Professional production work
 * is the strongest thing short of the candidate having verified it themselves;
 * `INFERRED` is the system's own guess and is never sufficient on its own.
 *
 * This complements `EVIDENCE_SOURCES` in `candidate-intelligence.ts`, which
 * records *where* a claim came from. This records *how much weight it carries*
 * when a job asks for the skill — the same source can yield different strength
 * depending on duration and recency.
 */
export const EVIDENCE_STRENGTHS = [
  'EXPLICIT_PROFESSIONAL',
  'EXPLICIT_PROJECT',
  'CERTIFICATION',
  'PORTFOLIO',
  'EDUCATION',
  'SELF_REPORTED',
  'INFERRED',
  'UNKNOWN',
] as const;

export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

/**
 * Credit each strength earns against a requirement.
 *
 * The gap between `EXPLICIT_PROFESSIONAL` and `SELF_REPORTED` is deliberately
 * wide. A skills list is a claim that costs nothing to make and is frequently
 * aspirational; two years of shipping it is a different kind of statement, and
 * a system that scores them alike will recommend jobs the candidate cannot
 * survive an interview for.
 *
 * `UNKNOWN` is zero rather than negative: earning no credit and being penalised
 * are different, and only a stated conflict deserves the latter.
 */
export const EVIDENCE_STRENGTH_CREDIT: Readonly<Record<EvidenceStrength, number>> = {
  EXPLICIT_PROFESSIONAL: 1,
  EXPLICIT_PROJECT: 0.7,
  CERTIFICATION: 0.6,
  PORTFOLIO: 0.55,
  EDUCATION: 0.4,
  SELF_REPORTED: 0.35,
  INFERRED: 0.2,
  UNKNOWN: 0,
};

/**
 * How much a skill decays once it stops being used.
 *
 * Gentle on purpose, and it never reaches zero. Someone who shipped Java for
 * six years and has not touched it for three has not forgotten Java; treating
 * old evidence as absent would make the system recommend only what the
 * candidate did last quarter. The floor says: stale, not void.
 */
export const RECENCY_HALF_LIFE_YEARS = 4;
export const RECENCY_FLOOR = 0.45;

export function recencyMultiplier(
  lastUsed: Date | null,
  now: Date = new Date(),
): { multiplier: number; reason: string } {
  if (!lastUsed) {
    /*
     * No date is not the same as old. Most resumes do not date their skills, so
     * assuming staleness here would penalise the common case.
     */
    return { multiplier: 0.85, reason: 'No usage date recorded; treated as recent but unverified.' };
  }

  const years = (now.getTime() - lastUsed.getTime()) / (365.25 * 24 * 3_600_000);

  if (years <= 1) return { multiplier: 1, reason: 'Used within the last year.' };

  const decayed = Math.pow(0.5, (years - 1) / RECENCY_HALF_LIFE_YEARS);
  const multiplier = Math.max(RECENCY_FLOOR, decayed);

  return {
    multiplier: Number(multiplier.toFixed(3)),
    reason: `Last used about ${Math.round(years)} year(s) ago.`,
  };
}

/**
 * One demonstrable claim, with everything needed to defend it.
 *
 * The shape is the argument: a skill the candidate "has" is meaningless without
 * how they got it, how long they did it, and when they stopped.
 */
export const skillEvidenceSchema = z.object({
  skill: z.string().max(120),
  strength: z.enum(EVIDENCE_STRENGTHS),

  /** Where it was demonstrated: employer, project or credential. */
  context: z.string().max(300).nullable().default(null),
  /** Months of demonstrated use, when derivable. */
  months: z.number().min(0).max(720).nullable().default(null),
  lastUsed: z.coerce.date().nullable().default(null),
  /** How often it appears across the candidate's history. */
  occurrences: z.number().int().min(0).max(500).default(1),

  /** Verbatim supporting text, so the claim is checkable. */
  quote: z.string().max(500).nullable().default(null),
});

export type SkillEvidence = z.infer<typeof skillEvidenceSchema>;

/**
 * The credit one piece of evidence earns.
 *
 * Duration and recency both scale the base credit, and both are bounded. Ten
 * years of a skill is not ten times better than one year — it is somewhat
 * better, and the curve says so.
 */
export function evidenceCredit(
  evidence: SkillEvidence,
  now: Date = new Date(),
): { credit: number; reasons: string[] } {
  const base = EVIDENCE_STRENGTH_CREDIT[evidence.strength];
  const reasons: string[] = [];

  if (base === 0) {
    return { credit: 0, reasons: ['No usable evidence.'] };
  }

  reasons.push(`${evidence.strength.replace(/_/g, ' ').toLowerCase()} evidence.`);

  /*
   * Duration saturates. A year of production use is most of the signal; the
   * difference between five and ten years is real but small, and a linear
   * scale would let tenure swamp everything else.
   */
  const months = evidence.months ?? 0;
  const durationFactor = months === 0 ? 0.8 : Math.min(1, 0.6 + 0.4 * Math.min(1, months / 24));

  if (months > 0) reasons.push(`about ${Math.round(months / 12 * 10) / 10} year(s).`);

  const recency = recencyMultiplier(evidence.lastUsed, now);
  if (recency.multiplier < 1) reasons.push(recency.reason);

  const credit = Math.min(1, base * durationFactor * recency.multiplier);

  return { credit: Number(credit.toFixed(3)), reasons };
}

// ── Semantic skill relationships (Parts 10, 11, 12) ─────────────────────────

/**
 * How closely two skills relate.
 *
 * `TRANSFERABLE` is the interesting one. React experience is genuine partial
 * evidence for Next.js — Next.js *is* React with a framework around it — but it
 * is not the same claim, and a system that treats it as equivalent will tell
 * someone they are a perfect fit for a role they would struggle in.
 */
export const SKILL_PROXIMITIES = ['EXACT', 'CLOSE', 'TRANSFERABLE', 'DISTANT', 'UNRELATED'] as const;
export type SkillProximity = (typeof SKILL_PROXIMITIES)[number];

/**
 * Credit that transfers across each relation.
 *
 * `DISTANT` earns a little because breadth in a domain is weak evidence of
 * being able to pick something up; `UNRELATED` earns nothing, because it is
 * not evidence of anything.
 */
export const SKILL_PROXIMITY_CREDIT: Readonly<Record<SkillProximity, number>> = {
  EXACT: 1,
  CLOSE: 0.8,
  TRANSFERABLE: 0.5,
  DISTANT: 0.15,
  UNRELATED: 0,
};

// ── Remote geography (Parts 20, 21, 22) ─────────────────────────────────────

/**
 * What "remote" actually means on a given posting.
 *
 * The most consistently misleading word in job listings. A posting tagged
 * "Remote" overwhelmingly means "remote *from somewhere specific*" — the US,
 * the EU, one country, sometimes one time zone. Treating them all as globally
 * remote is the single largest source of false matches for a candidate outside
 * the hiring region, and it wastes their time in the most demoralising way.
 */
export const REMOTE_REACHES = [
  'GLOBAL',
  'REGION_RESTRICTED',
  'COUNTRY_RESTRICTED',
  'TIMEZONE_RESTRICTED',
  'UNSPECIFIED',
] as const;

export type RemoteReach = (typeof REMOTE_REACHES)[number];

export const remoteGeographySchema = z.object({
  arrangement: z.enum(REMOTE_TYPES),
  reach: z.enum(REMOTE_REACHES).default('UNSPECIFIED'),

  /** ISO country codes the posting will hire from, when it says. */
  countries: z.array(z.string().length(2)).max(60).default([]),
  /** Named regions: `EU`, `EMEA`, `LATAM`, `US`. */
  regions: z.array(z.string().max(20)).max(20).default([]),
  /** UTC offsets the role requires overlap with. */
  timezoneOffsets: z.array(z.number().min(-12).max(14)).max(30).default([]),

  /** Days per week on site, for hybrid roles that state it. */
  onsiteDaysPerWeek: z.number().min(0).max(7).nullable().default(null),
  officeLocation: z.string().max(200).nullable().default(null),

  /** The phrase this was read from, so a wrong reading is traceable. */
  evidence: z.string().max(400).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type RemoteGeography = z.infer<typeof remoteGeographySchema>;

/**
 * Whether a candidate in one country can take a remote role.
 *
 * Returns a tri-state, not a boolean. `UNKNOWN` is the honest answer for a
 * posting that says "Remote" and nothing else, and it must not be rendered as
 * either a pass or a failure — a pass invents eligibility the posting never
 * offered, and a failure discards most of the remote market.
 */
export function evaluateRemoteEligibility(
  geography: RemoteGeography,
  candidateCountry: string | null,
): { result: 'PASS' | 'FAIL' | 'UNKNOWN'; explanation: string } {
  if (geography.arrangement === 'onsite' || geography.arrangement === 'hybrid') {
    return {
      result: 'UNKNOWN',
      explanation: 'This role requires attendance; remote geography does not apply.',
    };
  }

  if (geography.reach === 'GLOBAL') {
    return { result: 'PASS', explanation: 'The posting states it hires remotely worldwide.' };
  }

  if (geography.reach === 'UNSPECIFIED') {
    return {
      result: 'UNKNOWN',
      explanation:
        'The posting says "remote" without stating where it hires from. Most such roles are region-restricted, so this is unresolved rather than open.',
    };
  }

  if (!candidateCountry) {
    return {
      result: 'UNKNOWN',
      explanation: 'The role is geographically restricted and your country is not recorded.',
    };
  }

  const country = candidateCountry.toUpperCase();

  if (geography.countries.length > 0) {
    const permitted = geography.countries.includes(country);

    return permitted
      ? {
          result: 'PASS',
          explanation: `The posting hires remotely from ${country}.`,
        }
      : {
          result: 'FAIL',
          explanation: `This role hires remotely only from ${geography.countries.join(', ')}, which does not include ${country}.`,
        };
  }

  if (geography.regions.length > 0) {
    /*
     * Region membership is not resolved here, deliberately. Mapping countries
     * to regions is a data problem with real edge cases, and guessing at it
     * would produce confident wrong answers. The regions are surfaced so a
     * person can judge, and the result stays UNKNOWN.
     */
    return {
      result: 'UNKNOWN',
      explanation: `This role hires remotely within ${geography.regions.join(', ')}. Check whether ${country} qualifies.`,
    };
  }

  return { result: 'UNKNOWN', explanation: 'The geographic restriction could not be resolved.' };
}

// ── Career trajectory (Parts 18, 19) ────────────────────────────────────────

export const SENIORITY_ORDER: Readonly<Record<string, number>> = {
  intern: 0,
  entry: 1,
  junior: 2,
  mid: 3,
  senior: 4,
  staff: 5,
  principal: 6,
  lead: 5,
  manager: 5,
  director: 7,
  executive: 8,
};

export const TRAJECTORY_VERDICTS = [
  'NATURAL_PROGRESSION',
  'LATERAL_MOVE',
  'STRETCH',
  'STEP_BACK',
  'PIVOT',
  'UNRELATED',
  'UNKNOWN',
] as const;

export type TrajectoryVerdict = (typeof TRAJECTORY_VERDICTS)[number];

/**
 * Trajectory scores, and why they are compressed.
 *
 * The whole range sits between 30 and 92, and that is the point: trajectory is
 * a *weak* signal that should nudge a ranking, not decide it. Someone
 * deliberately changing direction is not making a mistake, and a system that
 * scored a pivot at 5 would fight every career change its user attempted.
 *
 * `UNRELATED` is the exception and sits genuinely low, because a frontend
 * engineer being shown an accounting role is not a career choice — it is a
 * matching failure.
 */
export const TRAJECTORY_SCORE: Readonly<Record<TrajectoryVerdict, number>> = {
  NATURAL_PROGRESSION: 92,
  LATERAL_MOVE: 78,
  STRETCH: 74,
  PIVOT: 58,
  STEP_BACK: 50,
  UNKNOWN: 60,
  UNRELATED: 30,
};

export const trajectoryAssessmentSchema = z.object({
  verdict: z.enum(TRAJECTORY_VERDICTS),
  score: z.number().min(0).max(100),
  /** Seniority delta: positive means the role is more senior. */
  seniorityDelta: z.number().int().min(-8).max(8).nullable().default(null),
  /** How much the role's domain overlaps the candidate's history, 0–1. */
  domainOverlap: z.number().min(0).max(1).nullable().default(null),
  explanation: z.string().max(400),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type TrajectoryAssessment = z.infer<typeof trajectoryAssessmentSchema>;

export function seniorityRank(level: string | null | undefined): number | null {
  if (!level) return null;
  return SENIORITY_ORDER[level.toLowerCase()] ?? null;
}

// ── Skill gaps (Parts 41, 42) ───────────────────────────────────────────────

export const GAP_SEVERITIES = ['CRITICAL', 'MODERATE', 'MINOR'] as const;
export type GapSeverity = (typeof GAP_SEVERITIES)[number];

/**
 * How realistically a gap can be closed before applying.
 *
 * The honest answer is usually "not before this application closes", and saying
 * so is more useful than encouragement. `NOT_LEARNABLE` exists because some
 * gaps are not skills at all — "eight years of experience" and "must already
 * hold a work permit" cannot be studied for, and telling someone to spend a
 * weekend on them would be a lie.
 */
export const LEARNABILITY = [
  'QUICK',
  'MODERATE',
  'SUBSTANTIAL',
  'NOT_LEARNABLE',
  'UNKNOWN',
] as const;

export type Learnability = (typeof LEARNABILITY)[number];

export const skillGapSchema = z.object({
  skill: z.string().max(120),
  /** How the posting framed it. */
  importance: z.enum(['required', 'preferred', 'nice_to_have', 'inferred']),
  requirementText: z.string().max(400).nullable().default(null),

  /** What the candidate has, if anything adjacent. */
  candidateEvidence: z.string().max(300).nullable().default(null),
  closestRelation: z.enum(SKILL_PROXIMITIES).default('UNRELATED'),

  severity: z.enum(GAP_SEVERITIES),
  learnability: z.enum(LEARNABILITY),

  /** What to do about it, or an honest statement that nothing can be. */
  recommendation: z.string().max(400),
});

export type SkillGap = z.infer<typeof skillGapSchema>;

/**
 * How severe a gap is.
 *
 * Severity follows the posting's own framing first: a `required` skill with no
 * adjacent evidence is critical regardless of how learnable it looks, because
 * the screening filter does not care how quickly you could learn it.
 */
export function gapSeverity(
  importance: SkillGap['importance'],
  relation: SkillProximity,
): GapSeverity {
  if (importance === 'nice_to_have' || importance === 'inferred') return 'MINOR';

  if (importance === 'required') {
    return relation === 'UNRELATED' || relation === 'DISTANT' ? 'CRITICAL' : 'MODERATE';
  }

  return relation === 'UNRELATED' ? 'MODERATE' : 'MINOR';
}

// ── Requirement coverage (Part 40) ──────────────────────────────────────────

/**
 * Coverage, reported as fractions rather than folded into a score.
 *
 * "8 of 9 required, 5 of 7 preferred" tells a candidate something a single
 * number cannot: exactly how close they are and to what. This is the figure
 * most worth showing in the interface.
 */
export const requirementCoverageSchema = z.object({
  requiredTotal: z.number().int().min(0).default(0),
  requiredCovered: z.number().int().min(0).default(0),
  preferredTotal: z.number().int().min(0).default(0),
  preferredCovered: z.number().int().min(0).default(0),
  optionalTotal: z.number().int().min(0).default(0),
  optionalCovered: z.number().int().min(0).default(0),

  /** Requirements the extractor was unsure were requirements at all. */
  lowConfidenceCount: z.number().int().min(0).default(0),
});

export type RequirementCoverage = z.infer<typeof requirementCoverageSchema>;

export function coverageRatio(coverage: RequirementCoverage): number {
  /*
   * Required-only, deliberately. Preferred requirements are what a posting says
   * it would like; folding them in lets a candidate who meets every hard
   * requirement look worse than one who meets fewer but ticks more wishes.
   */
  if (coverage.requiredTotal === 0) return 1;
  return coverage.requiredCovered / coverage.requiredTotal;
}

// ── Score caps (Parts 33, 34, 35) ───────────────────────────────────────────

export const scoreCapSchema = z.object({
  reason: z.string().max(200),
  cap: z.number().min(0).max(100),
});

export type ScoreCap = z.infer<typeof scoreCapSchema>;

/**
 * Ceilings applied when something important is unresolved.
 *
 * A cap is not a penalty — the score below the cap is untouched. It expresses
 * that the system cannot honestly claim a top-band match while a decisive
 * question is open. Work authorisation is the sharpest case: a role the
 * candidate cannot legally take is not a 96 no matter how well the skills line
 * up, and until sponsorship is known the honest ceiling is lower.
 */
export const DEFAULT_SCORE_CAPS = {
  authorizationUnknown: 85,
  remoteScopeUnknown: 88,
  salaryUnknownWhenStrict: 90,
  lowRequirementConfidence: 92,
  thinEvidence: 80,
} as const;

export function applyCaps(
  score: number,
  caps: readonly ScoreCap[],
): { score: number; applied: ScoreCap[] } {
  const applied = caps.filter((cap) => score > cap.cap);

  if (applied.length === 0) return { score, applied: [] };

  const lowest = applied.reduce((min, cap) => (cap.cap < min.cap ? cap : min), applied[0]!);

  return { score: lowest.cap, applied };
}

// ── Matching tiers (Parts 52, 53, 54) ───────────────────────────────────────

/**
 * How much work one job is worth.
 *
 * A thousand discovered jobs cannot each justify a model call. Most are
 * resolved by rules alone in microseconds; a minority need semantic comparison;
 * a handful — genuinely ambiguous, genuinely high-value — deserve reasoning.
 * Spending the deep tier on everything is not thoroughness, it is a bill.
 */
export const MATCH_TIERS = ['FAST', 'STANDARD', 'DEEP'] as const;
export type MatchTier = (typeof MATCH_TIERS)[number];

export const tierPolicySchema = z.object({
  /** Below this structured score, stop: the job is not close. */
  fastRejectBelow: z.number().min(0).max(100).default(35),
  /** Above this, run semantic comparison. */
  standardAbove: z.number().min(0).max(100).default(35),
  /** Deep reasoning only above this score… */
  deepAbove: z.number().min(0).max(100).default(70),
  /** …and only when confidence is below this, i.e. genuinely ambiguous. */
  deepMaxConfidence: z.number().min(0).max(1).default(0.75),
  /** Hard ceiling on deep evaluations per run. */
  maxDeepPerRun: z.number().int().min(0).max(1000).default(25),
});

export type TierPolicy = z.infer<typeof tierPolicySchema>;

export const DEFAULT_TIER_POLICY: TierPolicy = tierPolicySchema.parse({});

export interface TierDecision {
  tier: MatchTier;
  reason: string;
  /** True when the job was rejected outright without further work. */
  shortCircuit: boolean;
}

export function decideTier(
  input: {
    structuredScore: number;
    confidence: number;
    eligible: boolean;
    deepUsedThisRun: number;
  },
  policy: TierPolicy = DEFAULT_TIER_POLICY,
): TierDecision {
  if (!input.eligible) {
    /*
     * An ineligible job gets no further work at all. Spending a model call to
     * refine the score of a job the candidate legally cannot take is the purest
     * form of waste in this system.
     */
    return { tier: 'FAST', reason: 'Ineligible; no further evaluation is useful.', shortCircuit: true };
  }

  if (input.structuredScore < policy.fastRejectBelow) {
    return {
      tier: 'FAST',
      reason: `Structured score ${Math.round(input.structuredScore)} is below the ${policy.fastRejectBelow} floor.`,
      shortCircuit: true,
    };
  }

  const deepEligible =
    input.structuredScore >= policy.deepAbove &&
    input.confidence < policy.deepMaxConfidence &&
    input.deepUsedThisRun < policy.maxDeepPerRun;

  if (deepEligible) {
    return {
      tier: 'DEEP',
      reason: `Scores ${Math.round(input.structuredScore)} with confidence ${input.confidence.toFixed(2)} — high value and ambiguous.`,
      shortCircuit: false,
    };
  }

  return {
    tier: 'STANDARD',
    reason:
      input.structuredScore >= policy.deepAbove
        ? 'High score but confident enough that reasoning would not change it.'
        : 'Ordinary comparison.',
    shortCircuit: false,
  };
}

// ── Tradeoffs (Parts 46, 47) ────────────────────────────────────────────────

export const tradeoffSchema = z.object({
  dimension: z.string().max(40),
  /** `strength` or `cost` — what this dimension contributes to the ranking. */
  kind: z.enum(['strength', 'cost', 'unknown']),
  score: z.number().min(0).max(100).nullable(),
  summary: z.string().max(300),
});

export type Tradeoff = z.infer<typeof tradeoffSchema>;

/**
 * Whether one option dominates another on every dimension.
 *
 * Ranking by a single blended score hides the shape of a choice: a 95-match
 * with unknown salary and an 88-match paying well are not comparable by
 * arithmetic, and pretending otherwise makes the ranking feel arbitrary. This
 * finds the cases where one job really is better in every respect — those can
 * be ranked confidently — and leaves the rest to be explained rather than
 * silently ordered.
 */
export function dominates(
  a: Readonly<Record<string, number | null>>,
  b: Readonly<Record<string, number | null>>,
): boolean {
  let strictlyBetterSomewhere = false;

  for (const key of Object.keys(a)) {
    const left = a[key];
    const right = b[key];

    /* An unknown cannot be compared, so it cannot support dominance. */
    if (left === null || left === undefined || right === null || right === undefined) return false;

    if (left < right) return false;
    if (left > right) strictlyBetterSomewhere = true;
  }

  return strictlyBetterSomewhere;
}

// ── User correction (Parts 55, 56, 57) ──────────────────────────────────────

export const MATCH_FEEDBACK_TYPES = [
  'MATCH_TOO_HIGH',
  'MATCH_TOO_LOW',
  'WRONG_ROLE',
  'WRONG_LOCATION',
  'WRONG_SENIORITY',
  'WRONG_SALARY',
  'WRONG_WORK_ARRANGEMENT',
  'WRONG_AUTHORIZATION',
  'GOOD_MATCH',
] as const;

export type MatchFeedbackType = (typeof MATCH_FEEDBACK_TYPES)[number];

/**
 * Which dimension each correction is evidence about.
 *
 * Mapped explicitly so a correction adjusts the thing it was about. "Wrong
 * location" is not a general statement that the score was too high — it names
 * a dimension, and folding it into a global adjustment would lose exactly the
 * information the person took the trouble to give.
 */
export const FEEDBACK_DIMENSION: Readonly<Record<MatchFeedbackType, string | null>> = {
  WRONG_ROLE: 'title',
  WRONG_LOCATION: 'location',
  WRONG_SENIORITY: 'seniority',
  WRONG_SALARY: 'salary',
  WRONG_WORK_ARRANGEMENT: 'workArrangement',
  WRONG_AUTHORIZATION: 'visa',
  MATCH_TOO_HIGH: null,
  MATCH_TOO_LOW: null,
  GOOD_MATCH: null,
};

export const matchFeedbackSchema = z.object({
  jobId: z.string().uuid(),
  candidateProfileId: z.string().uuid(),
  feedbackType: z.enum(MATCH_FEEDBACK_TYPES),
  /** The score being corrected, so the correction stays interpretable. */
  scoreAtFeedback: z.number().min(0).max(100),
  scoringVersion: z.string().max(20),
  comment: z.string().max(1000).nullable().default(null),
  createdAt: z.coerce.date().default(() => new Date()),
});

export type MatchFeedback = z.infer<typeof matchFeedbackSchema>;

/**
 * Outcomes worth learning from.
 *
 * `IGNORED` is deliberately absent as an outcome the system records on its own.
 * Silence is not rejection — someone may not have opened the email — and
 * treating it as a negative label would train the ranker on noise the user
 * never generated.
 */
export const MATCH_OUTCOMES = [
  'SAVED',
  'APPLIED',
  'INTERVIEW',
  'OFFER',
  'REJECTED',
  'DISMISSED',
] as const;

export type MatchOutcome = (typeof MATCH_OUTCOMES)[number];

/** Relevance grade per outcome, for ranking metrics. */
export const OUTCOME_RELEVANCE: Readonly<Record<MatchOutcome, number>> = {
  OFFER: 4,
  INTERVIEW: 3,
  APPLIED: 2,
  SAVED: 1,
  REJECTED: 0,
  DISMISSED: 0,
};

// ── Ranking evaluation (Parts 58, 59) ───────────────────────────────────────

/**
 * Precision@k: how many of the top k were actually relevant.
 *
 * The metric that matches how the product is used. Nobody scrolls to rank 40;
 * if the first five are wrong, the ranking is wrong, whatever its average
 * error looks like.
 */
export function precisionAtK(
  ranked: readonly { relevant: boolean }[],
  k: number,
): number {
  const window = ranked.slice(0, k);
  if (window.length === 0) return 0;
  return window.filter((entry) => entry.relevant).length / window.length;
}

export function recallAtK(ranked: readonly { relevant: boolean }[], k: number): number {
  const total = ranked.filter((entry) => entry.relevant).length;
  if (total === 0) return 0;
  return ranked.slice(0, k).filter((entry) => entry.relevant).length / total;
}

/**
 * Normalised discounted cumulative gain.
 *
 * Unlike precision, this cares about *order* within the top k, and about
 * degrees of relevance rather than a binary. An offer at rank 1 and an offer at
 * rank 8 are different outcomes for the person using this, and NDCG is the
 * standard way to say so.
 */
export function ndcgAtK(ranked: readonly { relevance: number }[], k: number): number {
  const dcg = (entries: readonly { relevance: number }[]): number =>
    entries
      .slice(0, k)
      .reduce((sum, entry, index) => sum + entry.relevance / Math.log2(index + 2), 0);

  const ideal = [...ranked].sort((a, b) => b.relevance - a.relevance);
  const idealDcg = dcg(ideal);

  if (idealDcg === 0) return 0;

  return Number((dcg(ranked) / idealDcg).toFixed(4));
}

export const rankingEvaluationSchema = z.object({
  scoringVersion: z.string().max(20),
  sampleSize: z.number().int().min(0),
  precisionAt5: z.number().min(0).max(1),
  precisionAt10: z.number().min(0).max(1),
  recallAt10: z.number().min(0).max(1),
  ndcgAt10: z.number().min(0).max(1),
  /** Mean absolute error against graded expectations, when a set exists. */
  meanAbsoluteError: z.number().min(0).max(100).nullable().default(null),
  evaluatedAt: z.coerce.date().default(() => new Date()),
});

export type RankingEvaluation = z.infer<typeof rankingEvaluationSchema>;

// ── The full match result (Part 2) ──────────────────────────────────────────

export const ELIGIBILITY_STATUSES = ['ELIGIBLE', 'INELIGIBLE', 'UNCERTAIN'] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

/*
 * The recommendation vocabulary lives in `application-intelligence.ts`, where
 * Prompt 13 put it, and was extended there with `LOW_PRIORITY` rather than
 * duplicated. Two enums meaning almost the same thing would eventually
 * disagree, and the disagreement would surface as a job labelled SKIP on one
 * screen and CONSIDER on another.
 */
import { APPLICATION_RECOMMENDATIONS, type ApplicationRecommendation } from './application-intelligence';

export type MatchApplicationRecommendation = ApplicationRecommendation;

/**
 * Provenance for a match.
 *
 * Recorded on every result so a score can be recomputed, compared across
 * versions, or explained months later. Without it, a score that looks wrong is
 * unfalsifiable — you cannot tell whether the weights changed, the taxonomy
 * grew, or the model was swapped.
 */
export const matchProvenanceSchema = z.object({
  scoringVersion: z.string().max(20),
  taxonomyVersion: z.string().max(20),
  modelProvider: z.string().max(60).nullable().default(null),
  modelName: z.string().max(120).nullable().default(null),
  promptVersion: z.string().max(20).nullable().default(null),
  embeddingModel: z.string().max(120).nullable().default(null),
  tier: z.enum(MATCH_TIERS).default('STANDARD'),
  computedAt: z.coerce.date().default(() => new Date()),
});

export type MatchProvenance = z.infer<typeof matchProvenanceSchema>;

/**
 * The complete result.
 *
 * Long by design. Every field here is something a person or a downstream stage
 * asks for, and the alternative — a score plus a paragraph — makes the
 * reasoning unavailable to anything except a human reading it.
 *
 * Note what stays separate: `matchScore`, `confidenceScore`,
 * `applicationReadinessScore` and `applicationFrictionScore` are four different
 * questions. Friction in particular is *not* part of match quality — a
 * miserable application form does not make a job fit worse, it makes it cost
 * more to pursue, which is a ranking input rather than a fit input.
 */
export const jobMatchResultSchema = z.object({
  jobId: z.string().uuid(),
  candidateId: z.string().uuid(),
  profileId: z.string().uuid().nullable().default(null),

  eligibilityStatus: z.enum(ELIGIBILITY_STATUSES),

  matchScore: z.number().min(0).max(100),
  confidenceScore: z.number().min(0).max(100),

  hardConstraintScore: z.number().min(0).max(100).default(100),
  skillScore: z.number().min(0).max(100).nullable().default(null),
  experienceScore: z.number().min(0).max(100).nullable().default(null),
  roleScore: z.number().min(0).max(100).nullable().default(null),
  responsibilityScore: z.number().min(0).max(100).nullable().default(null),
  seniorityScore: z.number().min(0).max(100).nullable().default(null),
  locationScore: z.number().min(0).max(100).nullable().default(null),
  workArrangementScore: z.number().min(0).max(100).nullable().default(null),
  salaryScore: z.number().min(0).max(100).nullable().default(null),
  authorizationScore: z.number().min(0).max(100).nullable().default(null),
  companyScore: z.number().min(0).max(100).nullable().default(null),
  industryScore: z.number().min(0).max(100).nullable().default(null),
  careerTrajectoryScore: z.number().min(0).max(100).nullable().default(null),
  jobQualityScore: z.number().min(0).max(100).nullable().default(null),
  behavioralAffinityScore: z.number().min(0).max(100).nullable().default(null),

  applicationReadinessScore: z.number().min(0).max(100).nullable().default(null),
  applicationFrictionScore: z.number().min(0).max(100).nullable().default(null),
  recommendation: z.enum(APPLICATION_RECOMMENDATIONS),

  coverage: requirementCoverageSchema.prefault({}),
  matchedRequirements: z.array(z.string().max(200)).max(60).default([]),
  partialMatches: z.array(z.string().max(200)).max(60).default([]),
  missingRequirements: z.array(z.string().max(200)).max(60).default([]),
  hardBlockers: z.array(z.string().max(300)).max(20).default([]),
  skillGaps: z.array(skillGapSchema).max(30).default([]),
  tradeoffs: z.array(tradeoffSchema).max(20).default([]),
  capsApplied: z.array(scoreCapSchema).max(10).default([]),

  evidence: z.array(z.string().max(300)).max(40).default([]),
  explanation: z.string().max(2000),

  provenance: matchProvenanceSchema,
  createdAt: z.coerce.date().default(() => new Date()),
  updatedAt: z.coerce.date().default(() => new Date()),
});

export type JobMatchResult = z.infer<typeof jobMatchResultSchema>;

// ── Cache invalidation (Part 51) ────────────────────────────────────────────

/**
 * Everything a cached match depends on.
 *
 * A match is a function of these inputs; when any changes, the cached answer is
 * stale. Hashing them together turns invalidation from a set of remembered
 * rules — which someone will eventually forget to update — into a key
 * comparison that cannot be forgotten.
 */
export const matchCacheKeySchema = z.object({
  jobId: z.string().uuid(),
  candidateProfileId: z.string().uuid(),
  profileVersion: z.number().int().min(0),
  preferenceVersion: z.number().int().min(0),
  jobVersion: z.number().int().min(0),
  enrichmentVersion: z.number().int().min(0),
  scoringVersion: z.string().max(20),
  taxonomyVersion: z.string().max(20),
  /** Behavioural signals are versioned so learning stays reproducible. */
  behavioralVersion: z.number().int().min(0).default(0),
});

export type MatchCacheKey = z.infer<typeof matchCacheKeySchema>;

export function matchCacheFingerprint(key: MatchCacheKey): string {
  return [
    key.jobId,
    key.candidateProfileId,
    `p${key.profileVersion}`,
    `f${key.preferenceVersion}`,
    `j${key.jobVersion}`,
    `e${key.enrichmentVersion}`,
    `s${key.scoringVersion}`,
    `t${key.taxonomyVersion}`,
    `b${key.behavioralVersion}`,
  ].join('|');
}

export const SENIORITY_LEVELS_ORDERED = SENIORITY_LEVELS;
