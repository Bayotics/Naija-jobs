'use client';

import { useState } from 'react';
import {
  PREFERENCE_STRENGTHS,
  type PreferenceStrength,
  type WeightedPreference,
} from '@job-intel/contracts';
import { Badge } from '@/components/ui';

/**
 * Preference controls.
 *
 * The whole UI turns on making three things visually distinct at a glance:
 *
 *   HARD CONSTRAINT  — violating it excludes the job outright
 *   PREFERENCE       — shifts the score
 *   EXCLUSION        — a negative hard constraint
 *
 * A tag list where "Germany" and "not Germany" look the same is worse than no
 * UI at all, so strength is encoded in colour *and* in a written label, never
 * colour alone.
 */

/**
 * Strength → colour. Written out in full rather than derived, so adding a new
 * strength is a type error here instead of a silently uncoloured badge.
 */
const TONES: Record<PreferenceStrength, 'ok' | 'accent' | 'neutral' | 'warn' | 'danger'> = {
  required: 'ok',
  strongly_preferred: 'accent',
  preferred: 'accent',
  neutral: 'neutral',
  undesirable: 'warn',
  excluded: 'danger',
};

const STRENGTH_LABEL: Record<PreferenceStrength, string> = {
  required: 'Required (hard)',
  strongly_preferred: 'Strongly preferred',
  preferred: 'Preferred',
  neutral: 'Neutral',
  undesirable: 'Undesirable',
  excluded: 'Excluded (hard)',
};

export function StrengthBadge({ strength, hard }: { strength: PreferenceStrength; hard: boolean }) {
  const isHard = strength === 'required' || strength === 'excluded' || hard;
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={TONES[strength]}>{STRENGTH_LABEL[strength]}</Badge>
      {isHard && strength !== 'required' && strength !== 'excluded' && (
        <Badge tone="ok">hard</Badge>
      )}
    </span>
  );
}

export interface PreferenceListEditorProps {
  title: string;
  description: string;
  dimension: string;
  items: WeightedPreference[];
  placeholder: string;
  onChange(dimension: string, items: WeightedPreference[]): void;
  disabled?: boolean;
}

/**
 * Tag list with a per-entry strength selector.
 *
 * Deliberately not a JSON textarea: the requirement is that a candidate never
 * edits raw structures, and a strength dropdown per tag is what makes the
 * hard/soft distinction operable rather than merely documented.
 */
export function PreferenceListEditor({
  title,
  description,
  dimension,
  items,
  placeholder,
  onChange,
  disabled = false,
}: PreferenceListEditorProps) {
  const [draft, setDraft] = useState('');
  const [draftStrength, setDraftStrength] = useState<PreferenceStrength>('preferred');

  const add = () => {
    const value = draft.trim();
    if (value.length === 0) return;
    if (items.some((i) => i.value.toLowerCase() === value.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange(dimension, [
      ...items,
      { value, strength: draftStrength, hard: false, note: null, source: 'explicit' },
    ]);
    setDraft('');
  };

  const update = (value: string, strength: PreferenceStrength) => {
    onChange(
      dimension,
      items.map((i) => (i.value === value ? { ...i, strength } : i)),
    );
  };

  const remove = (value: string) => {
    onChange(dimension, items.filter((i) => i.value !== value));
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
          {description}
        </p>
      </div>

      {items.length === 0 ? (
        <p className="text-xs italic" style={{ color: 'var(--muted)' }}>
          Nothing set — this dimension will not affect matching.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.value}
              className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            >
              <span className="text-sm font-medium">{item.value}</span>
              <StrengthBadge strength={item.strength} hard={item.hard} />
              <span className="ml-auto flex items-center gap-2">
                <select
                  aria-label={`Strength for ${item.value}`}
                  value={item.strength}
                  disabled={disabled}
                  onChange={(e) => update(item.value, e.target.value as PreferenceStrength)}
                  className="rounded border px-1.5 py-1 text-xs"
                  style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
                >
                  {PREFERENCE_STRENGTHS.map((s) => (
                    <option key={s} value={s}>
                      {STRENGTH_LABEL[s]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => remove(item.value)}
                  disabled={disabled}
                  aria-label={`Remove ${item.value}`}
                  className="rounded px-2 py-1 text-xs"
                  style={{ border: '1px solid var(--border)', color: 'var(--danger)' }}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          className="min-w-0 flex-1 rounded-md border px-2.5 py-1.5 text-sm"
          style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
        />
        <select
          aria-label={`Strength for new ${title} entry`}
          value={draftStrength}
          onChange={(e) => setDraftStrength(e.target.value as PreferenceStrength)}
          disabled={disabled}
          className="rounded-md border px-2 py-1.5 text-xs"
          style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
        >
          {PREFERENCE_STRENGTHS.map((s) => (
            <option key={s} value={s}>
              {STRENGTH_LABEL[s]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={add}
          disabled={disabled || draft.trim().length === 0}
          className="rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

/** Slider row used by the matching-weights section. */
export function WeightSlider({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="w-40 shrink-0">{label}</span>
      <input
        type="range"
        min={0}
        max={50}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1"
      />
      <span className="tabular w-8 text-right text-xs" style={{ color: 'var(--muted)' }}>
        {value}
      </span>
    </label>
  );
}

export { TONES as STRENGTH_TONES, STRENGTH_LABEL };
