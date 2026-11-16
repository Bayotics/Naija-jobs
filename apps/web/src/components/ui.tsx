import type { ReactNode } from 'react';

/** Shared presentational primitives. Deliberately small — no design system yet. */

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
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm" style={{ color: 'var(--muted)' }}>
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
      className="rounded-lg border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      {(title ?? description) && (
        <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {description && (
            <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
              {description}
            </p>
          )}
        </div>
      )}
      <div className="p-4">{children}</div>
      {footer && (
        <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border)' }}>
          {footer}
        </div>
      )}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        {label}
      </div>
      <div className="tabular mt-1 text-2xl font-semibold">{value}</div>
      {hint && (
        <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
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

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{ border: `1px solid ${TONE_COLOR[tone]}`, color: TONE_COLOR[tone] }}
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
      className="rounded-lg border border-dashed p-8 text-center"
      style={{ borderColor: 'var(--border)' }}
    >
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-xs" style={{ color: 'var(--muted)' }}>
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
