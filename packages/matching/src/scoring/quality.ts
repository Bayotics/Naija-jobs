import type { ComponentScore, QualityFlag } from '@job-intel/contracts';
import type { ScorerInput } from '../types';
import { clamp, score } from './util';

/**
 * Posting quality.
 *
 * The only dimension that judges the *advertisement* rather than the fit. It
 * earns a place in the weighted score because a perfectly-matching job behind a
 * fraudulent posting is not a good recommendation, and because ranking that
 * ignores quality fills the top of the list with recruiter spam that happens to
 * contain the right keywords.
 *
 * Kept at a low default weight: quality should break ties, not decide them.
 */

/** Flags about the reader's safety, as opposed to the posting's tidiness. */
const SERIOUS_FLAGS: ReadonlySet<QualityFlag> = new Set<QualityFlag>([
  'payment_requested',
  'crypto_payment',
  'personal_documents_requested',
  'suspicious_contact_method',
  'unrealistic_compensation',
  'no_experience_high_pay',
]);

export function scoreQuality(input: ScorerInput): ComponentScore {
  const quality = input.job.enrichment.quality;
  const flags = quality.flags.map((f) => f.flag);
  const serious = flags.filter((f) => SERIOUS_FLAGS.has(f));

  // Scam risk is subtracted rather than averaged in: a posting can be well
  // written and still fraudulent, and the polish must not offset the risk.
  const value = clamp((quality.qualityScore - quality.scamScore) * 100);
  const percent = Math.round(quality.qualityScore * 100);

  const explanation =
    serious.length > 0
      ? `Posting quality ${percent}/100 with risk flags: ${serious.join(', ')}`
      : flags.length > 0
        ? `Posting quality ${percent}/100 (${flags.join(', ')})`
        : `Posting quality ${percent}/100`;

  return score('quality', value, quality.qualityConfidence, explanation, flags);
}
