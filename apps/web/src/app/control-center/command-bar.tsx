'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ConfigIntent, ValidationIssue } from '@job-intel/contracts';

/**
 * The natural-language command bar.
 *
 * Two steps, always, and the second one is the point: an instruction produces a
 * *preview* of what would change, and nothing is written until the person
 * looking at that preview says yes.
 *
 * The alternative — parse and apply in one action — is a system where a
 * misheard sentence silently changes what someone's job search looks for, and
 * they find out days later when the jobs stop arriving. A confirmation step
 * costs one click and removes an entire category of failure.
 */

interface PreviewResponse {
  intent: ConfigIntent;
  validation: { valid: boolean; issues: ValidationIssue[] };
  preview: unknown;
  providerError: string | null;
}

const EXAMPLES = [
  'Only show me jobs in Germany.',
  'Raise my minimum salary to €70,000.',
  'Add AWS as a preferred skill.',
  "Don't search reddit anymore.",
  'Search every 30 minutes.',
  'For the next 48 hours, also include remote jobs paying over €100,000.',
];

export function CommandBar({ profileId }: { profileId: string }) {
  const router = useRouter();
  const [instruction, setInstruction] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function requestPreview(): Promise<void> {
    setError(null);
    setPreview(null);

    const response = await fetch('/api/v1/search-config/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId, instruction }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? 'That could not be parsed.');
      return;
    }

    setPreview((await response.json()) as PreviewResponse);
  }

  async function applyPreview(): Promise<void> {
    if (!preview) return;
    setError(null);

    const response = await fetch('/api/v1/search-config/command', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: preview.intent, instruction }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? 'The changes were refused.');
      return;
    }

    setPreview(null);
    setInstruction('');
    startTransition(() => router.refresh());
  }

  const changes = preview?.intent.changes ?? [];
  const blocked = preview !== null && !preview.validation.valid;

  return (
    <div
      className="rounded border p-4"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <label htmlFor="command" className="text-sm font-medium">
        What should I search for?
      </label>

      <div className="mt-2 flex gap-2">
        <input
          id="command"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && instruction.trim().length > 2) void requestPreview();
          }}
          placeholder="Stop searching remote jobs. I want hybrid roles in Germany paying at least €70,000."
          className="flex-1 rounded border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--fg)' }}
        />

        <button
          type="button"
          onClick={() => void requestPreview()}
          disabled={instruction.trim().length < 3 || pending}
          className="rounded px-3 py-2 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--bg)' }}
        >
          Preview
        </button>
      </div>

      {preview === null && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setInstruction(example)}
              className="rounded border px-2 py-0.5 hover:underline"
              style={{ borderColor: 'var(--border)' }}
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {/* ── The preview ────────────────────────────────────────────────── */}
      {preview && (
        <div className="mt-4 rounded border p-3" style={{ borderColor: 'var(--border)' }}>
          <div className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
            Proposed changes
          </div>

          {changes.length === 0 ? (
            <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
              Nothing in that could be turned into a configuration change. Nothing has been altered.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {changes.map((change, index) => (
                <li key={`${change.field}-${index}`}>
                  <span className="font-medium">{change.field}</span>{' '}
                  <span style={{ color: 'var(--muted)' }}>— {change.summary}</span>
                  {change.confidence < 0.7 && (
                    <span className="ml-1 text-xs" style={{ color: 'var(--warn)' }}>
                      (low confidence — check this one)
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {preview.intent.overrideWindow && (
            <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
              This is a temporary change. It reverts on its own at{' '}
              {new Date(preview.intent.overrideWindow.endTime).toISOString().slice(0, 16).replace('T', ' ')}
              , and your saved configuration is not touched.
            </p>
          )}

          {preview.intent.unparsed.length > 0 && (
            <div className="mt-3 text-xs" style={{ color: 'var(--warn)' }}>
              <div className="font-medium">Not understood, and therefore not applied:</div>
              <ul className="mt-0.5 space-y-0.5">
                {preview.intent.unparsed.map((text, index) => (
                  <li key={`unparsed-${index}`}>&ldquo;{text}&rdquo;</li>
                ))}
              </ul>
            </div>
          )}

          {blocked && (
            <div className="mt-3 text-xs" style={{ color: 'var(--danger)' }}>
              <div className="font-medium">These changes contradict each other:</div>
              <ul className="mt-0.5 space-y-0.5">
                {preview.validation.issues
                  .filter((issue) => issue.severity === 'error')
                  .map((issue, index) => (
                    <li key={`issue-${index}`}>
                      {issue.message}
                      {issue.suggestion ? ` ${issue.suggestion}` : ''}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => void applyPreview()}
              disabled={changes.length === 0 || blocked || pending}
              className="rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'var(--bg)' }}
            >
              Apply changes
            </button>

            <button
              type="button"
              onClick={() => setPreview(null)}
              className="rounded border px-3 py-1.5 text-sm"
              style={{ borderColor: 'var(--border)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
