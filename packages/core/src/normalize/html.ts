import { collapseWhitespace } from './text';

/**
 * HTML handling for untrusted source content.
 *
 * Job descriptions are third-party HTML that ends up both in LLM prompts and in
 * the dashboard. Two separate needs:
 *
 *   `htmlToText`    — plain text for matching, hashing and prompting.
 *   `sanitizeHtml`  — allowlisted markup for rendering.
 *
 * Sanitization happens here, at normalization time, rather than at render time:
 * storing already-sanitized markup means a future template that forgets to
 * escape cannot reintroduce the vulnerability.
 */

const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table', 'section',
  'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
]);

/** Tags whose *contents* are dropped entirely, not just their markup. */
const VOID_CONTENT_TAGS = ['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'svg'];

/**
 * Zero-width, bidi and BOM characters. Invisible to a reader but they change
 * tokenization — and their presence is itself a scam signal recorded below.
 */
const ZERO_WIDTH_CLASS = '[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]';
const ZERO_WIDTH_PATTERN = new RegExp(ZERO_WIDTH_CLASS, 'g');
/**
 * Separate non-global instance for `.test()`. A `/g` regex advances
 * `lastIndex` on every `test`, so sharing one would make repeated checks
 * alternate between true and false.
 */
const ZERO_WIDTH_TEST = new RegExp(ZERO_WIDTH_CLASS);

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  bull: '•', middot: '·', eacute: 'é', trade: '™', copy: '©', reg: '®', euro: '€', pound: '£',
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Converts HTML to readable plain text, preserving block structure as newlines
 * so list items and paragraphs do not run together into one unreadable line.
 */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;

  let text = html;
  for (const tag of VOID_CONTENT_TAGS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
    text = text.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), ' ');
  }
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');

  // Turn block boundaries into newlines before stripping the remaining tags.
  text = text.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (_, tag: string) =>
    BLOCK_TAGS.has(tag.toLowerCase()) ? '\n' : ' ',
  );

  text = decodeEntities(text);
  // Strip zero-width and bidi characters: they are invisible to a reader but
  // change tokenization, and their presence is itself a scam signal later.
  text = text.replace(ZERO_WIDTH_PATTERN, '');

  const lines = text
    .split('\n')
    .map((line) => collapseWhitespace(line))
    .filter((line) => line.length > 0);

  const out = lines.join('\n').trim();
  return out.length > 0 ? out : null;
}

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'a', 'span', 'div',
]);

/**
 * Allowlist sanitizer.
 *
 * Everything not explicitly permitted is removed, including all attributes
 * except `href` on anchors — and `href` only when it is http(s), which closes
 * `javascript:` URLs. Event handlers, styles, scripts and frames cannot survive
 * this, which matters because this markup is rendered in the operator's browser.
 */
export function sanitizeHtml(html: string | null | undefined): string | null {
  if (!html) return null;

  let out = html;
  for (const tag of VOID_CONTENT_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '');
  }
  out = out.replace(/<!--[\s\S]*?-->/g, '');

  out = out.replace(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi, (_match, slash: string, tag: string, attrs: string) => {
    const name = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    if (slash === '/') return `</${name}>`;

    if (name === 'a') {
      const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.trim();
      if (href && /^https?:\/\//i.test(href)) {
        const safe = href.replace(/"/g, '&quot;');
        // Third-party links open in a new tab and must not gain window.opener.
        return `<a href="${safe}" rel="noopener noreferrer nofollow" target="_blank">`;
      }
      return '<a>';
    }
    return `<${name}>`;
  });

  out = out.replace(ZERO_WIDTH_PATTERN, '');
  return collapseWhitespace(out).length > 0 ? out.trim() : null;
}

/**
 * Detects hidden-text tricks before markup is stripped.
 * Surfaced as a quality/scam signal in a later phase; recorded here because
 * this is the only point where the original markup is still available.
 */
export function detectHiddenContent(html: string | null | undefined): string[] {
  if (!html) return [];
  const flags: string[] = [];
  if (ZERO_WIDTH_TEST.test(html)) flags.push('zero_width_characters');
  if (/display\s*:\s*none/i.test(html)) flags.push('display_none');
  if (/visibility\s*:\s*hidden/i.test(html)) flags.push('visibility_hidden');
  if (/font-size\s*:\s*0/i.test(html)) flags.push('zero_font_size');
  if (/color\s*:\s*#?(fff(fff)?|white)\b/i.test(html)) flags.push('white_text');
  if (/<!--[\s\S]{200,}?-->/.test(html)) flags.push('large_html_comment');
  return flags;
}
