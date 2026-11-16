import {
  digestPlanSchema,
  type ApplicationRecommendation,
  type DigestPlan,
  type DigestSectionKind,
  type NotificationIntelligenceConfig,
  type NotificationScore,
  type NotificationType,
} from '@job-intel/contracts';

/**
 * Digest assembly.
 *
 * The failure mode this module exists to avoid is the one the brief names:
 * dumping every discovered job into an email. A digest with sixty entries is
 * not more useful than one with eight — it is less useful, because nobody reads
 * past the first screen and the good ones are now buried among the rest.
 *
 * Two properties are load-bearing.
 *
 * **It is reproducible.** The plan is a pure function of its inputs, including
 * the window, so regenerating a digest for a past window produces the same
 * digest. That makes "why did I get this?" answerable weeks later, and makes
 * the whole thing testable without a clock.
 *
 * **Exclusions are counted.** A digest that quietly dropped forty jobs looks
 * identical to one that had eight candidates. The plan records what was left
 * out and why, so the dashboard can show the difference.
 */

export interface DigestCandidate {
  jobId: string;
  companyKey: string;
  companyName: string | null;
  score: NotificationScore;
  recommendation: ApplicationRecommendation | null;
  /** True when this company has not appeared in a previous digest. */
  newCompany: boolean;
  /** Already sent as an instant alert in this window. */
  alertedSeparately: boolean;
  discoveredAt: Date;
}

export interface DigestPlanInput {
  candidateId: string;
  type: NotificationType;
  windowStart: Date;
  windowEnd: Date;
  candidates: readonly DigestCandidate[];
  config: NotificationIntelligenceConfig;
  maxJobs: number;
  maxPerCompany: number;
  /** Reminders and insights, assembled by their own modules. */
  applicationReminders?: readonly string[];
  learningInsights?: readonly string[];
  now?: Date;
}

/**
 * Ranking inside the digest.
 *
 * Notification score first, because it already blends fit, timing and rarity.
 * Recommendation breaks ties, so an APPLY at 71 sits above a CONSIDER at 71 —
 * two jobs that score the same are not equally worth the reader's next minute.
 */
const RECOMMENDATION_RANK: Readonly<Record<string, number>> = {
  APPLY_NOW: 5,
  APPLY: 4,
  CONSIDER: 3,
  UNKNOWN: 2,
  SKIP: 1,
  BLOCKED: 0,
};

function rank(a: DigestCandidate, b: DigestCandidate): number {
  const byScore = b.score.score - a.score.score;
  if (Math.abs(byScore) > 0.5) return byScore;

  const byRecommendation =
    (RECOMMENDATION_RANK[b.recommendation ?? 'UNKNOWN'] ?? 2) -
    (RECOMMENDATION_RANK[a.recommendation ?? 'UNKNOWN'] ?? 2);
  if (byRecommendation !== 0) return byRecommendation;

  // Newest last, so a reader working down the list meets the freshest first.
  return b.discoveredAt.getTime() - a.discoveredAt.getTime();
}

export function planDigest(input: DigestPlanInput): DigestPlan {
  const excluded: Record<string, number> = {};
  const drop = (reason: string): void => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };

  // ── Eligibility ─────────────────────────────────────────────────────────
  const eligible: DigestCandidate[] = [];

  for (const candidate of input.candidates) {
    if (candidate.score.deadline.bucket === 'expired') {
      drop('expired');
      continue;
    }

    /*
     * Already sent as an instant alert.
     *
     * Repeating it in the evening digest is the single most irritating thing a
     * notification system does — the candidate reads the same job twice and
     * concludes the system is not paying attention.
     */
    if (candidate.alertedSeparately) {
      drop('already_alerted');
      continue;
    }

    if (candidate.score.score < input.config.thresholds.digest) {
      drop('below_digest_threshold');
      continue;
    }

    eligible.push(candidate);
  }

  // ── Deduplicate by job ──────────────────────────────────────────────────
  const seen = new Set<string>();
  const deduped: DigestCandidate[] = [];

  for (const candidate of eligible.sort(rank)) {
    if (seen.has(candidate.jobId)) {
      drop('duplicate');
      continue;
    }
    seen.add(candidate.jobId);
    deduped.push(candidate);
  }

  // ── Company cap ─────────────────────────────────────────────────────────
  /*
   * One employer posting twelve roles should not fill the digest.
   *
   * Applied after ranking so the cap keeps each company's *best* entries rather
   * than whichever happened to be discovered first.
   */
  const perCompany = new Map<string, number>();
  const capped: DigestCandidate[] = [];

  for (const candidate of deduped) {
    const used = perCompany.get(candidate.companyKey) ?? 0;

    if (used >= input.maxPerCompany) {
      drop('company_cap');
      continue;
    }

    perCompany.set(candidate.companyKey, used + 1);
    capped.push(candidate);
  }

  const selected = capped.slice(0, input.maxJobs);
  const overflow = capped.length - selected.length;
  if (overflow > 0) excluded['over_digest_size'] = overflow;

  // ── Sections ────────────────────────────────────────────────────────────
  const sections: DigestPlan['sections'] = [];

  const addSection = (
    kind: DigestSectionKind,
    title: string,
    jobIds: string[],
    note: string,
  ): void => {
    if (jobIds.length === 0) return;
    sections.push({ kind, title, jobIds: jobIds.slice(0, 50), note });
  };

  /*
   * Sections are assigned by first claim, so no job appears twice.
   *
   * A role that is both a top opportunity and expiring belongs in the section
   * the reader will act on first, and listing it in both would pad the digest
   * with repetition.
   */
  const claimed = new Set<string>();
  const claim = (candidates: DigestCandidate[]): string[] => {
    const ids: string[] = [];
    for (const candidate of candidates) {
      if (claimed.has(candidate.jobId)) continue;
      claimed.add(candidate.jobId);
      ids.push(candidate.jobId);
    }
    return ids;
  };

  const expiring = selected.filter(
    (candidate) =>
      candidate.score.deadline.bucket === 'under_24h' ||
      candidate.score.deadline.bucket === 'one_to_three_days',
  );

  addSection(
    'expiring',
    'Closing soon',
    claim(expiring),
    'These have a stated deadline within three days.',
  );

  const top = selected.filter(
    (candidate) => candidate.score.score >= input.config.thresholds.instant - 10,
  );

  addSection(
    'top_opportunities',
    'Top opportunities',
    claim(top),
    'Highest notification score, weighing fit, timing and how rare the combination is.',
  );

  const newCompanies = selected.filter((candidate) => candidate.newCompany);
  addSection(
    'new_companies',
    'Employers new to you',
    claim(newCompanies),
    'Companies that have not appeared in a previous digest.',
  );

  addSection(
    'strong_matches',
    'Strong matches',
    claim(selected),
    'Everything else that cleared your digest threshold.',
  );

  if (input.applicationReminders && input.applicationReminders.length > 0) {
    sections.push({
      kind: 'application_reminders',
      title: 'Applications to follow up',
      jobIds: [],
      note: input.applicationReminders.slice(0, 5).join(' ').slice(0, 300),
    });
  }

  if (input.learningInsights && input.learningInsights.length > 0) {
    sections.push({
      kind: 'learning_insights',
      title: 'What your activity suggests',
      jobIds: [],
      note: input.learningInsights.slice(0, 3).join(' ').slice(0, 300),
    });
  }

  return digestPlanSchema.parse({
    candidateId: input.candidateId,
    type: input.type,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    sections,
    totalJobs: selected.length,
    excluded,
    generatedAt: input.now ?? new Date(),
  });
}

/** Whether a digest is worth sending at all. */
export function digestWorthSending(plan: DigestPlan): { send: boolean; reason: string } {
  if (plan.totalJobs === 0) {
    /*
     * An empty digest is not sent.
     *
     * "Here are today's 0 jobs" trains people to stop opening the ones that do
     * have something in them, and the dashboard already says the same thing
     * without costing an interruption.
     */
    return {
      send: false,
      reason: 'Nothing cleared the digest threshold in this window, so no digest was sent.',
    };
  }

  return { send: true, reason: `${plan.totalJobs} jobs across ${plan.sections.length} sections.` };
}
