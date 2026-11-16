import { createHash } from 'node:crypto';
import {
  type AlertData,
  type DigestData,
  type JobCardData,
  type RenderedEmail,
  type SystemAlertData,
  type WeeklySummaryData,
} from '@job-intel/contracts';
import {
  PALETTE,
  ctaButton,
  digestHeader,
  emailFooter,
  emailShell,
  escapeHtml,
  jobCard,
  priorityBadge,
  reasonList,
  scoreBadge,
  sectionHeader,
  describeApplyUrl,
} from './components';

/**
 * Email rendering.
 *
 * Templates take a typed data structure and return HTML plus a plain-text
 * alternative. The separation matters twice over: business logic never builds
 * markup, and — because a template can only render what the data carries — an
 * email cannot state a fact the pipeline did not produce.
 *
 * The text part is not optional. Some clients prefer it, spam filters read it,
 * and an HTML-only message is measurably less deliverable.
 *
 * `idempotencyKey` is a hash of the rendered content plus a caller-supplied
 * scope. Re-rendering identical content yields the same key, which is what
 * makes a retry after an ambiguous provider response safe.
 */

export interface RenderOptions {
  /** Distinguishes recipients and runs, e.g. `digest:<profile>:<period>`. */
  scope: string;
}

function idempotencyKey(scope: string, subject: string, body: string): string {
  return createHash('sha256').update(`${scope}\n${subject}\n${body}`).digest('hex').slice(0, 64);
}

function finalise(
  scope: string,
  subject: string,
  html: string,
  text: string,
): RenderedEmail {
  return { subject, html, text, idempotencyKey: idempotencyKey(scope, subject, text) };
}

// ── Plain-text helpers ──────────────────────────────────────────────────────

function jobText(job: JobCardData, index?: number): string {
  const lines: string[] = [];
  const prefix = index === undefined ? '' : `${index}. `;
  lines.push(`${prefix}${job.title} — ${job.company}`);

  const meta = [job.location, job.workArrangement, job.salary].filter(Boolean).join(' · ');
  if (meta) lines.push(`   ${meta}`);

  lines.push(
    `   Match ${Math.round(job.matchScore)}% · Confidence ${Math.round(job.confidence * 100)}% · Recommended ${Math.round(job.recommendationScore)}`,
  );

  if (job.updateNote) lines.push(`   UPDATE to a job you previously received: ${job.updateNote}`);
  for (const why of job.whyItMatches.slice(0, 4)) lines.push(`   + ${why}`);
  for (const concern of job.concerns.slice(0, 2)) lines.push(`   ! ${concern}`);
  if (job.matchedSkills.length > 0) {
    lines.push(`   Skills: ${job.matchedSkills.slice(0, 8).join(', ')}`);
  }
  lines.push(`   Apply: ${job.applyUrl}`);
  lines.push(`   (${describeApplyUrl(job)})`);
  lines.push(`   ${job.sourceLabel} · posted ${job.postedAgo}`);
  return lines.join('\n');
}

// ── Digest ──────────────────────────────────────────────────────────────────

export function renderDigest(data: DigestData, options: RenderOptions): RenderedEmail {
  const totalJobs = data.sections.reduce((sum, section) => sum + section.jobs.length, 0);

  const body = [
    digestHeader('Your Job Intelligence Digest', data.periodLabel, [
      `${data.jobsDiscovered} discovered`,
      `${data.highQualityMatches} high-quality matches`,
      `${totalJobs} shown`,
    ]),
    ...data.sections
      .filter((section) => section.jobs.length > 0)
      .flatMap((section) => [
        sectionHeader(section.icon, section.title, section.jobs.length),
        ...section.jobs.map(jobCard),
      ]),
    totalJobs === 0
      ? `<p style="font-size:14px;color:${PALETTE.muted};">` +
        `Nothing cleared your thresholds this period. That is the system working — ` +
        `you can lower them in your settings if you would like to see more.</p>`
      : '',
    emailFooter(data.preferencesUrl),
  ].join('\n');

  const text = [
    'YOUR JOB INTELLIGENCE DIGEST',
    data.periodLabel,
    `${data.jobsDiscovered} discovered · ${data.highQualityMatches} high-quality matches · ${totalJobs} shown`,
    '',
    ...data.sections
      .filter((section) => section.jobs.length > 0)
      .flatMap((section) => [
        `${section.icon} ${section.title.toUpperCase()} (${section.jobs.length})`,
        '',
        ...section.jobs.map((job, index) => `${jobText(job, index + 1)}\n`),
      ]),
    totalJobs === 0 ? 'Nothing cleared your thresholds this period.\n' : '',
    `Manage notification settings: ${data.preferencesUrl}`,
  ].join('\n');

  return finalise(options.scope, data.subject, emailShell(data.subject, body), text);
}

// ── Individual alert ────────────────────────────────────────────────────────

export function renderAlert(data: AlertData, options: RenderOptions): RenderedEmail {
  const job = data.job;
  const meta = [job.location, job.workArrangement]
    .filter((value): value is string => Boolean(value))
    .map(escapeHtml)
    .join(' / ');

  const body = [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
            style="margin-bottom:16px;">
       <tr><td>${priorityBadge(data.priority)}</td></tr>
       <tr><td style="padding-top:10px;font-size:22px;font-weight:700;color:${PALETTE.text};">
         ${escapeHtml(data.headline)}
       </td></tr>
     </table>`,

    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
            style="border:1px solid ${PALETTE.border};border-radius:8px;background:${PALETTE.surface};">
       <tr><td style="padding:20px;">
         <div style="font-size:19px;font-weight:700;color:${PALETTE.text};">${escapeHtml(job.title)}</div>
         <div style="margin-top:4px;font-size:14px;color:${PALETTE.muted};">${escapeHtml(job.company)}</div>

         <div style="margin-top:14px;">
           ${scoreBadge('Match', job.matchScore, '%')}
           ${scoreBadge('Confidence', job.confidence * 100, '%')}
           ${scoreBadge('Recommended', job.recommendationScore)}
         </div>

         ${
           job.updateNote
             ? `<div style="margin-top:14px;padding:10px 12px;border-radius:4px;background:#fef3c7;
                  border:1px solid #fcd34d;font-size:13px;color:#78350f;">
                  <strong>Update to a job you previously received.</strong> ${escapeHtml(job.updateNote)}
                </div>`
             : ''
         }

         <div style="margin-top:16px;font-size:14px;font-weight:600;color:${PALETTE.text};">
           Why this is a strong match
         </div>
         ${reasonList(job.whyItMatches.slice(0, 8), 'positive')}

         ${
           job.concerns.length > 0
             ? `<div style="margin-top:14px;font-size:14px;font-weight:600;color:${PALETTE.text};">
                  Potential concerns
                </div>${reasonList(job.concerns.slice(0, 4), 'concern')}`
             : ''
         }

         ${
           job.salary
             ? `<div style="margin-top:14px;font-size:13px;color:${PALETTE.text};">
                  <strong>Compensation:</strong> ${escapeHtml(job.salary)}
                </div>`
             : ''
         }
         ${
           meta
             ? `<div style="margin-top:4px;font-size:13px;color:${PALETTE.text};">
                  <strong>Location:</strong> ${meta}
                </div>`
             : ''
         }

         <div style="margin-top:20px;">
           ${ctaButton(job.applyUrl, 'Apply', { destination: describeApplyUrl(job) })}
           <span style="display:inline-block;width:10px;"></span>
           ${ctaButton(job.viewUrl, 'View job', { primary: false })}
         </div>

         <div style="margin-top:16px;font-size:12px;color:${PALETTE.muted};">
           Source: ${escapeHtml(job.sourceLabel)} &middot; discovered ${escapeHtml(job.postedAgo)}<br>
           Triggered by: ${escapeHtml(data.ruleName)}
         </div>
       </td></tr>
     </table>`,

    emailFooter(data.preferencesUrl),
  ].join('\n');

  const text = [
    `${data.priority} — ${data.headline}`,
    '',
    jobText(job),
    '',
    `Triggered by: ${data.ruleName}`,
    `View: ${job.viewUrl}`,
    '',
    `Manage notification settings: ${data.preferencesUrl}`,
  ].join('\n');

  return finalise(options.scope, data.subject, emailShell(data.subject, body), text);
}

// ── System alert ────────────────────────────────────────────────────────────

const SEVERITY_COLOR = {
  info: PALETTE.accent,
  warning: PALETTE.warn,
  critical: PALETTE.danger,
} as const;

export function renderSystemAlert(data: SystemAlertData, options: RenderOptions): RenderedEmail {
  const color = SEVERITY_COLOR[data.severity];

  const facts = data.facts
    .map(
      (fact) =>
        `<tr><td style="padding:3px 14px 3px 0;font-size:13px;color:${PALETTE.muted};white-space:nowrap;">` +
        `${escapeHtml(fact.label)}</td>` +
        `<td style="padding:3px 0;font-size:13px;color:${PALETTE.text};">${escapeHtml(fact.value)}</td></tr>`,
    )
    .join('');

  const body = [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
            style="border-left:4px solid ${color};background:${PALETTE.surface};
                   border-radius:6px;border:1px solid ${PALETTE.border};">
       <tr><td style="padding:18px 20px;">
         <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${color};">
           ${escapeHtml(data.severity)}
         </div>
         <div style="margin-top:6px;font-size:18px;font-weight:700;color:${PALETTE.text};">
           ${escapeHtml(data.title)}
         </div>
         <div style="margin-top:8px;font-size:14px;line-height:21px;color:${PALETTE.text};">
           ${escapeHtml(data.summary)}
         </div>
         ${facts ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">${facts}</table>` : ''}
         ${
           data.suggestedAction
             ? `<div style="margin-top:14px;padding:10px 12px;border-radius:4px;
                  background:#f3f4f6;font-size:13px;color:${PALETTE.text};">
                  <strong>Suggested action:</strong> ${escapeHtml(data.suggestedAction)}
                </div>`
             : ''
         }
       </td></tr>
     </table>`,
    emailFooter(data.preferencesUrl),
  ].join('\n');

  const text = [
    `[${data.severity.toUpperCase()}] ${data.title}`,
    '',
    data.summary,
    '',
    ...data.facts.map((fact) => `${fact.label}: ${fact.value}`),
    data.suggestedAction ? `\nSuggested action: ${data.suggestedAction}` : '',
    '',
    `Manage notification settings: ${data.preferencesUrl}`,
  ].join('\n');

  return finalise(options.scope, data.subject, emailShell(data.subject, body), text);
}

// ── Weekly summary ──────────────────────────────────────────────────────────

function statGrid(stats: Array<[string, string | number]>): string {
  const cells = stats
    .map(
      ([label, value]) =>
        `<td style="padding:10px 14px;border:1px solid ${PALETTE.border};border-radius:6px;">` +
        `<div style="font-size:20px;font-weight:700;color:${PALETTE.text};">${escapeHtml(String(value))}</div>` +
        `<div style="margin-top:2px;font-size:11px;color:${PALETTE.muted};text-transform:uppercase;` +
        `letter-spacing:.04em;">${escapeHtml(label)}</div></td>`,
    )
    .join('<td style="width:8px;"></td>');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 14px;"><tr>${cells}</tr></table>`;
}

function rankedList(title: string, items: ReadonlyArray<{ label: string; count: number }>): string {
  if (items.length === 0) return '';
  const rows = items
    .slice(0, 5)
    .map(
      (item) =>
        `<tr><td style="padding:2px 12px 2px 0;font-size:13px;color:${PALETTE.text};">` +
        `${escapeHtml(item.label)}</td>` +
        `<td style="padding:2px 0;font-size:13px;color:${PALETTE.muted};">${item.count}</td></tr>`,
    )
    .join('');

  return (
    `<div style="margin-top:16px;font-size:14px;font-weight:600;color:${PALETTE.text};">${escapeHtml(title)}</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;">${rows}</table>`
  );
}

export function renderWeeklySummary(
  data: WeeklySummaryData,
  options: RenderOptions,
): RenderedEmail {
  const s = data.stats;

  const body = [
    digestHeader('Your Week in Job Intelligence', data.periodLabel, []),
    statGrid([
      ['Discovered', s.jobsDiscovered],
      ['Recommended', s.jobsRecommended],
      ['Notified', s.jobsNotified],
    ]),
    statGrid([
      ['Saved', s.jobsSaved],
      ['Clicked', s.jobsClicked],
      ['Applied', s.jobsApplied],
    ]),
    statGrid([
      ['Avg match', Math.round(s.averageMatchScore)],
      ['Duplicates', s.duplicatesMerged],
      ['Stale', s.staleJobs],
    ]),
    rankedList('Top companies', data.topCompanies),
    rankedList('Top locations', data.topLocations),
    rankedList('Top technologies', data.topTechnologies),
    data.bestSources.length > 0
      ? rankedList(
          'Sources producing the best jobs',
          data.bestSources.map((source) => ({
            label: `${source.label} (avg ${Math.round(source.averageScore)})`,
            count: source.count,
          })),
        )
      : '',
    emailFooter(data.preferencesUrl),
  ].join('\n');

  const text = [
    'YOUR WEEK IN JOB INTELLIGENCE',
    data.periodLabel,
    '',
    `Discovered: ${s.jobsDiscovered}`,
    `Recommended: ${s.jobsRecommended}`,
    `Notified: ${s.jobsNotified}`,
    `Saved: ${s.jobsSaved} · Clicked: ${s.jobsClicked} · Applied: ${s.jobsApplied}`,
    `Average match score: ${Math.round(s.averageMatchScore)}`,
    `Duplicates merged: ${s.duplicatesMerged} · Stale: ${s.staleJobs}`,
    '',
    ...(data.topCompanies.length > 0
      ? ['Top companies:', ...data.topCompanies.slice(0, 5).map((c) => `  ${c.label} (${c.count})`)]
      : []),
    ...(data.topTechnologies.length > 0
      ? ['Top technologies:', ...data.topTechnologies.slice(0, 5).map((t) => `  ${t.label} (${t.count})`)]
      : []),
    '',
    `Manage notification settings: ${data.preferencesUrl}`,
  ].join('\n');

  return finalise(options.scope, data.subject, emailShell(data.subject, body), text);
}
