import { createHash } from 'node:crypto';
import type { RenderedEmail } from '@job-intel/contracts';
import {
  PALETTE,
  ctaButton,
  emailFooter,
  emailShell,
  escapeHtml,
  sectionHeader,
} from './components';

/**
 * Templates for the notification types added by this layer.
 *
 * Three rules apply to every one of them, and all three are about the same
 * thing: an email is the one part of this system that reaches someone outside
 * it, so nothing untrusted may pass through unescaped and nothing may claim
 * more than the data supports.
 *
 * **Everything external is escaped.** Job titles, company names and posting
 * text come from strangers on the internet. `escapeHtml` is applied at every
 * interpolation rather than at the boundary, because a boundary someone forgets
 * to apply is not a boundary.
 *
 * **A link is only rendered when one exists.** Templates never construct a URL,
 * and a missing one renders as a note rather than a plausible-looking guess.
 *
 * **Every email says why it was sent.** The reason travels with the data and is
 * shown, because a notification the reader cannot account for is one they learn
 * to distrust.
 */

export interface RenderContext {
  candidateName: string | null;
  dashboardUrl: string;
  preferencesUrl: string;
  unsubscribeUrl: string | null;
}

const plainWrap = (lines: readonly string[]): string => lines.filter(Boolean).join('\n');

/** Stable id so the same content produces the same message identity. */
const contentId = (...parts: string[]): string =>
  createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);

// ── Deadline reminder (APPLICATION_DEADLINE) ────────────────────────────────

export interface DeadlineReminderData {
  jobTitle: string;
  companyName: string | null;
  /** Validated before it reaches here. Null renders as a note. */
  applicationUrl: string | null;
  jobDetailUrl: string;
  hoursRemaining: number;
  reason: string;
  /** Present when the candidate has already picked a resume. */
  recommendedResume: string | null;
}

export function renderDeadlineReminder(
  data: DeadlineReminderData,
  context: RenderContext,
): RenderedEmail {
  const hours = Math.max(1, Math.round(data.hoursRemaining));
  const window = hours < 24 ? `${hours} hours` : `${Math.round(hours / 24)} days`;

  const subject = `Closing in ${window}: ${data.jobTitle}`;

  const body = [
    sectionHeader('⏳', 'Closing soon', 1),
    `<p style="margin:0 0 12px;font-size:15px;color:${PALETTE.text};">` +
      `<strong>${escapeHtml(data.jobTitle)}</strong>` +
      (data.companyName ? ` at ${escapeHtml(data.companyName)}` : '') +
      ` closes in about ${escapeHtml(window)}.</p>`,
    `<p style="margin:0 0 16px;font-size:14px;color:${PALETTE.muted};">${escapeHtml(data.reason)}</p>`,
    data.recommendedResume
      ? `<p style="margin:0 0 16px;font-size:14px;color:${PALETTE.muted};">` +
        `Suggested resume: ${escapeHtml(data.recommendedResume)}.</p>`
      : '',
    /*
     * The application link is rendered only when one was validated.
     *
     * A deadline email whose button leads nowhere is worse than no email — it
     * spends the urgency on a dead end, at the exact moment the reader is most
     * inclined to act.
     */
    data.applicationUrl
      ? ctaButton(data.applicationUrl, 'Apply now', { destination: 'the employer' })
      : `<p style="margin:0 0 16px;font-size:14px;color:${PALETTE.muted};">` +
        'No direct application link was found for this posting — open it on your dashboard to follow the source.</p>',
    ctaButton(data.jobDetailUrl, 'View analysis', { destination: 'your dashboard' }),
    emailFooter(context.preferencesUrl),
  ].join('\n');

  return {
    subject,
    html: emailShell(subject, body),
    text: plainWrap([
      subject,
      '',
      `${data.jobTitle}${data.companyName ? ` at ${data.companyName}` : ''} closes in about ${window}.`,
      data.reason,
      data.recommendedResume ? `Suggested resume: ${data.recommendedResume}` : '',
      '',
      data.applicationUrl ? `Apply: ${data.applicationUrl}` : 'No direct application link was found.',
      `Analysis: ${data.jobDetailUrl}`,
    ]),
    idempotencyKey: contentId('deadline', data.jobTitle, data.companyName ?? '', String(hours)),
  };
}

// ── Application reminder (APPLICATION_REMINDER) ─────────────────────────────

export interface ApplicationReminderData {
  applications: ReadonlyArray<{
    jobTitle: string;
    companyName: string | null;
    appliedAt: Date;
    daysSince: number;
    status: string;
    jobDetailUrl: string;
  }>;
}

export function renderApplicationReminder(
  data: ApplicationReminderData,
  context: RenderContext,
): RenderedEmail {
  const count = data.applications.length;
  const subject = `${count} application${count === 1 ? '' : 's'} worth following up`;

  const rows = data.applications
    .map(
      (entry) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid ${PALETTE.border};font-size:14px;">` +
        `<a href="${escapeHtml(entry.jobDetailUrl)}" style="color:${PALETTE.accent};text-decoration:none;">` +
        `${escapeHtml(entry.jobTitle)}</a>` +
        (entry.companyName ? ` <span style="color:${PALETTE.muted};">${escapeHtml(entry.companyName)}</span>` : '') +
        `<br><span style="color:${PALETTE.muted};font-size:13px;">` +
        `Applied ${entry.daysSince} day${entry.daysSince === 1 ? '' : 's'} ago · ${escapeHtml(entry.status)}` +
        '</span></td></tr>',
    )
    .join('\n');

  const body = [
    sectionHeader('↻', 'Follow up', data.applications.length),
    `<p style="margin:0 0 12px;font-size:14px;color:${PALETTE.muted};">` +
      'These have had no reply for a while. Nothing here has been sent on your behalf — ' +
      'this is a reminder, not an action.</p>',
    `<table role="presentation" width="100%" style="border-collapse:collapse;">${rows}</table>`,
    ctaButton(context.dashboardUrl, 'Open your applications', { destination: 'your dashboard' }),
    emailFooter(context.preferencesUrl),
  ].join('\n');

  return {
    subject,
    html: emailShell(subject, body),
    text: plainWrap([
      subject,
      '',
      ...data.applications.map(
        (entry) =>
          `- ${entry.jobTitle}${entry.companyName ? ` at ${entry.companyName}` : ''} — applied ${entry.daysSince} days ago (${entry.status})\n  ${entry.jobDetailUrl}`,
      ),
      '',
      `Your applications: ${context.dashboardUrl}`,
    ]),
    idempotencyKey: contentId('reminder', String(count), data.applications[0]?.jobTitle ?? ''),
  };
}

// ── Preference suggestion (PREFERENCE_SUGGESTION) ───────────────────────────

export interface PreferenceSuggestionData {
  headline: string;
  rationale: string;
  /** What is being suggested. Never applied automatically. */
  suggestion: { setting: string; from: string; to: string } | null;
  settingsUrl: string;
}

export function renderPreferenceSuggestion(
  data: PreferenceSuggestionData,
  context: RenderContext,
): RenderedEmail {
  const subject = data.headline;

  const body = [
    sectionHeader('⚙', 'A suggestion', 1),
    `<p style="margin:0 0 12px;font-size:15px;color:${PALETTE.text};">${escapeHtml(data.rationale)}</p>`,
    data.suggestion
      ? `<p style="margin:0 0 16px;font-size:14px;color:${PALETTE.muted};">` +
        `Suggested change: <strong>${escapeHtml(data.suggestion.setting)}</strong> from ` +
        `${escapeHtml(data.suggestion.from)} to ${escapeHtml(data.suggestion.to)}.</p>`
      : '',
    /*
     * The sentence that makes this email honest.
     *
     * Nothing has changed. A system that adjusts someone's settings and then
     * emails to say so has taken a decision that was not its to take, and the
     * person will not know why the job they were waiting for never arrived.
     */
    `<p style="margin:0 0 16px;font-size:14px;color:${PALETTE.muted};">` +
      '<strong>Nothing has been changed.</strong> This is a suggestion you can take or ignore.</p>',
    ctaButton(data.settingsUrl, 'Review your settings', { destination: 'your settings' }),
    emailFooter(context.preferencesUrl),
  ].join('\n');

  return {
    subject,
    html: emailShell(subject, body),
    text: plainWrap([
      subject,
      '',
      data.rationale,
      data.suggestion
        ? `Suggested: ${data.suggestion.setting} from ${data.suggestion.from} to ${data.suggestion.to}`
        : '',
      '',
      'Nothing has been changed. This is a suggestion you can take or ignore.',
      `Settings: ${data.settingsUrl}`,
    ]),
    idempotencyKey: contentId('suggestion', data.headline, data.suggestion?.setting ?? ''),
  };
}

// ── Learning insight (LEARNING_INSIGHT) ─────────────────────────────────────

export interface LearningInsightData {
  headline: string;
  insights: ReadonlyArray<{ statement: string; evidence: string }>;
  learningUrl: string;
}

export function renderLearningInsight(
  data: LearningInsightData,
  context: RenderContext,
): RenderedEmail {
  const subject = data.headline;

  const items = data.insights
    .map(
      (entry) =>
        `<li style="margin:0 0 10px;font-size:14px;color:${PALETTE.text};">` +
        `${escapeHtml(entry.statement)}` +
        `<br><span style="color:${PALETTE.muted};font-size:13px;">${escapeHtml(entry.evidence)}</span></li>`,
    )
    .join('\n');

  const body = [
    sectionHeader('◉', 'What your activity suggests', data.insights.length),
    `<ul style="margin:0 0 16px;padding-left:18px;">${items}</ul>`,
    `<p style="margin:0 0 16px;font-size:13px;color:${PALETTE.muted};">` +
      'These are observations about your behaviour, not changes to your preferences. ' +
      'What you told us explicitly still takes precedence.</p>',
    ctaButton(data.learningUrl, 'See the detail', { destination: 'your dashboard' }),
    emailFooter(context.preferencesUrl),
  ].join('\n');

  return {
    subject,
    html: emailShell(subject, body),
    text: plainWrap([
      subject,
      '',
      ...data.insights.map((entry) => `- ${entry.statement}\n  ${entry.evidence}`),
      '',
      'These are observations, not changes. Your explicit preferences still take precedence.',
      `Detail: ${data.learningUrl}`,
    ]),
    idempotencyKey: contentId('insight', data.headline, String(data.insights.length)),
  };
}

// ── Search coverage alert (SEARCH_COVERAGE_ALERT) ───────────────────────────

export interface CoverageAlertData {
  headline: string;
  gaps: ReadonlyArray<{ dimension: string; detail: string }>;
  sourcesUrl: string;
}

export function renderCoverageAlert(
  data: CoverageAlertData,
  context: RenderContext,
): RenderedEmail {
  const subject = data.headline;

  const items = data.gaps
    .map(
      (entry) =>
        `<li style="margin:0 0 8px;font-size:14px;color:${PALETTE.text};">` +
        `<strong>${escapeHtml(entry.dimension)}</strong> — ` +
        `<span style="color:${PALETTE.muted};">${escapeHtml(entry.detail)}</span></li>`,
    )
    .join('\n');

  const body = [
    sectionHeader('▣', 'Search coverage', data.gaps.length),
    `<p style="margin:0 0 12px;font-size:14px;color:${PALETTE.muted};">` +
      'Parts of what you asked for are not being covered by the sources currently enabled.</p>',
    `<ul style="margin:0 0 16px;padding-left:18px;">${items}</ul>`,
    ctaButton(data.sourcesUrl, 'Review your sources', { destination: 'your settings' }),
    emailFooter(context.preferencesUrl),
  ].join('\n');

  return {
    subject,
    html: emailShell(subject, body),
    text: plainWrap([
      subject,
      '',
      ...data.gaps.map((entry) => `- ${entry.dimension}: ${entry.detail}`),
      '',
      `Sources: ${data.sourcesUrl}`,
    ]),
    idempotencyKey: contentId('coverage', data.headline, String(data.gaps.length)),
  };
}
