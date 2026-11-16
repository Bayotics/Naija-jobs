import type { Compensation, QualityAssessment, QualityFlag } from '@job-intel/contracts';
import { collapseWhitespace } from '@job-intel/core';

/**
 * Job quality and scam analysis.
 *
 * Two deliberately separate scores:
 *
 *   `qualityScore`  how complete and specific the posting is
 *   `scamScore`     how suspicious it looks
 *
 * Conflating them is a real failure mode: a three-line posting from a real
 * employer is low quality but not fraudulent, and if thin postings keep tripping
 * the scam flag you quickly learn to ignore the scam flag — exactly when it
 * matters. They are computed independently and reported independently.
 *
 * Nothing here deletes or hides a job. It assigns scores and flags; the ranking
 * engine decides how harshly to penalise them.
 */

interface ScamRule {
  flag: QualityFlag;
  weight: number;
  pattern: RegExp;
  note: string;
}

/**
 * Weights reflect how strongly each signal indicates fraud on its own.
 * Advance-fee patterns score highest: asking a candidate for money is the
 * defining feature of the job-scam genre and is common on open boards.
 */
const SCAM_RULES: ScamRule[] = [
  {
    flag: 'payment_requested',
    weight: 0.9,
    pattern: /\b(?:registration|processing|application|training|placement|admin(?:istrative)?)\s+fee\b|\bpay\s+(?:a\s+)?(?:fee|deposit)\b|\bsend\s+(?:us\s+)?money\b/i,
    note: 'asks the applicant to pay a fee',
  },
  {
    flag: 'personal_documents_requested',
    weight: 0.85,
    pattern: /\b(?:send|provide|submit)\s+(?:your\s+)?(?:bank\s+(?:account|details)|bvn|ssn|social security|passport\s+copy|credit card)\b/i,
    note: 'requests bank or identity documents up front',
  },
  {
    flag: 'crypto_payment',
    weight: 0.75,
    pattern: /\b(?:bitcoin|btc|usdt|crypto(?:currency)?)\s+(?:payment|wallet|only)\b|\bpaid\s+in\s+crypto\b/i,
    note: 'crypto-only payment',
  },
  {
    flag: 'suspicious_contact_method',
    weight: 0.6,
    pattern: /\b(?:whatsapp|telegram)\s*(?:us|me|:|\+|number)?\s*(?:\+?\d[\d\s-]{7,})?/i,
    note: 'directs applicants to WhatsApp/Telegram',
  },
  {
    flag: 'free_email_contact',
    weight: 0.45,
    pattern: /\b[\w.+-]+@(?:gmail|yahoo|hotmail|outlook|aol|protonmail)\.com\b/i,
    note: 'uses a free email address for applications',
  },
  {
    flag: 'no_experience_high_pay',
    weight: 0.5,
    pattern: /\bno\s+experience\s+(?:required|needed|necessary)\b[\s\S]{0,200}?(?:\$|£|€|₦)\s?[\d,]{4,}|\bearn\s+(?:up\s+to\s+)?(?:\$|£|€|₦)\s?[\d,]{3,}\s*(?:per|a)\s*(?:day|week)\b/i,
    note: 'high pay with no experience required',
  },
  {
    flag: 'excessive_urgency',
    weight: 0.3,
    // Deliberately excludes a bare "apply now": it is standard call-to-action
    // copy on legitimate boards, and flagging it would train the operator to
    // ignore the urgency signal exactly when it matters.
    pattern: /\b(?:urgent(?:ly)?\s+(?:needed|hiring|required)|apply\s+(?:immediately|within\s+\d+\s+hours?)|limited\s+slots?|first\s+come\s+first\s+serve|immediate\s+start\s+today)\b/i,
    note: 'excessive urgency language',
  },
];

/** Text that is present but carries no matching signal. */
const BOILERPLATE_PATTERN =
  /\b(?:equal opportunit|we are committed to divers|reasonable accommodation|background check)\w*\b/gi;

export interface QualityInput {
  title: string;
  companyName: string;
  description: string | null;
  /** Sanitized HTML, when available — hidden-content flags come from markup. */
  descriptionHtml?: string | null;
  compensation: Compensation;
  applicationUrl: string | null;
  /** Flags detected during normalization, e.g. zero-width characters. */
  contentFlags?: readonly string[];
  requirementCount: number;
  responsibilityCount: number;
  skillCount: number;
}

export function analyzeQuality(input: QualityInput): QualityAssessment {
  const description = input.description ?? '';
  const text = collapseWhitespace(description);
  const flags: QualityAssessment['flags'] = [];

  // ── Quality components ────────────────────────────────────────────────────
  const length = text.length;
  const lengthScore = length === 0 ? 0 : Math.min(1, Math.log10(length / 100 + 1) / Math.log10(31));
  const structureScore = Math.min(
    1,
    (input.requirementCount > 0 ? 0.4 : 0) +
      (input.responsibilityCount > 0 ? 0.3 : 0) +
      (input.skillCount >= 3 ? 0.3 : input.skillCount > 0 ? 0.15 : 0),
  );
  const companyScore = isIdentifiableCompany(input.companyName) ? 1 : 0;
  const urlScore = input.applicationUrl ? 1 : 0;
  const compensationScore = input.compensation.stated ? 1 : 0;

  const boilerplateMatches = description.match(BOILERPLATE_PATTERN)?.length ?? 0;
  const boilerplateRatio = length > 0 ? Math.min(1, (boilerplateMatches * 200) / length) : 0;

  if (length === 0) {
    flags.push({ flag: 'description_missing', weight: 1, evidence: 'no description text' });
  } else if (length < 200) {
    flags.push({
      flag: 'description_too_short',
      weight: 0.6,
      evidence: `description is only ${length} characters`,
    });
  }
  if (companyScore === 0) {
    flags.push({
      flag: 'company_unidentifiable',
      weight: 0.5,
      evidence: `company name "${input.companyName}" is not identifiable`,
    });
  }
  if (urlScore === 0) {
    flags.push({ flag: 'no_application_url', weight: 0.4, evidence: 'no application URL resolved' });
  }
  if (boilerplateRatio > 0.5) {
    flags.push({
      flag: 'boilerplate_heavy',
      weight: 0.3,
      evidence: 'a large share of the text is standard legal boilerplate',
    });
  }

  const components: Record<string, number> = {
    length: round(lengthScore),
    structure: round(structureScore),
    company: companyScore,
    applicationUrl: urlScore,
    compensation: compensationScore,
  };

  // Weighted so that *specificity* (structure, length) dominates. A stated
  // salary is a bonus, not a requirement — most legitimate postings omit it.
  const qualityScore = round(
    lengthScore * 0.3 +
      structureScore * 0.3 +
      companyScore * 0.2 +
      urlScore * 0.1 +
      compensationScore * 0.1,
  );

  // ── Scam signals ──────────────────────────────────────────────────────────
  const haystack = `${input.title}\n${description}`;
  let scamAccumulator = 0;

  for (const rule of SCAM_RULES) {
    const match = rule.pattern.exec(haystack);
    if (!match) continue;
    flags.push({
      flag: rule.flag,
      weight: rule.weight,
      evidence: `${rule.note}: "${collapseWhitespace(match[0]).slice(0, 160)}"`,
    });
    // Diminishing combination: several weak signals should not sum past 1, and
    // one strong signal should already be alarming.
    scamAccumulator = scamAccumulator + rule.weight * (1 - scamAccumulator);
  }

  for (const contentFlag of input.contentFlags ?? []) {
    flags.push({
      flag: 'hidden_content',
      weight: 0.6,
      evidence: `hidden content detected: ${contentFlag}`,
    });
    scamAccumulator = scamAccumulator + 0.6 * (1 - scamAccumulator);
  }

  // Implausible compensation. Only applied when a figure was actually stated,
  // and only above a wide threshold — senior roles legitimately pay a lot.
  const annual = input.compensation.conversion?.annualUsd ?? null;
  if (annual !== null && annual > 1_500_000) {
    flags.push({
      flag: 'unrealistic_compensation',
      weight: 0.5,
      evidence: `stated compensation converts to about $${annual.toLocaleString()} per year`,
    });
    scamAccumulator = scamAccumulator + 0.5 * (1 - scamAccumulator);
  }

  /**
   * Confidence in the assessment itself. A long posting gives the rules plenty
   * to work with; a two-line one gives almost nothing, so the verdict — in
   * either direction — deserves less weight.
   */
  const qualityConfidence = length === 0 ? 0.3 : Math.min(0.95, 0.4 + Math.min(0.55, length / 4000));

  return {
    qualityScore,
    scamScore: round(scamAccumulator),
    qualityConfidence: round(qualityConfidence),
    flags,
    components,
  };
}

/**
 * Whether a company name identifies an actual employer.
 *
 * Reddit posts carry "u/username" and some boards use placeholders; neither is
 * an employer, and treating them as one corrupts deduplication and grouping.
 */
function isIdentifiableCompany(name: string): boolean {
  const trimmed = collapseWhitespace(name);
  if (trimmed.length < 2) return false;
  if (/^u\//i.test(trimmed)) return false;
  return !/^(?:unknown|n\/a|na|see posting|confidential|private|company|employer|-{1,3})$/i.test(
    trimmed,
  );
}

function round(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}
