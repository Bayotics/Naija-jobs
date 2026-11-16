import {
  FRICTION_MINUTES,
  applicationFrictionSchema,
  competitivenessAssessmentSchema,
  legitimacyAssessmentSchema,
  timingAssessmentSchema,
  type ApplicationFriction,
  type CompetitionLevel,
  type CompetitivenessAssessment,
  type FrictionFactor,
  type JobEnrichment,
  type LegitimacyAssessment,
  type ParsedRequirementRecord,
  type TimingAssessment,
  type TimingState,
} from '@job-intel/contracts';

/**
 * Friction, timing, competitiveness and legitimacy.
 *
 * The four assessments that describe the *opportunity* rather than the
 * candidate. Each is a ranking input; none is a veto, with the single exception
 * of an expired posting, where applying is simply not possible.
 *
 * The constraint the brief is firmest about lives in the competitiveness
 * module: **do not claim to know how many people applied.** Almost no source
 * reports it, and a plausible-looking invented number is the most
 * decision-changing lie this system could tell. `applicantCount` stays null
 * unless a source actually said.
 */

// ── Friction (Part 20) ──────────────────────────────────────────────────────

const COVER_LETTER_REQUIRED = /\b(cover\s+letter|motivation\s+letter|covering\s+letter)\b[^.]{0,40}\b(required|must|please\s+(include|attach|submit))\b/i;
const COVER_LETTER_MENTIONED = /\b(cover\s+letter|motivation\s+letter|covering\s+letter)\b/i;
const COVER_LETTER_OPTIONAL = /\b(cover\s+letter|motivation\s+letter)\b[^.]{0,40}\b(optional|not\s+required|welcome|if\s+you.{0,4}d\s+like)\b/i;

const PORTFOLIO = /\b(portfolio|github|work\s+samples|writing\s+samples|dribbble|behance)\b[^.]{0,50}\b(required|please\s+(share|include|link)|send|attach)\b/i;
const ASSESSMENT = /\b(take[\s-]home|coding\s+(challenge|test|assessment)|technical\s+assessment|hackerrank|codility|online\s+test|screening\s+test)\b/i;
const REFERENCES = /\b(references?)\b[^.]{0,40}\b(required|please\s+provide|upon\s+request)\b/i;
const QUESTIONNAIRE = /\b(application\s+questions?|screening\s+questions?|questionnaire|please\s+answer\s+the\s+following)\b/i;

/** ATS vendors whose flows are short enough to notice. */
const LOW_FRICTION_ATS = new Set(['greenhouse', 'lever', 'ashby', 'workable']);
const HIGH_FRICTION_ATS = new Set(['workday', 'taleo', 'icims', 'successfactors', 'brassring']);

export interface FrictionInput {
  enrichment: JobEnrichment | null;
  description: string | null;
}

export function analyseFriction(input: FrictionInput): ApplicationFriction {
  const text = `${input.description ?? ''}\n${(input.enrichment?.requirements ?? []).join('\n')}`;
  const target = input.enrichment?.applicationTarget ?? null;

  const factors = new Set<FrictionFactor>();
  const parts: string[] = [];

  const atsVendor = target?.atsVendor ?? null;

  if (atsVendor && LOW_FRICTION_ATS.has(atsVendor)) {
    factors.add('simple_form');
    parts.push(`Applies through ${atsVendor}, which is usually a short form.`);
  } else if (atsVendor && HIGH_FRICTION_ATS.has(atsVendor)) {
    factors.add('external_ats');
    factors.add('account_required');
    factors.add('long_questionnaire');
    parts.push(`Applies through ${atsVendor}, which typically means an account and a long form.`);
  } else if (target?.applicationUrl) {
    factors.add('simple_form');
  } else {
    /*
     * No resolved application route.
     *
     * Genuinely costly: the candidate has to find the posting on the company's
     * own site before they can start. Worth flagging rather than hiding.
     */
    factors.add('unclear_route');
    parts.push('No direct application link was found, so you may have to locate the posting yourself.');
  }

  const coverLetterRequired = COVER_LETTER_REQUIRED.test(text);
  const coverLetterOptional = !coverLetterRequired && COVER_LETTER_OPTIONAL.test(text);
  const coverLetterMentioned = COVER_LETTER_MENTIONED.test(text);

  if (coverLetterRequired) {
    factors.add('cover_letter_required');
    parts.push('A cover letter is required.');
  } else if (coverLetterOptional) {
    parts.push('A cover letter is welcome but not required.');
  } else if (coverLetterMentioned) {
    parts.push('A cover letter is mentioned, though it is unclear whether it is required.');
  }

  const portfolioRequired = PORTFOLIO.test(text);
  if (portfolioRequired) {
    factors.add('portfolio_required');
    parts.push('A portfolio or work samples are requested.');
  }

  const assessmentRequired = ASSESSMENT.test(text);
  if (assessmentRequired) {
    factors.add('assessment_required');
    parts.push('There is a take-home or coding assessment in the process.');
  }

  if (REFERENCES.test(text)) factors.add('references_required');
  if (QUESTIONNAIRE.test(text)) {
    factors.add('long_questionnaire');
    parts.push('The application includes screening questions.');
  }

  const estimatedMinutes = [...factors].reduce((sum, factor) => sum + FRICTION_MINUTES[factor], 0);

  /*
   * The score is effort, not desirability.
   *
   * Two hours is treated as the practical ceiling: beyond that the difference
   * between "long" and "very long" stops changing the decision, and letting the
   * number keep climbing would eventually let friction outweigh fit.
   */
  const frictionScore = Math.min(100, Math.round((estimatedMinutes / 120) * 100));

  if (estimatedMinutes > 0) {
    parts.push(`Roughly ${estimatedMinutes} minutes of work, as a rough guide.`);
  }

  return applicationFrictionSchema.parse({
    factors: [...factors],
    estimatedMinutes,
    frictionScore,
    coverLetterRequired,
    coverLetterOptional,
    portfolioRequired,
    assessmentRequired,
    applicationUrl: target?.applicationUrl ?? null,
    atsVendor,
    explanation: parts.join(' ') || 'Nothing in the posting describes the application process.',
    // Read from prose, so genuinely uncertain. Said so rather than implied.
    confidence: target ? 0.55 : 0.35,
  });
}

// ── Timing (Parts 23, 24) ───────────────────────────────────────────────────

const DEADLINE_PATTERNS: readonly RegExp[] = [
  /\b(?:apply|applications?)\s+(?:by|before|until|close[sd]?\s+on)\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/i,
  /\b(?:deadline|closing\s+date)\s*[:-]?\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/i,
];

const OPEN_UNTIL_FILLED = /\b(open\s+until\s+filled|until\s+the\s+position\s+is\s+filled|rolling\s+basis|no\s+(fixed\s+)?deadline)\b/i;

export interface TimingInput {
  postedAt: Date | null;
  validThrough: Date | null;
  description: string | null;
  /** True when the lifecycle layer has already marked it closed. */
  closed: boolean;
  now: Date;
}

export function analyseTiming(input: TimingInput): TimingAssessment {
  const { now } = input;

  const hoursSincePosted =
    input.postedAt === null ? null : Math.max(0, (now.getTime() - input.postedAt.getTime()) / 3_600_000);
  const daysSincePosted = hoursSincePosted === null ? null : hoursSincePosted / 24;

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

  const openUntilFilled = input.description ? OPEN_UNTIL_FILLED.test(input.description) : false;

  const daysUntilDeadline =
    deadline === null ? null : (deadline.getTime() - now.getTime()) / 86_400_000;

  // ── State ───────────────────────────────────────────────────────────────
  let state: TimingState;
  const parts: string[] = [];

  if (input.closed || (daysUntilDeadline !== null && daysUntilDeadline < 0)) {
    state = 'expired';
    parts.push(
      daysUntilDeadline !== null && daysUntilDeadline < 0
        ? `The application deadline passed ${Math.abs(Math.round(daysUntilDeadline))} days ago.`
        : 'This posting has been closed at its source.',
    );
  } else if (daysUntilDeadline !== null && daysUntilDeadline <= 7) {
    state = 'closing_soon';
    parts.push(`Applications close in ${Math.max(0, Math.round(daysUntilDeadline))} days.`);
  } else if (daysSincePosted === null) {
    state = 'unknown';
    parts.push('The posting does not say when it was published.');
  } else if (daysSincePosted <= 3) {
    state = 'fresh';
    parts.push(`Posted ${daysSincePosted < 1 ? 'today' : `${Math.round(daysSincePosted)} days ago`}.`);
  } else if (daysSincePosted <= 21) {
    state = 'active';
    parts.push(`Posted ${Math.round(daysSincePosted)} days ago.`);
  } else {
    /*
     * Old, and deliberately not discarded.
     *
     * Plenty of roles stay open for months — senior hires, niche skills, slow
     * processes — and a system that hides everything over three weeks throws
     * away exactly the jobs with the least competition.
     */
    state = 'ageing';
    parts.push(
      `Posted ${Math.round(daysSincePosted)} days ago. Older postings are often still open, ` +
        'especially for senior or specialist roles.',
    );
  }

  if (openUntilFilled) parts.push('It says it is open until filled.');

  // ── Urgency ─────────────────────────────────────────────────────────────
  let urgency = 40;

  if (state === 'expired') urgency = 0;
  else if (state === 'closing_soon') urgency = 95;
  else if (state === 'fresh') urgency = 80;
  else if (state === 'active') urgency = 55;
  else if (state === 'ageing') urgency = 30;

  return timingAssessmentSchema.parse({
    state,
    hoursSincePosted,
    daysSincePosted,
    deadline,
    daysUntilDeadline,
    openUntilFilled,
    urgency,
    explanation: parts.join(' '),
  });
}

// ── Competitiveness (Part 22) ───────────────────────────────────────────────

export interface CompetitivenessInput {
  requirements: readonly ParsedRequirementRecord[];
  enrichment: JobEnrichment | null;
  timing: TimingAssessment;
  /** Set only when a source genuinely reported it. */
  reportedApplicants?: { count: number; source: string } | null;
  /** 0–100 skill alignment, as one input among several. */
  skillAlignmentScore: number;
  /** How many distinct sources carried this posting. */
  sourceCount: number;
}

export function analyseCompetitiveness(input: CompetitivenessInput): CompetitivenessAssessment {
  const signals: CompetitivenessAssessment['signals'] = [];

  /*
   * Reported applicant counts, when they exist.
   *
   * Almost no source provides this. When one does it dominates everything
   * else, and when none does the field stays null rather than being filled
   * with a number that looks authoritative and is not.
   */
  if (input.reportedApplicants) {
    const count = input.reportedApplicants.count;
    const level: CompetitionLevel = count >= 200 ? 'HIGH' : count >= 50 ? 'MEDIUM' : 'LOW';

    return competitivenessAssessmentSchema.parse({
      level,
      confidence: 0.8,
      applicantCount: count,
      applicantCountSource: input.reportedApplicants.source,
      signals: [
        {
          name: 'reported_applicants',
          detail: `${input.reportedApplicants.source} reports ${count} applicants.`,
          direction: count >= 50 ? 'raises' : 'lowers',
          weight: 1,
        },
      ],
      explanation: `${count} applicants reported by ${input.reportedApplicants.source}.`,
    });
  }

  let pressure = 0;
  let weightSum = 0;

  const add = (
    name: string,
    detail: string,
    direction: 'raises' | 'lowers' | 'neutral',
    weight: number,
  ): void => {
    signals.push({ name, detail, direction, weight });
    if (direction === 'raises') pressure += weight;
    else if (direction === 'lowers') pressure -= weight;
    weightSum += weight;
  };

  // ── Barriers to entry lower competition ─────────────────────────────────
  const yearsRequired = input.requirements
    .filter((entry) => entry.type === 'experience_years' && entry.minYears !== null)
    .reduce((max, entry) => Math.max(max, entry.minYears!), 0);

  if (yearsRequired >= 8) {
    add('high_experience_bar', `Asks for ${yearsRequired}+ years, which thins the field.`, 'lowers', 0.7);
  } else if (yearsRequired > 0 && yearsRequired <= 2) {
    add('low_experience_bar', `Asks for only ${yearsRequired} years, so many people qualify.`, 'raises', 0.6);
  }

  const requiredSkills = input.requirements.filter(
    (entry) => entry.type === 'technical_skill' && entry.importance === 'required',
  );

  if (requiredSkills.length >= 8) {
    add(
      'long_requirement_list',
      `${requiredSkills.length} required skills — few candidates will tick every box.`,
      'lowers',
      0.5,
    );
  } else if (requiredSkills.length > 0 && requiredSkills.length <= 3) {
    add('short_requirement_list', 'A short requirement list widens the field.', 'raises', 0.4);
  }

  const seniority = input.enrichment?.seniority ?? null;
  if (seniority === 'entry' || seniority === 'junior' || seniority === 'intern') {
    add('junior_role', 'Entry-level roles attract very large applicant pools.', 'raises', 0.9);
  } else if (seniority === 'staff' || seniority === 'principal' || seniority === 'director') {
    add('senior_role', 'Roles at this level have a much smaller candidate pool.', 'lowers', 0.6);
  }

  // ── Exposure raises competition ─────────────────────────────────────────
  if (input.enrichment?.workArrangement.remoteWorldwide) {
    add(
      'remote_worldwide',
      'Remote-from-anywhere roles compete against a global pool.',
      'raises',
      0.8,
    );
  }

  if (input.sourceCount >= 4) {
    add(
      'widely_syndicated',
      `Carried by ${input.sourceCount} sources, so it has had a lot of exposure.`,
      'raises',
      0.5,
    );
  }

  // ── Age cuts both ways ──────────────────────────────────────────────────
  if (input.timing.state === 'fresh') {
    add('fresh_posting', 'Applying early usually means a smaller pile.', 'lowers', 0.4);
  } else if (input.timing.daysSincePosted !== null && input.timing.daysSincePosted > 30) {
    add(
      'long_open',
      'Open for over a month — either hard to fill, which helps you, or dormant.',
      'neutral',
      0.3,
    );
  }

  if (weightSum === 0) {
    return competitivenessAssessmentSchema.parse({
      level: 'UNKNOWN',
      confidence: 0,
      signals: [],
      explanation:
        'Nothing in this posting indicates how competitive it is. No source reported applicant numbers.',
    });
  }

  const normalised = pressure / weightSum;
  const level: CompetitionLevel = normalised > 0.25 ? 'HIGH' : normalised < -0.25 ? 'LOW' : 'MEDIUM';

  /*
   * Confidence stays modest by design.
   *
   * These are proxies for something none of them measure. The honest ceiling
   * is "informed guess", and presenting it as more would invite someone to skip
   * a job on the strength of an inference about a number nobody counted.
   */
  const confidence = Math.min(0.5, 0.15 + signals.length * 0.06);

  return competitivenessAssessmentSchema.parse({
    level,
    confidence: Math.round(confidence * 100) / 100,
    applicantCount: null,
    applicantCountSource: null,
    signals: signals.slice(0, 12),
    explanation:
      `Estimated ${level.toLowerCase()} competition from ${signals.length} signal${signals.length === 1 ? '' : 's'}. ` +
      'No source reported actual applicant numbers, so this is an inference.',
  });
}

// ── Legitimacy (Part 28) ────────────────────────────────────────────────────

const PAYMENT_REQUEST = /\b(pay(ment)?\s+(a\s+)?fee|registration\s+fee|training\s+fee|deposit\s+required|purchase\s+(your\s+)?own\s+equipment\s+upfront)\b/i;
const FINANCIAL_DETAILS = /\b(bank\s+(account|details)|routing\s+number|sort\s+code|social\s+security\s+number|ssn\b|credit\s+card)\b/i;
const PERSONAL_CONTACT = /\b(whatsapp|telegram|@gmail\.com|@yahoo\.|@hotmail\.|@outlook\.com)\b/i;
const UNREALISTIC = /\b(\$\s?[5-9]\d{2,3}\s*(?:\/|per\s+)?(?:hour|hr)\b|earn\s+\$?\d{3,},?\d*\s+(?:per\s+)?week|no\s+experience\s+(?:necessary|required)[^.]{0,40}\$\d{3,})/i;
const VAGUE = /\b(work\s+from\s+home\s+opportunity|be\s+your\s+own\s+boss|unlimited\s+earning|immediate\s+start\s+no\s+interview)\b/i;

export interface LegitimacyInput {
  description: string | null;
  companyName: string | null;
  companyWebsite: string | null;
  applyUrl: string | null;
  /** The scam assessment from the recommendation layer, when one exists. */
  scamScore?: number | null;
  qualityScore?: number | null;
}

export function analyseLegitimacy(input: LegitimacyInput): LegitimacyAssessment {
  const text = input.description ?? '';
  const signals: LegitimacyAssessment['signals'] = [];

  const add = (name: string, detail: string, severity: 'low' | 'medium' | 'high'): void => {
    signals.push({ name, detail, severity });
  };

  if (PAYMENT_REQUEST.test(text)) {
    add('payment_requested', 'The posting mentions a fee or deposit from the applicant.', 'high');
  }

  if (FINANCIAL_DETAILS.test(text)) {
    add(
      'financial_details_requested',
      'The posting mentions bank or identity details in the application itself.',
      'high',
    );
  }

  if (PERSONAL_CONTACT.test(text)) {
    add(
      'personal_contact_channel',
      'Contact runs through a personal email or messaging app rather than a company address.',
      'medium',
    );
  }

  if (UNREALISTIC.test(text)) {
    add('unrealistic_compensation', 'The stated pay is far outside normal ranges for the role.', 'medium');
  }

  if (VAGUE.test(text)) {
    add('generic_marketing_language', 'The posting reads as generic recruitment marketing.', 'low');
  }

  if (!input.companyName || input.companyName.trim().length < 2) {
    add('no_company_identity', 'No company is named.', 'medium');
  }

  if (!input.companyWebsite) {
    add('no_company_website', 'No company website was resolved.', 'low');
  }

  if (text.length > 0 && text.length < 300) {
    add('very_short_description', 'The description is unusually short for a real posting.', 'low');
  }

  if (typeof input.scamScore === 'number' && input.scamScore >= 0.6) {
    add(
      'upstream_scam_score',
      `The enrichment layer scored this ${(input.scamScore * 100).toFixed(0)}% on its scam heuristics.`,
      'medium',
    );
  }

  const high = signals.filter((signal) => signal.severity === 'high').length;
  const medium = signals.filter((signal) => signal.severity === 'medium').length;

  /*
   * Three verdicts, and no fourth.
   *
   * `SUSPICIOUS` describes the posting, not the company. The system can say
   * "this asks for your bank details before an interview" — which is an
   * observation — and must not say "this company is a fraud", which is an
   * accusation it has no standing to make.
   */
  let verdict: LegitimacyAssessment['verdict'];
  let explanation: string;

  if (high > 0 || medium >= 2) {
    verdict = 'SUSPICIOUS';
    explanation =
      `This posting has ${signals.length} characteristic${signals.length === 1 ? '' : 's'} associated with fraudulent listings. ` +
      'That is a reason to verify the employer independently before applying, not proof of anything.';
  } else if (signals.length === 0 && input.companyName && input.companyWebsite) {
    verdict = 'LEGITIMATE_LIKELY';
    explanation = 'Nothing about this posting matches known fraud patterns.';
  } else if (signals.length <= 1 && (input.qualityScore ?? 0) >= 0.6) {
    verdict = 'LEGITIMATE_LIKELY';
    explanation = 'Nothing significant matches known fraud patterns.';
  } else {
    verdict = 'UNKNOWN';
    explanation = 'There is not enough information about this posting to judge either way.';
  }

  const confidence =
    verdict === 'SUSPICIOUS'
      ? Math.min(0.8, 0.4 + high * 0.2 + medium * 0.1)
      : verdict === 'LEGITIMATE_LIKELY'
        ? 0.6
        : 0.2;

  return legitimacyAssessmentSchema.parse({
    verdict,
    confidence: Math.round(confidence * 100) / 100,
    signals: signals.slice(0, 12),
    explanation,
  });
}
