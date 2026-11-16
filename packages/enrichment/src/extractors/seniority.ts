import type { ExperienceRequirement, SeniorityLevel } from '@job-intel/contracts';
import { collapseWhitespace } from '@job-intel/core';

/**
 * Seniority detection with explicit conflict handling.
 *
 * Titles are the strongest signal, but they are not gospel. A posting titled
 * "Senior Engineer" that asks for one year of experience is either mislabelled
 * or inflating the role, and the honest output is "senior, but low confidence,
 * and here is why" — not a confident `senior` that a matching engine will trust
 * as much as a well-evidenced one.
 *
 * Signals, in descending weight:
 *   1. explicit seniority word in the title
 *   2. stated years of experience
 *   3. responsibility-level language in the body
 *
 * When 1 and 2 disagree materially, confidence is cut and the disagreement is
 * recorded in `conflict` so it stays visible rather than being silently
 * resolved.
 */

export interface SeniorityResult {
  value: SeniorityLevel | null;
  confidence: number;
  evidence: string | null;
  /** Set when signals disagreed. Surfaced in the UI. */
  conflict: string | null;
}

const TITLE_RULES: Array<{ level: SeniorityLevel; pattern: RegExp; weight: number }> = [
  { level: 'intern', pattern: /\b(?:intern|internship|working student|werkstudent)\b/i, weight: 100 },
  { level: 'executive', pattern: /\b(?:chief|c[tefoi]o|vp|vice president|head of)\b/i, weight: 95 },
  { level: 'director', pattern: /\bdirector\b/i, weight: 90 },
  { level: 'principal', pattern: /\b(?:principal|distinguished|fellow)\b/i, weight: 85 },
  { level: 'staff', pattern: /\bstaff\b/i, weight: 80 },
  { level: 'manager', pattern: /\b(?:manager|management)\b/i, weight: 75 },
  { level: 'lead', pattern: /\b(?:lead|leiter)\b/i, weight: 70 },
  { level: 'senior', pattern: /\b(?:senior|sr\.?|snr)\b/i, weight: 65 },
  { level: 'junior', pattern: /\b(?:junior|jr\.?)\b/i, weight: 60 },
  { level: 'entry', pattern: /\b(?:entry[\s-]level|graduate|grad|fresher|trainee|apprentice)\b/i, weight: 60 },
  { level: 'mid', pattern: /\b(?:mid[\s-]level|intermediate)\b/i, weight: 55 },
];

/** Responsibility language. Weak on its own; used only to break ties. */
const BODY_RULES: Array<{ level: SeniorityLevel; pattern: RegExp }> = [
  { level: 'lead', pattern: /\b(?:lead\s+a\s+team|technical\s+leadership|drive\s+the\s+technical)\b/i },
  { level: 'senior', pattern: /\b(?:mentor|coach)\s+(?:junior|other|the\s+team)|\bown\s+(?:the\s+)?(?:architecture|design)\b/i },
  { level: 'manager', pattern: /\b(?:manage|lead)\s+a\s+team\s+of\b|\bdirect\s+reports\b|\bhiring\s+and\s+performance\b/i },
  { level: 'entry', pattern: /\bno\s+(?:prior\s+)?experience\s+(?:required|necessary)\b|\bwe\s+will\s+train\b/i },
];

/** Typical minimum years per level, used to detect title/experience conflicts. */
const EXPECTED_MIN_YEARS: Partial<Record<SeniorityLevel, { min: number; max: number }>> = {
  intern: { min: 0, max: 1 },
  entry: { min: 0, max: 2 },
  junior: { min: 0, max: 3 },
  mid: { min: 2, max: 6 },
  senior: { min: 4, max: 12 },
  staff: { min: 7, max: 20 },
  principal: { min: 8, max: 25 },
  lead: { min: 5, max: 20 },
  manager: { min: 5, max: 25 },
  director: { min: 8, max: 30 },
  executive: { min: 10, max: 40 },
};

/** Years-of-experience fallback when the title says nothing. */
function levelFromYears(years: number): SeniorityLevel {
  if (years < 1) return 'entry';
  if (years < 3) return 'junior';
  if (years < 5) return 'mid';
  if (years < 8) return 'senior';
  return 'staff';
}

export function detectSeniority(input: {
  title: string;
  description?: string | null;
  experience?: ExperienceRequirement;
}): SeniorityResult {
  const title = collapseWhitespace(input.title);
  const description = input.description ?? '';
  const years = input.experience?.minimumYears ?? null;

  // ── 1. Title ──────────────────────────────────────────────────────────────
  let titleMatch: { level: SeniorityLevel; weight: number; text: string } | null = null;
  for (const rule of TITLE_RULES) {
    const match = rule.pattern.exec(title);
    if (match && (!titleMatch || rule.weight > titleMatch.weight)) {
      titleMatch = { level: rule.level, weight: rule.weight, text: match[0] };
    }
  }

  // ── 2. Body ───────────────────────────────────────────────────────────────
  const bodyMatch = BODY_RULES.find((r) => r.pattern.test(description));

  // ── 3. Combine ────────────────────────────────────────────────────────────
  if (titleMatch) {
    const expected = EXPECTED_MIN_YEARS[titleMatch.level];
    let confidence = 0.85;
    let conflict: string | null = null;

    if (years !== null && expected) {
      if (years < expected.min - 1) {
        // "Senior" asking for 1 year. Keep the title's answer but stop trusting it.
        confidence = 0.45;
        conflict =
          `Title suggests "${titleMatch.level}" but the posting asks for ${years} year(s) ` +
          `of experience (typically ${expected.min}+ for this level).`;
      } else if (years > expected.max + 3) {
        confidence = 0.55;
        conflict =
          `Title suggests "${titleMatch.level}" but the posting asks for ${years} year(s), ` +
          `which is well above the usual range for this level.`;
      } else {
        // Experience corroborates the title.
        confidence = 0.95;
      }
    }

    // A body signal that contradicts the title is a further, milder warning.
    if (bodyMatch && bodyMatch.level !== titleMatch.level && conflict === null) {
      const distant = Math.abs(rank(bodyMatch.level) - rank(titleMatch.level)) > 2;
      if (distant) {
        confidence = Math.min(confidence, 0.6);
        conflict = `Title suggests "${titleMatch.level}" but the description reads as "${bodyMatch.level}".`;
      }
    }

    return {
      value: titleMatch.level,
      confidence,
      evidence: `title contains "${titleMatch.text}"${years !== null ? `; ${years}+ years stated` : ''}`,
      conflict,
    };
  }

  // No title signal — fall back to stated experience.
  if (years !== null) {
    return {
      value: levelFromYears(years),
      confidence: 0.6,
      evidence: `no seniority word in title; inferred from ${years} year(s) of experience`,
      conflict: null,
    };
  }

  if (bodyMatch) {
    return {
      value: bodyMatch.level,
      confidence: 0.35,
      evidence: 'inferred from responsibility language in the description',
      conflict: null,
    };
  }

  // Unknown is a legitimate answer and must stay distinguishable from "mid".
  return { value: null, confidence: 0, evidence: 'no seniority signal found', conflict: null };
}

const ORDER: SeniorityLevel[] = [
  'intern', 'entry', 'junior', 'mid', 'senior', 'staff', 'lead', 'principal', 'manager', 'director', 'executive',
];

function rank(level: SeniorityLevel): number {
  const index = ORDER.indexOf(level);
  return index === -1 ? 0 : index;
}
