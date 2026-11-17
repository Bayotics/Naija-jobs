import type { ReactNode } from 'react';

/**
 * Shared presentational primitives.
 *
 * Small on purpose, but no longer *thin*: every surface in the app is one of
 * these five, so a weak Card or an unreadable Badge is a weak app. Colour,
 * radius and elevation all come from tokens in `globals.css` — nothing here
 * hard-codes a hex value, which is what makes the light and dark themes stay
 * in step.
 */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm" style={{ color: 'var(--muted)' }}>
            {description}
          </p>
        )}
      </div>
      {actions}
    </header>
  );
}

export function Card({
  title,
  description,
  children,
  footer,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section
      className="overflow-hidden border"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      {(title ?? description) && (
        <div
          className="border-b px-5 py-3.5"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
        >
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {description && (
            <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
              {description}
            </p>
          )}
        </div>
      )}
      <div className="p-5">{children}</div>
      {footer && (
        <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border)' }}>
          {footer}
        </div>
      )}
    </section>
  );
}

/**
 * `emphasis` is for the one number on a page that is the answer.
 *
 * Four identical tiles make the reader compare them to work out which matters.
 * Marking one tints its value with the accent, which settles that in advance.
 */
export function Stat({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className="border p-4"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div
        className="text-[11px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--muted)' }}
      >
        {label}
      </div>
      <div
        className="tabular mt-1.5 text-3xl font-semibold leading-none tracking-tight"
        style={emphasis ? { color: 'var(--accent)' } : undefined}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

const TONE_COLOR: Record<Tone, string> = {
  neutral: 'var(--muted)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  accent: 'var(--accent)',
};

/*
 * Filled, not outlined.
 *
 * An outline badge draws a 1px box in the tone colour and sets the text to the
 * same colour, which at 11px is the weakest thing on the row — the border eats
 * the contrast the text needed. A soft fill gives the label a background of
 * its own and reads as a label rather than as a stray box.
 */
const TONE_BG: Record<Tone, string> = {
  neutral: 'var(--surface-2)',
  ok: 'var(--ok-soft)',
  warn: 'var(--warn-soft)',
  danger: 'var(--danger-soft)',
  accent: 'var(--accent-soft)',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{
        background: TONE_BG[tone],
        color: TONE_COLOR[tone],
        borderRadius: '999px',
      }}
    >
      {children}
    </span>
  );
}

/**
 * Empty state.
 *
 * `reason` explains *why* it is empty. "No jobs yet" is unhelpful; "no
 * connectors are implemented until prompt 5" tells the operator whether
 * something is broken or simply not built.
 */
export function EmptyState({
  title,
  reason,
  action,
}: {
  title: string;
  reason: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="border border-dashed p-10 text-center"
      style={{ borderColor: 'var(--border-strong)', borderRadius: 'var(--radius)' }}
    >
      <p className="text-base font-medium">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: 'var(--muted)' }}>
        {reason}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-10 animate-pulse rounded"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function ErrorNotice({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border p-4"
      style={{ borderColor: 'var(--danger)', background: 'var(--surface)' }}
    >
      <p className="text-sm font-semibold" style={{ color: 'var(--danger)' }}>
        {title}
      </p>
      {detail && (
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          {detail}
        </p>
      )}
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="scroll-x">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b text-left" style={{ borderColor: 'var(--border)' }}>
            {head.map((h) => (
              <th
                key={h}
                className="px-3 py-2 text-xs font-medium uppercase tracking-wide"
                style={{ color: 'var(--muted)' }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
