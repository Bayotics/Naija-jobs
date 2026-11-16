import {
  freshnessConfigSchema,
  type FreshnessConfig,
  type LifecycleStatus,
  type StalenessSignal,
  type StalenessSignalResult,
  type StalenessVerdict,
  type VerificationOutcome,
} from '@job-intel/contracts';

/**
 * Stale-job detection.
 *
 * Ten independent signals, weighted, producing a lifecycle status and a
 * confidence — not a deletion. Nothing here removes data, and that is a
 * deliberate constraint rather than caution: a source dropping a job from its
 * feed is weak evidence, feeds break, and a job wrongly deleted cannot be
 * recovered when it turns out to still be open.
 *
 * The statuses mean different things and are kept distinct:
 *
 *   ACTIVE  — believed open.
 *   STALE   — old enough to doubt, with no direct evidence it has closed.
 *   EXPIRED — the posting's own stated deadline has passed.
 *   CLOSED  — direct evidence: a 404/410, or explicit "position filled" text.
 *   UNKNOWN — genuinely undetermined. Not a synonym for ACTIVE.
 */

export interface StalenessInput {
  postedAt: Date | null;
  validThrough: Date | null;
  lastSeenAt: Date;
  lastVerifiedAt: Date | null;
  /** Consecutive source runs in which the listing did not appear. */
  absenceRuns: number;
  /** Most recent application-URL check, when one has been made. */
  verification: { outcome: VerificationOutcome; httpStatus: number | null } | null;
  /** Cleaned posting text, searched for closure language. */
  description: string | null;
  /** Set when the source explicitly reported the posting as removed. */
  removedFromSource: boolean;
  now?: Date;
}

/**
 * Closure language.
 *
 * Anchored to phrases employers actually use when closing a posting. Kept
 * narrow on purpose: "we are no longer accepting cover letters" must not close
 * a live job, so the patterns require the application itself as the object.
 */
const CLOSURE_PATTERNS: Array<{ pattern: RegExp; signal: StalenessSignal; weight: number }> = [
  {
    pattern: /\b(?:this )?position (?:has been |is |was )?(?:now )?filled\b/i,
    signal: 'position_filled_text',
    weight: 0.95,
  },
  {
    pattern: /\bno longer (?:accepting|receiving) applications?\b/i,
    signal: 'no_longer_accepting_text',
    weight: 0.95,
  },
  {
    pattern: /\bapplications? (?:are |is )?(?:now )?closed\b/i,
    signal: 'no_longer_accepting_text',
    weight: 0.9,
  },
  {
    pattern: /\b(?:this )?(?:job|vacancy|role|opening) (?:has )?(?:expired|closed)\b/i,
    signal: 'no_longer_accepting_text',
    weight: 0.85,
  },
];

function signal(
  name: StalenessSignal,
  strength: number,
  detail: string,
): StalenessSignalResult {
  return { signal: name, strength, detail };
}

export function detectStaleness(
  input: StalenessInput,
  config: Partial<FreshnessConfig> = {},
): StalenessVerdict {
  const cfg = freshnessConfigSchema.parse(config);
  const now = input.now ?? new Date();
  const signals: StalenessSignalResult[] = [];

  // ── Direct evidence of closure ──────────────────────────────────────────
  if (input.verification) {
    const { outcome, httpStatus } = input.verification;
    if (outcome === 'not_found' || httpStatus === 404) {
      signals.push(signal('http_404', 0.9, 'application URL returns 404'));
    } else if (outcome === 'gone' || httpStatus === 410) {
      signals.push(signal('dead_application_url', 0.95, 'application URL returns 410 Gone'));
    } else if (outcome === 'error') {
      // A transient error is not evidence of closure. Recorded weakly so it
      // shows up in the trace without moving the verdict on its own.
      signals.push(signal('http_error', 0.15, 'application URL check failed'));
    }
  }

  if (input.description) {
    for (const { pattern, signal: name, weight } of CLOSURE_PATTERNS) {
      const match = pattern.exec(input.description);
      if (match) {
        signals.push(signal(name, weight, `posting says "${match[0].trim()}"`));
        break;
      }
    }
  }

  if (input.removedFromSource) {
    signals.push(signal('source_removed', 0.75, 'source reported the posting as removed'));
  }

  // ── Deadlines ───────────────────────────────────────────────────────────
  if (input.validThrough && input.validThrough.getTime() < now.getTime()) {
    signals.push(
      signal(
        'past_valid_through',
        0.9,
        `stated deadline passed on ${input.validThrough.toISOString().slice(0, 10)}`,
      ),
    );
  }

  // ── Indirect evidence ───────────────────────────────────────────────────
  if (input.absenceRuns >= cfg.absenceRunsBeforeClosed) {
    signals.push(
      signal(
        'absent_from_source',
        0.7,
        `missing from ${input.absenceRuns} consecutive source runs`,
      ),
    );
  } else if (input.absenceRuns > 0) {
    signals.push(
      signal('absent_from_source', 0.25 * input.absenceRuns, `missing from ${input.absenceRuns} run(s)`),
    );
  }

  const reference = input.postedAt ?? input.lastSeenAt;
  const ageDays = (now.getTime() - reference.getTime()) / 86_400_000;
  if (ageDays > cfg.staleAfterDays) {
    // Age alone never closes a job. Plenty of real postings sit open for
    // months, and treating age as closure would suppress them wrongly.
    signals.push(
      signal(
        'old_posting',
        Math.min(0.6, 0.3 + (ageDays - cfg.staleAfterDays) / (cfg.staleAfterDays * 4)),
        `${Math.round(ageDays)} days old`,
      ),
    );
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  const strongest = signals.reduce((max, s) => Math.max(max, s.strength), 0);

  let status: LifecycleStatus = 'ACTIVE';
  let confidence = 0.7;

  const closureSignal = signals.find(
    (s) =>
      s.strength >= 0.75 &&
      (s.signal === 'http_404' ||
        s.signal === 'dead_application_url' ||
        s.signal === 'position_filled_text' ||
        s.signal === 'no_longer_accepting_text' ||
        s.signal === 'source_removed'),
  );

  if (closureSignal) {
    status = 'CLOSED';
    confidence = closureSignal.strength;
  } else if (signals.some((s) => s.signal === 'past_valid_through')) {
    status = 'EXPIRED';
    confidence = 0.9;
  } else if (strongest >= 0.5) {
    status = 'STALE';
    confidence = strongest;
  } else if (input.postedAt === null && input.lastVerifiedAt === null && ageDays > cfg.staleAfterDays) {
    // No stated date, never verified, and old by the only clock available.
    // "We do not know" is the honest answer, and it is not ACTIVE.
    status = 'UNKNOWN';
    confidence = 0.4;
  } else if (signals.length > 0) {
    status = 'ACTIVE';
    confidence = Math.max(0.4, 0.7 - strongest);
  } else {
    confidence = input.lastVerifiedAt ? 0.85 : 0.65;
  }

  const explanation =
    signals.length === 0
      ? 'No staleness signals; treated as active'
      : `${status}: ${signals
          .slice()
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 3)
          .map((s) => s.detail)
          .join('; ')}`;

  return {
    status,
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 1000) / 1000,
    signals,
    explanation: explanation.slice(0, 400),
  };
}

/** Multiplier applied to the recommendation score for each lifecycle status. */
export const LIFECYCLE_MULTIPLIERS: Readonly<Record<LifecycleStatus, number>> = {
  ACTIVE: 1,
  // Still worth showing — plenty of month-old postings are open — but it must
  // not outrank a fresh equivalent.
  STALE: 0.65,
  UNKNOWN: 0.85,
  EXPIRED: 0.15,
  CLOSED: 0,
};
