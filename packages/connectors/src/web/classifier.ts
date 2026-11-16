import {
  contentClassificationSchema,
  type ContentClassification,
} from '@job-intel/contracts';

/**
 * Job classification for ambiguous content.
 *
 * Used in two places the brief calls out separately but which share a problem:
 * a web page that might be a posting, and a social post that might be a job
 * lead. Both arrive as text with no structure, and both are expensive to get
 * wrong in the same direction — a false positive becomes a job record that
 * looks exactly like a real one.
 *
 * Three rules hold here:
 *
 *  1. **Deterministic first, and often deterministic only.** The gate in
 *     `extract/content.ts` rejects obvious non-jobs before any model is called,
 *     and `heuristicClassify` answers confidently on its own for clear cases.
 *     The model is for the genuinely ambiguous middle.
 *  2. **Strict schema, no repair.** A response that does not validate is a
 *     failed classification, not a partial one. Coercing a malformed answer
 *     into shape invents the very fields most likely to be wrong.
 *  3. **Never fabricate.** Every extracted field is optional and defaults to
 *     null. "The post does not say" is the correct answer far more often than
 *     any particular company name.
 */

export interface ClassificationInput {
  text: string;
  url: string | null;
  /** Title, subreddit, author handle — whatever context the source supplies. */
  metadata?: Record<string, string | null>;
}

/** Port implemented by the AI layer. Absent means deterministic-only. */
export interface ClassificationProvider {
  readonly id: string;
  readonly model: string;
  classify(input: ClassificationInput): Promise<unknown>;
}

export interface ClassificationResult {
  classification: ContentClassification;
  /** How the verdict was reached, for the provenance trail. */
  method: 'heuristic' | 'ai' | 'ai_failed_fallback';
  modelUsed: string | null;
  error: string | null;
}

const STRONG_JOB_PHRASES = [
  'we are hiring',
  "we're hiring",
  'now hiring',
  'job description',
  'apply now',
  'apply here',
  'job opening',
  'open position',
  'responsibilities',
  'qualifications',
  'what you will do',
  'requirements:',
  'send your cv',
  'send your resume',
  'to apply',
];

const RECRUITER_PHRASES = [
  'my client is looking',
  'i am recruiting',
  'reach out to me',
  'dm me your cv',
  'dm me your resume',
  'referral bonus',
];

const ADVICE_PHRASES = [
  'how to get a job',
  'interview tips',
  'resume tips',
  'cv tips',
  'career advice',
  'my journey',
  'ama',
  'ask me anything',
  'should i accept',
  'is it worth',
];

const SPAM_PHRASES = [
  'earn $',
  'work from home guaranteed',
  'no experience needed guaranteed',
  'telegram',
  'whatsapp only',
  'crypto investment',
  'registration fee',
  'pay a fee',
];

function countPhrases(haystack: string, phrases: string[]): number {
  return phrases.filter((phrase) => haystack.includes(phrase)).length;
}

/**
 * A deterministic verdict, plus whether it is confident enough to stand alone.
 *
 * Exported because the same logic gates the model call: content this can settle
 * should never cost a request.
 */
export function heuristicClassify(input: ClassificationInput): {
  classification: ContentClassification;
  decisive: boolean;
} {
  const haystack = `${Object.values(input.metadata ?? {}).join(' ')} ${input.text}`.toLowerCase();

  const spam = countPhrases(haystack, SPAM_PHRASES);
  const strong = countPhrases(haystack, STRONG_JOB_PHRASES);
  const recruiter = countPhrases(haystack, RECRUITER_PHRASES);
  const advice = countPhrases(haystack, ADVICE_PHRASES);

  if (spam >= 2) {
    return {
      classification: contentClassificationSchema.parse({
        isJob: false,
        contentType: 'spam',
        confidence: 0.85,
        reason: `Matched ${spam} spam indicators such as up-front fees or off-platform contact only`,
      }),
      decisive: true,
    };
  }

  if (strong >= 3 && advice === 0) {
    return {
      classification: contentClassificationSchema.parse({
        isJob: true,
        contentType: 'job_posting',
        confidence: Math.min(0.9, 0.6 + strong * 0.05),
        reason: `Contains ${strong} job-posting phrases including responsibilities and how to apply`,
      }),
      decisive: true,
    };
  }

  if (advice >= 2 && strong === 0) {
    return {
      classification: contentClassificationSchema.parse({
        isJob: false,
        contentType: 'career_advice',
        confidence: 0.8,
        reason: `Reads as career discussion (${advice} advice phrases, no posting vocabulary)`,
      }),
      decisive: true,
    };
  }

  // Everything else is genuinely ambiguous. A recruiter announcement with one
  // job phrase could be either a lead or a full posting, and that distinction
  // is exactly what the model is for.
  return {
    classification: contentClassificationSchema.parse({
      isJob: strong > 0,
      contentType: recruiter > 0 ? 'recruiter_announcement' : strong > 0 ? 'job_lead' : 'discussion',
      confidence: 0.4,
      reason: 'Ambiguous: some job vocabulary but no decisive signal',
    }),
    decisive: false,
  };
}

/**
 * Classifies content, spending a model call only when it will change the answer.
 *
 * The provider being absent is a normal configuration, not a degraded one: the
 * heuristic verdict is returned and marked as such, and the caller can apply
 * its own confidence penalty.
 */
export async function classifyContent(
  input: ClassificationInput,
  options: {
    provider?: ClassificationProvider | null;
    /** Budget guard: returns false when the call must not be made. */
    canSpend?: () => boolean;
  } = {},
): Promise<ClassificationResult> {
  const heuristic = heuristicClassify(input);

  if (heuristic.decisive || !options.provider || options.canSpend?.() === false) {
    return {
      classification: heuristic.classification,
      method: 'heuristic',
      modelUsed: null,
      error: null,
    };
  }

  let raw: unknown;
  try {
    raw = await options.provider.classify(input);
  } catch (error) {
    return {
      classification: heuristic.classification,
      method: 'ai_failed_fallback',
      modelUsed: options.provider.model,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = contentClassificationSchema.safeParse(raw);
  if (!parsed.success) {
    // A malformed answer falls back to the deterministic verdict rather than
    // being patched. Half a classification is not half right.
    return {
      classification: heuristic.classification,
      method: 'ai_failed_fallback',
      modelUsed: options.provider.model,
      error: `Model response failed validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .slice(0, 3)
        .join('; ')}`,
    };
  }

  return {
    classification: parsed.data,
    method: 'ai',
    modelUsed: options.provider.model,
    error: null,
  };
}
