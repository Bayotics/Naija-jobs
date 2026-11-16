import type { AlertPriority, JobCardData } from '@job-intel/contracts';

/**
 * Email components.
 *
 * Small, composable functions returning HTML fragments — the alternative being
 * giant template strings smeared through business logic, which is exactly what
 * the brief rules out. Data comes in as typed structures; nothing here computes
 * a score, formats a salary from raw numbers or decides what a job means.
 *
 * Email HTML is not web HTML. Three constraints shape everything below:
 *
 *  - **Tables, not flexbox.** Outlook renders through Word, which has no flex
 *    and no grid. Tables are the only layout primitive that works everywhere.
 *  - **Inline styles.** Gmail strips `<style>` blocks from forwarded mail and
 *    several clients strip them entirely. Anything that must survive is inline.
 *  - **No JavaScript, no large images.** Both are stripped or blocked, and a
 *    layout that depends on either degrades to unreadable.
 *
 * Dark mode is handled with `@media (prefers-color-scheme: dark)` in the head
 * for clients that honour it, over a palette that stays legible when they do
 * not — a design that only works in one scheme is broken in the other.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * URLs are escaped *and* scheme-checked.
 *
 * A `javascript:` or `data:` URL reaching an anchor is a stored-XSS vector in
 * any client that renders it, and these URLs originate from third-party job
 * boards. Anything not http(s) becomes a harmless placeholder.
 */
export function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '#';
    return escapeHtml(url.toString());
  } catch {
    return '#';
  }
}

export const PALETTE = {
  text: '#111827',
  muted: '#6b7280',
  border: '#e5e7eb',
  surface: '#ffffff',
  page: '#f4f5f7',
  accent: '#2563eb',
  ok: '#059669',
  warn: '#b45309',
  danger: '#dc2626',
} as const;

const PRIORITY_COLOR: Readonly<Record<AlertPriority, string>> = {
  URGENT: PALETTE.danger,
  HIGH: PALETTE.ok,
  NORMAL: PALETTE.accent,
  LOW: PALETTE.muted,
};

/** Score badge. Colour tracks the number so it is scannable without reading. */
export function scoreBadge(label: string, value: number, suffix = ''): string {
  const color = value >= 85 ? PALETTE.ok : value >= 65 ? PALETTE.accent : PALETTE.muted;
  return [
    `<span style="display:inline-block;padding:2px 8px;margin:0 6px 4px 0;`,
    `border:1px solid ${color};border-radius:999px;`,
    `font-size:12px;line-height:18px;color:${color};white-space:nowrap;">`,
    `${escapeHtml(label)} <strong>${Math.round(value)}${escapeHtml(suffix)}</strong>`,
    `</span>`,
  ].join('');
}

export function priorityBadge(priority: AlertPriority): string {
  const color = PRIORITY_COLOR[priority];
  return (
    `<span style="display:inline-block;padding:3px 10px;border-radius:4px;` +
    `background:${color};color:#ffffff;font-size:12px;font-weight:600;` +
    `letter-spacing:.04em;text-transform:uppercase;">${escapeHtml(priority)}</span>`
  );
}

/** Bulleted reasons. Ticks for positives, a caution mark for concerns. */
export function reasonList(items: readonly string[], kind: 'positive' | 'concern'): string {
  if (items.length === 0) return '';
  const mark = kind === 'positive' ? '✓' : '!';
  const color = kind === 'positive' ? PALETTE.ok : PALETTE.warn;

  const rows = items
    .map(
      (item) =>
        `<tr><td style="vertical-align:top;padding:1px 6px 1px 0;color:${color};` +
        `font-size:13px;line-height:19px;">${mark}</td>` +
        `<td style="padding:1px 0;color:${PALETTE.text};font-size:13px;line-height:19px;">` +
        `${escapeHtml(item)}</td></tr>`,
    )
    .join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 0;">${rows}</table>`;
}

/**
 * Call to action.
 *
 * The destination is named beside the button. A CTA that says only "Apply" and
 * silently lands on an aggregator's sign-up wall is the small dishonesty that
 * makes someone stop trusting every other link in the email.
 */
export function ctaButton(
  href: string,
  label: string,
  options: { destination?: string; primary?: boolean } = {},
): string {
  const primary = options.primary ?? true;
  const background = primary ? PALETTE.accent : PALETTE.surface;
  const color = primary ? '#ffffff' : PALETTE.accent;
  const border = primary ? PALETTE.accent : PALETTE.border;

  const button =
    `<a href="${safeUrl(href)}" target="_blank" rel="noopener noreferrer" ` +
    `style="display:inline-block;padding:10px 18px;border-radius:6px;` +
    `background:${background};color:${color};border:1px solid ${border};` +
    `font-size:14px;font-weight:600;text-decoration:none;">${escapeHtml(label)}</a>`;

  if (!options.destination) return button;
  return (
    `${button}<div style="margin-top:4px;font-size:11px;color:${PALETTE.muted};">` +
    `goes to ${escapeHtml(options.destination)}</div>`
  );
}

/** Where an application link actually leads, in words. */
export function describeApplyUrl(job: JobCardData): string {
  switch (job.applyUrlKind) {
    case 'ats':
      return job.applyUrlVerified
        ? "the employer's applicant tracking system (verified)"
        : "the employer's applicant tracking system";
    case 'company':
      return job.applyUrlVerified ? 'the company careers page (verified)' : 'the company careers page';
    case 'aggregator':
      return `${job.sourceLabel} — an aggregator, not the employer`;
    case 'unverified':
      return `${job.sourceLabel} (destination not confirmed)`;
    default:
      return job.sourceLabel;
  }
}

/**
 * One job.
 *
 * Ordered for a three-second decision: title and company, then the three
 * numbers, then why, then the caveat, then the button. Every value is read from
 * `JobCardData` — the card cannot invent a salary the posting never stated
 * because it has nowhere to invent one from.
 */
export function jobCard(job: JobCardData): string {
  const meta = [job.location, job.workArrangement, job.salary]
    .filter((v): v is string => Boolean(v))
    .map(escapeHtml)
    .join(' &middot; ');

  const update = job.updateNote
    ? `<tr><td style="padding:0 0 10px;"><div style="padding:8px 10px;border-radius:4px;` +
      `background:#fef3c7;border:1px solid #fcd34d;font-size:12px;color:#78350f;">` +
      `<strong>Update to a job you previously received.</strong> ${escapeHtml(job.updateNote)}` +
      `</div></td></tr>`
    : '';

  const skills =
    job.matchedSkills.length > 0
      ? `<div style="margin-top:8px;font-size:12px;color:${PALETTE.muted};">` +
        `Matched skills: ${escapeHtml(job.matchedSkills.slice(0, 8).join(', '))}</div>`
      : '';

  const missing =
    job.missingRequirements.length > 0
      ? `<div style="margin-top:4px;font-size:12px;color:${PALETTE.muted};">` +
        `Missing: ${escapeHtml(job.missingRequirements.slice(0, 5).join(', '))}</div>`
      : '';

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="margin:0 0 14px;border:1px solid ${PALETTE.border};border-radius:8px;
              background:${PALETTE.surface};">
  <tr><td style="padding:16px 18px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${update}
      <tr><td style="padding:0 0 2px;">
        <a href="${safeUrl(job.viewUrl)}" target="_blank" rel="noopener noreferrer"
           style="font-size:16px;font-weight:700;color:${PALETTE.text};text-decoration:none;">
          ${escapeHtml(job.title)}
        </a>
      </td></tr>
      <tr><td style="padding:0 0 8px;font-size:13px;color:${PALETTE.muted};">
        ${escapeHtml(job.company)}${meta ? ` &middot; ${meta}` : ''}
      </td></tr>
      <tr><td style="padding:0 0 6px;">
        ${scoreBadge('Match', job.matchScore, '%')}
        ${scoreBadge('Confidence', job.confidence * 100, '%')}
        ${scoreBadge('Recommended', job.recommendationScore)}
      </td></tr>
      <tr><td>${reasonList(job.whyItMatches.slice(0, 5), 'positive')}</td></tr>
      <tr><td>${reasonList(job.concerns.slice(0, 3), 'concern')}</td></tr>
      <tr><td>${skills}${missing}</td></tr>
      <tr><td style="padding:14px 0 0;">
        ${ctaButton(job.applyUrl, 'Apply', { destination: describeApplyUrl(job) })}
      </td></tr>
      <tr><td style="padding:10px 0 0;font-size:11px;color:${PALETTE.muted};">
        ${escapeHtml(job.sourceLabel)} &middot; posted ${escapeHtml(job.postedAgo)}
      </td></tr>
    </table>
  </td></tr>
</table>`.trim();
}

export function sectionHeader(icon: string, title: string, count: number): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 10px;">
  <tr><td style="font-size:15px;font-weight:700;color:${PALETTE.text};">
    ${escapeHtml(icon)} ${escapeHtml(title)}
    <span style="font-weight:400;color:${PALETTE.muted};">(${count})</span>
  </td></tr>
</table>`.trim();
}

export function digestHeader(title: string, subtitle: string, facts: string[]): string {
  const factLine = facts.map(escapeHtml).join(' &middot; ');
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="border-bottom:2px solid ${PALETTE.border};padding-bottom:14px;">
  <tr><td>
    <div style="font-size:20px;font-weight:700;color:${PALETTE.text};">${escapeHtml(title)}</div>
    <div style="margin-top:4px;font-size:13px;color:${PALETTE.muted};">${escapeHtml(subtitle)}</div>
    ${factLine ? `<div style="margin-top:8px;font-size:13px;color:${PALETTE.text};">${factLine}</div>` : ''}
  </td></tr>
</table>`.trim();
}

/**
 * Footer.
 *
 * The preferences link is a signed, single-purpose URL — see
 * `preferences/preference-link.ts`. A bare "click here to unsubscribe" that
 * mutates state on GET would let anyone who saw the address change the
 * account's settings.
 */
export function emailFooter(preferencesUrl: string): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="margin-top:26px;border-top:1px solid ${PALETTE.border};padding-top:14px;">
  <tr><td style="font-size:12px;color:${PALETTE.muted};line-height:18px;">
    You are receiving this because you set up job alerts.
    <a href="${safeUrl(preferencesUrl)}" style="color:${PALETTE.accent};">Manage notification settings</a>
    to change frequency, thresholds or quiet hours, or to stop these emails.
  </td></tr>
</table>`.trim();
}

/**
 * The document shell.
 *
 * `prefers-color-scheme` is honoured where the client supports it; the light
 * palette is chosen to stay readable where it does not, which is still most of
 * them.
 */
export function emailShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; padding:0; background:${PALETTE.page}; }
  .wrap { width:100%; padding:24px 12px; }
  .inner { max-width:640px; margin:0 auto; }
  @media (max-width:600px) {
    .wrap { padding:12px 8px; }
    .inner { width:100% !important; }
  }
  @media (prefers-color-scheme: dark) {
    body, .wrap { background:#0b0f19 !important; }
    .card, table[role="presentation"] { background:#111827 !important; }
    a, div, td, span, strong { color:#e5e7eb !important; }
    .muted, .muted * { color:#9ca3af !important; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="inner">
${body}
  </div>
</div>
</body>
</html>`;
}
