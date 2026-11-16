import type { ReactNode } from 'react';
import type {
  ComponentScore,
  HardConstraintResult,
  RecommendationCategory,
  SkillMatchDetail,
} from '@job-intel/contracts';
import { Badge } from './ui';

/**
 * Match presentation.
 *
 * Built around one rule: **never show a number without what produced it.** A
 * bare "72" invites the candidate either to trust it blindly or to distrust the
 * whole system when it disagrees with them. Every element here pairs a value
 * with its evidence, and the ineligible case leads with the reason rather than
 * burying it under a score of zero.
 */

const RECOMMENDATION_TONE: Record<
  RecommendationCategory,
  'ok' | 'accent' | 'neutral' | 'warn' | 'danger'
> = {
  EXCEPTIONAL_MATCH: 'ok',
  STRONG_MATCH: 'ok',
  GOOD_MATCH: 'accent',
  POSSIBLE_MATCH: 'neutral',
  WEAK_MATCH: 'warn',
  UNCERTAIN: 'warn',
  INELIGIBLE: 'danger',
};

const RECOMMENDATION_LABEL: Record<RecommendationCategory, string> = {
  EXCEPTIONAL_MATCH: 'Exceptional match',
  STRONG_MATCH: 'Strong match',
  GOOD_MATCH: 'Good match',
  POSSIBLE_MATCH: 'Possible match',
  WEAK_MATCH: 'Weak match',
  UNCERTAIN: 'Not enough information',
  INELIGIBLE: 'Ineligible',
};

const DIMENSION_LABEL: Record<string, string> = {
  skills: 'Skills',
  experience: 'Experience',
  seniority: 'Seniority',
  title: 'Job title',
  location: 'Location',
  workArrangement: 'Work arrangement',
  salary: 'Salary',
  visa: 'Visa sponsorship',
  education: 'Education',
  industry: 'Industry',
  employmentType: 'Employment type',
  company: 'Company',
  semantic: 'Description fit',
  behavioral: 'Your past activity',
  quality: 'Posting quality',
};

export function RecommendationBadge({ value }: { value: RecommendationCategory }) {
  return <Badge tone={RECOMMENDATION_TONE[value]}>{RECOMMENDATION_LABEL[value]}</Badge>;
}

/**
 * Score plus confidence, always together.
 *
 * Showing the score alone would let a 90 built on two known fields look
 * identical to a 90 built on twelve. The confidence line is the difference
 * between a recommendation and a guess.
 */
export function ScoreHeadline({
  score,
  confidence,
  recommendation,
}: {
  score: number;
  confidence: number;
  recommendation: RecommendationCategory;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-3">
      <span className="tabular text-3xl font-semibold">{Math.round(score)}</span>
      <span className="text-sm" style={{ color: 'var(--muted)' }}>
        / 100
      </span>
      <RecommendationBadge value={recommendation} />
      <span className="text-xs" style={{ color: 'var(--muted)' }}>
        {Math.round(confidence * 100)}% confidence
      </span>
    </div>
  );
}

function bar(score: number): string {
  if (score >= 75) return 'var(--ok)';
  if (score >= 45) return 'var(--accent)';
  return 'var(--warn)';
}

/**
 * The per-dimension breakdown.
 *
 * Inapplicable dimensions are listed rather than hidden, because "the posting
 * did not say" is itself information the candidate needs — it is the difference
 * between a job that pays badly and one that will not tell you.
 */
export function ComponentBreakdown({
  components,
  weights,
}: {
  components: ComponentScore[];
  weights: Record<string, number>;
}) {
  const applicable = components.filter((c) => c.applicable).sort((a, b) => b.score - a.score);
  const skipped = components.filter((c) => !c.applicable);

  return (
    <div className="space-y-3">
      {applicable.map((component) => (
        <div key={component.dimension}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="font-medium">
              {DIMENSION_LABEL[component.dimension] ?? component.dimension}
            </span>
            <span className="tabular text-xs" style={{ color: 'var(--muted)' }}>
              {Math.round(component.score)}
              {weights[component.dimension] !== undefined && (
                <> · weight {Math.round((weights[component.dimension] ?? 0) * 100)}%</>
              )}
            </span>
          </div>
          <div
            className="mt-1 h-1.5 w-full overflow-hidden rounded"
            style={{ background: 'var(--border)' }}
          >
            <div
              className="h-full rounded"
              style={{ width: `${Math.max(2, component.score)}%`, background: bar(component.score) }}
            />
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            {component.explanation}
            {component.evidence.length > 0 && <> — {component.evidence.slice(0, 4).join('; ')}</>}
          </p>
        </div>
      ))}

      {skipped.length > 0 && (
        <div className="pt-2 text-xs" style={{ color: 'var(--muted)' }}>
          <div className="font-medium">Not scored</div>
          <ul className="mt-1 space-y-0.5">
            {skipped.map((component) => (
              <li key={component.dimension}>
                {DIMENSION_LABEL[component.dimension] ?? component.dimension}:{' '}
                {component.explanation}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Eligibility, with the unresolved checks shown as their own state. */
export function ConstraintList({ result }: { result: HardConstraintResult }) {
  const rows = [...result.violations, ...result.unknowns, ...result.checks.filter((c) => c.result === 'PASS')];
  if (rows.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        You have set no hard requirements, so nothing was filtered out.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((check, index) => (
        <li key={`${check.constraint}-${index}`} className="text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              tone={check.result === 'FAIL' ? 'danger' : check.result === 'UNKNOWN' ? 'warn' : 'ok'}
            >
              {check.result}
            </Badge>
            <span className="font-medium">{check.constraint}</span>
            {check.severity === 'ABSOLUTE' && <Badge tone="neutral">non-negotiable</Badge>}
          </div>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
            {check.explanation}
            {check.required && check.actual && (
              <>
                {' '}
                (you: {check.required} · posting: {check.actual})
              </>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Skill coverage.
 *
 * The `via` path is rendered for indirect matches. Without it "we counted your
 * Next.js against their React requirement" looks like the system guessing.
 */
export function SkillMatchList({ matches }: { matches: SkillMatchDetail[] }) {
  if (matches.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        This posting lists no identifiable skills.
      </p>
    );
  }

  const tone = (kind: SkillMatchDetail['kind']) =>
    kind === 'exact' ? 'ok' : kind === 'closely_related' ? 'accent' : kind === 'transferable' ? 'warn' : 'danger';

  return (
    <ul className="flex flex-wrap gap-2">
      {matches.map((match) => (
        <li key={match.required} className="text-xs">
          <span
            className="inline-flex items-center gap-1 rounded border px-2 py-1"
            style={{ borderColor: 'var(--border)' }}
          >
            <Badge tone={tone(match.kind)}>{match.kind.replace('_', ' ')}</Badge>
            <span className="font-medium">{match.required}</span>
            <span style={{ color: 'var(--muted)' }}>({match.requirement})</span>
            {match.kind !== 'exact' && match.kind !== 'missing' && match.satisfiedBy && (
              <span style={{ color: 'var(--muted)' }}>
                via {match.via.length > 1 ? match.via.join(' → ') : match.satisfiedBy}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SignalList({ title, items, tone }: { title: string; items: string[]; tone: 'ok' | 'warn' }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        {title}
      </div>
      <ul className="space-y-1 text-sm">
        {items.map((item, index) => (
          <li key={`${item}-${index}`} className="flex gap-2">
            <span style={{ color: tone === 'ok' ? 'var(--ok)' : 'var(--warn)' }}>•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Key/value provenance strip. */
export function TraceGrid({ entries }: { entries: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
      {entries.map(([label, value]) => (
        <div key={label}>
          <dt style={{ color: 'var(--muted)' }}>{label}</dt>
          <dd className="tabular mt-0.5 font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
