import type { SkillCategory } from '@job-intel/contracts';

/**
 * Skill taxonomy.
 *
 * Three properties matter more than breadth:
 *
 *  1. **Aliases, not just names.** "ReactJS", "React.js" and "React" are one
 *     skill. Without aliases they are three unrelated strings and matching
 *     silently under-counts.
 *  2. **Implications.** "Next.js" implies React; "Rails" implies Ruby. A
 *     posting that never says "React" while requiring Next.js still wants
 *     React, and that is recorded as `inferred` rather than `required`.
 *  3. **Word-boundary safety.** Short names like Go, R and C are the classic
 *     false-positive source — "go to the office" is not the Go language. Those
 *     entries carry stricter patterns.
 *
 * This is a seed vocabulary, not an attempt at completeness. It is designed to
 * grow: entries are data, and the `skills` table already stores aliases so the
 * vocabulary becomes editable at runtime.
 */

export interface SkillDefinition {
  slug: string;
  displayName: string;
  category: SkillCategory;
  /** Surface forms matched case-insensitively on word boundaries. */
  aliases: string[];
  /**
   * Full regex overriding alias matching. Used where a plain word boundary
   * produces false positives (Go, R, C, .NET).
   */
  pattern?: RegExp;
  /** Slugs this skill implies. Recorded as `inferred`, never `required`. */
  implies?: string[];
}

export const SKILL_TAXONOMY: SkillDefinition[] = [
  // ── Languages ─────────────────────────────────────────────────────────────
  { slug: 'typescript', displayName: 'TypeScript', category: 'language', aliases: ['typescript', 'ts'] },
  {
    slug: 'javascript',
    displayName: 'JavaScript',
    category: 'language',
    aliases: ['javascript', 'js', 'ecmascript', 'es6'],
  },
  { slug: 'python', displayName: 'Python', category: 'language', aliases: ['python'] },
  { slug: 'java', displayName: 'Java', category: 'language', aliases: ['java'] },
  { slug: 'kotlin', displayName: 'Kotlin', category: 'language', aliases: ['kotlin'] },
  { slug: 'swift', displayName: 'Swift', category: 'language', aliases: ['swift'] },
  { slug: 'ruby', displayName: 'Ruby', category: 'language', aliases: ['ruby'] },
  { slug: 'php', displayName: 'PHP', category: 'language', aliases: ['php'] },
  { slug: 'rust', displayName: 'Rust', category: 'language', aliases: ['rust'] },
  { slug: 'scala', displayName: 'Scala', category: 'language', aliases: ['scala'] },
  { slug: 'elixir', displayName: 'Elixir', category: 'language', aliases: ['elixir'] },
  // "Go" needs disambiguation from the English verb.
  {
    slug: 'go',
    displayName: 'Go',
    category: 'language',
    aliases: [],
    pattern: /\b(?:golang|go\s+(?:lang|developer|engineer|programming)|(?<=\/|,|\|)\s*go\s*(?=\/|,|\||$))/i,
  },
  {
    slug: 'csharp',
    displayName: 'C#',
    category: 'language',
    aliases: [],
    pattern: /\bc#|\bc\s?sharp\b/i,
  },
  { slug: 'cpp', displayName: 'C++', category: 'language', aliases: [], pattern: /\bc\+\+/i },
  {
    slug: 'dotnet',
    displayName: '.NET',
    category: 'framework',
    aliases: [],
    pattern: /\.net\b|\bdotnet\b|\basp\.net\b/i,
    implies: ['csharp'],
  },
  { slug: 'sql', displayName: 'SQL', category: 'language', aliases: ['sql'] },
  {
    slug: 'r-lang',
    displayName: 'R',
    category: 'language',
    aliases: [],
    pattern: /\br\s+(?:programming|language|studio)\b|\bin\s+r\b(?!\w)/i,
  },

  // ── Frontend frameworks ───────────────────────────────────────────────────
  {
    slug: 'react',
    displayName: 'React',
    category: 'framework',
    aliases: ['react', 'reactjs', 'react.js', 'react js'],
  },
  {
    slug: 'nextjs',
    displayName: 'Next.js',
    category: 'framework',
    aliases: ['next.js', 'nextjs', 'next js'],
    implies: ['react'],
  },
  { slug: 'vue', displayName: 'Vue', category: 'framework', aliases: ['vue', 'vuejs', 'vue.js'] },
  {
    slug: 'nuxt',
    displayName: 'Nuxt',
    category: 'framework',
    aliases: ['nuxt', 'nuxtjs', 'nuxt.js'],
    implies: ['vue'],
  },
  { slug: 'angular', displayName: 'Angular', category: 'framework', aliases: ['angular', 'angularjs'] },
  { slug: 'svelte', displayName: 'Svelte', category: 'framework', aliases: ['svelte', 'sveltekit'] },
  { slug: 'tailwind', displayName: 'Tailwind CSS', category: 'framework', aliases: ['tailwind', 'tailwindcss'] },
  { slug: 'redux', displayName: 'Redux', category: 'library', aliases: ['redux'], implies: ['react'] },
  { slug: 'html-css', displayName: 'HTML/CSS', category: 'language', aliases: ['html', 'css', 'html5', 'css3', 'scss', 'sass'] },

  // ── Backend / runtime ─────────────────────────────────────────────────────
  {
    slug: 'nodejs',
    displayName: 'Node.js',
    category: 'framework',
    aliases: ['node.js', 'nodejs', 'node js'],
    implies: ['javascript'],
  },
  { slug: 'express', displayName: 'Express', category: 'framework', aliases: ['express', 'expressjs'], implies: ['nodejs'] },
  { slug: 'nestjs', displayName: 'NestJS', category: 'framework', aliases: ['nestjs', 'nest.js'], implies: ['nodejs', 'typescript'] },
  { slug: 'django', displayName: 'Django', category: 'framework', aliases: ['django'], implies: ['python'] },
  { slug: 'flask', displayName: 'Flask', category: 'framework', aliases: ['flask'], implies: ['python'] },
  { slug: 'fastapi', displayName: 'FastAPI', category: 'framework', aliases: ['fastapi'], implies: ['python'] },
  { slug: 'rails', displayName: 'Ruby on Rails', category: 'framework', aliases: ['rails', 'ruby on rails'], implies: ['ruby'] },
  { slug: 'spring', displayName: 'Spring', category: 'framework', aliases: ['spring', 'spring boot'], implies: ['java'] },
  { slug: 'laravel', displayName: 'Laravel', category: 'framework', aliases: ['laravel'], implies: ['php'] },
  { slug: 'graphql', displayName: 'GraphQL', category: 'framework', aliases: ['graphql', 'apollo'] },
  { slug: 'rest-api', displayName: 'REST APIs', category: 'framework', aliases: ['rest api', 'restful', 'rest apis'] },

  // ── Databases ─────────────────────────────────────────────────────────────
  { slug: 'postgresql', displayName: 'PostgreSQL', category: 'database', aliases: ['postgresql', 'postgres', 'psql'] },
  { slug: 'mysql', displayName: 'MySQL', category: 'database', aliases: ['mysql', 'mariadb'] },
  { slug: 'mongodb', displayName: 'MongoDB', category: 'database', aliases: ['mongodb', 'mongo'] },
  { slug: 'redis', displayName: 'Redis', category: 'database', aliases: ['redis'] },
  { slug: 'elasticsearch', displayName: 'Elasticsearch', category: 'database', aliases: ['elasticsearch', 'opensearch'] },
  { slug: 'dynamodb', displayName: 'DynamoDB', category: 'database', aliases: ['dynamodb'] },
  { slug: 'cassandra', displayName: 'Cassandra', category: 'database', aliases: ['cassandra'] },

  // ── Cloud ─────────────────────────────────────────────────────────────────
  { slug: 'aws', displayName: 'AWS', category: 'cloud', aliases: ['aws', 'amazon web services'] },
  { slug: 'gcp', displayName: 'Google Cloud', category: 'cloud', aliases: ['gcp', 'google cloud'] },
  { slug: 'azure', displayName: 'Azure', category: 'cloud', aliases: ['azure', 'microsoft azure'] },
  { slug: 'vercel', displayName: 'Vercel', category: 'cloud', aliases: ['vercel'] },
  { slug: 'cloudflare', displayName: 'Cloudflare', category: 'cloud', aliases: ['cloudflare'] },

  // ── DevOps ────────────────────────────────────────────────────────────────
  { slug: 'docker', displayName: 'Docker', category: 'devops', aliases: ['docker', 'containerization'] },
  { slug: 'kubernetes', displayName: 'Kubernetes', category: 'devops', aliases: ['kubernetes', 'k8s'] },
  { slug: 'terraform', displayName: 'Terraform', category: 'devops', aliases: ['terraform'] },
  { slug: 'ansible', displayName: 'Ansible', category: 'devops', aliases: ['ansible'] },
  { slug: 'ci-cd', displayName: 'CI/CD', category: 'devops', aliases: ['ci/cd', 'cicd', 'continuous integration', 'continuous delivery'] },
  { slug: 'github-actions', displayName: 'GitHub Actions', category: 'devops', aliases: ['github actions'], implies: ['ci-cd'] },
  { slug: 'jenkins', displayName: 'Jenkins', category: 'devops', aliases: ['jenkins'], implies: ['ci-cd'] },
  { slug: 'git', displayName: 'Git', category: 'devops', aliases: ['git', 'github', 'gitlab', 'version control'] },
  { slug: 'linux', displayName: 'Linux', category: 'devops', aliases: ['linux', 'unix'] },
  { slug: 'kafka', displayName: 'Kafka', category: 'devops', aliases: ['kafka'] },
  { slug: 'rabbitmq', displayName: 'RabbitMQ', category: 'devops', aliases: ['rabbitmq'] },

  // ── Testing ───────────────────────────────────────────────────────────────
  { slug: 'jest', displayName: 'Jest', category: 'testing', aliases: ['jest'] },
  { slug: 'vitest', displayName: 'Vitest', category: 'testing', aliases: ['vitest'] },
  { slug: 'cypress', displayName: 'Cypress', category: 'testing', aliases: ['cypress'] },
  { slug: 'playwright', displayName: 'Playwright', category: 'testing', aliases: ['playwright'] },
  { slug: 'selenium', displayName: 'Selenium', category: 'testing', aliases: ['selenium'] },
  { slug: 'pytest', displayName: 'pytest', category: 'testing', aliases: ['pytest'], implies: ['python'] },
  { slug: 'tdd', displayName: 'TDD', category: 'testing', aliases: ['tdd', 'test driven development', 'test-driven'] },

  // ── Data / ML ─────────────────────────────────────────────────────────────
  { slug: 'pandas', displayName: 'pandas', category: 'data', aliases: ['pandas'], implies: ['python'] },
  { slug: 'spark', displayName: 'Spark', category: 'data', aliases: ['spark', 'pyspark', 'apache spark'] },
  { slug: 'airflow', displayName: 'Airflow', category: 'data', aliases: ['airflow'] },
  { slug: 'dbt', displayName: 'dbt', category: 'data', aliases: ['dbt'] },
  { slug: 'snowflake', displayName: 'Snowflake', category: 'data', aliases: ['snowflake'] },
  { slug: 'tensorflow', displayName: 'TensorFlow', category: 'data', aliases: ['tensorflow'] },
  { slug: 'pytorch', displayName: 'PyTorch', category: 'data', aliases: ['pytorch'] },
  { slug: 'machine-learning', displayName: 'Machine Learning', category: 'data', aliases: ['machine learning', 'ml', 'deep learning'] },
  { slug: 'llm', displayName: 'LLMs', category: 'data', aliases: ['llm', 'llms', 'large language model', 'generative ai', 'genai'] },

  // ── Mobile ────────────────────────────────────────────────────────────────
  { slug: 'react-native', displayName: 'React Native', category: 'mobile', aliases: ['react native'], implies: ['react'] },
  { slug: 'flutter', displayName: 'Flutter', category: 'mobile', aliases: ['flutter', 'dart'] },
  { slug: 'ios', displayName: 'iOS', category: 'mobile', aliases: ['ios', 'swiftui', 'uikit'] },
  { slug: 'android', displayName: 'Android', category: 'mobile', aliases: ['android', 'jetpack compose'] },

  // ── Design / PM / security ────────────────────────────────────────────────
  { slug: 'figma', displayName: 'Figma', category: 'design', aliases: ['figma'] },
  { slug: 'ui-ux', displayName: 'UI/UX', category: 'design', aliases: ['ui/ux', 'ux design', 'user experience'] },
  { slug: 'jira', displayName: 'Jira', category: 'project_management', aliases: ['jira'] },
  { slug: 'agile', displayName: 'Agile', category: 'project_management', aliases: ['agile', 'scrum', 'kanban'] },
  { slug: 'oauth', displayName: 'OAuth', category: 'security', aliases: ['oauth', 'oauth2', 'openid'] },
  { slug: 'penetration-testing', displayName: 'Penetration Testing', category: 'security', aliases: ['penetration testing', 'pentesting'] },
  { slug: 'soc2', displayName: 'SOC 2', category: 'security', aliases: ['soc 2', 'soc2', 'iso 27001'] },

  // ── Soft skills ───────────────────────────────────────────────────────────
  { slug: 'communication', displayName: 'Communication', category: 'soft_skill', aliases: ['communication skills', 'excellent communication'] },
  { slug: 'leadership', displayName: 'Leadership', category: 'soft_skill', aliases: ['leadership', 'mentoring', 'mentorship'] },
  { slug: 'collaboration', displayName: 'Collaboration', category: 'soft_skill', aliases: ['collaboration', 'teamwork', 'cross-functional'] },
  { slug: 'problem-solving', displayName: 'Problem Solving', category: 'soft_skill', aliases: ['problem solving', 'problem-solving', 'analytical skills'] },
];

/**
 * Contextual phrases that imply a skill without naming it directly.
 *
 * This is what turns "experience across the modern React ecosystem" into a
 * React signal. Matches are always recorded as `inferred` with lower
 * confidence — the posting did not actually list the skill.
 */
export const CONTEXTUAL_IMPLICATIONS: Array<{ pattern: RegExp; slugs: string[]; note: string }> = [
  {
    pattern: /modern\s+react\s+ecosystem|react\s+ecosystem/i,
    slugs: ['react', 'nextjs', 'typescript'],
    note: 'modern React ecosystem',
  },
  {
    pattern: /modern\s+(?:javascript|js)\s+(?:ecosystem|stack|tooling)/i,
    slugs: ['javascript', 'typescript', 'nodejs'],
    note: 'modern JavaScript stack',
  },
  { pattern: /\bmern\s+stack\b/i, slugs: ['mongodb', 'express', 'react', 'nodejs'], note: 'MERN stack' },
  { pattern: /\bmean\s+stack\b/i, slugs: ['mongodb', 'express', 'angular', 'nodejs'], note: 'MEAN stack' },
  { pattern: /\blamp\s+stack\b/i, slugs: ['linux', 'mysql', 'php'], note: 'LAMP stack' },
  {
    pattern: /full[\s-]?stack\s+(?:developer|engineer)/i,
    slugs: ['javascript', 'rest-api'],
    note: 'full-stack role',
  },
  {
    pattern: /cloud[\s-]native|microservices\s+architecture/i,
    slugs: ['docker', 'kubernetes'],
    note: 'cloud-native architecture',
  },
  {
    pattern: /infrastructure\s+as\s+code|\biac\b/i,
    slugs: ['terraform'],
    note: 'infrastructure as code',
  },
  {
    pattern: /\bdata\s+pipelines?\b|\betl\b/i,
    slugs: ['sql', 'airflow'],
    note: 'data pipeline work',
  },
];

const BY_SLUG = new Map(SKILL_TAXONOMY.map((s) => [s.slug, s]));

export function findSkill(slug: string): SkillDefinition | undefined {
  return BY_SLUG.get(slug);
}

export function allSkillSlugs(): string[] {
  return [...BY_SLUG.keys()];
}

/** Alias and display-name lookup, built once. */
const BY_SURFACE_FORM = new Map<string, string>();
for (const definition of SKILL_TAXONOMY) {
  BY_SURFACE_FORM.set(definition.slug, definition.slug);
  BY_SURFACE_FORM.set(definition.displayName.toLowerCase(), definition.slug);
  for (const alias of definition.aliases) BY_SURFACE_FORM.set(alias.toLowerCase(), definition.slug);
}

/**
 * Resolves a free-text skill name to a canonical slug.
 *
 * The candidate types "React.js" and a posting says "ReactJS"; without a shared
 * resolver those are two unrelated strings and the match silently under-counts.
 * Falls back to a slugified form so an unknown skill still compares against
 * itself consistently rather than vanishing.
 */
export function resolveSkillSlug(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const direct = BY_SURFACE_FORM.get(trimmed);
  if (direct) return direct;

  const slugified = trimmed
    .replace(/\+\+/g, 'pp')
    .replace(/#/g, 'sharp')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return BY_SURFACE_FORM.get(slugified) ?? slugified;
}

/** Escapes a literal alias for use inside a regex. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles a matcher for one skill.
 *
 * Aliases are joined into a single alternation with word boundaries. `\b` does
 * not work after characters like `+` or `#`, so entries whose names contain
 * them supply an explicit `pattern` instead.
 */
export function compileSkillPattern(definition: SkillDefinition): RegExp | null {
  if (definition.pattern) return definition.pattern;
  if (definition.aliases.length === 0) return null;

  const alternation = definition.aliases
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  return new RegExp(`(?<![\\w-])(?:${alternation})(?![\\w-])`, 'i');
}
