import {
  FIELD_SIGNIFICANCE,
  jobChangeSetSchema,
  type ChangeSignificance,
  type JobChangeSet,
  type JobFieldChange,
  type TrackedJobField,
} from '@job-intel/contracts';

/**
 * What changed about a posting since we last saw it.
 *
 * The system re-reads postings it has already stored, and most of the time
 * nothing has changed. The interesting cases are rare and specific: a salary
 * appears where there was none, a deadline moves, a role that was remote
 * becomes hybrid, a posting closes. Those are worth telling someone about; a
 * recruiter rewording a paragraph is not.
 *
 * The distinction is the whole point of this module. Without it the choice is
 * between notifying on every diff — which trains someone to ignore the
 * notifications — and notifying on none, which loses the salary that appeared
 * on a job they were unsure about.
 *
 * Nothing here decides whether to notify. It produces evidence; the
 * notification layer applies policy to it. Keeping those apart is what stops
 * "is this change interesting" and "has this person been alerted too often
 * today" from becoming one tangled question.
 */

/** The subset of a job this module compares. */
export interface ComparableJob {
  title: string | null;
  description: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  locationText: string | null;
  remoteType: string | null;
  employmentType: string | null;
  deadline: Date | null;
  status: string | null;
  applyUrl: string | null;
  seniority: string | null;
  visaSponsorship: string | null;
}

/** Collapses whitespace and case so cosmetic edits do not register. */
function normalise(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

function describeSalary(job: ComparableJob): string | null {
  if (job.salaryMin === null && job.salaryMax === null) return null;

  const currency = job.salaryCurrency ?? '';
  const min = job.salaryMin === null ? '' : job.salaryMin.toLocaleString();
  const max = job.salaryMax === null ? '' : job.salaryMax.toLocaleString();

  return `${currency} ${min}${min && max ? '–' : ''}${max}`.trim();
}

/**
 * How much a description changed.
 *
 * Length ratio rather than a diff. A proper diff would be more precise and is
 * not worth it here: the only decision being made is "did this get rewritten or
 * lightly edited", and a twenty-percent length change answers it. Anything
 * finer would be precision the policy above it cannot use.
 */
function descriptionSignificance(before: string | null, after: string | null): ChangeSignificance {
  if (before === null && after !== null) return 'material';
  if (before !== null && after === null) return 'material';
  if (before === null || after === null) return 'cosmetic';

  const longer = Math.max(before.length, after.length);
  if (longer === 0) return 'cosmetic';

  const ratio = Math.abs(before.length - after.length) / longer;
  return ratio > 0.4 ? 'minor' : 'cosmetic';
}

/** Clipped so a change record never carries a whole job description. */
function clip(value: string | null, max = 500): string | null {
  if (value === null) return null;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

interface FieldReader {
  field: TrackedJobField;
  read: (job: ComparableJob) => string | null;
  /** Overrides the field's default significance based on the values. */
  significance?: (before: string | null, after: string | null) => ChangeSignificance;
}

const READERS: FieldReader[] = [
  { field: 'title', read: (job) => normalise(job.title) },
  {
    field: 'description',
    read: (job) => normalise(job.description),
    significance: descriptionSignificance,
  },
  {
    field: 'salary',
    read: describeSalary,
    /*
     * A salary appearing is the single most useful change this system can
     * report, so it outranks the field's baseline. A salary *changing* is
     * material too; a salary disappearing is usually a re-post rather than a
     * withdrawal, and is reported as minor so it does not trigger an alert.
     */
    significance: (_before, after) => (after !== null ? 'material' : 'minor'),
  },
  { field: 'location', read: (job) => normalise(job.locationText) },
  { field: 'remoteType', read: (job) => normalise(job.remoteType) },
  { field: 'employmentType', read: (job) => normalise(job.employmentType) },
  {
    field: 'deadline',
    read: (job) => (job.deadline ? job.deadline.toISOString().slice(0, 10) : null),
    /*
     * A deadline appearing or moving closer is urgent; one being removed is
     * not. Both are reported, but only the first should be allowed to
     * interrupt someone.
     */
    significance: (before, after) => {
      if (after === null) return 'minor';
      if (before === null) return 'material';
      return after < before ? 'material' : 'minor';
    },
  },
  { field: 'status', read: (job) => normalise(job.status) },
  { field: 'applyUrl', read: (job) => job.applyUrl },
  { field: 'seniority', read: (job) => normalise(job.seniority) },
  {
    field: 'visaSponsorship',
    read: (job) => normalise(job.visaSponsorship),
    /*
     * Sponsorship becoming known is material; becoming unknown is not. The
     * tri-state rule from the matching layer applies here too — losing
     * evidence is not the same as gaining negative evidence.
     */
    significance: (_before, after) =>
      after !== null && after !== 'unknown' ? 'material' : 'minor',
  },
];

const SUMMARIES: Readonly<Record<TrackedJobField, (before: string | null, after: string | null) => string>> = {
  title: (b, a) => (b === null ? `Title set to "${a}".` : `Title changed from "${b}" to "${a}".`),
  description: (b, a) =>
    b === null ? 'A description was added.' : a === null ? 'The description was removed.' : 'The description was edited.',
  salary: (b, a) =>
    b === null ? `Salary published: ${a}.` : a === null ? 'The salary was removed.' : `Salary changed from ${b} to ${a}.`,
  location: (b, a) => (b === null ? `Location set to ${a}.` : `Location changed from ${b} to ${a}.`),
  remoteType: (b, a) => (b === null ? `Work arrangement set to ${a}.` : `Work arrangement changed from ${b} to ${a}.`),
  employmentType: (b, a) => (b === null ? `Employment type set to ${a}.` : `Employment type changed from ${b} to ${a}.`),
  deadline: (b, a) =>
    b === null ? `A deadline was set: ${a}.` : a === null ? 'The deadline was removed.' : `Deadline moved from ${b} to ${a}.`,
  status: (b, a) => `Status changed from ${b ?? 'unknown'} to ${a ?? 'unknown'}.`,
  applyUrl: () => 'The application link changed.',
  seniority: (b, a) => (b === null ? `Seniority set to ${a}.` : `Seniority changed from ${b} to ${a}.`),
  visaSponsorship: (b, a) =>
    b === null ? `Visa sponsorship stated as ${a}.` : `Visa sponsorship changed from ${b} to ${a}.`,
};

export interface DetectChangesInput {
  jobId: string;
  sourceId: string;
  previous: ComparableJob;
  current: ComparableJob;
  previousContentHash: string;
  currentContentHash: string;
  detectedAt?: Date;
}

/**
 * Compares two versions of a posting.
 *
 * Returns a change set even when nothing changed — an empty one — rather than
 * null. A caller that has to distinguish "no changes" from "comparison did not
 * run" gets that from the shape of the result rather than from a nullable, and
 * the empty case is worth recording: it is how we know the source was read.
 */
export function detectChanges(input: DetectChangesInput): JobChangeSet {
  const changes: JobFieldChange[] = [];

  for (const reader of READERS) {
    const before = reader.read(input.previous);
    const after = reader.read(input.current);

    if (before === after) continue;

    const significance = reader.significance
      ? reader.significance(before, after)
      : FIELD_SIGNIFICANCE[reader.field];

    changes.push({
      field: reader.field,
      significance,
      before: clip(before),
      after: clip(after),
      summary: SUMMARIES[reader.field](before, after).slice(0, 300),
    });
  }

  return jobChangeSetSchema.parse({
    jobId: input.jobId,
    sourceId: input.sourceId,
    detectedAt: input.detectedAt ?? new Date(),
    previousContentHash: input.previousContentHash,
    currentContentHash: input.currentContentHash,
    changes: changes.slice(0, 30),
    material: changes.some((change) => change.significance === 'material'),
  });
}

/**
 * Whether the content is byte-identical to last time (Part 28).
 *
 * The cheapest possible check, and it short-circuits the expensive half of the
 * pipeline. A careers page polled hourly changes a few times a week; without
 * this, every poll re-parses, re-normalizes and re-writes an identical record.
 */
export function isUnchanged(previousHash: string | null, currentHash: string): boolean {
  return previousHash !== null && previousHash === currentHash;
}
