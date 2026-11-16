import { normalisedTitleSchema, type NormalisedTitle } from '@job-intel/contracts';

/**
 * Title normalisation.
 *
 * "Frontend Engineer", "Frontend Developer", "UI Engineer" and "Software
 * Engineer — Frontend" are usually the same job and occasionally are not, and
 * the brief is precise about this: recognise them as *potentially related*, do
 * not assume they are identical.
 *
 * So the output carries two numbers rather than one. `similarity` is how close
 * the strings are; `confidence` is how sure the mapping is. They come apart
 * exactly where it matters — "Software Engineer" is highly similar to a dozen
 * canonical roles and confidently mapped to none of them, and reporting a
 * single number would hide that.
 *
 * The vocabulary is a seed, not an attempt at completeness. An unrecognised
 * title maps to nothing and keeps its original text, so a niche role is never
 * silently rewritten into an adjacent one.
 */

export interface CanonicalRole {
  slug: string;
  label: string;
  /** Surface forms that map here directly. */
  aliases: readonly string[];
  /** Words that, in combination, suggest this role. */
  signals: readonly string[];
  /** Roles this one is adjacent to but distinct from. */
  adjacent: readonly string[];
  /**
   * True for catch-all roles that name a field rather than a job.
   *
   * "Software Engineer" is a perfectly good alias and a terrible answer: it maps
   * exactly, and it tells you almost nothing about whether the job is frontend,
   * backend or embedded. Confidence is capped for these so a caller can tell an
   * exact match on a specific title from an exact match on a vague one.
   */
  generic?: boolean;
}

export const CANONICAL_ROLES: readonly CanonicalRole[] = [
  {
    slug: 'frontend-engineer',
    label: 'Frontend Engineer',
    aliases: [
      'frontend engineer',
      'front-end engineer',
      'front end engineer',
      'frontend developer',
      'front-end developer',
      'ui engineer',
      'ui developer',
      'web engineer',
      'client-side engineer',
    ],
    signals: ['frontend', 'front-end', 'ui', 'react', 'vue', 'angular'],
    adjacent: ['fullstack-engineer', 'web-developer', 'design-engineer'],
  },
  {
    slug: 'backend-engineer',
    label: 'Backend Engineer',
    aliases: [
      'backend engineer',
      'back-end engineer',
      'back end engineer',
      'backend developer',
      'server-side engineer',
      'api engineer',
    ],
    signals: ['backend', 'back-end', 'api', 'server'],
    adjacent: ['fullstack-engineer', 'platform-engineer'],
  },
  {
    slug: 'fullstack-engineer',
    label: 'Full Stack Engineer',
    aliases: [
      'full stack engineer',
      'fullstack engineer',
      'full-stack engineer',
      'full stack developer',
      'fullstack developer',
      'full-stack developer',
    ],
    signals: ['full stack', 'fullstack', 'full-stack'],
    adjacent: ['frontend-engineer', 'backend-engineer'],
  },
  {
    slug: 'platform-engineer',
    label: 'Platform Engineer',
    aliases: ['platform engineer', 'infrastructure engineer', 'devops engineer', 'sre', 'site reliability engineer'],
    signals: ['platform', 'infrastructure', 'devops', 'reliability', 'kubernetes'],
    adjacent: ['backend-engineer', 'cloud-engineer'],
  },
  {
    slug: 'cloud-engineer',
    label: 'Cloud Engineer',
    aliases: ['cloud engineer', 'cloud architect', 'aws engineer', 'azure engineer'],
    signals: ['cloud', 'aws', 'azure', 'gcp'],
    adjacent: ['platform-engineer'],
  },
  {
    slug: 'mobile-engineer',
    label: 'Mobile Engineer',
    aliases: ['mobile engineer', 'mobile developer', 'ios engineer', 'android engineer', 'react native developer'],
    signals: ['mobile', 'ios', 'android', 'react native', 'flutter'],
    adjacent: ['frontend-engineer'],
  },
  {
    slug: 'data-engineer',
    label: 'Data Engineer',
    aliases: ['data engineer', 'analytics engineer', 'etl engineer'],
    signals: ['data', 'etl', 'pipeline', 'warehouse'],
    adjacent: ['backend-engineer', 'machine-learning-engineer'],
  },
  {
    slug: 'machine-learning-engineer',
    label: 'Machine Learning Engineer',
    aliases: ['machine learning engineer', 'ml engineer', 'ai engineer', 'research engineer'],
    signals: ['machine learning', 'ml', 'ai', 'model'],
    adjacent: ['data-engineer'],
  },
  {
    slug: 'security-engineer',
    label: 'Security Engineer',
    aliases: ['security engineer', 'application security engineer', 'appsec engineer', 'infosec engineer'],
    signals: ['security', 'appsec', 'infosec'],
    adjacent: ['platform-engineer'],
  },
  {
    slug: 'engineering-manager',
    label: 'Engineering Manager',
    aliases: ['engineering manager', 'software engineering manager', 'development manager', 'team lead'],
    signals: ['manager', 'management', 'lead'],
    adjacent: ['tech-lead'],
  },
  {
    slug: 'tech-lead',
    label: 'Tech Lead',
    aliases: ['tech lead', 'technical lead', 'lead engineer', 'lead developer', 'staff engineer'],
    signals: ['lead', 'staff', 'principal'],
    adjacent: ['engineering-manager', 'backend-engineer'],
  },
  {
    slug: 'qa-engineer',
    label: 'QA Engineer',
    aliases: ['qa engineer', 'test engineer', 'sdet', 'quality engineer', 'automation engineer'],
    signals: ['qa', 'test', 'quality', 'automation'],
    adjacent: ['backend-engineer'],
  },
  {
    slug: 'web-developer',
    label: 'Web Developer',
    aliases: ['web developer', 'website developer', 'wordpress developer'],
    signals: ['web', 'website', 'wordpress'],
    adjacent: ['frontend-engineer'],
  },
  {
    slug: 'software-engineer',
    label: 'Software Engineer',
    aliases: ['software engineer', 'software developer', 'programmer', 'developer'],
    signals: ['software', 'engineer', 'developer'],
    adjacent: ['frontend-engineer', 'backend-engineer', 'fullstack-engineer'],
    generic: true,
  },
];

const ALIAS_INDEX: ReadonlyMap<string, CanonicalRole> = (() => {
  const index = new Map<string, CanonicalRole>();

  for (const role of CANONICAL_ROLES) {
    index.set(role.label.toLowerCase(), role);
    for (const alias of role.aliases) index.set(alias, role);
  }

  return index;
})();

/** Seniority words stripped before matching, and reported separately. */
const SENIORITY_WORDS = [
  'intern',
  'graduate',
  'junior',
  'jnr',
  'jr',
  'mid',
  'mid-level',
  'midlevel',
  'senior',
  'snr',
  'sr',
  'staff',
  'principal',
  'lead',
  'head of',
  'director',
  'vp',
  'chief',
];

/** Strips punctuation, seniority and filler so the role itself is comparable. */
export function normaliseTitleText(title: string): { core: string; seniority: string | null } {
  let text = title
    .toLowerCase()
    .replace(/[—–-]/g, ' ')
    .replace(/[(),/|]/g, ' ')
    .replace(/\b(remote|hybrid|onsite|contract|permanent|full[\s-]?time|part[\s-]?time)\b/g, ' ')
    .replace(/\b[ivx]+\b/g, ' ')
    .replace(/\b(i{1,3}|1|2|3|4)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let seniority: string | null = null;

  for (const word of SENIORITY_WORDS) {
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    if (pattern.test(text)) {
      seniority ??= word;
      text = text.replace(pattern, ' ');
    }
  }

  return { core: text.replace(/\s+/g, ' ').trim(), seniority };
}

/** Token overlap, as a 0–1 similarity. */
function tokenSimilarity(a: string, b: string): number {
  const left = new Set(a.split(/\s+/).filter((token) => token.length > 1));
  const right = new Set(b.split(/\s+/).filter((token) => token.length > 1));

  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;

  // Jaccard: penalises a short title matching one word of a long one.
  return shared / (left.size + right.size - shared);
}

/**
 * Maps a title onto the canonical vocabulary.
 *
 * An exact alias is confident. A signal-word match is similar but much less
 * confident, because the same signals appear in several roles — and a title
 * that matches nothing keeps its own text rather than being forced into the
 * nearest bucket.
 */
export function normaliseTitle(title: string): NormalisedTitle {
  const { core, seniority } = normaliseTitleText(title);

  const build = (
    canonicalRole: string | null,
    similarity: number,
    confidence: number,
    rationale: string,
  ): NormalisedTitle =>
    normalisedTitleSchema.parse({
      originalTitle: title.slice(0, 200),
      canonicalRole,
      similarity: Math.round(similarity * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      rationale: rationale.slice(0, 200),
    });

  if (core.length === 0) {
    return build(null, 0, 0, 'Nothing recognisable remained after normalisation.');
  }

  // ── Exact alias ─────────────────────────────────────────────────────────
  const exact = ALIAS_INDEX.get(core);
  if (exact) {
    /*
     * An exact match on a generic role is still ambiguous.
     *
     * The string matched perfectly — similarity is genuinely 1 — but "Software
     * Engineer" could be any of a dozen jobs, and reporting high confidence
     * would let a caller expand it into synonyms for roles the person never
     * asked about. This is precisely the case the two numbers exist to keep
     * apart.
     */
    return build(
      exact.slug,
      1,
      exact.generic ? 0.4 : 0.95,
      exact.generic
        ? `"${core}" names a field rather than a specific role, so the mapping is uncertain.`
        : `"${core}" is a known name for ${exact.label}${seniority ? ` (${seniority} level)` : ''}.`,
    );
  }

  // ── Best token overlap ──────────────────────────────────────────────────
  let best: { role: CanonicalRole; similarity: number } | null = null;

  for (const role of CANONICAL_ROLES) {
    for (const alias of [role.label.toLowerCase(), ...role.aliases]) {
      const similarity = tokenSimilarity(core, alias);
      if (!best || similarity > best.similarity) best = { role, similarity };
    }
  }

  if (best && best.similarity >= 0.5) {
    /*
     * Confidence below similarity, deliberately.
     *
     * Two titles sharing most of their words are usually the same job and
     * sometimes are not — "Frontend Engineer" and "Frontend Architect" score
     * highly and are different roles. The gap between the numbers is where that
     * doubt lives.
     */
    const confidence = Math.min(0.85, best.similarity * 0.8);

    return build(
      best.role.slug,
      best.similarity,
      confidence,
      `Shares most of its wording with ${best.role.label}.`,
    );
  }

  // ── Signal words ────────────────────────────────────────────────────────
  const scored = CANONICAL_ROLES.map((role) => ({
    role,
    hits: role.signals.filter((signal) => core.includes(signal)).length,
  }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  if (scored.length === 0) {
    return build(null, 0, 0, 'No canonical role matched, so the original title is kept.');
  }

  const top = scored[0]!;
  const contested = scored.filter((entry) => entry.hits === top.hits).length > 1;

  /*
   * The case that makes two numbers necessary.
   *
   * "Software Engineer" hits signals for half the vocabulary. It is similar to
   * many things and confidently mapped to none, and a caller reading only a
   * similarity score would treat it as a solid match for whichever happened to
   * sort first.
   */
  return build(
    top.role.slug,
    Math.min(0.6, 0.3 + top.hits * 0.1),
    contested ? 0.25 : 0.45,
    contested
      ? `Signals match ${scored.length} roles equally, so this mapping is uncertain.`
      : `Signals suggest ${top.role.label}, but the wording does not match a known title.`,
  );
}

/** Titles worth searching for, given one target. Used by query expansion. */
export function titleSynonyms(title: string, limit = 6): string[] {
  const normalised = normaliseTitle(title);
  const results = new Set<string>([title]);

  if (normalised.canonicalRole === null || normalised.confidence < 0.4) {
    // Not confident enough to expand: searching adjacent titles for a role we
    // could not place produces noise, not coverage.
    return [...results];
  }

  const role = CANONICAL_ROLES.find((entry) => entry.slug === normalised.canonicalRole);
  if (!role) return [...results];

  const { seniority } = normaliseTitleText(title);
  const prefix = seniority ? `${seniority} ` : '';

  for (const alias of [role.label, ...role.aliases].slice(0, limit)) {
    results.add(`${prefix}${alias}`.replace(/\s+/g, ' ').trim());
    if (results.size >= limit) break;
  }

  return [...results];
}

/** Whether two titles are close enough to treat as the same search target. */
export function titlesRelated(a: string, b: string): { related: boolean; confidence: number } {
  const left = normaliseTitle(a);
  const right = normaliseTitle(b);

  if (left.canonicalRole !== null && left.canonicalRole === right.canonicalRole) {
    return { related: true, confidence: Math.min(left.confidence, right.confidence) };
  }

  const similarity = tokenSimilarity(normaliseTitleText(a).core, normaliseTitleText(b).core);
  return { related: similarity >= 0.6, confidence: similarity * 0.7 };
}
