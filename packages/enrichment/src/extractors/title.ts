import { collapseWhitespace, stripDiacritics } from '@job-intel/core';
import type { Confident } from '@job-intel/contracts';

/**
 * Job-title normalization.
 *
 * "Frontend Engineer", "Front-End Developer", "Software Engineer, Frontend" and
 * "React Engineer" describe substantially the same role. The goal is a canonical
 * `roleSlug` those collapse onto, without destroying the original title, which
 * is always kept on the job row.
 *
 * The approach is rules plus a small role vocabulary rather than a hardcoded
 * list of hundreds of titles:
 *
 *   1. strip decoration (seniority, employment type, gender markers, locations)
 *   2. canonicalise spelling variants (front-end → frontend)
 *   3. match a *discipline* and a *specialisation* independently
 *   4. recombine into a canonical form
 *
 * That composes: adding one specialisation term covers every seniority and
 * phrasing variant of it automatically. Semantic similarity over embeddings is
 * the natural upgrade for the long tail and slots in behind the same interface.
 */

export interface NormalizedTitle {
  /** Human-readable canonical form, e.g. "Frontend Engineer". */
  normalized: string;
  /** Stable key, e.g. "frontend-engineer". */
  roleSlug: string | null;
  confidence: number;
  /** Decoration removed along the way, retained for debugging. */
  strippedTokens: string[];
}

/** Seniority and employment decoration, removed before role matching. */
const DECORATION_PATTERNS: RegExp[] = [
  /\((?:m|w|f|h|d|x)(?:\s*\/\s*(?:m|w|f|h|d|x))+\)/gi, // (m/w/d)
  /\b(?:senior|sr\.?|junior|jr\.?|lead|principal|staff|entry[\s-]level|mid[\s-]level|graduate|intern(?:ship)?|trainee|associate|chief|head\s+of|vice\s+president|vp)\b/gi,
  /\b(?:full[\s-]?time|part[\s-]?time|contract|contractor|freelance|permanent|temporary|remote|hybrid|on[\s-]?site)\b/gi,
  /\b(?:i{1,3}|iv|v)\b/gi, // level numerals: Engineer II
  /\b\d+\b/g,
  /\[[^\]]*\]/g,
  /\((?:[^)]*)\)/g, // any remaining parenthetical
  /\s+[-–—|]\s+(?:[a-z\s]{0,30})$/i, // trailing " - Berlin" (spaced separator only)
];

/** Spelling and phrasing variants that mean the same thing. */
const CANONICAL_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bfront[\s-]?end\b/gi, 'frontend'],
  [/\bback[\s-]?end\b/gi, 'backend'],
  [/\bfull[\s-]?stack\b/gi, 'fullstack'],
  [/\bweb\s?dev(?:eloper)?\b/gi, 'web developer'],
  [/\bdev\s?ops\b/gi, 'devops'],
  [/\bsre\b/gi, 'site reliability'],
  [/\bml\b/gi, 'machine learning'],
  [/\bai\b/gi, 'artificial intelligence'],
  [/\bqa\b/gi, 'quality assurance'],
  [/\bui\s*\/\s*ux\b/gi, 'ux'],
  [/\bs\/w\b/gi, 'software'],
  [/\bengineer(?:ing)?\b/gi, 'engineer'],
  [/\bdeveloper\b/gi, 'engineer'], // Developer and Engineer are not distinguished
  [/\bprogrammer\b/gi, 'engineer'],
];

/** The discipline noun. */
const DISCIPLINES: Array<{ slug: string; label: string; patterns: RegExp[] }> = [
  { slug: 'engineer', label: 'Engineer', patterns: [/\bengineer\b/i] },
  { slug: 'scientist', label: 'Scientist', patterns: [/\bscientist\b/i] },
  { slug: 'analyst', label: 'Analyst', patterns: [/\banalyst\b/i] },
  { slug: 'designer', label: 'Designer', patterns: [/\bdesigner\b/i] },
  { slug: 'architect', label: 'Architect', patterns: [/\barchitect\b/i] },
  { slug: 'manager', label: 'Manager', patterns: [/\bmanager\b/i] },
  { slug: 'administrator', label: 'Administrator', patterns: [/\badministrator\b|\badmin\b/i] },
  { slug: 'consultant', label: 'Consultant', patterns: [/\bconsultant\b/i] },
  { slug: 'specialist', label: 'Specialist', patterns: [/\bspecialist\b/i] },
  { slug: 'technician', label: 'Technician', patterns: [/\btechnician\b/i] },
];

/**
 * The specialisation. Ordered most-specific-first — "machine learning" must be
 * tested before "data", or every ML role collapses into Data Engineer.
 */
const SPECIALISATIONS: Array<{ slug: string; label: string; patterns: RegExp[] }> = [
  { slug: 'machine-learning', label: 'Machine Learning', patterns: [/\bmachine learning\b/i, /\bartificial intelligence\b/i, /\bdeep learning\b/i] },
  { slug: 'site-reliability', label: 'Site Reliability', patterns: [/\bsite reliability\b/i] },
  { slug: 'devops', label: 'DevOps', patterns: [/\bdevops\b/i, /\bplatform\b/i, /\binfrastructure\b/i] },
  { slug: 'frontend', label: 'Frontend', patterns: [/\bfrontend\b/i, /\bui\b/i, /\breact\b/i, /\bvue\b/i, /\bangular\b/i] },
  { slug: 'backend', label: 'Backend', patterns: [/\bbackend\b/i, /\bserver[\s-]?side\b/i, /\bapi\b/i] },
  { slug: 'fullstack', label: 'Full Stack', patterns: [/\bfullstack\b/i] },
  { slug: 'mobile', label: 'Mobile', patterns: [/\bmobile\b/i, /\bios\b/i, /\bandroid\b/i, /\bflutter\b/i, /\breact native\b/i] },
  { slug: 'data', label: 'Data', patterns: [/\bdata\b/i, /\banalytics\b/i, /\bbi\b/i] },
  { slug: 'security', label: 'Security', patterns: [/\bsecurity\b/i, /\bcyber\b/i, /\bappsec\b/i] },
  { slug: 'quality-assurance', label: 'Quality Assurance', patterns: [/\bquality assurance\b/i, /\btest(?:ing)?\b/i, /\bautomation\b/i] },
  { slug: 'cloud', label: 'Cloud', patterns: [/\bcloud\b/i, /\baws\b/i, /\bazure\b/i] },
  { slug: 'embedded', label: 'Embedded', patterns: [/\bembedded\b/i, /\bfirmware\b/i] },
  { slug: 'ux', label: 'UX', patterns: [/\bux\b/i, /\buser experience\b/i] },
  { slug: 'product', label: 'Product', patterns: [/\bproduct\b/i] },
  { slug: 'software', label: 'Software', patterns: [/\bsoftware\b/i, /\bweb\b/i, /\bapplication\b/i] },
];

export function normalizeJobTitle(rawTitle: string): Confident<NormalizedTitle> {
  const original = collapseWhitespace(rawTitle);
  if (original.length === 0) {
    return {
      value: { normalized: '', roleSlug: null, confidence: 0, strippedTokens: [] },
      confidence: 0,
      method: 'default',
      evidence: null,
    };
  }

  const stripped: string[] = [];
  let working = stripDiacritics(original);

  for (const pattern of DECORATION_PATTERNS) {
    working = working.replace(pattern, (match) => {
      const token = match.trim();
      if (token.length > 0) stripped.push(token);
      return ' ';
    });
  }
  for (const [pattern, replacement] of CANONICAL_REPLACEMENTS) {
    working = working.replace(pattern, replacement);
  }

  working = collapseWhitespace(working.replace(/[,/&]+/g, ' ').replace(/[^\w\s+#.]/g, ' '));

  const discipline = DISCIPLINES.find((d) => d.patterns.some((p) => p.test(working)));
  const specialisation = SPECIALISATIONS.find((s) => s.patterns.some((p) => p.test(working)));

  // Both parts found: high confidence in a fully canonical role.
  if (discipline && specialisation) {
    const normalized = `${specialisation.label} ${discipline.label}`;
    return {
      value: {
        normalized,
        roleSlug: `${specialisation.slug}-${discipline.slug}`,
        confidence: 0.85,
        strippedTokens: stripped,
      },
      confidence: 0.85,
      method: 'taxonomy',
      evidence: `"${original}" -> discipline=${discipline.slug}, specialisation=${specialisation.slug}`,
    };
  }

  // Discipline only: still a useful canonical form, less specific.
  if (discipline) {
    return {
      value: {
        normalized: discipline.label,
        roleSlug: discipline.slug,
        confidence: 0.55,
        strippedTokens: stripped,
      },
      confidence: 0.55,
      method: 'taxonomy',
      evidence: `"${original}" -> discipline=${discipline.slug} only`,
    };
  }

  /**
   * Nothing matched. Return the decoration-stripped title in title case rather
   * than inventing a role — a wrong canonical role is worse than none, because
   * downstream grouping would silently merge unrelated jobs.
   */
  const fallback = titleCase(working) || original;
  return {
    value: { normalized: fallback, roleSlug: null, confidence: 0.2, strippedTokens: stripped },
    confidence: 0.2,
    method: 'heuristic',
    evidence: `no discipline matched in "${original}"`,
  };
}

function titleCase(value: string): string {
  return collapseWhitespace(value)
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
