import { collapseWhitespace } from '@job-intel/core';

/**
 * Description cleaning.
 *
 * Job pages carry a lot of text that is not the job: cookie banners, nav, "you
 * may also like" rails, legal footers, tracking blurbs. Removing them makes
 * every downstream extractor more accurate — a footer mentioning "equal
 * opportunity employer" is not a requirement, and a related-jobs rail full of
 * other titles wrecks title and skill extraction.
 *
 * The cleaner is deliberately **conservative**. Over-stripping is worse than
 * under-stripping: a lost requirements section is invisible damage, whereas
 * some leftover boilerplate merely adds noise. Every rule therefore targets a
 * recognisable, self-contained block, and the amount removed is reported so a
 * cleaner that starts eating real content is detectable rather than silent.
 */

export interface CleaningResult {
  cleaned: string;
  removedChars: number;
  /** Which rules fired, for debugging a bad clean. */
  removedBlocks: string[];
}

/**
 * Lines matching these are dropped outright. Anchored to whole lines so a
 * sentence that merely mentions "cookies" inside a real paragraph survives.
 */
const NOISE_LINE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'cookie_banner', pattern: /^(?:we use cookies|this (?:site|website) uses cookies|accept (?:all )?cookies|cookie (?:policy|settings|preferences))\b.*$/i },
  { name: 'nav', pattern: /^(?:home|about(?: us)?|contact(?: us)?|login|sign in|sign up|register|menu|search jobs|browse jobs|all jobs|back to (?:jobs|search|results))$/i },
  { name: 'social_prompt', pattern: /^(?:share (?:this )?(?:job|post|on)|follow us(?: on)?|connect with us|like us on facebook|tweet|share on linkedin)\b.*$/i },
  { name: 'related_jobs', pattern: /^(?:similar jobs|related jobs|you may also (?:like|be interested)|more jobs (?:at|from|like)|recommended (?:jobs|for you)|other opportunities)\b.*:?$/i },
  { name: 'legal_footer', pattern: /^(?:©|copyright|all rights reserved|privacy policy|terms (?:of (?:use|service)|and conditions)|gdpr)\b.*$/i },
  { name: 'app_prompt', pattern: /^(?:download (?:our|the) app|get it on google play|available on the app store)\b.*$/i },
  { name: 'newsletter', pattern: /^(?:subscribe|sign up for (?:our )?(?:job alerts|newsletter)|get job alerts|never miss a job)\b.*$/i },
  { name: 'tracking', pattern: /^(?:powered by|hosted by|job id\s*[:#]|ref(?:erence)?\s*(?:no|number|code)?\s*[:#])\s*\S{0,40}$/i },
  { name: 'breadcrumb', pattern: /^(?:\w[\w\s]{0,20})(?:\s*[>/»]\s*[\w\s]{1,30}){2,}$/ },
  { name: 'empty_bullet', pattern: /^[-*•·–—\s]+$/ },
];

/**
 * Everything from a matching heading to the end is dropped.
 *
 * Job pages put the real content first and the site furniture last, so a
 * recognisable trailing heading is a reliable cut point. Only applied when the
 * heading appears in the last 40% of the text — an "About us" section near the
 * top is genuine content.
 */
const TAIL_CUT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'tail_related', pattern: /^(?:similar|related|recommended)\s+jobs?\b/i },
  { name: 'tail_more_jobs', pattern: /^more jobs? (?:at|from|like)\b/i },
  { name: 'tail_newsletter', pattern: /^(?:job alerts?|subscribe to)\b/i },
  { name: 'tail_footer', pattern: /^(?:quick links|useful links|follow us|stay connected)\b/i },
];

/** Boilerplate that is real content but adds no matching signal. */
const BOILERPLATE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'eeo_statement',
    pattern: /\b(?:is an equal opportunit(?:y|ies) employer|we are an equal opportunit)\b[\s\S]{0,400}?(?:\.|$)/gi,
  },
  {
    name: 'recruiter_spam',
    pattern: /^(?:no agencies|recruiters?,? please do not contact|principals only)\b.*$/gim,
  },
];

export function cleanJobDescription(input: string | null | undefined): CleaningResult {
  if (!input) return { cleaned: '', removedChars: 0, removedBlocks: [] };

  const original = input;
  const removedBlocks = new Set<string>();
  let lines = original.split('\n').map((l) => collapseWhitespace(l));

  // 1. Trailing site furniture.
  const cutThreshold = Math.floor(lines.length * 0.6);
  for (let i = cutThreshold; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const hit = TAIL_CUT_PATTERNS.find((p) => p.pattern.test(line));
    if (hit) {
      removedBlocks.add(hit.name);
      lines = lines.slice(0, i);
      break;
    }
  }

  // 2. Whole-line noise.
  lines = lines.filter((line) => {
    if (line.length === 0) return true; // paragraph breaks carry structure
    const hit = NOISE_LINE_PATTERNS.find((p) => p.pattern.test(line));
    if (hit) {
      removedBlocks.add(hit.name);
      return false;
    }
    return true;
  });

  let cleaned = lines.join('\n');

  // 3. Consecutive duplicate lines. Scrapes routinely repeat a block twice;
  //    non-adjacent repeats are left alone because bullet lists legitimately
  //    reuse short phrases.
  const deduped: string[] = [];
  for (const line of cleaned.split('\n')) {
    const previous = deduped[deduped.length - 1];
    if (line.length > 20 && previous === line) {
      removedBlocks.add('duplicate_line');
      continue;
    }
    deduped.push(line);
  }
  cleaned = deduped.join('\n');

  // 4. Boilerplate.
  for (const { name, pattern } of BOILERPLATE_PATTERNS) {
    const next = cleaned.replace(pattern, '');
    if (next !== cleaned) {
      removedBlocks.add(name);
      cleaned = next;
    }
  }

  // 5. Collapse runs of blank lines.
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  /**
   * Safety valve. If the rules removed more than 60% of the text, something is
   * wrong with them rather than with the posting — fall back to the original
   * rather than hand a gutted description to every downstream extractor.
   */
  const removedChars = original.length - cleaned.length;
  if (cleaned.length < original.length * 0.4 && original.length > 400) {
    return {
      cleaned: original.trim(),
      removedChars: 0,
      removedBlocks: ['cleaning_reverted_excessive_removal'],
    };
  }

  return { cleaned, removedChars: Math.max(0, removedChars), removedBlocks: [...removedBlocks] };
}

// ── Section segmentation ────────────────────────────────────────────────────

export interface JobSections {
  responsibilities: string[];
  requirements: string[];
  preferredQualifications: string[];
  benefits: string[];
  /** Text that belonged to no recognised section. */
  other: string[];
}

/**
 * Section headings.
 *
 * Order matters: `preferred` is tested before `requirements` because "Preferred
 * Qualifications" contains the word "qualifications" and would otherwise be
 * filed as a hard requirement — which is exactly the distinction the matching
 * engine most needs preserved.
 */
const SECTION_PATTERNS: Array<{ section: keyof JobSections; pattern: RegExp }> = [
  {
    section: 'preferredQualifications',
    pattern: /^(?:nice[\s-]to[\s-]have|preferred|bonus|plus(?:es)?|desirable|good to have|would be a plus|advantageous)\b.{0,40}$/i,
  },
  {
    section: 'responsibilities',
    pattern: /^(?:responsibilit|what you(?:'| wi)?ll (?:do|be doing)|the role|your (?:role|mission|impact)|duties|about the (?:role|job)|day[\s-]to[\s-]day|key tasks)\b.{0,40}$/i,
  },
  {
    section: 'requirements',
    pattern: /^(?:requirements?|qualifications?|what (?:we(?:'| a)?re looking for|you(?:'| wi)?ll need|you bring)|must[\s-]have|skills? (?:&|and) experience|your profile|who you are|essential)\b.{0,40}$/i,
  },
  {
    section: 'benefits',
    pattern: /^(?:benefits?|what we offer|perks|compensation (?:&|and) benefits|why (?:join|work)|we offer)\b.{0,40}$/i,
  },
];

/**
 * Splits a description into sections by heading.
 *
 * Deliberately simple and conservative: a bullet is assigned to whichever
 * heading most recently preceded it. Anything before the first recognised
 * heading lands in `other` rather than being guessed into a section.
 */
export function segmentSections(description: string | null | undefined): JobSections {
  const sections: JobSections = {
    responsibilities: [],
    requirements: [],
    preferredQualifications: [],
    benefits: [],
    other: [],
  };
  if (!description) return sections;

  let current: keyof JobSections = 'other';

  for (const rawLine of description.split('\n')) {
    const line = collapseWhitespace(rawLine);
    if (line.length === 0) continue;

    // A heading is short and matches a known pattern. The length guard stops a
    // sentence that merely starts with "Requirements" from resetting the section.
    const headingText = line.replace(/^[#*•·\-–—\s]+/, '').replace(/[:：]\s*$/, '');
    if (headingText.length <= 60) {
      const match = SECTION_PATTERNS.find((p) => p.pattern.test(headingText));
      if (match) {
        current = match.section;
        continue;
      }
    }

    const item = line.replace(/^[*•·\-–—•]\s*/, '').trim();
    if (item.length < 3) continue;
    sections[current].push(item.slice(0, 1000));
  }

  return sections;
}
