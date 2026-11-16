import { htmlToText } from '@job-intel/core';

/**
 * Main-content extraction.
 *
 * A job page is mostly not the job: navigation, a cookie banner, a footer with
 * forty links, a sidebar of "similar roles", and a newsletter form. Sending all
 * of that to a model costs tokens for noise and actively degrades the answer —
 * "similar roles" is the single most common source of a hallucinated job title.
 *
 * The strategy is ordered by how much the publisher told us:
 *
 *   1. `<script type="application/ld+json">` — handled elsewhere, always first.
 *   2. Semantic containers the publisher chose: `<main>`, `<article>`,
 *      `[role=main]`, or a container whose class names say "job description".
 *   3. Density heuristic: the block with the most text and the fewest links.
 *      Navigation is link-dense and word-poor; a job description is the reverse.
 *
 * No DOM parser is used. The pages this runs on are arbitrary and often
 * malformed, and a regex-and-slice approach that degrades to "return the whole
 * body text" is more predictable here than a parser that throws on the tenth
 * unclosed `<div>`.
 */

/** Elements whose content is never part of a job description. */
const STRIP_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'canvas',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  'video',
  'audio',
];

/** Class/id fragments that mark page chrome rather than content. */
const CHROME_PATTERNS = [
  'cookie',
  'consent',
  'gdpr',
  'banner',
  'navbar',
  'nav-',
  'menu',
  'sidebar',
  'footer',
  'header',
  'breadcrumb',
  'social',
  'share',
  'newsletter',
  'subscribe',
  'advert',
  'ads-',
  'promo',
  'related-jobs',
  'similar-jobs',
  'other-jobs',
  'recommended',
  'popup',
  'modal',
  'skip-link',
];

/** Containers a publisher uses when it means "this is the job". */
const CONTENT_HINTS = [
  'job-description',
  'jobdescription',
  'job_description',
  'job-details',
  'job-content',
  'job-post',
  'jobpost',
  'posting',
  'vacancy',
  'description',
  'content-main',
  'main-content',
];

export interface ExtractedContent {
  text: string;
  /** Which strategy produced it, so a weak extraction is visible downstream. */
  strategy: 'semantic' | 'hinted_container' | 'density' | 'whole_body';
  /** Characters removed as chrome. A large number is a healthy sign. */
  removedChars: number;
  /** Links per hundred words. High values suggest an index, not a posting. */
  linkDensity: number;
  wordCount: number;
}

function stripElements(html: string): string {
  let out = html;
  for (const tag of STRIP_ELEMENTS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    // Void or unclosed forms of the same tags.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
  }
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  return out;
}

/**
 * Removes elements whose class or id names them as chrome.
 *
 * Non-greedy and depth-blind: it removes the opening tag and everything up to
 * the *next* closing div, which over-trims occasionally and under-trims
 * occasionally. Both are acceptable — the density fallback catches the cases
 * where this leaves too little.
 */
function stripChrome(html: string): string {
  const pattern = new RegExp(
    `<(div|section|ul|ol|table|p)\\b[^>]*(?:class|id)\\s*=\\s*["'][^"']*(?:${CHROME_PATTERNS.join('|')})[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>`,
    'gi',
  );
  let out = html;
  // Two passes: removing an outer block often exposes a nested one.
  for (let pass = 0; pass < 2; pass += 1) out = out.replace(pattern, ' ');
  return out;
}

function countLinks(html: string): number {
  return (html.match(/<a\b/gi) ?? []).length;
}

function wordsIn(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Pulls the inner HTML of the first matching element, if it has real content. */
function firstMatch(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html);
  const inner = match?.[1];
  return inner && inner.trim().length > 200 ? inner : null;
}

function semanticContainer(html: string): string | null {
  return (
    firstMatch(html, /<main\b[^>]*>([\s\S]*?)<\/main>/i) ??
    firstMatch(html, /<article\b[^>]*>([\s\S]*?)<\/article>/i) ??
    firstMatch(html, /<[a-z]+\b[^>]*role\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/[a-z]+>/i)
  );
}

function hintedContainer(html: string): string | null {
  for (const hint of CONTENT_HINTS) {
    const pattern = new RegExp(
      `<(div|section|article)\\b[^>]*(?:class|id)\\s*=\\s*["'][^"']*${hint}[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
      'i',
    );
    const match = pattern.exec(html);
    const inner = match?.[2];
    if (inner && inner.trim().length > 200) return inner;
  }
  return null;
}

/**
 * Picks the block with the best text-to-link ratio.
 *
 * Scores each top-level `<div>`/`<section>` by words minus a penalty per link.
 * Navigation loses badly: fifty links and thirty words. A job description wins:
 * four hundred words and two links.
 */
function densestBlock(html: string): string | null {
  const blocks = [...html.matchAll(/<(div|section)\b[^>]*>([\s\S]{400,}?)<\/\1>/gi)];
  if (blocks.length === 0) return null;

  let best: { inner: string; score: number } | null = null;

  for (const block of blocks) {
    const inner = block[2];
    if (!inner) continue;
    const words = wordsIn(htmlToText(inner) ?? '');
    const links = countLinks(inner);
    const score = words - links * 12;
    if (words < 60) continue;
    if (!best || score > best.score) best = { inner, score };
  }

  return best && best.score > 0 ? best.inner : null;
}

/**
 * Extracts the readable content of a page.
 *
 * Always returns something: an empty extraction would make a caller decide
 * between "the page was empty" and "extraction failed", and the strategy field
 * already distinguishes a confident extraction from a fallback.
 */
export function extractMainContent(html: string, options: { maxChars?: number } = {}): ExtractedContent {
  const maxChars = options.maxChars ?? 20_000;
  const originalLength = html.length;

  const cleaned = stripChrome(stripElements(html));

  const candidates: Array<{ inner: string | null; strategy: ExtractedContent['strategy'] }> = [
    { inner: semanticContainer(cleaned), strategy: 'semantic' },
    { inner: hintedContainer(cleaned), strategy: 'hinted_container' },
    { inner: densestBlock(cleaned), strategy: 'density' },
  ];

  const chosen = candidates.find(
    (candidate): candidate is { inner: string; strategy: ExtractedContent['strategy'] } =>
      candidate.inner !== null,
  );
  const inner = chosen?.inner ?? cleaned;
  const strategy: ExtractedContent['strategy'] = chosen?.strategy ?? 'whole_body';

  const text = (htmlToText(inner) ?? '').slice(0, maxChars);
  const words = wordsIn(text);
  const links = countLinks(inner);

  return {
    text,
    strategy,
    removedChars: Math.max(0, originalLength - inner.length),
    linkDensity: words > 0 ? (links / words) * 100 : 0,
    wordCount: words,
  };
}

/**
 * Whether a page is worth spending a model call on.
 *
 * The brief is explicit that the LLM must not be called for pages that are
 * obviously not job pages, and this is the gate. It is deliberately generous in
 * one direction: rejecting a real job page costs a missed opportunity, while
 * accepting a listing index costs one cheap call and a `false` answer.
 */
export interface ClassificationGate {
  worthClassifying: boolean;
  reason: string;
}

const JOB_SIGNALS = [
  'responsibilities',
  'requirements',
  'qualifications',
  'what you will do',
  'what you’ll do',
  'about the role',
  'about this role',
  'we are looking for',
  'apply now',
  'job description',
  'your profile',
  'benefits',
  'salary',
  'full-time',
  'part-time',
  'years of experience',
];

const NON_JOB_SIGNALS = [
  'privacy policy',
  'terms of service',
  'cookie policy',
  'shopping cart',
  'add to basket',
  '404',
  'page not found',
  'sign in to continue',
];

export function shouldClassify(content: ExtractedContent, url: string): ClassificationGate {
  if (content.wordCount < 80) {
    return { worthClassifying: false, reason: `only ${content.wordCount} words extracted` };
  }
  if (content.wordCount > 12_000) {
    return { worthClassifying: false, reason: 'page is too large to be a single posting' };
  }

  const lower = content.text.toLowerCase();

  const negative = NON_JOB_SIGNALS.find((signal) => lower.includes(signal));
  if (negative && content.wordCount < 400) {
    return { worthClassifying: false, reason: `looks like a ${negative} page` };
  }

  // A link-dense page with many words is a listing index, not one posting.
  if (content.linkDensity > 12) {
    return {
      worthClassifying: false,
      reason: `link density ${content.linkDensity.toFixed(1)}/100 words suggests a listing index`,
    };
  }

  const positives = JOB_SIGNALS.filter((signal) => lower.includes(signal)).length;
  const urlSuggestsJob = /\/(job|jobs|career|careers|vacanc|position|opening|opportunit)/i.test(url);

  if (positives === 0 && !urlSuggestsJob) {
    return { worthClassifying: false, reason: 'no job-posting vocabulary and no job-like URL' };
  }

  return {
    worthClassifying: true,
    reason: `${positives} job signal(s)${urlSuggestsJob ? ', job-like URL' : ''}`,
  };
}
