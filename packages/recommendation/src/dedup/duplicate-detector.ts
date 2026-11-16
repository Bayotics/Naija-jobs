import {
  dedupConfigSchema,
  type DedupConfig,
  type DedupSignalResult,
  type DuplicateTier,
  type DuplicateVerdict,
} from '@job-intel/contracts';
import { simhashDistance } from '@job-intel/core';
import { VETO_SIGNALS, computeSignals, type DedupCandidate } from './signals';

/**
 * Multi-stage duplicate detection.
 *
 * Four stages, cheapest first, each able to answer on its own:
 *
 *   1. **Identity** — same application URL, canonical URL, ATS posting or
 *      per-source external id. Near-proof; short-circuits.
 *   2. **Veto** — different company or different ATS posting. Near-disproof;
 *      short-circuits the other way, because a job description copied between
 *      two employers must never merge them.
 *   3. **Weighted evidence** — every remaining signal, weighted, with
 *      `unknown` contributing nothing to either side.
 *   4. **Near-duplicate text** — SimHash distance, used to lift a borderline
 *      verdict rather than to create one.
 *
 * The output is a *confidence and a tier*, never a bare boolean. Merging is a
 * destructive act; the caller needs to know how sure the system was, and a
 * later "why were these merged?" has to be answerable from the record.
 */

export interface DuplicateDetectorOptions {
  config?: Partial<DedupConfig>;
}

export class DuplicateDetector {
  readonly config: DedupConfig;

  constructor(options: DuplicateDetectorOptions = {}) {
    this.config = dedupConfigSchema.parse(options.config ?? {});
  }

  /**
   * Compares two postings.
   *
   * Pure: no database, no clock, no network. Everything it needs is in the two
   * candidates, which is what lets the twenty-one dedup scenarios in the test
   * suite be written as plain data.
   */
  compare(a: DedupCandidate, b: DedupCandidate): DuplicateVerdict {
    if (a.jobId === b.jobId) {
      return this.verdict(1, [], [], 'same record');
    }

    const signals = computeSignals(a, b, {
      postedWindowDays: this.config.postedWindowDays,
    });
    const byName = new Map(signals.map((s) => [s.signal, s]));
    const conflicts = signals.filter((s) => s.agreement === 'conflict');

    // ── Stage 2: vetoes ─────────────────────────────────────────────────────
    // Checked before the identity short-circuit deliberately. A shared ATS
    // vendor with different slugs, or two genuinely different companies, is
    // decisive whatever the URLs happen to look like.
    const veto = conflicts.find((s) => VETO_SIGNALS.has(s.signal));
    if (veto) {
      return this.verdict(0, signals, conflicts, `not a duplicate: ${veto.detail}`);
    }

    // ── Stage 1: identity ───────────────────────────────────────────────────
    const identity = (['application_url', 'ats_identity', 'canonical_url', 'external_id'] as const)
      .map((name) => byName.get(name))
      .find((s): s is DedupSignalResult => s?.agreement === 'match' && s.strength >= 1);

    if (identity) {
      // Still capped below 1 unless the company also agrees: an application URL
      // can be a shared recruiter portal serving several employers.
      const companyAgrees = byName.get('company')?.agreement === 'match';
      const confidence = companyAgrees ? 0.99 : 0.9;
      return this.verdict(confidence, signals, conflicts, identity.detail);
    }

    // ── Stage 3: weighted evidence ──────────────────────────────────────────
    let agree = 0;
    let disagree = 0;
    for (const signal of signals) {
      if (signal.agreement === 'match') agree += signal.weight * signal.strength;
      else if (signal.agreement === 'conflict') disagree += signal.weight * signal.strength;
      // `unknown` contributes to neither. Shared silence is not agreement.
    }

    const total = agree + disagree;
    let confidence = total === 0 ? 0 : agree / total;

    // A verdict resting on almost no evidence must not be confident, however
    // one-sided it is. Two postings agreeing only on their country are not a
    // duplicate at 100%.
    const evidenceMass = Math.min(1, total / 1.8);
    confidence *= evidenceMass;

    // Agreement on metadata and text alone is strong evidence, never proof:
    // two simultaneous openings on one team genuinely look like this. Only an
    // identity signal (stage 1) may reach the `exact` tier.
    confidence = Math.min(confidence, 0.94);

    // ── Stage 4: near-duplicate text ────────────────────────────────────────
    let reason = '';
    if (a.simhash && b.simhash) {
      const distance = simhashDistance(a.simhash, b.simhash);
      if (distance <= this.config.simhashMaxDistance) {
        const lift = 0.15 * (1 - distance / Math.max(1, this.config.simhashMaxDistance + 1));
        confidence = Math.min(0.96, confidence + lift);
        reason = `near-identical description text (simhash distance ${distance})`;
      }
    }

    return this.verdict(confidence, signals, conflicts, reason);
  }

  /**
   * The best duplicate among a candidate set.
   *
   * Blocking happens upstream (the repository selects only same-fingerprint or
   * same-company rows), so this loop is over a handful of records rather than
   * the whole corpus — which is what keeps deduplication linear.
   */
  findBest(
    subject: DedupCandidate,
    candidates: readonly DedupCandidate[],
  ): { candidate: DedupCandidate; verdict: DuplicateVerdict } | null {
    let best: { candidate: DedupCandidate; verdict: DuplicateVerdict } | null = null;
    for (const candidate of candidates) {
      if (candidate.jobId === subject.jobId) continue;
      const verdict = this.compare(subject, candidate);
      if (verdict.duplicateConfidence < this.config.reviewThreshold) continue;
      if (!best || verdict.duplicateConfidence > best.verdict.duplicateConfidence) {
        best = { candidate, verdict };
      }
    }
    return best;
  }

  private tierFor(confidence: number): DuplicateTier {
    const t = this.config.tierThresholds;
    if (confidence >= t.exact) return 'exact';
    if (confidence >= t.strong) return 'strong';
    if (confidence >= t.probable) return 'probable';
    if (confidence >= t.weak) return 'weak';
    return 'distinct';
  }

  private verdict(
    confidence: number,
    signals: DedupSignalResult[],
    conflicts: DedupSignalResult[],
    headline: string,
  ): DuplicateVerdict {
    const rounded = Math.round(Math.max(0, Math.min(1, confidence)) * 1000) / 1000;
    const tier = this.tierFor(rounded);

    // The reason is assembled from the strongest agreeing signals so the
    // explanation is always the arithmetic, never a summary of it.
    const supporting = signals
      .filter((s) => s.agreement === 'match')
      .sort((a, b) => b.weight * b.strength - a.weight * a.strength)
      .slice(0, 3)
      .map((s) => s.detail);

    const parts = [headline, ...supporting].filter(Boolean);
    if (parts.length === 0) parts.push('no shared identifying signals');

    return {
      isDuplicate: rounded >= this.config.mergeThreshold,
      tier,
      duplicateConfidence: rounded,
      duplicateReason: parts.join('; ').slice(0, 500),
      signals,
      conflicts,
    };
  }
}
