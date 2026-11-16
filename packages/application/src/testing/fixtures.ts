import {
  applicationTargetSchema,
  candidateIntelligenceSchema,
  candidatePreferencesSchema,
  candidateSkillFactSchema,
  compensationSchema,
  dateRangeSchema,
  educationRequirementSchema,
  evidenceItemSchema,
  experienceEntrySchema,
  experienceRequirementSchema,
  extractedLocationSchema,
  jobEnrichmentSchema,
  partialDateSchema,
  qualityAssessmentSchema,
  workArrangementSchema,
  workAuthorizationSchema,
  type CandidateIntelligence,
  type CandidatePreferences,
  type CandidateSkillFact,
  type EvidenceItem,
  type ExperienceEntry,
  type JobEnrichment,
} from '@job-intel/contracts';

/**
 * Synthetic jobs and candidates for exercising the policy.
 *
 * Every posting here is invented. The point is not to be realistic in the
 * decorative sense — it is to be *adversarial*: each fixture is built around one
 * way the recommendation engine could plausibly get it wrong, so that running
 * the twenty of them together says something about the policy rather than
 * confirming that the happy path works.
 *
 * The candidate is deliberately specific — a senior frontend-leaning full-stack
 * engineer in the UK, with real gaps — because a candidate who is good at
 * everything makes every job look like a match and tests nothing.
 */

export const CANDIDATE_ID = '11111111-2222-4333-8444-555555555555';
export const NOW = new Date('2025-06-15T00:00:00Z');

const uuid = (n: number): string =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

// ── Candidate ───────────────────────────────────────────────────────────────

function evidence(context: string, source: EvidenceItem['source'] = 'employment_responsibility'): EvidenceItem {
  return evidenceItemSchema.parse({
    id: `ev-${context.slice(0, 20).replace(/\W/g, '')}`,
    source,
    documentId: null,
    context,
    excerpt: `Worked on ${context}`,
    confidence: source === 'employment_responsibility' ? 0.85 : 0.5,
    observedFrom: new Date('2019-01-01'),
    observedTo: new Date('2025-05-01'),
    extractedBy: null,
    extractedAt: NOW,
  });
}

function skill(
  slug: string,
  name: string,
  months: number | null,
  overrides: Partial<CandidateSkillFact> = {},
): CandidateSkillFact {
  return candidateSkillFactSchema.parse({
    slug,
    name,
    category: overrides.category ?? 'framework',
    proficiency: overrides.proficiency ?? (months !== null && months >= 48 ? 'ADVANCED' : 'PROFICIENT'),
    proficiencyConfidence: 0.7,
    proficiencyRationale: `Evidence suggests use across ${months ?? 0} months.`,
    totalMonths: months,
    lastEvidencedAt: overrides.lastEvidencedAt ?? new Date('2025-05-01'),
    firstEvidencedAt: new Date('2019-01-01'),
    evidence: overrides.evidence ?? [evidence(`${name} at Meridian Labs`)],
    strongestSource: overrides.strongestSource ?? 'employment_responsibility',
    userVerified: false,
  });
}

function role(
  company: string,
  title: string,
  startYear: number,
  endYear: number | null,
  technologies: string[],
): ExperienceEntry {
  return experienceEntrySchema.parse({
    id: `${company}-${startYear}`,
    company,
    title,
    location: 'London, UK',
    employmentKind: 'full_time',
    dates: dateRangeSchema.parse({
      start: partialDateSchema.parse({ year: startYear, month: 1, precision: 'month' }),
      end:
        endYear === null
          ? partialDateSchema.parse({})
          : partialDateSchema.parse({ year: endYear, month: 1, precision: 'month' }),
      isCurrent: endYear === null,
      durationMonths: endYear === null ? null : (endYear - startYear) * 12,
    }),
    description: null,
    responsibilities: [`Built and maintained services using ${technologies.slice(0, 3).join(', ')}`],
    achievements: ['Reduced page load time by 68%'],
    technologies,
    seniorityIndicators: ['Led the migration', 'Mentored three engineers'],
    sourceText: `${company} — ${title}`,
    confidence: 0.9,
  });
}

/**
 * The reference candidate.
 *
 * Strong on frontend, competent on backend, thin on infrastructure, no
 * Kubernetes, no German recorded, UK-authorised only. Every one of those is a
 * fixture below that depends on it.
 */
export const CANDIDATE: CandidateIntelligence = candidateIntelligenceSchema.parse({
  candidateId: CANDIDATE_ID,
  profileVersion: 4,
  summary: 'Senior frontend-leaning full-stack engineer, seven years, London.',
  skills: [
    skill('react', 'React', 72, { proficiency: 'EXPERT' }),
    skill('typescript', 'TypeScript', 66, { proficiency: 'EXPERT' }),
    skill('nextjs', 'Next.js', 42),
    skill('javascript', 'JavaScript', 84, { proficiency: 'EXPERT', category: 'language' }),
    skill('nodejs', 'Node.js', 54),
    skill('graphql', 'GraphQL', 30),
    skill('postgresql', 'PostgreSQL', 48, { category: 'database' }),
    skill('docker', 'Docker', 30, { category: 'devops' }),
    skill('aws', 'AWS', 36, { category: 'cloud' }),
    skill('s3', 'S3', 24, { category: 'cloud' }),
    skill('ecs', 'ECS', 18, { category: 'cloud' }),
    skill('terraform', 'Terraform', 12, { category: 'devops', proficiency: 'WORKING' }),
    skill('testing', 'Testing', 60, { category: 'testing' }),
    // Listed only. Deliberately weak, to test that a claim is not evidence.
    skill('python', 'Python', null, {
      proficiency: 'WORKING',
      strongestSource: 'resume_skill_section',
      evidence: [evidence('Skills section', 'resume_skill_section')],
      lastEvidencedAt: null,
    }),
    // Real but stale, to test recency.
    skill('php', 'PHP', 36, {
      category: 'language',
      lastEvidencedAt: new Date('2016-06-01'),
      proficiency: 'PROFICIENT',
    }),
  ],
  experience: [
    role('Meridian Labs', 'Senior Software Engineer', 2021, null, [
      'react',
      'typescript',
      'nextjs',
      'nodejs',
      'graphql',
      'postgresql',
      'aws',
      'docker',
    ]),
    role('Harbourview Systems', 'Software Engineer', 2018, 2021, [
      'javascript',
      'react',
      'nodejs',
      'postgresql',
    ]),
    role('Kestrel Digital', 'Junior Developer', 2016, 2018, ['javascript', 'php', 'css']),
  ],
  education: [
    {
      id: 'edu-1',
      institution: 'University of Leeds',
      degree: 'BSc Computer Science',
      field: 'Computer Science',
      level: 'bachelors',
      dates: dateRangeSchema.parse({
        start: partialDateSchema.parse({ year: 2013, precision: 'year' }),
        end: partialDateSchema.parse({ year: 2016, precision: 'year' }),
      }),
      grade: 'First Class',
      coursework: [],
      sourceText: 'University of Leeds, BSc Computer Science',
      confidence: 0.9,
      userVerified: false,
    },
  ],
  certifications: [],
  projects: [],
  achievements: [],
  languages: [
    {
      id: 'lang-en',
      language: 'English',
      proficiency: 'NATIVE',
      sourceText: 'English (Native)',
      confidence: 0.9,
      userVerified: false,
    },
  ],
  seniority: {
    estimatedLevel: 'senior',
    confidence: 0.75,
    signals: [],
    evidence: [],
    titleVsEvidenceNote: null,
  },
  trajectory: {
    dimensions: [
      {
        dimension: 'technical_depth',
        direction: 0.5,
        confidence: 0.6,
        detail: 'Increasing depth in frontend architecture.',
        evidence: [],
      },
      {
        dimension: 'leadership',
        direction: 0.4,
        confidence: 0.5,
        detail: 'Mentoring and leading migrations in recent roles.',
        evidence: [],
      },
    ],
    trajectorySummary: 'Seven years, frontend deepening into full-stack and platform work.',
    trajectoryConfidence: 0.6,
    timeline: [],
    totalExperienceMonths: 108,
    gaps: [],
  },
  quality: null,
  sourceDocumentIds: [uuid(90), uuid(91)],
  openConflicts: 0,
  computedAt: NOW,
});

export const PREFERENCES: CandidatePreferences = candidatePreferencesSchema.parse({
  titles: [{ value: 'Frontend Engineer', strength: 'strongly_preferred', hard: false, source: 'explicit' }],
  countries: [{ value: 'GB', strength: 'preferred', hard: false, source: 'explicit' }],
  cities: [{ value: 'London', strength: 'preferred', hard: false, source: 'explicit' }],
  workArrangement: 'REMOTE_PREFERRED',
  maxOfficeDaysPerWeek: 2,
  salary: {
    minimum: 85_000,
    target: 105_000,
    ideal: 130_000,
    currency: 'USD',
    period: 'year',
    minimumIsHard: false,
    acceptUnstatedSalary: true,
  },
  workAuthorization: {
    sponsorshipRequirement: 'not_needed',
    authorizedCountries: ['GB'],
    citizenships: ['GB'],
    willingToRelocate: false,
    relocationCountries: [],
    acceptUnknownSponsorship: true,
  },
  technologies: [
    { value: 'React', strength: 'strongly_preferred', hard: false, source: 'explicit' },
    // Excluded on purpose, to test that a CONFLICT is produced.
    { value: 'PHP', strength: 'excluded', hard: false, source: 'explicit' },
  ],
  seniorityLevels: ['senior', 'staff'],
});

// ── Job fixtures ────────────────────────────────────────────────────────────

export interface JobFixture {
  id: string;
  name: string;
  /** What this fixture is designed to catch. */
  tests: string;
  title: string;
  companyName: string | null;
  companyWebsite: string | null;
  description: string;
  postedAt: Date | null;
  validThrough: Date | null;
  closed: boolean;
  applyUrl: string | null;
  sourceCount: number;
  enrichment: JobEnrichment;
  /** The verdict the fixture is built to produce. */
  expected: string[];
}

let counter = 1;

function enrichment(options: {
  title: string;
  seniority?: JobEnrichment['seniority'];
  seniorityConfidence?: number;
  skills?: Array<{ slug: string; name: string; requirement: 'required' | 'preferred' | 'optional' | 'inferred' }>;
  minYears?: number | null;
  qualitative?: boolean;
  requirements?: string[];
  preferred?: string[];
  mode?: JobEnrichment['workArrangement']['mode'];
  remoteRegions?: string[];
  remoteWorldwide?: boolean;
  officeDays?: number | null;
  city?: string | null;
  countryCode?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string | null;
  sponsorship?: JobEnrichment['workAuthorization']['sponsorship'];
  authorizationRequirement?: string | null;
  educationLevel?: JobEnrichment['education']['level'];
  educationRequirement?: 'required' | 'preferred' | 'not_specified';
  certifications?: string[];
  quality?: number;
  scam?: number;
  ats?: JobEnrichment['applicationTarget']['atsVendor'];
  applicationUrl?: string | null;
}): JobEnrichment {
  return jobEnrichmentSchema.parse({
    enrichmentVersion: 1,
    normalizedTitle: options.title,
    titleConfidence: 0.9,
    roleSlug: null,
    seniority: options.seniority ?? null,
    seniorityConfidence: options.seniorityConfidence ?? 0.7,
    seniorityEvidence: null,
    seniorityConflict: null,
    experience: experienceRequirementSchema.parse({
      minimumYears: options.minYears ?? null,
      maximumYears: null,
      confidence: 0.8,
      method: 'pattern',
      rawText: options.minYears ? `${options.minYears}+ years` : null,
      qualitativeOnly: options.qualitative ?? false,
    }),
    employmentTypes: ['full_time'],
    workArrangement: workArrangementSchema.parse({
      mode: options.mode ?? 'remote',
      confidence: 0.85,
      method: 'pattern',
      evidence: null,
      remoteAllowed: (options.mode ?? 'remote') === 'remote',
      remoteRegions: options.remoteRegions ?? [],
      remoteWorldwide: options.remoteWorldwide ?? false,
      officeDaysPerWeek: options.officeDays ?? null,
      officeLocation: null,
      relocationRequired: null,
      geographicRestriction: null,
      travelRequirement: null,
    }),
    location: extractedLocationSchema.parse({
      raw: options.city ?? null,
      city: options.city ?? null,
      region: null,
      countryCode: options.countryCode ?? null,
      confidence: 0.8,
      method: 'pattern',
    }),
    compensation: compensationSchema.parse({
      stated: options.salaryMin !== undefined && options.salaryMin !== null,
      minimum: options.salaryMin ?? null,
      maximum: options.salaryMax ?? null,
      currency: options.currency ?? (options.salaryMin ? 'USD' : null),
      period: options.salaryMin ? 'year' : null,
      isOpenEnded: false,
      isEstimated: false,
      rawText: null,
      components: [],
      confidence: options.salaryMin ? 0.85 : 0,
      method: 'pattern',
      conversion: null,
    }),
    workAuthorization: workAuthorizationSchema.parse({
      sponsorship: options.sponsorship ?? 'not_mentioned',
      sponsorshipConfidence: options.sponsorship ? 0.8 : 0.2,
      sponsorshipEvidence: null,
      workAuthorizationRequirement: options.authorizationRequirement ?? null,
      citizenshipRequired: null,
      securityClearanceRequired: null,
      securityClearanceLevel: null,
      relocationSupport: 'not_mentioned',
      relocationEvidence: null,
    }),
    education: educationRequirementSchema.parse({
      level: options.educationLevel ?? null,
      requirement: options.educationRequirement ?? 'not_specified',
      fields: [],
      certifications: options.certifications ?? [],
      confidence: 0.7,
      method: 'pattern',
      evidence: null,
    }),
    classification: {
      jobFunction: 'software_engineering',
      functionConfidence: 0.8,
      industries: [],
      industryConfidence: 0.3,
      method: 'pattern',
      evidence: null,
    },
    quality: qualityAssessmentSchema.parse({
      qualityScore: options.quality ?? 0.8,
      scamScore: options.scam ?? 0.05,
      qualityConfidence: 0.7,
      flags: [],
      components: {},
    }),
    applicationTarget: applicationTargetSchema.parse({
      sourceUrl: 'https://example.invalid/job',
      canonicalJobUrl: null,
      applicationUrl: options.applicationUrl === undefined ? 'https://example.invalid/apply' : options.applicationUrl,
      atsVendor: options.ats ?? null,
      atsSlug: null,
      confidence: 0.8,
      kind: 'ats_direct',
      candidates: [],
    }),
    skills: (options.skills ?? []).map((entry) => ({
      slug: entry.slug,
      displayName: entry.name,
      category: 'framework',
      requirement: entry.requirement,
      confidence: 0.85,
      method: 'pattern',
      matchedText: entry.name,
      evidence: null,
    })),
    responsibilities: [],
    requirements: options.requirements ?? [],
    preferredQualifications: options.preferred ?? [],
    benefits: [],
    cleanedDescription: null,
    cleaningRemovedChars: 0,
    stageReports: [],
    totalDurationMs: 100,
    aiUsed: false,
    aiModel: null,
    aiInputTokens: null,
    aiOutputTokens: null,
    aiCostUsd: null,
    aiError: null,
  });
}

const days = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

function job(fixture: Omit<JobFixture, 'id'>): JobFixture {
  return { id: uuid(counter++), ...fixture };
}

export const JOB_FIXTURES: readonly JobFixture[] = [
  // 1 ── The obvious yes ───────────────────────────────────────────────────
  job({
    name: 'excellent-match',
    tests: 'everything aligns: skills, seniority, remote, pay, fresh',
    title: 'Senior Frontend Engineer',
    companyName: 'Northwind Software',
    companyWebsite: 'https://northwind.example',
    description:
      'We are looking for a Senior Frontend Engineer to own our design system. ' +
      'Requirements: 5+ years building production React applications, strong TypeScript, ' +
      'experience with Next.js. Nice to have: GraphQL.',
    postedAt: days(1),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
        { slug: 'nextjs', name: 'Next.js', requirement: 'required' },
        { slug: 'graphql', name: 'GraphQL', requirement: 'preferred' },
      ],
      requirements: [
        '5+ years building production React applications',
        'Strong TypeScript',
        'Experience with Next.js',
      ],
      preferred: ['GraphQL experience is a plus'],
      mode: 'remote',
      remoteRegions: ['GB', 'IE'],
      salaryMin: 110_000,
      salaryMax: 140_000,
      ats: 'greenhouse',
    }),
    expected: ['APPLY_NOW', 'APPLY'],
  }),

  // 2 ── Good, with one real gap ───────────────────────────────────────────
  job({
    name: 'strong-with-one-gap',
    tests: 'strong fit but one required skill has no evidence at all',
    title: 'Senior Full Stack Engineer',
    companyName: 'Cobalt Systems',
    companyWebsite: 'https://cobalt.example',
    description:
      'Requirements: 5+ years full-stack development, React, TypeScript, Node.js, ' +
      'and production Kubernetes experience.',
    postedAt: days(4),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 2,
    enrichment: enrichment({
      title: 'Senior Full Stack Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
        { slug: 'nodejs', name: 'Node.js', requirement: 'required' },
        { slug: 'kubernetes', name: 'Kubernetes', requirement: 'required' },
      ],
      requirements: ['5+ years full-stack development', 'Production Kubernetes experience'],
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 100_000,
      salaryMax: 130_000,
      ats: 'lever',
    }),
    expected: ['APPLY', 'CONSIDER'],
  }),

  // 3 ── The hard blocker ──────────────────────────────────────────────────
  job({
    name: 'hard-blocker-authorization',
    tests: 'candidate is UK-only, role is US-only and explicitly does not sponsor',
    title: 'Senior Frontend Engineer',
    companyName: 'Redwood Analytics',
    companyWebsite: 'https://redwood.example',
    description:
      'Must be authorized to work in the United States. We do not provide visa sponsorship. ' +
      'Requirements: 5+ years React, TypeScript.',
    postedAt: days(2),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
      ],
      requirements: ['Must be authorized to work in the United States', '5+ years React'],
      mode: 'remote',
      remoteRegions: ['US'],
      countryCode: 'US',
      sponsorship: 'not_offered',
      authorizationRequirement: 'Must be authorized to work in the United States',
      salaryMin: 150_000,
      salaryMax: 190_000,
    }),
    expected: ['BLOCKED'],
  }),

  // 4 ── Nothing to go on ──────────────────────────────────────────────────
  job({
    name: 'missing-information',
    tests: 'a posting with almost no structured content',
    title: 'Software Engineer',
    companyName: 'Acme',
    companyWebsite: null,
    description: 'Join our team. Great opportunity.',
    postedAt: null,
    validThrough: null,
    closed: false,
    applyUrl: null,
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Software Engineer',
      quality: 0.2,
      applicationUrl: null,
    }),
    expected: ['UNKNOWN', 'SKIP', 'CONSIDER'],
  }),

  // 5 ── Authorization unstated ────────────────────────────────────────────
  job({
    name: 'unknown-work-authorization',
    tests: 'authorization is required but the posting does not say where, and does not refuse sponsorship',
    title: 'Senior React Engineer',
    companyName: 'Lantern Health',
    companyWebsite: 'https://lantern.example',
    description:
      'Requirements: work authorization required. 4+ years React and TypeScript.',
    postedAt: days(6),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior React Engineer',
      seniority: 'senior',
      minYears: 4,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
      ],
      requirements: ['Work authorization required', '4+ years React and TypeScript'],
      authorizationRequirement: 'Work authorization required',
      mode: 'remote',
      salaryMin: 105_000,
      salaryMax: 125_000,
    }),
    expected: ['APPLY', 'APPLY_NOW', 'CONSIDER'],
  }),

  // 6 ── Pay below preference, soft ────────────────────────────────────────
  job({
    name: 'salary-below-preference',
    tests: 'pay is well below the stated minimum, but the minimum is not hard',
    title: 'Frontend Engineer',
    companyName: 'Bramble Studio',
    companyWebsite: 'https://bramble.example',
    description: 'Requirements: 3+ years React and TypeScript.',
    postedAt: days(3),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Frontend Engineer',
      seniority: 'mid',
      minYears: 3,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
      ],
      requirements: ['3+ years React and TypeScript'],
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 45_000,
      salaryMax: 55_000,
    }),
    expected: ['CONSIDER', 'APPLY', 'SKIP'],
  }),

  // 7 ── Location mismatch ─────────────────────────────────────────────────
  job({
    name: 'location-mismatch',
    tests: 'onsite in a country the candidate is not in and will not relocate to',
    title: 'Senior Frontend Engineer',
    companyName: 'Alpenglow GmbH',
    companyWebsite: 'https://alpenglow.example',
    description: 'Onsite in Munich. Requirements: 5+ years React.',
    postedAt: days(5),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [{ slug: 'react', name: 'React', requirement: 'required' }],
      requirements: ['Based in Munich, onsite five days a week', '5+ years React'],
      mode: 'onsite',
      city: 'Munich',
      countryCode: 'DE',
      salaryMin: 95_000,
      salaryMax: 115_000,
    }),
    expected: ['BLOCKED', 'SKIP'],
  }),

  // 8 ── Seniority mismatch upward ─────────────────────────────────────────
  job({
    name: 'seniority-stretch',
    tests: 'a principal role against a senior profile',
    title: 'Principal Engineer',
    companyName: 'Vantage Cloud',
    companyWebsite: 'https://vantage.example',
    description: 'Requirements: 10+ years, React, TypeScript, distributed systems.',
    postedAt: days(8),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Principal Engineer',
      seniority: 'principal',
      minYears: 10,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
        { slug: 'system-design', name: 'System Design', requirement: 'required' },
      ],
      requirements: ['10+ years of engineering experience', 'Distributed systems design'],
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 150_000,
      salaryMax: 180_000,
    }),
    expected: ['CONSIDER', 'APPLY', 'SKIP'],
  }),

  // 9 ── Seniority mismatch downward ───────────────────────────────────────
  job({
    name: 'seniority-overqualified',
    tests: 'a junior role against a senior profile — not an automatic rejection',
    title: 'Junior Frontend Developer',
    companyName: 'Pebble Interactive',
    companyWebsite: 'https://pebble.example',
    description: 'Requirements: 1+ years React. Great first role.',
    postedAt: days(2),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Junior Frontend Developer',
      seniority: 'junior',
      minYears: 1,
      skills: [{ slug: 'react', name: 'React', requirement: 'required' }],
      requirements: ['1+ years React'],
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 40_000,
      salaryMax: 50_000,
    }),
    expected: ['CONSIDER', 'SKIP'],
  }),

  // 10 ── Transferable, not direct ─────────────────────────────────────────
  job({
    name: 'transferable-skills',
    tests: 'asks for Lambda; candidate has ECS and S3 — related, not the same',
    title: 'Platform Engineer',
    companyName: 'Thames Data',
    companyWebsite: 'https://thames.example',
    description: 'Requirements: 4+ years, AWS Lambda, Terraform, Docker.',
    postedAt: days(7),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Platform Engineer',
      seniority: 'senior',
      minYears: 4,
      skills: [
        { slug: 'lambda', name: 'AWS Lambda', requirement: 'required' },
        { slug: 'terraform', name: 'Terraform', requirement: 'required' },
        { slug: 'docker', name: 'Docker', requirement: 'required' },
      ],
      requirements: ['4+ years platform engineering', 'AWS Lambda in production'],
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 100_000,
      salaryMax: 125_000,
    }),
    expected: ['APPLY', 'CONSIDER'],
  }),

  // 11 ── Expired ──────────────────────────────────────────────────────────
  job({
    name: 'expired',
    tests: 'a perfect match whose deadline has passed',
    title: 'Senior Frontend Engineer',
    companyName: 'Halcyon Labs',
    companyWebsite: 'https://halcyon.example',
    description: 'Apply by March 1, 2025. Requirements: 5+ years React, TypeScript.',
    postedAt: days(120),
    validThrough: new Date('2025-03-01T00:00:00Z'),
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
      ],
      requirements: ['5+ years React'],
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 120_000,
      salaryMax: 145_000,
    }),
    expected: ['SKIP'],
  }),

  // 12 ── Closing soon ─────────────────────────────────────────────────────
  job({
    name: 'closing-soon',
    tests: 'good fit with a deadline three days out — urgency should show',
    title: 'Senior React Engineer',
    companyName: 'Fernbank',
    companyWebsite: 'https://fernbank.example',
    description: 'Applications close soon. Requirements: 5+ years React, TypeScript, Next.js.',
    postedAt: days(20),
    validThrough: new Date(NOW.getTime() + 3 * 86_400_000),
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior React Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
        { slug: 'nextjs', name: 'Next.js', requirement: 'required' },
      ],
      requirements: ['5+ years React'],
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 115_000,
      salaryMax: 135_000,
      ats: 'ashby',
    }),
    expected: ['APPLY_NOW', 'APPLY'],
  }),

  // 13 ── Language blocker ─────────────────────────────────────────────────
  job({
    name: 'language-unknown',
    tests: 'requires German C1; candidate has no German recorded — UNKNOWN, not FAIL',
    title: 'Senior Frontend Engineer',
    companyName: 'Rheinwerk AG',
    companyWebsite: 'https://rheinwerk.example',
    description: 'German C1 required. Requirements: 5+ years React and TypeScript.',
    postedAt: days(5),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
      ],
      requirements: ['German C1 required', '5+ years React and TypeScript'],
      mode: 'remote',
      remoteRegions: ['DE', 'GB'],
      salaryMin: 100_000,
      salaryMax: 120_000,
    }),
    expected: ['APPLY', 'CONSIDER'],
  }),

  // 14 ── Suspicious ───────────────────────────────────────────────────────
  job({
    name: 'suspicious',
    tests: 'fraud markers — must warn, must not accuse',
    title: 'Remote Data Entry — Immediate Start',
    companyName: null,
    companyWebsite: null,
    description:
      'Work from home opportunity! Earn $4,000 per week with no experience necessary. ' +
      'Contact us on WhatsApp. A registration fee is required to process your application. ' +
      'Please provide your bank account details.',
    postedAt: days(1),
    validThrough: null,
    closed: false,
    applyUrl: null,
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Remote Data Entry',
      quality: 0.15,
      scam: 0.85,
      mode: 'remote',
      remoteWorldwide: true,
      applicationUrl: null,
    }),
    expected: ['CONSIDER', 'SKIP', 'UNKNOWN'],
  }),

  // 15 ── High friction ────────────────────────────────────────────────────
  job({
    name: 'high-friction',
    tests: 'excellent fit behind a long process — friction must rank, not veto',
    title: 'Senior Frontend Engineer',
    companyName: 'Ironwood Financial',
    companyWebsite: 'https://ironwood.example',
    description:
      'Requirements: 5+ years React, TypeScript. A cover letter is required. ' +
      'Please provide references. There is a take-home coding challenge. ' +
      'Please answer the following screening questions.',
    postedAt: days(3),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
      ],
      requirements: ['5+ years React', 'A cover letter is required'],
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 125_000,
      salaryMax: 150_000,
      ats: 'workday',
    }),
    expected: ['APPLY', 'APPLY_NOW', 'CONSIDER'],
  }),

  // 16 ── Poor match ───────────────────────────────────────────────────────
  job({
    name: 'poor-match',
    tests: 'nothing the candidate evidences',
    title: 'Senior Embedded Firmware Engineer',
    companyName: 'Calder Instruments',
    companyWebsite: 'https://calder.example',
    description:
      'Requirements: 6+ years embedded C and C++, RTOS, hardware bring-up, oscilloscope work.',
    postedAt: days(4),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior Embedded Firmware Engineer',
      seniority: 'senior',
      minYears: 6,
      skills: [
        { slug: 'cpp', name: 'C++', requirement: 'required' },
        { slug: 'rtos', name: 'RTOS', requirement: 'required' },
      ],
      requirements: ['6+ years embedded C and C++', 'RTOS experience', 'Hardware bring-up'],
      mode: 'onsite',
      city: 'Cambridge',
      countryCode: 'GB',
      salaryMin: 90_000,
      salaryMax: 110_000,
    }),
    expected: ['SKIP', 'CONSIDER'],
  }),

  // 17 ── Excluded technology ──────────────────────────────────────────────
  job({
    name: 'excluded-technology',
    tests: 'requires PHP, which the candidate explicitly excluded — CONFLICT',
    title: 'Senior Backend Engineer',
    companyName: 'Marlow Retail',
    companyWebsite: 'https://marlow.example',
    description: 'Requirements: 5+ years PHP and Laravel.',
    postedAt: days(6),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior Backend Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [
        { slug: 'php', name: 'PHP', requirement: 'required' },
        { slug: 'laravel', name: 'Laravel', requirement: 'required' },
      ],
      requirements: ['5+ years PHP', 'Laravel experience'],
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 95_000,
      salaryMax: 115_000,
    }),
    expected: ['SKIP', 'CONSIDER'],
  }),

  // 18 ── Total meets, relevant does not ───────────────────────────────────
  job({
    name: 'relevant-experience-shortfall',
    tests: 'seven years total, but the posting wants six years of a skill with two',
    title: 'Senior GraphQL Platform Engineer',
    companyName: 'Beacon API',
    companyWebsite: 'https://beacon.example',
    description: 'Requirements: 6+ years of GraphQL schema design at scale.',
    postedAt: days(9),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior GraphQL Platform Engineer',
      seniority: 'senior',
      minYears: 6,
      skills: [{ slug: 'graphql', name: 'GraphQL', requirement: 'required' }],
      requirements: ['6+ years of GraphQL schema design at scale'],
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 110_000,
      salaryMax: 130_000,
    }),
    expected: ['CONSIDER', 'APPLY'],
  }),

  // 19 ── Widely syndicated, junior, worldwide: high competition ───────────
  job({
    name: 'high-competition',
    tests: 'low bar, worldwide remote, many sources — competition should read HIGH',
    title: 'Frontend Developer',
    companyName: 'Skylark Media',
    companyWebsite: 'https://skylark.example',
    description: 'Requirements: 2+ years React. Remote worldwide.',
    postedAt: days(12),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 6,
    enrichment: enrichment({
      title: 'Frontend Developer',
      seniority: 'junior',
      minYears: 2,
      skills: [{ slug: 'react', name: 'React', requirement: 'required' }],
      requirements: ['2+ years React'],
      mode: 'remote',
      remoteWorldwide: true,
      salaryMin: 60_000,
      salaryMax: 75_000,
    }),
    expected: ['CONSIDER', 'SKIP'],
  }),

  // 20 ── Narrow senior role: low competition ──────────────────────────────
  job({
    name: 'low-competition',
    tests: 'high bar, long requirement list, staff level — competition should read LOW',
    title: 'Staff Frontend Architect',
    companyName: 'Quarry Engineering',
    companyWebsite: 'https://quarry.example',
    description:
      'Requirements: 9+ years, React, TypeScript, Next.js, GraphQL, Node.js, PostgreSQL, ' +
      'Docker, AWS, design systems, performance optimisation.',
    postedAt: days(15),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Staff Frontend Architect',
      seniority: 'staff',
      minYears: 9,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
        { slug: 'nextjs', name: 'Next.js', requirement: 'required' },
        { slug: 'graphql', name: 'GraphQL', requirement: 'required' },
        { slug: 'nodejs', name: 'Node.js', requirement: 'required' },
        { slug: 'postgresql', name: 'PostgreSQL', requirement: 'required' },
        { slug: 'docker', name: 'Docker', requirement: 'required' },
        { slug: 'aws', name: 'AWS', requirement: 'required' },
        { slug: 'performance', name: 'Performance Optimisation', requirement: 'required' },
      ],
      requirements: ['9+ years of frontend engineering', 'Design system ownership'],
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 140_000,
      salaryMax: 175_000,
    }),
    expected: ['APPLY', 'CONSIDER'],
  }),

  // 21 ── Hybrid over the candidate's office-day limit ─────────────────────
  job({
    name: 'hybrid-too-many-office-days',
    tests: 'four office days against a stated maximum of two',
    title: 'Senior Frontend Engineer',
    companyName: 'Cheapside Bank',
    companyWebsite: 'https://cheapside.example',
    description: 'Hybrid, four days a week in our London office. Requirements: 5+ years React.',
    postedAt: days(3),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [{ slug: 'react', name: 'React', requirement: 'required' }],
      requirements: ['5+ years React', 'Hybrid: four days a week in the London office'],
      mode: 'hybrid',
      officeDays: 4,
      city: 'London',
      countryCode: 'GB',
      salaryMin: 110_000,
      salaryMax: 130_000,
    }),
    expected: ['BLOCKED', 'SKIP'],
  }),

  // 22 ── Degree requirement the candidate meets ───────────────────────────
  job({
    name: 'degree-required-met',
    tests: 'a bachelor requirement against a recorded bachelor',
    title: 'Senior Frontend Engineer',
    companyName: 'Whitfield Group',
    companyWebsite: 'https://whitfield.example',
    description: "Requirements: Bachelor's degree in Computer Science. 5+ years React.",
    postedAt: days(2),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
      ],
      requirements: ["Bachelor's degree in Computer Science", '5+ years React'],
      educationLevel: 'bachelors',
      educationRequirement: 'required',
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 115_000,
      salaryMax: 135_000,
      ats: 'greenhouse',
    }),
    expected: ['APPLY_NOW', 'APPLY'],
  }),

  // 23 ── Doctorate the candidate does not have ────────────────────────────
  job({
    name: 'degree-required-unmet',
    tests: 'a doctorate requirement against a recorded bachelor — likely, not hard',
    title: 'Research Engineer',
    companyName: 'Institute for Applied Systems',
    companyWebsite: 'https://ias.example',
    description: 'Requirements: PhD in Computer Science or related field. 5+ years research.',
    postedAt: days(10),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Research Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [{ slug: 'python', name: 'Python', requirement: 'required' }],
      requirements: ['PhD in Computer Science or a related field', '5+ years of research experience'],
      educationLevel: 'doctorate',
      educationRequirement: 'required',
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 95_000,
      salaryMax: 115_000,
    }),
    expected: ['CONSIDER', 'SKIP'],
  }),

  // 24 ── Salary silent ────────────────────────────────────────────────────
  job({
    name: 'salary-unstated',
    tests: 'no salary at all — must be unknown, never below_preference',
    title: 'Senior Frontend Engineer',
    companyName: 'Ashgrove Digital',
    companyWebsite: 'https://ashgrove.example',
    description: 'Requirements: 5+ years React, TypeScript, Next.js.',
    postedAt: days(5),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
        { slug: 'nextjs', name: 'Next.js', requirement: 'required' },
      ],
      requirements: ['5+ years React'],
      mode: 'remote',
      remoteRegions: ['GB'],
      ats: 'lever',
    }),
    expected: ['APPLY', 'APPLY_NOW'],
  }),

  // 25 ── Old but open ─────────────────────────────────────────────────────
  job({
    name: 'ageing-but-open',
    tests: 'posted 60 days ago and open until filled — must not be discarded',
    title: 'Senior Frontend Engineer',
    companyName: 'Longacre Systems',
    companyWebsite: 'https://longacre.example',
    description: 'Open until filled. Requirements: 5+ years React and TypeScript.',
    postedAt: days(60),
    validThrough: null,
    closed: false,
    applyUrl: 'https://example.invalid/apply',
    sourceCount: 1,
    enrichment: enrichment({
      title: 'Senior Frontend Engineer',
      seniority: 'senior',
      minYears: 5,
      skills: [
        { slug: 'react', name: 'React', requirement: 'required' },
        { slug: 'typescript', name: 'TypeScript', requirement: 'required' },
      ],
      requirements: ['5+ years React and TypeScript'],
      mode: 'remote',
      remoteRegions: ['GB'],
      salaryMin: 105_000,
      salaryMax: 125_000,
    }),
    expected: ['APPLY', 'CONSIDER'],
  }),
];

/** The candidate's documents, for resume-selection fixtures. */
export function documents() {
  const base = {
    uploadedAt: new Date('2025-01-01'),
    education: CANDIDATE.education,
    certifications: [],
    projects: [],
    achievements: [],
    languages: CANDIDATE.languages,
    summary: null,
  };

  return [
    {
      ...base,
      documentId: uuid(90),
      label: 'Frontend CV',
      targetRole: 'Frontend engineering',
      experience: CANDIDATE.experience,
      skills: CANDIDATE.skills.filter((entry) =>
        ['react', 'typescript', 'nextjs', 'javascript', 'testing', 'graphql'].includes(entry.slug),
      ),
    },
    {
      ...base,
      documentId: uuid(91),
      label: 'Cloud CV',
      targetRole: 'Platform engineering',
      experience: CANDIDATE.experience.slice(0, 1),
      skills: CANDIDATE.skills.filter((entry) =>
        ['aws', 's3', 'ecs', 'docker', 'terraform', 'nodejs', 'postgresql'].includes(entry.slug),
      ),
    },
  ];
}
