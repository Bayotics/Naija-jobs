import type { WorkAuthorization } from '@job-intel/contracts';
import { collapseWhitespace } from '@job-intel/core';

/**
 * Visa, work-authorization and relocation extraction.
 *
 * The most consequential distinction in this whole package:
 *
 *   `not_mentioned`  the posting is silent
 *   `unclear`        the posting says something ambiguous
 *   `not_offered`    the posting explicitly refuses sponsorship
 *   `offered`        the posting explicitly provides it
 *
 * A candidate who requires sponsorship must not have silent postings discarded
 * — most postings never mention it, and treating silence as refusal would throw
 * away the majority of the corpus. Equally, silence must never be reported as
 * `offered`, and an international-sounding employer is not evidence of anything.
 * Nothing here infers sponsorship from company size, name or location.
 */

const NEGATIVE_PATTERNS: RegExp[] = [
  /\b(?:we\s+(?:are|do)\s+not|cannot|can't|unable\s+to|will\s+not)\s+(?:currently\s+)?(?:offer|provide|sponsor|support)\s+(?:visa\s+)?sponsorship\b/i,
  /\bno\s+(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:available|offered|provided)\b/i,
  /\bsponsorship\s+is\s+not\s+(?:available|offered|provided)\b/i,
  /\bwe\s+(?:are\s+)?unable\s+to\s+sponsor\b/i,
  /\bnot\s+(?:able|eligible)\s+to\s+sponsor\b/i,
  /\bmust\s+(?:already\s+)?(?:have|possess)\s+(?:the\s+)?(?:legal\s+)?right\s+to\s+work\b[^.]{0,80}\bwithout\s+sponsorship\b/i,
  /\bapplicants?\s+must\s+be\s+authorized\s+to\s+work\b[^.]{0,80}\bwithout\s+(?:visa\s+)?sponsorship\b/i,
  /\bwithout\s+the\s+need\s+for\s+(?:visa\s+)?sponsorship\b/i,
];

const POSITIVE_PATTERNS: RegExp[] = [
  /\b(?:we|the\s+company)\s+(?:can|will|do|does|are\s+(?:happy|able|willing))\s+(?:to\s+)?(?:offer|provide|sponsor|support)\s+(?:visa\s+)?sponsorship\b/i,
  /\b(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:available|offered|provided|possible)\b/i,
  /\bwe\s+sponsor\s+visas?\b/i,
  /\bvisa\s+support\s+(?:is\s+)?(?:available|provided|offered)\b/i,
  /\b(?:we\s+)?(?:offer|provide)\s+(?:visa|immigration)\s+(?:support|assistance|sponsorship)\b/i,
  /\bh1b\s+(?:sponsorship|transfer)\s+(?:available|offered)\b/i,
  /\bblue\s+card\s+(?:support|sponsorship)\b/i,
  /\brelocation\s+and\s+visa\s+support\b/i,
];

/** Ambiguous: sponsorship is discussed without a clear yes or no. */
const UNCLEAR_PATTERNS: RegExp[] = [
  /\bsponsorship\s+(?:may\s+be|might\s+be|could\s+be)\s+(?:available|considered)\b/i,
  /\bsponsorship\s+(?:considered|available)\s+(?:for\s+)?(?:exceptional|the\s+right)\s+candidates?\b/i,
  /\bcase[\s-]by[\s-]case\b[^.]{0,60}\bsponsorship\b/i,
  /\bsponsorship\s+on\s+request\b/i,
  /\bdepending\s+on\b[^.]{0,40}\bvisa\b/i,
];

/** Work-authorization requirements that are not sponsorship statements. */
const AUTHORIZATION_PATTERNS: RegExp[] = [
  /\b(?:must|should)\s+(?:have|possess|hold)\s+(?:the\s+)?(?:legal\s+)?(?:right|authorization|authorisation)\s+to\s+work\s+in\s+[^.]{2,60}/i,
  /\b(?:must\s+be|are)\s+(?:legally\s+)?(?:authorized|authorised|eligible)\s+to\s+work\s+in\s+[^.]{2,60}/i,
  /\bvalid\s+work\s+permit\s+(?:for|in)\s+[^.]{2,60}/i,
  /\beu\s+work\s+(?:permit|authorization)\b[^.]{0,40}/i,
];

const CITIZENSHIP_PATTERNS: RegExp[] = [
  /\b(?:must\s+be\s+a?\s*)?(?:us|u\.s\.|american|uk|british|canadian|australian)\s+citizen(?:ship)?\s*(?:required|only)?\b/i,
  /\bcitizenship\s+(?:is\s+)?required\b/i,
  /\bonly\s+citizens\s+(?:of|from)\b/i,
];

const CLEARANCE_PATTERNS: Array<{ pattern: RegExp; level: string | null }> = [
  { pattern: /\btop\s+secret\s*(?:\/\s*sci)?\b/i, level: 'Top Secret' },
  { pattern: /\bsecret\s+(?:security\s+)?clearance\b/i, level: 'Secret' },
  { pattern: /\bsc\s+clearance\b/i, level: 'SC' },
  { pattern: /\bdv\s+clearance\b/i, level: 'DV' },
  { pattern: /\bsecurity\s+clearance\s+(?:is\s+)?(?:required|mandatory)\b/i, level: null },
  { pattern: /\bmust\s+(?:be\s+able\s+to\s+)?(?:obtain|hold)\s+(?:a\s+)?security\s+clearance\b/i, level: null },
];

const RELOCATION_POSITIVE: RegExp[] = [
  /\brelocation\s+(?:assistance|support|package|allowance|bonus)\s*(?:is\s+)?(?:available|offered|provided)?\b/i,
  /\bwe\s+(?:offer|provide)\s+relocation\b/i,
  /\brelocation\s+costs?\s+(?:are\s+)?covered\b/i,
  /\bwill\s+(?:help|assist)\s+with\s+relocation\b/i,
];

const RELOCATION_NEGATIVE: RegExp[] = [
  /\bno\s+relocation\s+(?:assistance|support|package)\b/i,
  /\brelocation\s+(?:assistance|support)\s+is\s+not\s+(?:available|offered|provided)\b/i,
  /\bwe\s+(?:do\s+not|don't|cannot)\s+(?:offer|provide)\s+relocation\b/i,
];

export function extractWorkAuthorization(input: {
  description: string | null;
  /** A structured flag from the source. Arbeitnow supplies one. */
  sourceVisaFlag?: boolean | null;
}): WorkAuthorization {
  const text = input.description ?? '';

  const result: WorkAuthorization = {
    sponsorship: 'not_mentioned',
    sponsorshipConfidence: 0.9,
    sponsorshipEvidence: null,
    workAuthorizationRequirement: null,
    citizenshipRequired: null,
    securityClearanceRequired: null,
    securityClearanceLevel: null,
    relocationSupport: 'not_mentioned',
    relocationEvidence: null,
  };

  // ── Sponsorship ───────────────────────────────────────────────────────────
  // Negatives are tested first: "we cannot offer sponsorship" contains
  // "offer sponsorship", so checking positives first would invert the answer.
  const negative = firstMatch(NEGATIVE_PATTERNS, text);
  const positive = firstMatch(POSITIVE_PATTERNS, text);
  const unclear = firstMatch(UNCLEAR_PATTERNS, text);

  if (negative) {
    result.sponsorship = 'not_offered';
    result.sponsorshipConfidence = 0.92;
    result.sponsorshipEvidence = quote(negative[0]);
  } else if (positive) {
    result.sponsorship = 'offered';
    result.sponsorshipConfidence = 0.9;
    result.sponsorshipEvidence = quote(positive[0]);
  } else if (unclear) {
    result.sponsorship = 'unclear';
    result.sponsorshipConfidence = 0.7;
    result.sponsorshipEvidence = quote(unclear[0]);
  } else if (input.sourceVisaFlag === true) {
    result.sponsorship = 'offered';
    result.sponsorshipConfidence = 0.8;
    result.sponsorshipEvidence = 'source supplied a visa-sponsorship flag';
  } else if (/\bvisa\b|\bsponsorship\b/i.test(text)) {
    // The topic is raised but no rule matched — ambiguous, not absent.
    result.sponsorship = 'unclear';
    result.sponsorshipConfidence = 0.5;
    result.sponsorshipEvidence = 'sponsorship mentioned but no clear statement found';
  } else {
    result.sponsorship = 'not_mentioned';
    result.sponsorshipConfidence = 0.95;
    result.sponsorshipEvidence = 'no sponsorship statement found';
  }

  // ── Work authorization requirement ────────────────────────────────────────
  const authorization = firstMatch(AUTHORIZATION_PATTERNS, text);
  if (authorization) result.workAuthorizationRequirement = quote(authorization[0], 400);

  // ── Citizenship ───────────────────────────────────────────────────────────
  if (firstMatch(CITIZENSHIP_PATTERNS, text)) result.citizenshipRequired = true;

  // ── Security clearance ────────────────────────────────────────────────────
  for (const { pattern, level } of CLEARANCE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    result.securityClearanceRequired = true;
    result.securityClearanceLevel = level ?? quote(match[0], 120);
    break;
  }

  // ── Relocation ────────────────────────────────────────────────────────────
  const relocationNegative = firstMatch(RELOCATION_NEGATIVE, text);
  const relocationPositive = firstMatch(RELOCATION_POSITIVE, text);
  if (relocationNegative) {
    result.relocationSupport = 'not_offered';
    result.relocationEvidence = quote(relocationNegative[0]);
  } else if (relocationPositive) {
    result.relocationSupport = 'offered';
    result.relocationEvidence = quote(relocationPositive[0]);
  } else if (/\brelocation\b/i.test(text)) {
    result.relocationSupport = 'unclear';
    result.relocationEvidence = 'relocation mentioned without a clear statement';
  }

  return result;
}

function firstMatch(patterns: RegExp[], text: string): RegExpExecArray | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}

function quote(text: string, max = 400): string {
  return collapseWhitespace(text).slice(0, max);
}
