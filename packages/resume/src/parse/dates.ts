import {
  dateRangeSchema,
  partialDateSchema,
  type DateRange,
  type PartialDate,
} from '@job-intel/contracts';

/**
 * Employment date parsing.
 *
 * The rule the brief states and this module holds to absolutely: **do not
 * invent missing months.** "2021 – 2023" is a year-precision range and every
 * duration derived from it is an estimate. Silently reading it as
 * 2021-01 → 2023-01 produces a confident-looking 24 months that could be
 * anywhere from 1 to 35, and that error then propagates into skill duration,
 * seniority estimation and the requirement matrix.
 *
 * So precision is carried on the value, and `durationIsEstimate` is set
 * wherever precision forced an assumption. Every consumer can then choose to
 * present "about 2 years" rather than "24 months".
 */

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** Words meaning "still there". A present role has an open end, not a missing one. */
const PRESENT = /^(present|current|now|ongoing|to\s*date|today)$/i;

const UNKNOWN_DATE: PartialDate = partialDateSchema.parse({});

/**
 * Parses one date token.
 *
 * Handles: `January 2024`, `Jan 2024`, `2024`, `01/2024`, `2024-01`,
 * `01/06/2024`, `Q1 2024`. Returns an unknown date rather than guessing when
 * the token is not a date at all.
 */
export function parsePartialDate(input: string | null | undefined): PartialDate {
  if (!input) return UNKNOWN_DATE;

  const raw = input.trim();
  if (raw.length === 0) return UNKNOWN_DATE;

  const make = (
    year: number | null,
    month: number | null,
    day: number | null,
  ): PartialDate =>
    partialDateSchema.parse({
      year,
      month,
      day,
      precision: day !== null ? 'day' : month !== null ? 'month' : year !== null ? 'year' : 'unknown',
      raw,
    });

  // Month name + year: "January 2024", "Jan. 2024", "Sept 2024"
  const named = /^([a-z]{3,9})\.?\s+(\d{4})$/i.exec(raw);
  if (named) {
    const month = MONTHS[named[1]!.toLowerCase()];
    if (month) return make(Number(named[2]), month, null);
  }

  // Year + month name: "2024 January"
  const namedReversed = /^(\d{4})\s+([a-z]{3,9})\.?$/i.exec(raw);
  if (namedReversed) {
    const month = MONTHS[namedReversed[2]!.toLowerCase()];
    if (month) return make(Number(namedReversed[1]), month, null);
  }

  // ISO-ish: "2024-01", "2024/01", "2024-01-15"
  const iso = /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/.exec(raw);
  if (iso) {
    const month = Number(iso[2]);
    const day = iso[3] ? Number(iso[3]) : null;
    if (month >= 1 && month <= 12) {
      return make(Number(iso[1]), month, day !== null && day >= 1 && day <= 31 ? day : null);
    }
  }

  // Slashed with year last: "01/2024", "1/2024", "01/06/2024" (day/month/year)
  const slashed = /^(\d{1,2})[-/](\d{1,2})?[-/]?(\d{4})$/.exec(raw);
  if (slashed) {
    const year = Number(slashed[3]);
    const first = Number(slashed[1]);
    const second = slashed[2] ? Number(slashed[2]) : null;

    if (second === null) {
      // "01/2024" — one number before the year is a month.
      return first >= 1 && first <= 12 ? make(year, first, null) : make(year, null, null);
    }

    /*
     * Two numbers before the year is genuinely ambiguous: 06/07/2024 is June 7
     * in the US and 6 July elsewhere. The day is discarded rather than guessed
     * — month precision is correct and useful, an invented day is neither.
     */
    const month = first >= 1 && first <= 12 ? first : second >= 1 && second <= 12 ? second : null;
    return make(year, month, null);
  }

  // Quarter: "Q1 2024" → the quarter's first month, flagged as month precision
  // because a quarter genuinely pins it to a three-month window.
  const quarter = /^q([1-4])\s*[-/ ]?\s*(\d{4})$/i.exec(raw);
  if (quarter) {
    return make(Number(quarter[2]), (Number(quarter[1]) - 1) * 3 + 1, null);
  }

  // Bare year.
  const year = /^(19|20)\d{2}$/.exec(raw);
  if (year) return make(Number(raw), null, null);

  return partialDateSchema.parse({ raw });
}

/** Whether a token means the role is ongoing. */
export function isPresent(input: string | null | undefined): boolean {
  return Boolean(input && PRESENT.test(input.trim()));
}

/**
 * Months between two partial dates.
 *
 * Returns `null` when either end has no year — a duration cannot be
 * established, and returning 0 would be indistinguishable from "started and
 * ended the same month".
 *
 * When months are missing, both ends are assumed to be mid-year. That is the
 * *least wrong* assumption available: assuming January for both systematically
 * understates, and it is flagged as an estimate rather than presented as fact.
 */
export function monthsBetween(
  start: PartialDate,
  end: PartialDate,
  now = new Date(),
): { months: number | null; isEstimate: boolean } {
  if (start.year === null) return { months: null, isEstimate: false };

  const endYear = end.year ?? now.getUTCFullYear();
  const endMonth = end.month ?? (end.year === null ? now.getUTCMonth() + 1 : 6);
  const startMonth = start.month ?? 6;

  const isEstimate = start.month === null || (end.year !== null && end.month === null);

  const months = (endYear - start.year) * 12 + (endMonth - startMonth);
  if (months < 0) return { months: null, isEstimate };

  return { months, isEstimate };
}

/**
 * Parses a range from a line of resume text.
 *
 * Accepts the separators resumes actually use, including the en dash and the
 * word "to". Returns an unknown range rather than a wrong one when no dates are
 * present.
 */
export function parseDateRange(input: string, now = new Date()): DateRange {
  const text = input.trim();

  const separator = /\s*(?:–|—|-|to|until|through|–|—)\s*/i;
  const parts = text.split(separator).map((part) => part.trim()).filter(Boolean);

  // A single date with no separator: treat as a start with an unknown end,
  // unless it says "Present" (meaningless alone).
  if (parts.length === 1) {
    const single = parsePartialDate(parts[0]!);
    const duration = monthsBetween(single, UNKNOWN_DATE, now);

    return dateRangeSchema.parse({
      start: single,
      end: UNKNOWN_DATE,
      isCurrent: false,
      durationMonths: single.year === null ? null : duration.months,
      durationIsEstimate: true,
    });
  }

  // Take the first parseable token as start and the last as end: resume lines
  // frequently carry a location or title between them.
  const startToken = parts.find((part) => parsePartialDate(part).year !== null) ?? parts[0]!;
  const endCandidates = parts.slice(parts.indexOf(startToken) + 1);
  const endToken =
    endCandidates.find((part) => isPresent(part) || parsePartialDate(part).year !== null) ??
    endCandidates[endCandidates.length - 1] ??
    '';

  const start = parsePartialDate(startToken);
  const current = isPresent(endToken);
  const end = current ? UNKNOWN_DATE : parsePartialDate(endToken);

  const duration = monthsBetween(start, current ? UNKNOWN_DATE : end, now);

  return dateRangeSchema.parse({
    start,
    end,
    isCurrent: current,
    durationMonths: duration.months,
    // A current role's duration depends on today, so it is always an estimate.
    durationIsEstimate: duration.isEstimate || current,
  });
}

/**
 * Finds a date range anywhere in a block of text.
 *
 * Resume role headers put dates in unpredictable positions — leading,
 * trailing, in brackets, on the next line — so the range is located by pattern
 * rather than by position.
 */
const RANGE_PATTERN = new RegExp(
  String.raw`((?:[A-Za-z]{3,9}\.?\s+)?(?:19|20)\d{2}|(?:\d{1,2}[-/])?(?:19|20)\d{2})` +
    String.raw`\s*(?:–|—|-|to|until|through)\s*` +
    String.raw`((?:[A-Za-z]{3,9}\.?\s+)?(?:19|20)\d{2}|(?:\d{1,2}[-/])?(?:19|20)\d{2}|present|current|now|ongoing)`,
  'i',
);

/**
 * Removes the date range from a line, leaving the rest of the header.
 *
 * Needed because a role header carries its dates inline — "Northgate Analytics
 * | Staff Engineer | 2020 – present" — and the company and title cannot be read
 * until the dates are out of the way. Cutting exactly the matched range rather
 * than "everything up to the year" is the difference between recovering two
 * fields and losing the whole line.
 */
export function stripDateRange(text: string): string {
  let out = text;

  const range = RANGE_PATTERN.exec(out);
  if (range) out = out.replace(range[0], ' ');
  else {
    const lone = /\b(?:[A-Za-z]{3,9}\.?\s+)?(?:19|20)\d{2}\b/.exec(out);
    if (lone) out = out.replace(lone[0], ' ');
  }

  return out
    // Separators left stranded by the removal.
    .replace(/[|·‧–—-]\s*$/, '')
    .replace(/^\s*[|·‧–—-]\s*/, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findDateRange(text: string, now = new Date()): DateRange | null {
  const match = RANGE_PATTERN.exec(text);
  if (!match) {
    // A lone year is still information: "2024" on a certification line.
    const lone = /\b((?:[A-Za-z]{3,9}\.?\s+)?(?:19|20)\d{2})\b/.exec(text);
    return lone ? parseDateRange(lone[1]!, now) : null;
  }

  return parseDateRange(`${match[1]} – ${match[2]}`, now);
}

/** A partial date as a concrete Date, for comparison. Mid-year when unknown. */
export function toApproximateDate(date: PartialDate): Date | null {
  if (date.year === null) return null;
  return new Date(Date.UTC(date.year, (date.month ?? 6) - 1, date.day ?? 1));
}

/**
 * Total months across ranges, counting overlaps once.
 *
 * This is Part 15's requirement, and it is the difference between an honest
 * profile and an inflated one: React used 2021–2023 and again 2022–2024 is
 * three years, not four. Two concurrent roles are one span of time, and a
 * system that adds them produces someone with more years of experience than
 * they have been alive.
 */
export function mergedMonths(
  ranges: ReadonlyArray<DateRange>,
  now = new Date(),
): { months: number; isEstimate: boolean } {
  interface Span {
    start: number;
    end: number;
  }

  const spans: Span[] = [];
  let isEstimate = false;

  for (const range of ranges) {
    if (range.start.year === null) continue;

    const start = range.start.year * 12 + ((range.start.month ?? 6) - 1);
    const endYear = range.isCurrent ? now.getUTCFullYear() : range.end.year;
    if (endYear === null) continue;

    const endMonth = range.isCurrent
      ? now.getUTCMonth()
      : (range.end.month ?? 6) - 1;

    const end = endYear * 12 + endMonth;
    if (end < start) continue;

    if (range.durationIsEstimate) isEstimate = true;
    spans.push({ start, end });
  }

  if (spans.length === 0) return { months: 0, isEstimate: false };

  spans.sort((a, b) => a.start - b.start);

  const merged: Span[] = [spans[0]!];
  for (const span of spans.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (span.start <= last.end) {
      // Overlapping or contiguous: extend rather than add.
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  const months = merged.reduce((sum, span) => sum + (span.end - span.start), 0);
  return { months, isEstimate };
}
