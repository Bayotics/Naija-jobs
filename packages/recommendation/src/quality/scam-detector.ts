import { z } from 'zod';
import type { ScamAssessment, ScamSignal, ScamVerdict } from '@job-intel/contracts';

/**
 * Scam and low-quality detection.
 *
 * Deterministic rules first, a model only where the rules are unsure, and the
 * two risks kept **separately** on the result. That last part is the design:
 * averaging a rule-based 0.2 and a model's 0.9 into "0.55" produces a number
 * nobody can act on and nobody can audit. Storing both lets the UI say "no rule
 * fired, but the model is uneasy", which is the truth.
 *
 * The model is also never the sole authority. It can raise risk within a bound
 * and it can corroborate, but a `likely_scam` verdict always has at least one
 * deterministic signal behind it — otherwise a hallucination could quarantine a
 * legitimate employer.
 */

export interface ScamDetectionInput {
  title: string;
  companyName: string;
  description: string | null;
  applyUrl: string | null;
  contactEmails: string[];
  salaryAnnualUsd: number | null;
  /** Requirement text; used for the "no experience, huge pay" pattern. */
  minYearsExperience: number | null;
  /** Copies of this exact description found under other employers. */
  copiedDescriptionCount: number;
}

interface Rule {
  name: string;
  weight: number;
  test: (input: ScamDetectionInput) => string | null;
}

/** Free-mail domains. A recruiter writing from one is a real warning sign. */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'aol.com',
  'protonmail.com',
  'yandex.com',
  'mail.com',
  'gmx.com',
  'zoho.com',
]);

/**
 * Rules, weighted by how damning each is on its own.
 *
 * Money and crypto are near-conclusive: no legitimate employer asks a candidate
 * to pay. Urgency and vagueness are suggestive at best and are weighted so that
 * several of them together still fall short of a `likely_scam` verdict.
 */
const RULES: Rule[] = [
  {
    name: 'requests_payment',
    weight: 0.95,
    test: ({ description }) => {
      const m =
        description &&
        /\b(?:registration|application|processing|training|placement|admin(?:istrative)?)\s+fee\b|\bpay\s+(?:a\s+)?(?:fee|deposit)\b|\bsend\s+(?:us\s+)?money\b/i.exec(
          description,
        );
      return m ? `payment requested: "${m[0]}"` : null;
    },
  },
  {
    name: 'crypto_payment',
    weight: 0.9,
    test: ({ description }) => {
      const m =
        description &&
        /\b(?:bitcoin|btc|ethereum|usdt|crypto(?:currency)?\s+wallet|binance\s+pay)\b/i.exec(description);
      return m ? `cryptocurrency mentioned: "${m[0]}"` : null;
    },
  },
  {
    name: 'personal_documents_requested',
    weight: 0.85,
    test: ({ description }) => {
      const m =
        description &&
        /\b(?:bank\s+(?:account|details)|bvn|social\s+security\s+number|ssn|passport\s+(?:copy|scan)|credit\s+card)\b/i.exec(
          description,
        );
      return m ? `sensitive details requested up front: "${m[0]}"` : null;
    },
  },
  {
    name: 'free_email_contact',
    weight: 0.55,
    test: ({ contactEmails }) => {
      const bad = contactEmails.find((e) => FREE_EMAIL_DOMAINS.has(e.split('@')[1]?.toLowerCase() ?? ''));
      return bad ? `applications go to a free-mail address (${bad})` : null;
    },
  },
  {
    name: 'no_experience_high_pay',
    weight: 0.6,
    test: ({ minYearsExperience, salaryAnnualUsd }) =>
      minYearsExperience !== null &&
      minYearsExperience <= 0 &&
      salaryAnnualUsd !== null &&
      salaryAnnualUsd > 150_000
        ? `no experience required at $${salaryAnnualUsd.toLocaleString()}/yr`
        : null,
  },
  {
    name: 'unrealistic_compensation',
    weight: 0.5,
    test: ({ salaryAnnualUsd }) =>
      salaryAnnualUsd !== null && salaryAnnualUsd > 1_500_000
        ? `stated salary of $${salaryAnnualUsd.toLocaleString()}/yr is implausible`
        : null,
  },
  {
    name: 'excessive_urgency',
    weight: 0.35,
    test: ({ description }) => {
      const m =
        description &&
        /\b(?:urgent(?:ly)?\s+(?:hiring|needed)|immediate\s+start|apply\s+(?:now|today)\s*!{1,}|limited\s+slots?)\b/i.exec(
          description,
        );
      return m ? `urgency language: "${m[0]}"` : null;
    },
  },
  {
    name: 'vague_company',
    weight: 0.4,
    test: ({ companyName }) =>
      /^(?:confidential|undisclosed|private|a\s+(?:leading|reputable|top)\b|our\s+client)/i.test(
        companyName.trim(),
      )
        ? `employer is not named ("${companyName}")`
        : null,
  },
  {
    name: 'copied_description',
    weight: 0.55,
    test: ({ copiedDescriptionCount }) =>
      copiedDescriptionCount >= 2
        ? `identical description appears under ${copiedDescriptionCount} other employers`
        : null,
  },
  {
    name: 'suspicious_contact_method',
    weight: 0.6,
    test: ({ description }) => {
      const m =
        description &&
        /\b(?:whatsapp|telegram|signal)\b[^.]{0,40}\b(?:\+?\d[\d\s-]{7,})/i.exec(description);
      return m ? `applications directed to a messaging app: "${m[0].slice(0, 60)}"` : null;
    },
  },
  {
    name: 'no_application_path',
    weight: 0.3,
    test: ({ applyUrl, contactEmails }) =>
      !applyUrl && contactEmails.length === 0 ? 'no application URL or contact address' : null,
  },
];

/** Schema for the model's reply. Anything failing it is discarded, not coerced. */
export const scamReasoningSchema = z.object({
  risk: z.number().min(0).max(1),
  concerns: z.array(z.string().max(200)).max(8).default([]),
  reasoning: z.string().max(600),
});
export type ScamReasoning = z.infer<typeof scamReasoningSchema>;

export interface ScamReasoningProvider {
  readonly id: string;
  readonly model: string;
  isAvailable(): boolean;
  assess(input: ScamDetectionInput, signal?: AbortSignal): Promise<ScamReasoning>;
}

export class NullScamReasoningProvider implements ScamReasoningProvider {
  readonly id = 'null';
  readonly model = 'none';
  isAvailable(): boolean {
    return false;
  }
  assess(): Promise<ScamReasoning> {
    return Promise.reject(new Error('No scam reasoning provider configured'));
  }
}

/** Most the model may add to the deterministic risk. */
export const MAX_AI_CONTRIBUTION = 0.25;

/** Deterministic pass. Complete on its own; the model is optional throughout. */
export function detectScamDeterministic(input: ScamDetectionInput): ScamAssessment {
  const signals: ScamSignal[] = [];

  for (const rule of RULES) {
    const evidence = rule.test(input);
    if (evidence) {
      signals.push({ signal: rule.name, weight: rule.weight, evidence, origin: 'deterministic' });
    }
  }

  // Noisy-OR rather than a sum: three weak signals should raise suspicion
  // without three of them adding up to certainty.
  const risk = signals.reduce((acc, s) => acc + (1 - acc) * s.weight, 0);
  return buildAssessment(risk, null, null, signals);
}

/**
 * Whether a model call is worth making.
 *
 * Only in the middle band. A posting with no signals is fine and one demanding
 * a registration fee is already decided — in both cases the model can only
 * cost money and introduce disagreement.
 */
export function shouldConsultModel(
  deterministic: ScamAssessment,
  bounds: { low: number; high: number } = { low: 0.15, high: 0.75 },
): boolean {
  return deterministic.risk >= bounds.low && deterministic.risk <= bounds.high;
}

/**
 * Folds a model's opinion into a deterministic assessment.
 *
 * The model may only add, never subtract, and never more than
 * `MAX_AI_CONTRIBUTION`. It cannot clear a posting the rules flagged, and it
 * cannot condemn one on its own — `likely_scam` still requires a deterministic
 * signal, so every quarantine has a rule behind it.
 */
export function combineWithReasoning(
  deterministic: ScamAssessment,
  reasoning: ScamReasoning,
  model: string,
): ScamAssessment {
  const aiSignals: ScamSignal[] = reasoning.concerns.map((concern) => ({
    signal: 'ai_concern',
    weight: reasoning.risk,
    evidence: concern,
    origin: 'ai' as const,
  }));

  const contribution = Math.min(MAX_AI_CONTRIBUTION, reasoning.risk * MAX_AI_CONTRIBUTION);
  const combined = Math.min(1, deterministic.deterministicRisk + contribution);

  return buildAssessment(combined, reasoning.risk, model, [...deterministic.signals, ...aiSignals]);
}

function buildAssessment(
  risk: number,
  aiRisk: number | null,
  aiModel: string | null,
  signals: ScamSignal[],
): ScamAssessment {
  const deterministicSignals = signals.filter((s) => s.origin === 'deterministic');
  const rounded = Math.round(Math.max(0, Math.min(1, risk)) * 1000) / 1000;

  // The guard that keeps a model from condemning a posting unaided.
  const verdict: ScamVerdict =
    rounded >= 0.7 && deterministicSignals.length > 0
      ? 'likely_scam'
      : rounded >= 0.35
        ? 'suspicious'
        : 'clear';

  const explanation =
    signals.length === 0
      ? 'No scam indicators found'
      : `${verdict.replace('_', ' ')} (risk ${rounded.toFixed(2)}): ` +
        signals
          .slice()
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 4)
          .map((s) => s.evidence ?? s.signal)
          .join('; ');

  return {
    risk: rounded,
    verdict,
    deterministicRisk:
      aiRisk === null
        ? rounded
        : Math.round(
            deterministicSignals.reduce((acc, s) => acc + (1 - acc) * s.weight, 0) * 1000,
          ) / 1000,
    aiRisk,
    aiModel,
    signals,
    explanation: explanation.slice(0, 500),
  };
}

/** The instruction sent with every scam-reasoning request. */
export const SCAM_REASONING_SYSTEM_PROMPT = [
  'You are reviewing a job posting for signs of fraud or bad faith.',
  '',
  'Deterministic rules have already run and their findings are supplied. Your',
  'task is to notice what pattern-matching cannot: internal inconsistency,',
  'implausible claims, and language typical of advance-fee and reshipping scams.',
  '',
  'Rules:',
  '- Do NOT flag a posting merely for omitting salary or being short. Most',
  '  legitimate postings do both.',
  '- Do NOT flag a posting for being from an unfamiliar company.',
  '- Cite specific text. Do not infer intent you cannot point at.',
  '- Your risk score is advisory and bounded by the caller; it cannot clear a',
  '  posting the rules flagged.',
  '- Respond only with JSON matching the requested schema.',
].join('\n');
