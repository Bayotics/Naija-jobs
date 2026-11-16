import {
  careerTrajectorySchema,
  timelineEntrySchema,
  type CareerTrajectory,
  type CertificationRecord,
  type EducationRecord,
  type ExperienceEntry,
  type ProjectRecord,
  type TimelineEntry,
  type TrajectoryDimension,
} from '@job-intel/contracts';
import { mergedMonths } from '../parse/dates';
import { levelFromTitle, seniorityRank } from './seniority';

/**
 * Career timeline and trajectory.
 *
 * Two related but distinct outputs:
 *
 *  - The **timeline** is a chronological reconstruction. It is descriptive: it
 *    says what happened and when, and it marks gaps without commenting on them.
 *
 *  - The **trajectory** is directional. It answers "is this person growing in
 *    depth, breadth, leadership?" along named dimensions, each with its own
 *    confidence, because someone can be clearly deepening technically while
 *    saying nothing at all about leadership.
 *
 * Employment gaps are reported as facts and nothing more. A gap is not evidence
 * of anything — illness, caring, study, redundancy, a sabbatical and a year of
 * failed job-hunting all look identical on a timeline — so the system states
 * the dates and stops. Reading a gap as a negative would be exactly the kind of
 * inference the brief forbids.
 */

const MIN_GAP_MONTHS = 3;

/** Distance across the IC ladder, used to normalise progression. */
const IC_SPAN = 6;

export interface TrajectoryInput {
  experience: readonly ExperienceEntry[];
  education?: readonly EducationRecord[];
  certifications?: readonly CertificationRecord[];
  projects?: readonly ProjectRecord[];
  now?: Date;
}

/** A chronological reconstruction of the career. */
export function buildTimeline(input: TrajectoryInput): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  const push = (candidate: unknown): void => {
    const parsed = timelineEntrySchema.safeParse(candidate);
    if (parsed.success) entries.push(parsed.data);
  };

  for (const role of input.experience) {
    if (role.dates.start.year !== null) {
      push({
        year: role.dates.start.year,
        month: role.dates.start.month,
        label: `Started as ${role.title}`,
        company: role.company,
        kind: 'role_start',
        seniority: levelFromTitle(role.title),
        detail: role.location ?? '',
      });
    }

    if (!role.dates.isCurrent && role.dates.end.year !== null) {
      push({
        year: role.dates.end.year,
        month: role.dates.end.month,
        label: `Left ${role.title}`,
        company: role.company,
        kind: 'role_end',
        seniority: levelFromTitle(role.title),
        detail:
          role.dates.durationMonths !== null
            ? `${role.dates.durationMonths} months${role.dates.durationIsEstimate ? ' (estimated)' : ''}`
            : '',
      });
    }
  }

  for (const record of input.education ?? []) {
    const year = record.dates.end.year ?? record.dates.start.year;
    if (year === null) continue;
    push({
      year,
      month: record.dates.end.month ?? record.dates.start.month,
      label: record.degree ?? `Studied at ${record.institution}`,
      company: record.institution,
      kind: 'education',
      detail: record.field ?? '',
    });
  }

  for (const record of input.certifications ?? []) {
    if (record.issued.year === null) continue;
    push({
      year: record.issued.year,
      month: record.issued.month,
      label: `Certified: ${record.name}`,
      company: record.issuer,
      kind: 'certification',
      detail: '',
    });
  }

  for (const project of input.projects ?? []) {
    const year = project.dates.start.year ?? project.dates.end.year;
    if (year === null) continue;
    push({
      year,
      month: project.dates.start.month,
      label: `Project: ${project.name}`,
      company: null,
      kind: 'project',
      detail: project.context,
    });
  }

  return entries.sort((a, b) => a.year - b.year || (a.month ?? 6) - (b.month ?? 6));
}

/**
 * Employment gaps over three months.
 *
 * Stated as dates and duration, with no interpretation attached. The note field
 * says what the gap *is*, never what it might mean.
 */
export function findGaps(
  experience: readonly ExperienceEntry[],
  now = new Date(),
): CareerTrajectory['gaps'] {
  interface Span {
    start: number;
    end: number;
  }

  const spans: Span[] = [];

  for (const role of experience) {
    if (role.dates.start.year === null) continue;
    const start = role.dates.start.year * 12 + ((role.dates.start.month ?? 6) - 1);

    const endYear = role.dates.isCurrent ? now.getUTCFullYear() : role.dates.end.year;
    if (endYear === null) continue;
    const endMonth = role.dates.isCurrent ? now.getUTCMonth() : (role.dates.end.month ?? 6) - 1;

    const end = endYear * 12 + endMonth;
    if (end >= start) spans.push({ start, end });
  }

  if (spans.length < 2) return [];

  spans.sort((a, b) => a.start - b.start);

  // Merge first: concurrent roles must not manufacture a gap between them.
  const merged: Span[] = [spans[0]!];
  for (const span of spans.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  const gaps: CareerTrajectory['gaps'] = [];

  for (let index = 1; index < merged.length; index += 1) {
    const previous = merged[index - 1]!;
    const next = merged[index]!;
    const months = next.start - previous.end;

    if (months >= MIN_GAP_MONTHS) {
      gaps.push({
        fromYear: Math.floor(previous.end / 12),
        toYear: Math.floor(next.start / 12),
        months,
        // Descriptive only. A gap has no meaning the resume can supply.
        note: `${months} months between recorded roles.`,
      });
    }
  }

  return gaps;
}

const DIMENSION_PATTERNS: Readonly<Record<TrajectoryDimension, RegExp[]>> = {
  technical_depth: [
    /\b(optimis|optimiz|performance|scal(ed|ing|ability)|latency|throughput|profil(ed|ing)|internals|low.level|algorithm)\w*/i,
    /\b(architect|distributed|concurren|memory|compiler|kernel)\w*/i,
  ],
  technical_breadth: [
    /\b(full.stack|frontend and backend|across the stack|infrastructure and|end.to.end)\w*/i,
  ],
  leadership: [
    /\b(led|leading|mentor|coach|guided|drove|spearhead|championed|set the direction)\w*/i,
  ],
  management: [/\b(managed a team|line manage|direct reports?|performance review|hiring|headcount)\w*/i],
  domain_specialization: [
    /\b(fintech|healthcare|e.?commerce|logistics|gaming|edtech|insurtech|payments|banking|biotech)\w*/i,
  ],
  industry_movement: [],
  seniority_progression: [],
};

/**
 * Trajectory across named dimensions.
 *
 * Direction is computed by comparing the earlier half of the career against the
 * later half, so it measures change rather than level. Someone who has always
 * been deeply technical has high depth and *flat* depth trajectory, and those
 * are different facts.
 */
export function analyseTrajectory(input: TrajectoryInput): CareerTrajectory {
  const now = input.now ?? new Date();
  const experience = [...input.experience].sort(
    (a, b) => (a.dates.start.year ?? 0) - (b.dates.start.year ?? 0),
  );

  const timeline = buildTimeline({ ...input, now });
  const gaps = findGaps(experience, now);
  const total = mergedMonths(experience.map((role) => role.dates), now);

  const dimensions: CareerTrajectory['dimensions'] = [];

  if (experience.length === 0) {
    return careerTrajectorySchema.parse({
      dimensions: [],
      trajectorySummary: 'No employment history was found, so no trajectory could be established.',
      trajectoryConfidence: 0,
      timeline,
      totalExperienceMonths: null,
      gaps: [],
    });
  }

  const midpoint = Math.ceil(experience.length / 2);
  const early = experience.slice(0, midpoint);
  const late = experience.slice(midpoint);

  const textOf = (roles: readonly ExperienceEntry[]): string =>
    roles
      .map((role) => [role.title, role.description ?? '', ...role.responsibilities, ...role.achievements].join('\n'))
      .join('\n');

  const earlyText = textOf(early);
  const lateText = textOf(late.length > 0 ? late : early);

  const countHits = (text: string, patterns: readonly RegExp[]): number =>
    patterns.reduce((sum, pattern) => sum + (text.match(new RegExp(pattern.source, 'gi'))?.length ?? 0), 0);

  for (const [dimension, patterns] of Object.entries(DIMENSION_PATTERNS) as Array<
    [TrajectoryDimension, RegExp[]]
  >) {
    if (patterns.length === 0) continue;

    const earlyHits = countHits(earlyText, patterns);
    const lateHits = countHits(lateText, patterns);
    const totalHits = earlyHits + lateHits;

    if (totalHits === 0) continue;

    // Normalised difference, so a long resume does not automatically read as
    // "increasing" simply by having more words in its later half.
    const earlyRate = early.length > 0 ? earlyHits / early.length : 0;
    const lateRate = late.length > 0 ? lateHits / late.length : earlyRate;
    const direction =
      earlyRate + lateRate === 0 ? 0 : Math.max(-1, Math.min(1, (lateRate - earlyRate) / (earlyRate + lateRate)));

    const evidence: string[] = [];
    for (const pattern of patterns) {
      const match = new RegExp(pattern.source, 'i').exec(lateText);
      if (match) {
        evidence.push(
          lateText
            .slice(Math.max(0, match.index - 30), Math.min(lateText.length, match.index + 120))
            .replace(/\s+/g, ' ')
            .slice(0, 300),
        );
      }
      if (evidence.length >= 3) break;
    }

    dimensions.push({
      dimension,
      direction,
      // More mentions across more roles means a more trustworthy direction.
      confidence: Math.min(0.8, 0.2 + Math.min(totalHits, 8) * 0.05 + Math.min(experience.length, 4) * 0.05),
      detail:
        direction > 0.2
          ? `Increasing: ${lateHits} signals in recent roles against ${earlyHits} earlier.`
          : direction < -0.2
            ? `Decreasing: ${lateHits} signals in recent roles against ${earlyHits} earlier.`
            : `Steady: consistently evidenced across the career (${totalHits} signals).`,
      evidence: evidence.slice(0, 8),
    });
  }

  // ── Seniority progression, from titles over time ────────────────────────
  const ranked = experience
    .map((role) => ({ role, level: levelFromTitle(role.title) }))
    .filter((entry): entry is { role: ExperienceEntry; level: NonNullable<typeof entry.level> } => entry.level !== null);

  if (ranked.length >= 2) {
    const first = seniorityRank(ranked[0]!.level);
    const last = seniorityRank(ranked[ranked.length - 1]!.level);
    const span = Math.max(1, IC_SPAN);

    dimensions.push({
      dimension: 'seniority_progression',
      direction: Math.max(-1, Math.min(1, (last - first) / span)),
      confidence: Math.min(0.75, 0.3 + ranked.length * 0.1),
      detail:
        last > first
          ? `Progressed from ${ranked[0]!.level} to ${ranked[ranked.length - 1]!.level}.`
          : last < first
            ? `Most recent title (${ranked[ranked.length - 1]!.level}) sits below an earlier one (${ranked[0]!.level}). Titles are not comparable across companies, so this is not necessarily a step down.`
            : `Titles stayed at ${ranked[0]!.level} across ${ranked.length} roles.`,
      evidence: ranked.map((entry) => `${entry.role.title} at ${entry.role.company}`).slice(0, 8),
    });
  }

  // ── Industry movement ───────────────────────────────────────────────────
  const companies = experience.map((role) => role.company).filter(Boolean);
  const domains = new Set(experience.map((role) => role.domain).filter(Boolean));

  if (companies.length >= 2) {
    dimensions.push({
      dimension: 'industry_movement',
      // Movement is neither good nor bad. Direction here means "how much
      // change", and the detail says what actually happened.
      direction: domains.size > 1 ? 1 : 0,
      confidence: domains.size > 0 ? 0.4 : 0.15,
      detail:
        domains.size > 1
          ? `Worked across ${domains.size} identified domains.`
          : `${companies.length} companies recorded; no distinct domain change identified.`,
      evidence: companies.slice(0, 8),
    });
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const rising = dimensions.filter((entry) => entry.direction > 0.2 && entry.confidence >= 0.35);
  const years = (total.months / 12).toFixed(1);

  const parts: string[] = [
    `About ${years} years of recorded experience across ${experience.length} role${experience.length === 1 ? '' : 's'}${
      total.isEstimate ? ', estimated from partial dates' : ''
    }.`,
  ];

  if (rising.length > 0) {
    parts.push(
      `Growing in ${rising.map((entry) => entry.dimension.replace(/_/g, ' ')).join(', ')}.`,
    );
  } else if (dimensions.length > 0) {
    parts.push('No clear directional change across the measured dimensions.');
  }

  if (gaps.length > 0) {
    parts.push(
      `${gaps.length} period${gaps.length === 1 ? '' : 's'} of ${MIN_GAP_MONTHS}+ months between recorded roles.`,
    );
  }

  const trajectoryConfidence =
    dimensions.length === 0
      ? 0
      : Math.min(
          0.85,
          dimensions.reduce((sum, entry) => sum + entry.confidence, 0) / dimensions.length,
        );

  return careerTrajectorySchema.parse({
    dimensions,
    trajectorySummary: parts.join(' ').slice(0, 800),
    trajectoryConfidence,
    timeline: timeline.slice(0, 200),
    totalExperienceMonths: total.months > 0 ? total.months : null,
    gaps,
  });
}
