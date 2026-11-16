import {
  authorizationGuidanceSchema,
  coverLetterStrategySchema,
  preparedAnswerSchema,
  salaryGuidanceSchema,
  type AuthorizationGuidance,
  type CoverLetterStrategy,
  type EvidenceRef,
  type PreparedAnswer,
  type SalaryGuidance,
  type SupportedClaim,
} from '@job-intel/contracts';

/**
 * Cover letters, application questions, salary and authorisation.
 *
 * Everything a candidate has to *say*, prepared from what is actually known.
 * The recurring decision in this file is when to answer "I don't know" — and
 * the answer is: whenever that is true. A salary figure invented from nothing,
 * an authorisation status inferred from a name, a behavioural example
 * assembled from adjacent facts: each is worse than a blank, because a blank
 * prompts the candidate to fill it and a fabrication prompts them to repeat it.
 */

// ── Cover letter (Parts 23, 24) ─────────────────────────────────────────────

export interface CoverLetterInput {
  /** Text of the posting, where a requirement would be stated. */
  descriptionText: string | null;
  /** Structured flag from the connector, when the source supplies one. */
  explicitlyRequired?: boolean | null;
  /** How competitive the application is: a strong fit needs less argument. */
  matchScore: number | null;
  /** Claims the candidate can make, best first. */
  strengths: readonly SupportedClaim[];
  /** Verified employer facts. Empty is normal and fine. */
  companyFacts: readonly SupportedClaim[];
  /** Why the candidate wants this, in their own words. Never invented. */
  statedMotivation?: string | null;
}

const REQUIRED_PATTERNS: readonly RegExp[] = [
  /cover letter is required/i,
  /please (?:attach|include|submit) a cover letter/i,
  /applications without a cover letter/i,
  /\brequired\b[^.]{0,40}\bcover letter\b/i,
];

const OPTIONAL_PATTERNS: readonly RegExp[] = [
  /cover letter (?:is )?optional/i,
  /(?:optionally|if you wish)[^.]{0,40}cover letter/i,
  /no cover letter (?:is )?(?:required|necessary|needed)/i,
];

/**
 * Whether to write one at all.
 *
 * Asked before what to write, because the honest answer is often "don't". Every
 * competitor in this space generates a cover letter for every application; most
 * are never read, a generic one is worse than none, and each costs the
 * candidate twenty minutes they could have spent on an application that
 * converts. `UNNECESSARY` is a real answer and this returns it.
 */
export function decideCoverLetter(input: CoverLetterInput): CoverLetterStrategy {
  const text = input.descriptionText ?? '';

  const explicitlyOptional = OPTIONAL_PATTERNS.some((pattern) => pattern.test(text));
  const explicitlyRequired =
    input.explicitlyRequired === true || REQUIRED_PATTERNS.some((pattern) => pattern.test(text));

  if (explicitlyRequired) {
    return coverLetterStrategySchema.parse({
      verdict: 'REQUIRED',
      reason: 'The posting states that a cover letter is required.',
      brief: buildBrief(input),
    });
  }

  if (explicitlyOptional) {
    /*
     * "Optional" plus a strong match is the clearest case for skipping. The
     * letter would restate a resume the screener is about to read, and the
     * candidate's time is better spent elsewhere.
     */
    if ((input.matchScore ?? 0) >= 78) {
      return coverLetterStrategySchema.parse({
        verdict: 'UNNECESSARY',
        reason:
          'The posting says a cover letter is optional and your evidence already speaks for itself. Skip it and spend the time on another application.',
        brief: null,
      });
    }

    return coverLetterStrategySchema.parse({
      verdict: 'RECOMMENDED',
      reason:
        'Optional, but your fit needs explaining — a short letter connecting your experience to this role would help.',
      brief: buildBrief(input),
    });
  }

  if (input.strengths.length === 0) {
    /*
     * No evidenced strengths means nothing honest to write. Better to say so
     * than to produce a letter of enthusiasm with no substance behind it.
     */
    return coverLetterStrategySchema.parse({
      verdict: 'UNKNOWN',
      reason:
        'The posting does not say, and there is not enough evidence on your profile to draft anything specific yet.',
      brief: null,
    });
  }

  return coverLetterStrategySchema.parse({
    verdict: 'OPTIONAL',
    reason:
      'The posting does not mention one. A short letter helps when the fit needs context; otherwise it is safe to skip.',
    brief: buildBrief(input),
  });
}

function buildBrief(input: CoverLetterInput): CoverLetterStrategy['brief'] {
  const topEvidence = input.strengths.slice(0, 3);

  if (topEvidence.length === 0) return null;

  const achievement =
    input.strengths.find((claim) => /\b(?:led|built|shipped|reduced|improved|launched)\b/i.test(claim.claim)) ??
    null;

  /*
   * The company point is only included when a *verified* fact exists. A letter
   * that praises a company for something it does not do is worse than one that
   * says nothing about the company, and inference is exactly how that happens.
   */
  const companyPoint = input.companyFacts[0] ?? null;

  return {
    openingAngle:
      'Open with the single strongest piece of evidence you have for this role, stated plainly. Skip the "I am writing to apply" sentence.',
    topEvidence,
    motivation:
      input.statedMotivation ??
      'Say why this role, in your own words. Leave this blank rather than writing something generic — a screener can tell.',
    relevantAchievement: achievement,
    companyPoint,
    closingAngle: 'Close by naming what you would work on first. Short.',
    suggestedLength: 'short',
  };
}

// ── Application questions (Parts 27–29) ─────────────────────────────────────

const QUESTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: PreparedAnswer['kind'] }> = [
  { pattern: /why (?:do you want to|would you like to) work (?:here|at|for)/i, kind: 'motivation' },
  { pattern: /why are you (?:a good fit|interested)/i, kind: 'fit' },
  { pattern: /salary (?:expectation|requirement)/i, kind: 'salary' },
  { pattern: /notice period|when (?:can|could) you start|availability/i, kind: 'notice_period' },
  { pattern: /authori[sz]ed to work|require sponsorship|work permit|visa status/i, kind: 'work_authorization' },
  { pattern: /how many years/i, kind: 'experience_years' },
  { pattern: /tell (?:me|us) about a time|describe a situation/i, kind: 'behavioral' },
];

/** Reads questions out of a posting. */
export function extractQuestions(text: string | null): Array<{ question: string; kind: PreparedAnswer['kind'] }> {
  if (!text) return [];

  const sentences = text
    .split(/(?<=[?])\s+|\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('?') && line.length > 12 && line.length < 400);

  const found: Array<{ question: string; kind: PreparedAnswer['kind'] }> = [];

  for (const sentence of sentences.slice(0, 30)) {
    const matched = QUESTION_PATTERNS.find((entry) => entry.pattern.test(sentence));
    found.push({ question: sentence, kind: matched?.kind ?? 'other' });
  }

  return found;
}

export interface AnswerInput {
  question: string;
  kind: PreparedAnswer['kind'];
  strengths: readonly SupportedClaim[];
  yearsOfExperience: number | null;
  noticePeriod: string | null;
  availableFrom: Date | null;
  salary: SalaryGuidance | null;
  authorization: AuthorizationGuidance | null;
}

/**
 * Guidance for one question.
 *
 * Returns a null answer with `missingInformation` whenever the honest response
 * depends on something the candidate has not told us. A behavioural question
 * with no matching experience gets a request for the story, not a story.
 */
export function prepareAnswer(input: AnswerInput): PreparedAnswer {
  switch (input.kind) {
    case 'salary':
      return preparedAnswerSchema.parse({
        question: input.question,
        kind: 'salary',
        recommendedAnswer: input.salary?.recommendedResponse ?? null,
        confidence: input.salary ? 0.7 : 0.2,
        missingInformation: input.salary
          ? []
          : ['Your target salary is not configured, so no range can be suggested.'],
        risk: input.salary?.containsEstimates
          ? 'Some figures here are estimates rather than stated facts. Check them before using.'
          : null,
      });

    case 'work_authorization':
      return preparedAnswerSchema.parse({
        question: input.question,
        kind: 'work_authorization',
        recommendedAnswer: input.authorization?.recommendedResponse ?? null,
        confidence: input.authorization?.needsCandidateInput ? 0.2 : 0.9,
        missingInformation: input.authorization?.needsCandidateInput
          ? ['Your work authorisation is not recorded. This must come from you — it cannot be inferred.']
          : [],
      });

    case 'notice_period':
      return preparedAnswerSchema.parse({
        question: input.question,
        kind: 'notice_period',
        recommendedAnswer:
          input.noticePeriod ??
          (input.availableFrom
            ? `Available from ${input.availableFrom.toISOString().slice(0, 10)}.`
            : null),
        confidence: input.noticePeriod || input.availableFrom ? 0.9 : 0.1,
        missingInformation:
          input.noticePeriod || input.availableFrom
            ? []
            : ['Your notice period and availability date are not recorded.'],
      });

    case 'experience_years':
      return preparedAnswerSchema.parse({
        question: input.question,
        kind: 'experience_years',
        recommendedAnswer:
          input.yearsOfExperience === null
            ? null
            : `${input.yearsOfExperience} years, based on the roles on your profile.`,
        confidence: input.yearsOfExperience === null ? 0.1 : 0.85,
        missingInformation:
          input.yearsOfExperience === null ? ['Your total years of experience are not recorded.'] : [],
      });

    case 'behavioral': {
      const story = input.strengths.find((claim) => claim.evidence.some((ref) => ref.quote.length > 60));

      if (!story) {
        /*
         * The important refusal. Assembling a STAR answer from skill mentions
         * would produce something the candidate has to defend in an interview
         * and cannot, because it did not happen to them.
         */
        return preparedAnswerSchema.parse({
          question: input.question,
          kind: 'behavioral',
          recommendedAnswer: null,
          confidence: 0.1,
          missingInformation: [
            'No experience on your profile has enough detail to answer this. Tell us about a relevant situation and we can structure it.',
          ],
        });
      }

      const ref = story.evidence[0]!;

      return preparedAnswerSchema.parse({
        question: input.question,
        kind: 'behavioral',
        recommendedAnswer:
          'Structure this as situation, task, action, result — the outline below is drawn from your own record. Fill in the outcome in your own words.',
        evidence: [ref],
        star: {
          situation: ref.locator ? `At ${ref.locator}.` : 'From your recorded experience.',
          task: story.claim,
          action: ref.quote,
          result:
            'Add the outcome yourself — we will not put a number here that your record does not contain.',
          evidence: [ref],
        },
        confidence: 0.55,
        missingInformation: ['The result. Only you know how it turned out.'],
      });
    }

    case 'motivation':
      return preparedAnswerSchema.parse({
        question: input.question,
        kind: 'motivation',
        recommendedAnswer: null,
        confidence: 0.15,
        missingInformation: [
          'Why you want this role is yours to say. A generated answer here reads as generated.',
        ],
      });

    case 'fit': {
      if (input.strengths.length === 0) {
        return preparedAnswerSchema.parse({
          question: input.question,
          kind: 'fit',
          recommendedAnswer: null,
          confidence: 0.1,
          missingInformation: ['No evidenced strengths for this role yet.'],
        });
      }

      return preparedAnswerSchema.parse({
        question: input.question,
        kind: 'fit',
        recommendedAnswer: `Lead with: ${input.strengths
          .slice(0, 3)
          .map((claim) => claim.claim)
          .join('; ')}.`,
        evidence: input.strengths.slice(0, 3).flatMap((claim) => claim.evidence.slice(0, 1)),
        confidence: 0.75,
      });
    }

    default:
      return preparedAnswerSchema.parse({
        question: input.question,
        kind: input.kind,
        recommendedAnswer: null,
        confidence: 0.1,
        missingInformation: ['This question needs an answer only you can give.'],
      });
  }
}

// ── Salary (Parts 30, 31) ───────────────────────────────────────────────────

export interface SalaryInput {
  /** What the posting states. Null when it says nothing. */
  postedMin: number | null;
  postedMax: number | null;
  postedCurrency: string | null;
  /** What the candidate configured. Never derived from their history. */
  targetMin: number | null;
  targetCurrency: string | null;
  /** Only from a real source. Null is the normal case. */
  marketMedian?: number | null;
  marketSource?: string | null;
}

/**
 * What to say about money.
 *
 * Four strategies, chosen by what is actually known. The one this refuses to do
 * is invent a number: with no posted range, no configured target and no market
 * data, the correct advice is to defer, and saying "ask for $85,000" on no
 * basis would be advice the candidate cannot justify and might regret.
 */
export function prepareSalaryGuidance(input: SalaryInput): SalaryGuidance {
  const posted =
    input.postedMin !== null
      ? `${input.postedCurrency ?? ''} ${input.postedMin.toLocaleString()}${
          input.postedMax ? `–${input.postedMax.toLocaleString()}` : '+'
        }`.trim()
      : null;

  const target =
    input.targetMin !== null
      ? `${input.targetCurrency ?? ''} ${input.targetMin.toLocaleString()}+`.trim()
      : null;

  const market =
    input.marketMedian !== null && input.marketMedian !== undefined && input.marketSource
      ? `Estimated market median ${input.marketMedian.toLocaleString()} (${input.marketSource}).`
      : null;

  if (posted) {
    return salaryGuidanceSchema.parse({
      strategy: 'range',
      postedRange: posted,
      candidateTarget: target,
      marketContext: market,
      recommendedResponse:
        `The posting states ${posted}. Anchoring inside the stated range is the safest answer` +
        (target ? `, and it sits against your target of ${target}.` : '.'),
      considerations: [
        'A posted range is usually the band they have approved, not an opening bid.',
        ...(target && input.postedMin !== null && input.targetMin !== null && input.targetMin > input.postedMin
          ? ['Your target sits above the bottom of their range — say so early rather than late.']
          : []),
      ],
      containsEstimates: market !== null,
    });
  }

  if (target) {
    return salaryGuidanceSchema.parse({
      strategy: 'range',
      postedRange: null,
      candidateTarget: target,
      marketContext: market,
      recommendedResponse: `Give a range built around your target of ${target} rather than a single figure.`,
      considerations: ['The posting states nothing, so you are setting the anchor.'],
      containsEstimates: market !== null,
    });
  }

  if (market) {
    return salaryGuidanceSchema.parse({
      strategy: 'market_anchored',
      postedRange: null,
      candidateTarget: null,
      marketContext: market,
      recommendedResponse:
        'Anchor on the market estimate below, and label it as an estimate if asked where it comes from.',
      considerations: ['This is an estimate, not a figure either party has stated.'],
      containsEstimates: true,
    });
  }

  /*
   * Nothing known. Deferring is the honest answer, and inventing a number here
   * would be the single most consequential fabrication in this file.
   */
  return salaryGuidanceSchema.parse({
    strategy: 'defer',
    postedRange: null,
    candidateTarget: null,
    marketContext: null,
    recommendedResponse:
      'The posting states no salary and you have not set a target, so there is no basis for a number. Ask what range they have budgeted, or set your target in your profile first.',
    considerations: ['Nothing here is known. Any figure would be invented.'],
    containsEstimates: false,
  });
}

// ── Authorisation (Part 32) ─────────────────────────────────────────────────

export interface AuthorizationAnswerInput {
  authorizedCountries: readonly string[];
  requiresSponsorship: boolean | null;
  /** What the posting says, when it says anything. */
  employerSponsorship: 'offered' | 'not_offered' | 'unclear' | 'not_mentioned' | null;
  jobCountry: string | null;
}

/**
 * The authorisation answer.
 *
 * Every field comes from the candidate's own configuration. Nothing is inferred
 * from nationality, location, name or anything else — inferring someone's right
 * to work from who they appear to be is wrong on the facts and wrong in
 * principle, and the only correct source is what they told us.
 */
export function prepareAuthorizationGuidance(input: AuthorizationAnswerInput): AuthorizationGuidance {
  const countries = input.authorizedCountries.map((code) => code.toUpperCase());

  if (countries.length === 0 && input.requiresSponsorship === null) {
    return authorizationGuidanceSchema.parse({
      authorizedCountries: [],
      requiresSponsorship: null,
      employerPosition: describeEmployer(input.employerSponsorship),
      recommendedResponse:
        'Your work authorisation is not recorded, and it cannot be guessed. Set it in your profile before answering this — an incorrect answer here is difficult to walk back.',
      needsCandidateInput: true,
    });
  }

  const authorisedHere =
    input.jobCountry !== null && countries.includes(input.jobCountry.toUpperCase());

  if (authorisedHere) {
    return authorizationGuidanceSchema.parse({
      authorizedCountries: countries,
      requiresSponsorship: false,
      employerPosition: describeEmployer(input.employerSponsorship),
      recommendedResponse: `Yes — you are authorised to work in ${input.jobCountry}. No sponsorship required.`,
      needsCandidateInput: false,
    });
  }

  const needsSponsorship = input.requiresSponsorship ?? true;

  return authorizationGuidanceSchema.parse({
    authorizedCountries: countries,
    requiresSponsorship: needsSponsorship,
    employerPosition: describeEmployer(input.employerSponsorship),
    recommendedResponse: needsSponsorship
      ? `You would need sponsorship for this role. Say so plainly and early — ${
          input.employerSponsorship === 'offered'
            ? 'this employer states they sponsor, so it should not be a barrier.'
            : 'it is better to find out now than after two interviews.'
        }`
      : `You are authorised in ${countries.join(', ')}. Confirm whether that covers this role's location.`,
    needsCandidateInput: false,
  });
}

function describeEmployer(position: AuthorizationAnswerInput['employerSponsorship']): string | null {
  switch (position) {
    case 'offered':
      return 'The employer states they offer sponsorship.';
    case 'not_offered':
      return 'The employer states they do not sponsor.';
    case 'unclear':
      return 'The posting mentions sponsorship but is ambiguous.';
    default:
      return null;
  }
}

/** Evidence refs from a claim, for callers assembling a package. */
export function refsOf(claims: readonly SupportedClaim[]): EvidenceRef[] {
  return claims.flatMap((claim) => claim.evidence);
}
