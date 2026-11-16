import type {
  MaterialChange,
  MaterialChangeResult,
  MaterialField,
} from '@job-intel/contracts';

/**
 * Material-change detection.
 *
 * A previously-notified job may earn a second notification, but only for a
 * change the candidate would actually want interrupting for. The failure this
 * guards against is concrete and common: postings get re-crawled constantly and
 * their HTML, whitespace and tracking parameters churn on every pass. Keying
 * re-notification on "the content hash moved" would email the same job nightly.
 *
 * So change is assessed field by field, on **semantic** values only, and each
 * change carries a significance the policy compares against a threshold.
 */

export interface JobSnapshot {
  salaryAnnualUsd: number | null;
  city: string | null;
  countryCode: string | null;
  remoteType: string | null;
  visaSponsorship: string | null;
  seniority: string | null;
  employmentTypes: string[];
  requirements: string[];
  applyUrl: string | null;
}

/** Base significance per field, before the size of the change is considered. */
const FIELD_SIGNIFICANCE: Readonly<Record<MaterialField, number>> = {
  salary: 0.9,
  visa_sponsorship: 0.9,
  work_arrangement: 0.8,
  location: 0.75,
  seniority: 0.6,
  employment_type: 0.5,
  application_url: 0.4,
  requirements: 0.4,
};

function change(
  field: MaterialField,
  before: string | null,
  after: string | null,
  significance: number,
  direction: MaterialChange['direction'],
  summary: string,
): MaterialChange {
  return {
    field,
    before,
    after,
    significance: Math.round(Math.max(0, Math.min(1, significance)) * 1000) / 1000,
    direction,
    summary: summary.slice(0, 300),
  };
}

/** Token overlap, for deciding whether requirements really moved. */
function overlap(a: readonly string[], b: readonly string[]): number {
  const tokens = (list: readonly string[]) =>
    new Set(
      list
        .join(' ')
        .toLowerCase()
        .replace(/[^a-z0-9+#. ]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const setA = tokens(a);
  const setB = tokens(b);
  if (setA.size === 0 || setB.size === 0) return 1;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

export function detectMaterialChanges(
  before: JobSnapshot,
  after: JobSnapshot,
): MaterialChangeResult {
  const changes: MaterialChange[] = [];

  // ── Salary ──────────────────────────────────────────────────────────────
  if (before.salaryAnnualUsd !== after.salaryAnnualUsd) {
    if (before.salaryAnnualUsd === null && after.salaryAnnualUsd !== null) {
      changes.push(
        change(
          'salary',
          null,
          `$${after.salaryAnnualUsd.toLocaleString()}/yr`,
          FIELD_SIGNIFICANCE.salary,
          'improved',
          `Salary is now stated at about $${after.salaryAnnualUsd.toLocaleString()}/yr`,
        ),
      );
    } else if (before.salaryAnnualUsd !== null && after.salaryAnnualUsd !== null) {
      const delta = (after.salaryAnnualUsd - before.salaryAnnualUsd) / before.salaryAnnualUsd;
      // Rounding and FX drift move salaries by a percent or two constantly.
      if (Math.abs(delta) >= 0.05) {
        changes.push(
          change(
            'salary',
            `$${before.salaryAnnualUsd.toLocaleString()}/yr`,
            `$${after.salaryAnnualUsd.toLocaleString()}/yr`,
            Math.min(1, FIELD_SIGNIFICANCE.salary * Math.min(1, Math.abs(delta) * 4)),
            delta > 0 ? 'improved' : 'worsened',
            `Salary ${delta > 0 ? 'rose' : 'fell'} by ${Math.round(Math.abs(delta) * 100)}%`,
          ),
        );
      }
    }
  }

  // ── Work arrangement ────────────────────────────────────────────────────
  if (before.remoteType !== after.remoteType && after.remoteType && after.remoteType !== 'unknown') {
    const improved = after.remoteType === 'remote' && before.remoteType !== 'remote';
    changes.push(
      change(
        'work_arrangement',
        before.remoteType,
        after.remoteType,
        FIELD_SIGNIFICANCE.work_arrangement,
        improved ? 'improved' : 'changed',
        improved
          ? 'The role is now remote'
          : `Work arrangement changed from ${before.remoteType ?? 'unstated'} to ${after.remoteType}`,
      ),
    );
  }

  // ── Visa ────────────────────────────────────────────────────────────────
  if (before.visaSponsorship !== after.visaSponsorship && after.visaSponsorship) {
    const improved = after.visaSponsorship === 'offered' && before.visaSponsorship !== 'offered';
    changes.push(
      change(
        'visa_sponsorship',
        before.visaSponsorship,
        after.visaSponsorship,
        improved ? FIELD_SIGNIFICANCE.visa_sponsorship : FIELD_SIGNIFICANCE.visa_sponsorship * 0.6,
        improved ? 'improved' : 'changed',
        improved
          ? 'Visa sponsorship is now offered'
          : `Sponsorship changed to ${after.visaSponsorship.replace('_', ' ')}`,
      ),
    );
  }

  // ── Location ────────────────────────────────────────────────────────────
  const locBefore = [before.city, before.countryCode].filter(Boolean).join(', ');
  const locAfter = [after.city, after.countryCode].filter(Boolean).join(', ');
  if (locBefore !== locAfter && locAfter) {
    changes.push(
      change(
        'location',
        locBefore || null,
        locAfter,
        before.countryCode !== after.countryCode
          ? FIELD_SIGNIFICANCE.location
          : FIELD_SIGNIFICANCE.location * 0.5,
        'changed',
        `Location changed from ${locBefore || 'unstated'} to ${locAfter}`,
      ),
    );
  }

  // ── Seniority and employment type ───────────────────────────────────────
  if (before.seniority !== after.seniority && after.seniority) {
    changes.push(
      change(
        'seniority',
        before.seniority,
        after.seniority,
        FIELD_SIGNIFICANCE.seniority,
        'changed',
        `Seniority changed from ${before.seniority ?? 'unstated'} to ${after.seniority}`,
      ),
    );
  }

  const typesBefore = [...before.employmentTypes].sort().join(',');
  const typesAfter = [...after.employmentTypes].sort().join(',');
  if (typesBefore !== typesAfter && after.employmentTypes.length > 0) {
    changes.push(
      change(
        'employment_type',
        typesBefore || null,
        typesAfter,
        FIELD_SIGNIFICANCE.employment_type,
        'changed',
        `Employment type changed to ${typesAfter.replace(/,/g, ', ')}`,
      ),
    );
  }

  // ── Requirements ────────────────────────────────────────────────────────
  const similarity = overlap(before.requirements, after.requirements);
  if (similarity < 0.6 && after.requirements.length > 0) {
    changes.push(
      change(
        'requirements',
        `${before.requirements.length} requirement(s)`,
        `${after.requirements.length} requirement(s)`,
        FIELD_SIGNIFICANCE.requirements * (1 - similarity),
        'changed',
        `Requirements rewritten (${Math.round(similarity * 100)}% overlap with the previous version)`,
      ),
    );
  }

  // ── Application path ────────────────────────────────────────────────────
  if (before.applyUrl !== after.applyUrl && after.applyUrl) {
    changes.push(
      change(
        'application_url',
        before.applyUrl,
        after.applyUrl,
        before.applyUrl === null
          ? FIELD_SIGNIFICANCE.application_url
          : FIELD_SIGNIFICANCE.application_url * 0.5,
        before.applyUrl === null ? 'improved' : 'changed',
        before.applyUrl === null
          ? 'An application URL is now available'
          : 'The application URL changed',
      ),
    );
  }

  const maxSignificance = changes.reduce((max, c) => Math.max(max, c.significance), 0);

  return {
    changed: changes.length > 0,
    changes,
    maxSignificance,
    explanation:
      changes.length === 0
        ? 'No material change; only formatting or metadata moved'
        : changes
            .slice()
            .sort((a, b) => b.significance - a.significance)
            .slice(0, 3)
            .map((c) => c.summary)
            .join('; ')
            .slice(0, 400),
  };
}
