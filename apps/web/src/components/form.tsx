'use client';

import type { ReactNode } from 'react';

/** Form primitives with consistent labelling, hints and error wiring. */

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor: string;
  children: ReactNode;
}) {
  const errorId = `${htmlFor}-error`;
  const hintId = `${htmlFor}-hint`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="text-[11px]" style={{ color: 'var(--muted)' }}>
          {hint}
        </p>
      )}
      {children}
      {error && (
        <p id={errorId} role="alert" className="text-[11px]" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}

const inputStyle = {
  background: 'var(--bg)',
  borderColor: 'var(--border)',
  color: 'var(--text)',
};

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="rounded-md border px-2.5 py-1.5 text-sm outline-none"
      style={inputStyle}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className="rounded-md border px-2.5 py-1.5 text-sm outline-none"
      style={inputStyle}
    />
  );
}

/**
 * Multi-select rendered as checkboxes.
 *
 * An empty selection means "no constraint", which is a meaningful and common
 * state — so the control says so explicitly rather than looking unfinished.
 */
export function CheckboxGroup({
  name,
  options,
  selected,
  onChange,
  emptyMeaning = 'No constraint — all values accepted',
}: {
  name: string;
  options: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  emptyMeaning?: string;
}) {
  const toggle = (value: string) => {
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
    );
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const id = `${name}-${option}`;
          const checked = selected.includes(option);
          return (
            <label
              key={option}
              htmlFor={id}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
              style={{
                borderColor: checked ? 'var(--accent)' : 'var(--border)',
                color: checked ? 'var(--accent)' : 'var(--text)',
              }}
            >
              <input
                id={id}
                type="checkbox"
                checked={checked}
                onChange={() => toggle(option)}
                className="h-3 w-3"
              />
              {option.replace(/_/g, ' ')}
            </label>
          );
        })}
      </div>
      {selected.length === 0 && (
        <p className="mt-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
          {emptyMeaning}
        </p>
      )}
    </div>
  );
}

export function SubmitBar({
  dirty,
  saving,
  status,
}: {
  dirty: boolean;
  saving: boolean;
  status: { kind: 'idle' | 'ok' | 'error'; message?: string };
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="submit"
        disabled={!dirty || saving}
        className="rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        style={{ background: 'var(--accent)', color: '#fff' }}
      >
        {saving ? 'Saving…' : 'Save changes'}
      </button>
      {status.kind === 'ok' && (
        <span role="status" className="text-xs" style={{ color: 'var(--ok)' }}>
          {status.message}
        </span>
      )}
      {status.kind === 'error' && (
        <span role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>
          {status.message}
        </span>
      )}
      {status.kind === 'idle' && dirty && (
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          Unsaved changes
        </span>
      )}
    </div>
  );
}

/** Comma-separated list ⇄ array. Trims and drops blanks. */
export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function formatList(values: readonly string[]): string {
  return values.join(', ');
}
