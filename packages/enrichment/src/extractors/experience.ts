import type { ExperienceRequirement } from '@job-intel/contracts';
import { collapseWhitespace } from '@job-intel/core';

/**
 * Experience requirement extraction.
 *
 * Handles the forms postings actually use:
 *   "3+ years", "at least 5 years", "2-4 years", "minimum of 3 years",
 *   "5 years' experience", "three years", "strong professional experience"
 *
 * Two rules keep it honest:
 *
 *  - A qualitative phrase with no number sets `qualitativeOnly` rather than
 *    inventing a figure. "Strong experience" is not "5 years".
 *  - Matches must sit near the word "experience". Job descriptions are full of
 *    unrelated numbers ("3 days in office", "2 rounds of interviews"), and
 *    grabbing the first number in the text is the classic way this extractor
 *    produces confident nonsense.
 */

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 10, ten: 10, twelve: 12, fifteen: 15, twenty: 20,
};

/** Ordered most-specific-first: a range must be tested before a single bound. */
const PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  read(match: RegExpMatchArray): { min: number | null; max: number | null };
  confidence: number;
}> = [
  {
    name: 'range',
    // "2-4 years", "2 to 4 years"
    pattern: /(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\+?\s*(?:\+)?\s*years?/i,
    read: (m) => ({ min: num(m[1]), max: num(m[2]) }),
    confidence: 0.92,
  },
  {
    name: 'minimum_plus',
    // "5+ years"
    pattern: /(\d{1,2})\s*\+\s*years?/i,
    read: (m) => ({ min: num(m[1]), max: null }),
    confidence: 0.9,
  },
  {
    name: 'at_least',
    // "at least 5 years", "minimum of 3 years", "no less than 4 years"
    pattern: /(?:at\s+least|minimum\s+(?:of\s+)?|min\.?\s*|no\s+less\s+than|over)\s*(\d{1,2})\s*years?/i,
    read: (m) => ({ min: num(m[1]), max: null }),
    confidence: 0.9,
  },
  {
    name: 'up_to',
    // "up to 3 years"
    pattern: /up\s+to\s+(\d{1,2})\s*years?/i,
    read: (m) => ({ min: null, max: num(m[1]) }),
    confidence: 0.8,
  },
  {
    name: 'word_number',
    // "three years"
    pattern: new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join('|')})\\s*(?:\\+)?\\s*years?`, 'i'),
    read: (m) => ({ min: WORD_NUMBERS[(m[1] ?? '').toLowerCase()] ?? null, max: null }),
    confidence: 0.75,
  },
  {
    name: 'plain',
    // "5 years of experience", "5 years' experience"
    pattern: /(\d{1,2})\s*years?['’]?\s*(?:of\s+)?(?:relevant\s+|professional\s+|commercial\s+|hands[\s-]on\s+)?experience/i,
    read: (m) => ({ min: num(m[1]), max: null }),
    confidence: 0.85,
  },
];

/** Qualitative phrasing that signals seniority without a number. */
const QUALITATIVE_PATTERNS: RegExp[] = [
  /\b(?:strong|extensive|significant|proven|demonstrable|substantial|deep)\s+(?:professional\s+|commercial\s+|hands[\s-]on\s+|industry\s+)?experience\b/i,
  /\bsolid\s+(?:background|experience)\b/i,
  /\bseasoned\s+(?:professional|engineer|developer)\b/i,
  /\btrack\s+record\s+of\b/i,
];

const NEARBY_WINDOW = 90;

export function extractExperience(text: string | null | undefined): ExperienceRequirement {
  const empty: ExperienceRequirement = {
    minimumYears: null,
    maximumYears: null,
    confidence: 0,
    method: 'default',
    rawText: null,
    qualitativeOnly: false,
  };
  if (!text) return empty;

  const haystack = collapseWhitespace(text);

  for (const { pattern, read, confidence, name } of PATTERNS) {
    const match = pattern.exec(haystack);
    if (!match) continue;

    // Require the phrase "experience" nearby, unless the pattern already
    // demands it. Otherwise "2-4 years old company" becomes a requirement.
    const index = match.index ?? 0;
    const context = haystack.slice(
      Math.max(0, index - NEARBY_WINDOW),
      index + match[0].length + NEARBY_WINDOW,
    );
    if (name !== 'plain' && !/experience|exp\.|background|working/i.test(context)) continue;

    const { min, max } = read(match);
    if (min === null && max === null) continue;
    // A range the wrong way round means we misread it; do not guess.
    if (min !== null && max !== null && min > max) continue;

    return {
      minimumYears: min,
      maximumYears: max,
      confidence,
      method: 'pattern',
      rawText: collapseWhitespace(match[0]).slice(0, 300),
      qualitativeOnly: false,
    };
  }

  for (const pattern of QUALITATIVE_PATTERNS) {
    const match = pattern.exec(haystack);
    if (match) {
      return {
        minimumYears: null,
        maximumYears: null,
        confidence: 0.4,
        method: 'heuristic',
        rawText: collapseWhitespace(match[0]).slice(0, 300),
        qualitativeOnly: true,
      };
    }
  }

  return empty;
}

function num(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  // 40+ years is a parsing artefact, not a requirement.
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 40 ? parsed : null;
}
