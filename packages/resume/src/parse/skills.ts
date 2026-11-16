import { createHash } from 'node:crypto';
import {
  EVIDENCE_SOURCE_WEIGHT,
  evidenceItemSchema,
  type EvidenceItem,
  type EvidenceSource,
  type ExperienceEntry,
  type ProjectRecord,
  type SkillCategory,
} from '@job-intel/contracts';
import { toApproximateDate } from './dates';

/**
 * Skill taxonomy and extraction.
 *
 * Two jobs, deliberately separated:
 *
 *  1. **Normalisation.** `JS`, `JavaScript` and `ECMAScript` are one skill.
 *     `React.js`, `ReactJS` and `React` are one skill. Without this the profile
 *     fragments into near-duplicates and matching misses obvious hits.
 *
 *  2. **Evidence attachment.** A skill is only claimed where something supports
 *     it, and the support is recorded with its origin. This is the whole point
 *     of the layer: the system must be able to say *where* it thinks the
 *     candidate learned React, not merely that they did.
 *
 * The taxonomy is a seed, not an attempt at completeness. An unrecognised term
 * is still extracted — slugged from its own text — so a niche technology is
 * never silently dropped, it simply has no aliases and no graph edges yet.
 */

export interface CanonicalSkill {
  slug: string;
  name: string;
  category: SkillCategory;
  aliases: readonly string[];
}

/**
 * The seed taxonomy.
 *
 * Aliases are the surface forms that actually appear in resumes and job
 * postings — including the ones that are technically wrong ("NodeJS") but
 * ubiquitous, because matching against what people write beats matching against
 * what they should write.
 */
export const SKILL_TAXONOMY: readonly CanonicalSkill[] = [
  // Languages
  { slug: 'javascript', name: 'JavaScript', category: 'language', aliases: ['js', 'ecmascript', 'es6', 'es2015', 'vanilla js'] },
  { slug: 'typescript', name: 'TypeScript', category: 'language', aliases: ['ts'] },
  { slug: 'python', name: 'Python', category: 'language', aliases: ['py', 'python3'] },
  { slug: 'java', name: 'Java', category: 'language', aliases: ['java se', 'java ee', 'j2ee'] },
  { slug: 'csharp', name: 'C#', category: 'language', aliases: ['c sharp', 'c-sharp', 'csharp'] },
  { slug: 'go', name: 'Go', category: 'language', aliases: ['golang'] },
  { slug: 'rust', name: 'Rust', category: 'language', aliases: [] },
  { slug: 'ruby', name: 'Ruby', category: 'language', aliases: [] },
  { slug: 'php', name: 'PHP', category: 'language', aliases: [] },
  { slug: 'kotlin', name: 'Kotlin', category: 'language', aliases: [] },
  { slug: 'swift', name: 'Swift', category: 'language', aliases: [] },
  { slug: 'sql', name: 'SQL', category: 'language', aliases: ['t-sql', 'pl/sql', 'ansi sql'] },
  { slug: 'html', name: 'HTML', category: 'language', aliases: ['html5'] },
  { slug: 'css', name: 'CSS', category: 'language', aliases: ['css3', 'scss', 'sass', 'less'] },

  // Frontend
  { slug: 'react', name: 'React', category: 'framework', aliases: ['react.js', 'reactjs', 'react js'] },
  { slug: 'nextjs', name: 'Next.js', category: 'framework', aliases: ['next.js', 'nextjs', 'next js'] },
  { slug: 'vue', name: 'Vue', category: 'framework', aliases: ['vue.js', 'vuejs', 'vue 3'] },
  { slug: 'angular', name: 'Angular', category: 'framework', aliases: ['angularjs', 'angular 2+'] },
  { slug: 'svelte', name: 'Svelte', category: 'framework', aliases: ['sveltekit'] },
  { slug: 'react-native', name: 'React Native', category: 'framework', aliases: ['react-native', 'rn'] },
  { slug: 'redux', name: 'Redux', category: 'library', aliases: ['redux toolkit', 'rtk'] },
  { slug: 'tailwind', name: 'Tailwind CSS', category: 'library', aliases: ['tailwindcss', 'tailwind css'] },

  // Backend
  { slug: 'nodejs', name: 'Node.js', category: 'framework', aliases: ['node.js', 'nodejs', 'node js', 'node'] },
  { slug: 'express', name: 'Express', category: 'framework', aliases: ['express.js', 'expressjs'] },
  { slug: 'nestjs', name: 'NestJS', category: 'framework', aliases: ['nest.js', 'nest js'] },
  { slug: 'django', name: 'Django', category: 'framework', aliases: [] },
  { slug: 'flask', name: 'Flask', category: 'framework', aliases: [] },
  { slug: 'fastapi', name: 'FastAPI', category: 'framework', aliases: ['fast api'] },
  { slug: 'spring', name: 'Spring', category: 'framework', aliases: ['spring boot', 'springboot'] },
  { slug: 'rails', name: 'Ruby on Rails', category: 'framework', aliases: ['ror', 'rails'] },
  { slug: 'laravel', name: 'Laravel', category: 'framework', aliases: [] },
  { slug: 'dotnet', name: '.NET', category: 'framework', aliases: ['.net core', 'dotnet', 'asp.net', 'aspnet'] },
  { slug: 'graphql', name: 'GraphQL', category: 'framework', aliases: ['apollo'] },
  { slug: 'rest-api', name: 'REST APIs', category: 'framework', aliases: ['rest', 'restful', 'restful api', 'rest api'] },

  // Data
  { slug: 'postgresql', name: 'PostgreSQL', category: 'database', aliases: ['postgres', 'psql'] },
  { slug: 'mysql', name: 'MySQL', category: 'database', aliases: ['mariadb'] },
  { slug: 'mongodb', name: 'MongoDB', category: 'database', aliases: ['mongo'] },
  { slug: 'redis', name: 'Redis', category: 'database', aliases: [] },
  { slug: 'elasticsearch', name: 'Elasticsearch', category: 'database', aliases: ['elastic search', 'opensearch'] },
  { slug: 'dynamodb', name: 'DynamoDB', category: 'database', aliases: ['dynamo'] },

  // Cloud and infra
  { slug: 'aws', name: 'AWS', category: 'cloud', aliases: ['amazon web services'] },
  { slug: 'gcp', name: 'Google Cloud', category: 'cloud', aliases: ['google cloud platform', 'gcp'] },
  { slug: 'azure', name: 'Azure', category: 'cloud', aliases: ['microsoft azure'] },
  { slug: 'ec2', name: 'EC2', category: 'cloud', aliases: ['amazon ec2'] },
  { slug: 's3', name: 'S3', category: 'cloud', aliases: ['amazon s3'] },
  { slug: 'lambda', name: 'AWS Lambda', category: 'cloud', aliases: ['aws lambda'] },
  { slug: 'ecs', name: 'ECS', category: 'cloud', aliases: ['amazon ecs', 'fargate'] },
  { slug: 'docker', name: 'Docker', category: 'devops', aliases: ['containerisation', 'containerization'] },
  { slug: 'kubernetes', name: 'Kubernetes', category: 'devops', aliases: ['k8s', 'eks', 'gke'] },
  { slug: 'terraform', name: 'Terraform', category: 'devops', aliases: ['hcl'] },
  { slug: 'ci-cd', name: 'CI/CD', category: 'devops', aliases: ['ci/cd', 'continuous integration', 'continuous delivery', 'github actions', 'jenkins', 'gitlab ci'] },
  { slug: 'linux', name: 'Linux', category: 'devops', aliases: ['unix', 'bash'] },

  // Practice
  { slug: 'system-design', name: 'System Design', category: 'domain', aliases: ['systems design', 'architecture', 'software architecture', 'distributed systems'] },
  { slug: 'testing', name: 'Testing', category: 'testing', aliases: ['unit testing', 'integration testing', 'tdd', 'jest', 'vitest', 'cypress', 'playwright', 'pytest'] },
  { slug: 'agile', name: 'Agile', category: 'project_management', aliases: ['scrum', 'kanban', 'agile methodologies'] },
  { slug: 'git', name: 'Git', category: 'devops', aliases: ['github', 'gitlab', 'version control'] },
  { slug: 'accessibility', name: 'Accessibility', category: 'design', aliases: ['a11y', 'wcag'] },
  { slug: 'performance', name: 'Performance Optimisation', category: 'domain', aliases: ['performance optimization', 'web performance', 'core web vitals'] },

  // Soft skills — extracted because Part 9 asks for them explicitly.
  { slug: 'communication', name: 'Communication', category: 'soft_skill', aliases: ['written communication', 'verbal communication'] },
  { slug: 'leadership', name: 'Leadership', category: 'soft_skill', aliases: ['team leadership', 'technical leadership'] },
  { slug: 'mentoring', name: 'Mentoring', category: 'soft_skill', aliases: ['coaching', 'mentorship'] },
  { slug: 'project-management', name: 'Project Management', category: 'project_management', aliases: ['delivery management', 'programme management'] },
  { slug: 'stakeholder-management', name: 'Stakeholder Management', category: 'soft_skill', aliases: ['stakeholder engagement', 'client management'] },
  { slug: 'problem-solving', name: 'Problem Solving', category: 'soft_skill', aliases: ['analytical thinking'] },
];

/** Alias → slug, built once. Longest aliases first so `react native` beats `react`. */
const ALIAS_INDEX: ReadonlyMap<string, CanonicalSkill> = (() => {
  const index = new Map<string, CanonicalSkill>();
  for (const skill of SKILL_TAXONOMY) {
    index.set(skill.name.toLowerCase(), skill);
    index.set(skill.slug, skill);
    for (const alias of skill.aliases) index.set(alias.toLowerCase(), skill);
  }
  return index;
})();

const SORTED_ALIASES: readonly string[] = [...ALIAS_INDEX.keys()].sort((a, b) => b.length - a.length);

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[.\s_]+/g, '-')
    .replace(/[^a-z0-9+#-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Maps a surface form to its canonical skill.
 *
 * Returns a synthesised entry for unrecognised terms rather than null: a
 * technology absent from the seed taxonomy is still a real skill, and dropping
 * it would make the profile quietly incomplete in exactly the cases where the
 * candidate is unusual.
 */
export function normaliseSkill(raw: string): CanonicalSkill | null {
  const cleaned = raw
    .trim()
    .replace(/^[•\-–—*]\s*/, '')
    .replace(/\s*\(.*?\)\s*$/, '')
    .replace(/[.,;:]+$/, '')
    .trim();

  if (cleaned.length < 1 || cleaned.length > 60) return null;

  const known = ALIAS_INDEX.get(cleaned.toLowerCase());
  if (known) return known;

  // Not in the taxonomy. Keep it, slugged from its own text.
  const slug = slugify(cleaned);
  if (slug.length < 1) return null;

  return { slug, name: cleaned, category: 'other', aliases: [] };
}

/** Every taxonomy term mentioned in a block of text. */
export function findSkillsInText(text: string): CanonicalSkill[] {
  const haystack = ` ${text.toLowerCase().replace(/[\n\t]/g, ' ')} `;
  const found = new Map<string, CanonicalSkill>();

  for (const alias of SORTED_ALIASES) {
    const skill = ALIAS_INDEX.get(alias)!;
    if (found.has(skill.slug)) continue;

    /*
     * Word-boundary matching, built by hand because `\b` does not work for
     * terms containing `+`, `#` or `.` — and "C#" and "Node.js" are exactly the
     * terms a naive boundary check gets wrong.
     */
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^a-z0-9+#])${escaped}([^a-z0-9+#]|$)`, 'i');

    if (pattern.test(haystack)) found.set(skill.slug, skill);
  }

  return [...found.values()];
}

/**
 * Whether an unrecognised token is plausibly a skill rather than prose.
 *
 * Needed because a document with no section headings is handed to this function
 * whole, and comma-splitting English prose produces "where they have" and "and"
 * as skills. A technology absent from the taxonomy still looks like a name —
 * capitalised, or carrying a digit or symbol — while a sentence fragment does
 * not.
 */
const PROSE_WORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by',
  'as', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'they', 'their', 'them', 'she', 'he',
  'we', 'our', 'us', 'it', 'its', 'this', 'that', 'these', 'those', 'where', 'when', 'while',
  'who', 'which', 'been', 'being', 'also', 'other', 'using', 'used', 'including', 'etc',
]);

function looksLikeSkillName(value: string): boolean {
  const words = value.split(/\s+/);
  if (words.length > 4) return false;

  const lower = value.toLowerCase();
  if (PROSE_WORDS.has(lower)) return false;
  // Any function word in the phrase means it is a fragment, not a name.
  if (words.some((word) => PROSE_WORDS.has(word.toLowerCase()))) return false;

  // A name: capitalised, an acronym, or carrying a version/symbol.
  return /^[A-Z]/.test(value) || /[0-9+#./]/.test(value);
}

/** Comma/newline-separated skills from a skills section. */
export function parseSkillSection(section: string): CanonicalSkill[] {
  const found = new Map<string, CanonicalSkill>();

  for (const line of section.split('\n')) {
    // "Languages: JavaScript, TypeScript" — drop the category label.
    const body = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;

    for (const token of body.split(/[,;|•·]/)) {
      const skill = normaliseSkill(token);
      if (!skill) continue;

      // Taxonomy hits are trusted; anything else has to look like a name.
      const known = ALIAS_INDEX.has(skill.slug);
      if (!known && !looksLikeSkillName(skill.name)) continue;

      found.set(skill.slug, skill);
    }
  }

  // Also sweep the raw text: a skills section written as prose still names
  // technologies, and the token split alone would miss them.
  for (const skill of findSkillsInText(section)) {
    if (!found.has(skill.slug)) found.set(skill.slug, skill);
  }

  return [...found.values()];
}

const evidenceId = (...parts: Array<string | null>): string =>
  createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 16);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SkillMention {
  skill: CanonicalSkill;
  evidence: EvidenceItem;
}

/**
 * Skill mentions across the whole document, each with its evidence.
 *
 * The evidence source is what differentiates these: the same skill named in a
 * two-year role and in a skills list produces two evidence items with different
 * weights, and the proficiency estimator downstream can tell them apart.
 */
export function collectSkillMentions(input: {
  documentId: string | null;
  skillSection: string;
  experience: readonly ExperienceEntry[];
  projects: readonly ProjectRecord[];
  certifications: ReadonlyArray<{ name: string; issuer: string | null }>;
  educationCoursework: readonly string[];
  extractedBy?: string | null;
}): SkillMention[] {
  const mentions: SkillMention[] = [];
  const extractedBy = input.extractedBy ?? null;

  /*
   * Checked once, loudly, rather than per item.
   *
   * `documentId` is a UUID in the contract, and a caller passing something else
   * would otherwise fail every `safeParse` below and return an empty list —
   * a profile with no skills at all, reported as a successful extraction. A
   * caller error must not be able to look like a candidate with no skills.
   */
  if (input.documentId !== null && !UUID_PATTERN.test(input.documentId)) {
    throw new Error(
      `collectSkillMentions: documentId must be a UUID or null, received "${input.documentId}".`,
    );
  }

  const push = (
    skill: CanonicalSkill,
    source: EvidenceSource,
    context: string,
    excerpt: string | null,
    observedFrom: Date | null,
    observedTo: Date | null,
    confidenceBoost = 0,
  ): void => {
    const parsed = evidenceItemSchema.safeParse({
      id: evidenceId(skill.slug, source, context, excerpt?.slice(0, 60) ?? null),
      source,
      documentId: input.documentId,
      context: context.slice(0, 300),
      excerpt: excerpt?.slice(0, 1_000) ?? null,
      confidence: Math.min(1, EVIDENCE_SOURCE_WEIGHT[source] + confidenceBoost),
      observedFrom,
      observedTo,
      extractedBy,
      extractedAt: new Date(),
    });

    if (!parsed.success) {
      // Every field above is bounded before it gets here, so a failure means a
      // contract change the extractor has not caught up with. Silence would
      // show up later as a skill that mysteriously has no evidence.
      throw new Error(`Evidence for "${skill.slug}" failed validation: ${parsed.error.message}`);
    }

    mentions.push({ skill, evidence: parsed.data });
  };

  // ── Skills section ──────────────────────────────────────────────────────
  for (const skill of parseSkillSection(input.skillSection)) {
    push(skill, 'resume_skill_section', 'Skills section', null, null, null);
  }

  // ── Employment ──────────────────────────────────────────────────────────
  for (const role of input.experience) {
    const text = [role.description ?? '', ...role.responsibilities, ...role.achievements].join('\n');
    const from = toApproximateDate(role.dates.start);
    const to = role.dates.isCurrent ? new Date() : toApproximateDate(role.dates.end);

    for (const skill of findSkillsInText(text)) {
      // The sentence that mentions it, so the evidence is readable.
      const sentence =
        text
          .split(/(?<=[.!?])\s+|\n/)
          .find((line) => new RegExp(skill.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(line)) ??
        null;

      push(
        skill,
        'employment_responsibility',
        `${role.company} — ${role.title}`,
        sentence,
        from,
        to,
        // A longer role is stronger evidence of the same skill.
        role.dates.durationMonths && role.dates.durationMonths >= 24 ? 0.1 : 0,
      );
    }
  }

  // ── Projects ────────────────────────────────────────────────────────────
  for (const project of input.projects) {
    const text = [project.description ?? '', project.outcome ?? '', project.name].join('\n');
    const from = toApproximateDate(project.dates.start);
    const to = toApproximateDate(project.dates.end);

    for (const skill of findSkillsInText(text)) {
      push(
        skill,
        // A professional project is employment-grade evidence; a personal one
        // is not, and the source records which.
        project.context === 'professional' ? 'employment_responsibility' : 'project_implementation',
        `Project: ${project.name}`,
        project.description?.slice(0, 300) ?? null,
        from,
        to,
      );
    }
  }

  // ── Certifications ──────────────────────────────────────────────────────
  for (const certification of input.certifications) {
    for (const skill of findSkillsInText(`${certification.name} ${certification.issuer ?? ''}`)) {
      push(
        skill,
        'certification',
        `Certification: ${certification.name}`,
        certification.name,
        null,
        null,
      );
    }
  }

  // ── Coursework ──────────────────────────────────────────────────────────
  for (const course of input.educationCoursework) {
    for (const skill of findSkillsInText(course)) {
      push(skill, 'education_coursework', `Coursework: ${course}`, course, null, null);
    }
  }

  return mentions;
}

/**
 * Skill mentions from a linked public profile.
 *
 * Kept separate from resume evidence and weighted lower on purpose: a public
 * repository shows that someone has written a language, which is real but is
 * not the same as having been paid to maintain it. The shape is structural
 * rather than imported from the connector package, so this module stays
 * independent of how the data was fetched.
 */
export function mentionsFromExternalProfile(input: {
  provider: string;
  url: string;
  items: ReadonlyArray<{
    name: string;
    detail: string;
    url: string | null;
    observedFrom: Date | null;
    observedTo: Date | null;
  }>;
}): SkillMention[] {
  const source: EvidenceSource = input.provider === 'github' ? 'public_repository' : 'portfolio';
  const mentions: SkillMention[] = [];

  for (const item of input.items) {
    const skill = normaliseSkill(item.name);
    if (!skill) continue;

    const parsed = evidenceItemSchema.safeParse({
      id: evidenceId(skill.slug, source, input.provider, item.detail.slice(0, 60)),
      source,
      documentId: null,
      context: `${input.provider}: ${input.url}`.slice(0, 300),
      excerpt: item.detail.slice(0, 1_000),
      confidence: EVIDENCE_SOURCE_WEIGHT[source],
      observedFrom: item.observedFrom,
      observedTo: item.observedTo,
      extractedBy: null,
      extractedAt: new Date(),
    });

    if (parsed.success) mentions.push({ skill, evidence: parsed.data });
  }

  return mentions;
}

/** Technologies evidenced by one role or project, as canonical slugs. */
export function technologiesFor(text: string): string[] {
  return findSkillsInText(text)
    .filter((skill) => skill.category !== 'soft_skill')
    .map((skill) => skill.slug);
}
