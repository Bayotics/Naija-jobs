import {
  seniorityEstimateSchema,
  type EvidenceItem,
  type ExperienceEntry,
  type SeniorityEstimate,
} from '@job-intel/contracts';
import type { SeniorityLevel } from '@job-intel/contracts';
import { mergedMonths } from '../parse/dates';

/**
 * Seniority estimation.
 *
 * The brief's constraint is the whole design: **do not determine seniority from
 * job title alone.** Titles are the least reliable signal in a resume. A
 * "Senior Engineer" at a ten-person startup and one at a bank are different
 * jobs; "Software Engineer III" means nothing outside the company that coined
 * it; and title inflation runs in both directions — some people are three
 * levels below their title, others three above.
 *
 * So the title is *one* signal among several, weighted alongside scope
 * indicators (what they actually did), total experience, and progression
 * (whether they moved up). Every signal is named and weighted in the output, so
 * the estimate can be argued with rather than merely accepted.
 *
 * When the title and the rest of the evidence disagree, the disagreement is
 * reported rather than resolved silently.
 */

const LEVEL_ORDER: readonly SeniorityLevel[] = [
  'intern',
  'entry',
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
  'executive',
];

/** Individual-contributor levels, ordered. Management is a separate axis. */
const IC_LADDER: readonly SeniorityLevel[] = ['intern', 'entry', 'junior', 'mid', 'senior', 'staff', 'principal'];

const TITLE_PATTERNS: ReadonlyArray<[RegExp, SeniorityLevel]> = [
  [/\b(chief|cto|ceo|cio|vp|vice president|head of)\b/i, 'executive'],
  [/\bdirector\b/i, 'director'],
  [/\b(engineering manager|em|people manager|manager)\b/i, 'manager'],
  [/\b(tech lead|team lead|technical lead|lead engineer|lead developer|lead)\b/i, 'lead'],
  [/\bprincipal\b/i, 'principal'],
  [/\bstaff\b/i, 'staff'],
  [/\b(senior|snr|sr\.?)\b/i, 'senior'],
  [/\b(junior|jnr|jr\.?)\b/i, 'junior'],
  [/\b(intern|internship|placement|trainee)\b/i, 'intern'],
  [/\b(graduate|entry.level|associate)\b/i, 'entry'],
];

/**
 * Scope indicators: what the person actually did.
 *
 * These are the signals that survive title inflation. Someone who owned an
 * architecture decision and mentored three engineers is operating at a senior
 * level whatever their business card says.
 */
const SCOPE_SIGNALS: ReadonlyArray<{
  name: string;
  pattern: RegExp;
  supports: SeniorityLevel;
  weight: number;
}> = [
  { name: 'org_leadership', pattern: /\b(managed|led)\s+(a\s+)?(team|department|org)\w*\s+of\s+(\d+|\w+)/i, supports: 'manager', weight: 3 },
  { name: 'hiring', pattern: /\b(hired|recruited|interviewed|built the team|grew the team)\b/i, supports: 'manager', weight: 2 },
  { name: 'budget_ownership', pattern: /\b(budget|p&l|headcount)\b/i, supports: 'director', weight: 2 },
  { name: 'strategy', pattern: /\b(roadmap|technical strategy|org.wide|company.wide)\b/i, supports: 'principal', weight: 2 },
  { name: 'architecture_ownership', pattern: /\b(architect(ed|ure)|designed the system|system design|led the design)\b/i, supports: 'senior', weight: 2.5 },
  { name: 'mentoring', pattern: /\b(mentor(ed|ing)?|coached|onboard(ed|ing)|taught)\b/i, supports: 'senior', weight: 2 },
  { name: 'cross_team', pattern: /\b(cross.functional|multiple teams|stakeholders?|partnered with)\b/i, supports: 'senior', weight: 1.5 },
  { name: 'technical_direction', pattern: /\b(set (the )?standards?|introduced|established|drove adoption|migrated the)\b/i, supports: 'senior', weight: 1.5 },
  { name: 'code_review', pattern: /\b(code review|reviewed pull requests|reviewed code)\b/i, supports: 'mid', weight: 1 },
  { name: 'independent_delivery', pattern: /\b(owned|end.to.end|independently|sole (developer|engineer))\b/i, supports: 'mid', weight: 1.5 },
  { name: 'supervised_work', pattern: /\b(assisted|supported the team|under the guidance|shadowed|learned)\b/i, supports: 'junior', weight: 1.5 },
];

/** Level suggested by a title, or null when the title says nothing. */
export function levelFromTitle(title: string): SeniorityLevel | null {
  for (const [pattern, level] of TITLE_PATTERNS) {
    if (pattern.test(title)) return level;
  }
  return null;
}

/** Level suggested by total professional experience alone. */
function levelFromYears(months: number): SeniorityLevel {
  if (months < 12) return 'entry';
  if (months < 30) return 'junior';
  if (months < 66) return 'mid';
  if (months < 114) return 'senior';
  return 'staff';
}

const rank = (level: SeniorityLevel): number => {
  const ic = IC_LADDER.indexOf(level);
  if (ic >= 0) return ic;
  // Management levels map onto the IC ladder for comparison purposes only —
  // they are a different track, not simply "more senior".
  if (level === 'lead') return IC_LADDER.indexOf('senior');
  if (level === 'manager') return IC_LADDER.indexOf('senior');
  if (level === 'director') return IC_LADDER.indexOf('principal');
  return IC_LADDER.length;
};

export interface SeniorityInput {
  experience: readonly ExperienceEntry[];
  now?: Date;
  /** Level the candidate stated for themselves, which outranks inference. */
  statedLevel?: SeniorityLevel | null;
}

/**
 * Estimates seniority from the whole record.
 *
 * Returns `null` with zero confidence when there is nothing to go on. That is a
 * legitimate answer — inventing "mid" for an empty resume would be a fabricated
 * fact, and every consumer of this estimate treats null as UNKNOWN rather than
 * as a low level.
 */
export function estimateSeniority(input: SeniorityInput): SeniorityEstimate {
  const now = input.now ?? new Date();
  const experience = [...input.experience].sort((a, b) => {
    const aYear = a.dates.start.year ?? 0;
    const bYear = b.dates.start.year ?? 0;
    return aYear - bYear;
  });

  const signals: SeniorityEstimate['signals'] = [];
  const evidence: EvidenceItem[] = [];

  if (experience.length === 0 && !input.statedLevel) {
    return seniorityEstimateSchema.parse({
      estimatedLevel: null,
      confidence: 0,
      signals: [],
      titleVsEvidenceNote: 'No employment history was found, so seniority could not be estimated.',
    });
  }

  // ── Signal 1: total experience ──────────────────────────────────────────
  const totalMonths = mergedMonths(
    experience.map((role) => role.dates),
    now,
  );

  let yearsLevel: SeniorityLevel | null = null;
  if (totalMonths.months > 0) {
    yearsLevel = levelFromYears(totalMonths.months);
    signals.push({
      name: 'total_experience',
      detail: `About ${(totalMonths.months / 12).toFixed(1)} years of non-overlapping professional experience${
        totalMonths.isEstimate ? ' (estimated from partial dates)' : ''
      }.`,
      weight: 3,
      supports: yearsLevel,
    });
  }

  // ── Signal 2: most recent title ─────────────────────────────────────────
  const latest = experience[experience.length - 1];
  const titleLevel = latest ? levelFromTitle(latest.title) : null;

  if (latest && titleLevel) {
    signals.push({
      name: 'current_title',
      detail: `Most recent title "${latest.title}" at ${latest.company}.`,
      // Deliberately below total experience and scope combined: the title is a
      // real signal, but it must not be able to carry the estimate by itself.
      weight: 2,
      supports: titleLevel,
    });
  } else if (latest) {
    signals.push({
      name: 'current_title',
      detail: `Most recent title "${latest.title}" carries no seniority marker.`,
      weight: 0,
      supports: null,
    });
  }

  // ── Signal 3: scope of work ─────────────────────────────────────────────
  const corpus = experience
    .map((role) => [role.description ?? '', ...role.responsibilities, ...role.achievements].join('\n'))
    .join('\n');

  const scopeHits = SCOPE_SIGNALS.filter((signal) => signal.pattern.test(corpus));

  for (const hit of scopeHits) {
    const match = hit.pattern.exec(corpus);
    const excerpt = match
      ? corpus.slice(Math.max(0, match.index - 30), Math.min(corpus.length, match.index + 120)).replace(/\s+/g, ' ')
      : '';

    signals.push({
      name: hit.name,
      detail: excerpt.slice(0, 300),
      weight: hit.weight,
      supports: hit.supports,
    });
  }

  // ── Signal 4: progression ───────────────────────────────────────────────
  const titleLevels = experience
    .map((role) => levelFromTitle(role.title))
    .filter((level): level is SeniorityLevel => level !== null);

  if (titleLevels.length >= 2) {
    const first = rank(titleLevels[0]!);
    const last = rank(titleLevels[titleLevels.length - 1]!);

    if (last > first) {
      signals.push({
        name: 'upward_progression',
        detail: `Titles progressed from ${titleLevels[0]} to ${titleLevels[titleLevels.length - 1]}.`,
        weight: 1.5,
        supports: titleLevels[titleLevels.length - 1]!,
      });
    }
  }

  // ── Weighted vote ───────────────────────────────────────────────────────
  const votes = new Map<SeniorityLevel, number>();
  let totalWeight = 0;

  for (const signal of signals) {
    if (!signal.supports || signal.weight <= 0) continue;
    votes.set(signal.supports, (votes.get(signal.supports) ?? 0) + signal.weight);
    totalWeight += signal.weight;
  }

  let estimated: SeniorityLevel | null = null;
  let topWeight = 0;

  for (const [level, weight] of votes) {
    if (weight > topWeight) {
      topWeight = weight;
      estimated = level;
    }
  }

  /*
   * A stated level outranks everything inferred. The candidate knows their own
   * level and the system's job is to record it, not to second-guess it — the
   * inference exists for the case where they have not said.
   */
  if (input.statedLevel) {
    return seniorityEstimateSchema.parse({
      estimatedLevel: input.statedLevel,
      confidence: 1,
      signals: [
        {
          name: 'candidate_stated',
          detail: 'The candidate stated this level themselves.',
          weight: 10,
          supports: input.statedLevel,
        },
        ...signals,
      ].slice(0, 20),
      evidence,
      titleVsEvidenceNote:
        estimated && estimated !== input.statedLevel
          ? `The resume evidence reads closer to ${estimated}; the stated level is used.`
          : null,
    });
  }

  // ── Confidence ──────────────────────────────────────────────────────────
  // Agreement between independent signals is what makes this believable.
  const agreement = totalWeight > 0 ? topWeight / totalWeight : 0;
  const breadth = Math.min(1, signals.filter((signal) => signal.weight > 0).length / 5);

  let confidence = agreement * 0.5 + breadth * 0.3;
  if (yearsLevel && titleLevel && yearsLevel === titleLevel) confidence += 0.15;
  if (experience.length === 1) confidence *= 0.7;
  confidence = Math.min(0.9, Math.max(0, confidence));

  // ── Title versus evidence ───────────────────────────────────────────────
  let note: string | null = null;

  if (titleLevel && estimated && titleLevel !== estimated) {
    const titleRank = rank(titleLevel);
    const evidenceRank = rank(estimated);

    if (Math.abs(titleRank - evidenceRank) >= 1) {
      note =
        titleRank > evidenceRank
          ? `The most recent title suggests ${titleLevel}, but the described scope of work reads closer to ${estimated}. Both are shown rather than one being chosen.`
          : `The most recent title says ${titleLevel}, but the described scope of work reads closer to ${estimated} — the title may understate the role.`;
    }
  }

  if (!titleLevel && estimated) {
    note = `No seniority marker appears in any job title, so this estimate rests on scope of work and total experience.`;
  }

  return seniorityEstimateSchema.parse({
    estimatedLevel: estimated,
    confidence,
    signals: signals.slice(0, 20),
    evidence,
    titleVsEvidenceNote: note,
  });
}

export { LEVEL_ORDER, rank as seniorityRank };
