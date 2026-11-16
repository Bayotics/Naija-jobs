import type { ReactNode } from 'react';
import type {
  ComponentStatus,
  Funnel,
  PipelineStageStatus,
  SourceHealthScore,
} from '@job-intel/contracts';

/**
 * Operations-console primitives.
 *
 * Dense by design. The brief asks for an intelligence console rather than a
 * wall of giant cards: the most important information should be visible without
 * scrolling, which means small type, tight rows and colour used for status
 * rather than decoration.
 */

const STATUS_COLOR: Record<ComponentStatus, string> = {
  healthy: 'var(--ok)',
  degraded: 'var(--warn)',
  down: 'var(--danger)',
  unknown: 'var(--muted)',
  disabled: 'var(--muted)',
};

const STATUS_LABEL: Record<ComponentStatus, string> = {
  healthy: 'healthy',
  degraded: 'degraded',
  down: 'down',
  unknown: 'unknown',
  disabled: 'off',
};

/** A filled dot plus a word — colour alone is not accessible. */
export function StatusDot({ status, label }: { status: ComponentStatus; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: STATUS_COLOR[status] }}
      />
      <span style={{ color: STATUS_COLOR[status] }}>{label ?? STATUS_LABEL[status]}</span>
    </span>
  );
}

/** One component's health. Detail is always shown — a bare status is not useful. */
export function HealthCard({
  component,
  status,
  detail,
  latencyMs,
}: {
  component: string;
  status: ComponentStatus;
  detail: string;
  latencyMs?: number | null;
}) {
  return (
    <div
      className="rounded-md border px-3 py-2"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{component.replace(/_/g, ' ')}</span>
        <StatusDot status={status} />
      </div>
      <p className="mt-1 text-[11px] leading-4" style={{ color: 'var(--muted)' }}>
        {detail}
        {latencyMs !== null && latencyMs !== undefined ? ` · ${latencyMs} ms` : ''}
      </p>
    </div>
  );
}

/** A compact metric. Deliberately small: most numbers do not deserve a hero card. */
export function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  const color = tone ? `var(--${tone === 'danger' ? 'danger' : tone})` : 'var(--text)';
  return (
    <div
      className="rounded-md border px-3 py-2"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        {label}
      </div>
      <div className="tabular mt-0.5 text-lg font-semibold" style={{ color }}>
        {value}
      </div>
      {hint && (
        <div className="text-[10px]" style={{ color: 'var(--muted)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * The pipeline, as a vertical spine.
 *
 * Each stage shows processed / failed / waiting, so a stage that is quietly
 * backing up is visible without opening the queue page.
 */
export function PipelineView({ stages }: { stages: PipelineStageStatus[] }) {
  return (
    <ol className="space-y-1">
      {stages.map((stage, index) => (
        <li key={stage.stage}>
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          >
            <span className="w-28 text-xs font-semibold">{stage.stage}</span>
            <StatusDot status={stage.status} />
            <span className="tabular text-xs" style={{ color: 'var(--muted)' }}>
              {stage.processed.toLocaleString()} processed
            </span>
            {stage.failed > 0 && (
              <span className="tabular text-xs" style={{ color: 'var(--danger)' }}>
                {stage.failed.toLocaleString()} failed
              </span>
            )}
            {stage.waiting > 0 && (
              <span className="tabular text-xs" style={{ color: 'var(--warn)' }}>
                {stage.waiting.toLocaleString()} waiting
              </span>
            )}
            <span className="ml-auto text-[10px]" style={{ color: 'var(--muted)' }}>
              {stage.detail}
            </span>
          </div>
          {index < stages.length - 1 && (
            <div aria-hidden className="pl-6 text-[10px]" style={{ color: 'var(--border)' }}>
              ↓
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The funnel, as proportional bars.
 *
 * Retention is shown on every step because the interesting fact is never the
 * final number — it is which step ate the corpus.
 */
export function FunnelView({ funnel }: { funnel: Funnel }) {
  const max = Math.max(1, ...funnel.steps.map((s) => s.count));

  return (
    <ol className="space-y-2">
      {funnel.steps.map((step) => (
        <li key={step.key}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="font-medium">{step.label}</span>
            <span className="tabular" style={{ color: 'var(--muted)' }}>
              {step.count.toLocaleString()}
              {step.retention !== null && (
                <span style={{ color: step.retention < 0.3 ? 'var(--warn)' : 'var(--muted)' }}>
                  {' '}
                  ({Math.round(step.retention * 100)}%)
                </span>
              )}
            </span>
          </div>
          <div
            className="mt-1 h-1.5 w-full overflow-hidden rounded"
            style={{ background: 'var(--border)' }}
          >
            <div
              className="h-full rounded"
              style={{
                width: `${Math.max(1, (step.count / max) * 100)}%`,
                background: 'var(--accent)',
              }}
            />
          </div>
          <p className="mt-0.5 text-[10px]" style={{ color: 'var(--muted)' }}>
            {step.detail}
          </p>
        </li>
      ))}
    </ol>
  );
}

/** Source health, with the component breakdown visible on demand. */
export function SourceHealthRow({
  name,
  health,
  enabled,
  lastError,
}: {
  name: string;
  health: SourceHealthScore | null;
  enabled: boolean;
  lastError: string | null;
}) {
  const status = health?.status ?? (enabled ? 'unknown' : 'disabled');

  return (
    <details
      className="rounded-md border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-3 py-2">
        <span className="text-xs font-semibold">{name}</span>
        <StatusDot status={status} />
        <span className="tabular text-xs" style={{ color: 'var(--muted)' }}>
          {health ? `${health.score}/100` : '—'}
        </span>
        {health && health.anomalies.length > 0 && (
          <span className="text-[10px]" style={{ color: 'var(--warn)' }}>
            {health.anomalies.length} anomaly(ies)
          </span>
        )}
      </summary>

      <div className="border-t px-3 py-2" style={{ borderColor: 'var(--border)' }}>
        {health ? (
          <>
            {/* The formula, visible. An opaque health number earns no trust. */}
            <table className="w-full text-[11px]">
              <tbody>
                {health.components.map((component) => (
                  <tr key={component.component}>
                    <td className="py-0.5 pr-3" style={{ color: 'var(--muted)' }}>
                      {component.component.replace(/_/g, ' ')}
                    </td>
                    <td className="tabular py-0.5 pr-3">
                      {component.applicable ? Math.round(component.score) : 'n/a'}
                    </td>
                    <td className="tabular py-0.5 pr-3" style={{ color: 'var(--muted)' }}>
                      ×{component.weight}
                    </td>
                    <td className="py-0.5" style={{ color: 'var(--muted)' }}>
                      {component.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {health.anomalies.map((anomaly, index) => (
              <p key={index} className="mt-1 text-[11px]" style={{ color: 'var(--warn)' }}>
                ⚠ {anomaly}
              </p>
            ))}
          </>
        ) : (
          <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
            No health data yet.
          </p>
        )}
        {lastError && (
          <p className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
            Last error: {lastError}
          </p>
        )}
      </div>
    </details>
  );
}

/** Field origin, so raw data is never confused with a model's output. */
export function OriginBadge({ origin }: { origin: string }) {
  const map: Record<string, { label: string; color: string }> = {
    raw: { label: 'RAW', color: 'var(--muted)' },
    normalized: { label: 'NORMALIZED', color: 'var(--accent)' },
    ai_extracted: { label: 'AI-EXTRACTED', color: 'var(--warn)' },
    system_derived: { label: 'SYSTEM-DERIVED', color: 'var(--ok)' },
  };
  const entry = map[origin] ?? map.raw!;

  return (
    <span
      className="rounded px-1 py-0.5 text-[9px] font-semibold tracking-wide"
      style={{ border: `1px solid ${entry.color}`, color: entry.color }}
    >
      {entry.label}
    </span>
  );
}
