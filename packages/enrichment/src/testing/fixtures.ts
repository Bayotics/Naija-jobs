import type { EnrichmentInput } from '../pipeline/enrichment-pipeline';

/**
 * Realistic messy job fixtures.
 *
 * Written from the shapes actually seen in the live sources this system reads,
 * including the awkward ones: postings with no salary, conflicting seniority
 * signals, four different visa phrasings, and an advance-fee scam of the kind
 * common on open boards.
 *
 * These drive the deterministic tests. AI extraction is tested separately with
 * a stub provider, so a failing model can never be mistaken for a failing
 * extractor.
 */

function base(overrides: Partial<EnrichmentInput> & { jobId: string; title: string; companyName: string; sourceUrl: string }): EnrichmentInput {
  return {
    companyWebsite: null,
    description: null,
    descriptionHtml: null,
    locationText: null,
    remoteFlag: null,
    applyUrl: null,
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    tags: [],
    ...overrides,
  };
}

/** 1. A well-formed posting with every section present. */
export const normalJob = base({
  jobId: '00000000-0000-4000-8000-000000000001',
  title: 'Senior Frontend Engineer',
  companyName: 'Acme Corp',
  companyWebsite: 'https://acme.example.com',
  sourceUrl: 'https://boards.greenhouse.io/acme/jobs/123',
  locationText: 'Berlin, Germany',
  tags: ['react', 'typescript'],
  description: `About the role
We are looking for a Senior Frontend Engineer to join our platform team in Berlin.

Responsibilities
- Build and maintain our customer-facing React application
- Mentor junior engineers and review code
- Own the architecture of the frontend platform

Requirements
- 5+ years of professional experience in frontend development
- Strong proficiency in React and TypeScript
- Experience with REST APIs and modern CI/CD practices
- Bachelor's degree in Computer Science or equivalent experience

Nice to have
- Familiarity with Next.js
- Exposure to AWS

Benefits
- Competitive salary and equity
- 30 days holiday
- Relocation assistance is available for international candidates`,
});

/** 2. Almost no content. */
export const veryShortJob = base({
  jobId: '00000000-0000-4000-8000-000000000002',
  title: 'Developer',
  companyName: 'Startup',
  sourceUrl: 'https://example.com/jobs/2',
  description: 'We need a developer. Apply now.',
});

/** 3. Long, boilerplate-heavy, with site furniture to be cleaned. */
export const longJob = base({
  jobId: '00000000-0000-4000-8000-000000000003',
  title: 'Staff Backend Engineer, Payments',
  companyName: 'FinCo',
  sourceUrl: 'https://jobs.lever.co/finco/abc-def',
  locationText: 'London, UK',
  description: `We use cookies
This website uses cookies to improve your experience.
Home
About us
Search jobs

About the role
FinCo is building the payments infrastructure for modern fintech. ${'We process billions in volume. '.repeat(30)}

Responsibilities
- Design and operate distributed payment services in Go and Java
- Partner with product to define the technical roadmap
- Lead a team of engineers on high-traffic systems

Requirements
- At least 8 years of experience building backend systems
- Deep knowledge of PostgreSQL and Kafka
- Experience with Kubernetes and Terraform

What we offer
- Salary range: £110,000 - £140,000 per year
- Share options

FinCo is an equal opportunity employer and we are committed to diversity and inclusion in the workplace.

Similar jobs
- Backend Engineer at OtherCo
- Platform Engineer at ThirdCo
Follow us on LinkedIn
© 2026 FinCo. All rights reserved.
Privacy policy`,
});

/** 4. Remote, unrestricted. */
export const remoteWorldwideJob = base({
  jobId: '00000000-0000-4000-8000-000000000004',
  title: 'Backend Engineer',
  companyName: 'Distributed Inc',
  sourceUrl: 'https://example.com/jobs/4',
  locationText: 'Remote - Worldwide',
  remoteFlag: true,
  description: 'Fully remote position, work from anywhere in the world. We are a fully distributed team. 3+ years experience with Python and PostgreSQL required.',
});

/** 5. Hybrid with a stated office cadence. */
export const hybridJob = base({
  jobId: '00000000-0000-4000-8000-000000000005',
  title: 'Data Engineer',
  companyName: 'DataCo',
  sourceUrl: 'https://example.com/jobs/5',
  locationText: 'Amsterdam, Netherlands',
  description: 'Hybrid role: 2 days per week in office in Amsterdam. Requirements: 4 years of experience with Spark, Airflow and SQL.',
});

/** 6. Explicitly on-site. */
export const onsiteJob = base({
  jobId: '00000000-0000-4000-8000-000000000006',
  title: 'IT Support Technician',
  companyName: 'LocalBiz',
  sourceUrl: 'https://example.com/jobs/6',
  locationText: 'Lagos, Nigeria',
  description: 'This is an on-site role based in our Lagos office. No remote work available. Must be located within commutable distance to Victoria Island.',
});

/** 7. Salary as a clean annual range. */
export const salaryRangeJob = base({
  jobId: '00000000-0000-4000-8000-000000000007',
  title: 'Software Engineer',
  companyName: 'PayCo',
  sourceUrl: 'https://example.com/jobs/7',
  salaryText: '$120,000 - $150,000 per year',
  description: 'Salary: $120,000 - $150,000 per year plus equity and an annual bonus.',
});

/** 8. Compensation mentioned but never quantified. */
export const salaryMissingJob = base({
  jobId: '00000000-0000-4000-8000-000000000008',
  title: 'Product Manager',
  companyName: 'VagueCo',
  sourceUrl: 'https://example.com/jobs/8',
  description: 'We offer a competitive salary commensurate with experience, plus benefits.',
});

/** 9. Several currencies and periods. */
export const multiCurrencyJobs = [
  base({
    jobId: '00000000-0000-4000-8000-000000000009',
    title: 'Contract Developer',
    companyName: 'UKCo',
    sourceUrl: 'https://example.com/jobs/9a',
    salaryText: '£500/day',
    description: 'Day rate of £500/day, outside IR35, 6 month contract.',
  }),
  base({
    jobId: '00000000-0000-4000-8000-00000000000a',
    title: 'Accountant',
    companyName: 'NaijaCo',
    sourceUrl: 'https://example.com/jobs/9b',
    locationText: 'Lagos, Nigeria',
    salaryText: 'N300,000 monthly',
    description: 'Salary: N300,000 monthly. Based in Lagos.',
  }),
  base({
    jobId: '00000000-0000-4000-8000-00000000000b',
    title: 'Engineer',
    companyName: 'EuroCo',
    sourceUrl: 'https://example.com/jobs/9c',
    salaryText: '€70,000–€90,000',
    description: 'Compensation: €70,000–€90,000 per year depending on experience.',
  }),
];

/** 10. Sponsorship explicitly offered. */
export const visaOfferedJob = base({
  jobId: '00000000-0000-4000-8000-00000000000c',
  title: 'Machine Learning Engineer',
  companyName: 'GlobalAI',
  sourceUrl: 'https://example.com/jobs/10',
  locationText: 'Berlin, Germany',
  description: 'We can offer visa sponsorship and relocation assistance for international candidates. 4+ years of experience with PyTorch required.',
});

/** 11. Sponsorship explicitly refused. */
export const visaNotOfferedJob = base({
  jobId: '00000000-0000-4000-8000-00000000000d',
  title: 'Security Engineer',
  companyName: 'USDefense',
  sourceUrl: 'https://example.com/jobs/11',
  locationText: 'Washington, USA',
  description: 'Applicants must be authorized to work in the United States without visa sponsorship. US citizenship required. Active Secret security clearance required.',
});

/** 12. Sponsorship never mentioned — the common case. */
export const visaUnspecifiedJob = base({
  jobId: '00000000-0000-4000-8000-00000000000e',
  title: 'Frontend Developer',
  companyName: 'QuietCo',
  sourceUrl: 'https://example.com/jobs/12',
  description: 'Build user interfaces with React and TypeScript. 3 years of experience required.',
});

/** 13. Title says senior, body says one year. */
export const conflictingSeniorityJob = base({
  jobId: '00000000-0000-4000-8000-00000000000f',
  title: 'Senior Software Engineer',
  companyName: 'ConfusedCo',
  sourceUrl: 'https://example.com/jobs/13',
  description: 'We are looking for a senior engineer. Requirements: 1 year of experience with JavaScript. Entry level candidates welcome.',
});

/** 14. Several locations in one field. */
export const multiLocationJob = base({
  jobId: '00000000-0000-4000-8000-000000000010',
  title: 'Solutions Architect',
  companyName: 'MultiCo',
  sourceUrl: 'https://example.com/jobs/14',
  locationText: 'Americas, Europe, Israel',
  remoteFlag: true,
  description: 'Remote role open to candidates in the Americas and Europe.',
});

/** 15. Advance-fee scam, the pattern common on open boards. */
export const scamJob = base({
  jobId: '00000000-0000-4000-8000-000000000011',
  title: 'URGENT!!! Work From Home Data Entry - Earn $5000 weekly',
  companyName: 'Quick Cash Ltd',
  sourceUrl: 'https://example.com/jobs/15',
  description: `URGENT hiring! No experience required! Earn $5000 per week working from home.
Apply within 24 hours - limited slots available!
A registration fee of $50 is required to process your application.
Send your bank account details and a passport copy to quickcash.hr2026@gmail.com
Contact us on WhatsApp +1234567890 for immediate start today.
Payment made in bitcoin only.`,
});

/** 16. Byte-identical repost, for idempotence checks. */
export const duplicateJob = base({
  ...normalJob,
  jobId: '00000000-0000-4000-8000-000000000012',
});

/** 17. Board listing that links out to an ATS. */
export const atsApplicationJob = base({
  jobId: '00000000-0000-4000-8000-000000000013',
  title: 'Platform Engineer',
  companyName: 'Widgets Inc',
  companyWebsite: 'https://widgets.example.com',
  sourceUrl: 'https://remotive.com/remote-jobs/devops/platform-engineer-12345',
  applyUrl: 'https://boards.greenhouse.io/widgets/jobs/4567',
  description: 'Join our platform team. Requirements: Kubernetes, Terraform and AWS. Apply at https://boards.greenhouse.io/widgets/jobs/4567',
});

/** 18. Social post: no company field, informal prose. */
export const socialPostJob = base({
  jobId: '00000000-0000-4000-8000-000000000014',
  title: '[HIRING] Full Stack Dev for early stage startup',
  companyName: 'u/founder_guy',
  sourceUrl: 'https://www.reddit.com/r/forhire/comments/abc123/hiring_full_stack',
  description: `Hey everyone! We're a small startup and looking for a full stack developer.
Stack is React, Node.js and Postgres. Modern React ecosystem experience preferred.
Pay is $60-80/hour depending on experience. Remote, US only.
DM me if interested.`,
});

/** 19. Nigerian board: employer in the title, no explicit country. */
export const nigerianJob = base({
  jobId: '00000000-0000-4000-8000-000000000015',
  title: 'Software Developer at Interswitch Group',
  companyName: 'Interswitch Group',
  sourceUrl: 'https://www.hotnigerianjobs.com/hotjobs/999/software-developer.html',
  locationText: 'Nigeria',
  description: `Interswitch Group is recruiting a Software Developer.

Requirements
- B.Sc in Computer Science or related field
- Minimum of 3 years experience in software development
- Proficiency in Java and SQL
- NYSC discharge certificate

Method of Application
Interested candidates should send their CV to careers@interswitchng.com`,
});

/** 20. International posting with a timezone constraint. */
export const internationalJob = base({
  jobId: '00000000-0000-4000-8000-000000000016',
  title: 'Site Reliability Engineer (m/w/d)',
  companyName: 'Zalando SE',
  sourceUrl: 'https://example.com/jobs/20',
  locationText: 'Remote - EU',
  remoteFlag: true,
  description: `Remote within the EU, must overlap with CET business hours.

Requirements
- 6+ years operating production systems
- Expert knowledge of Kubernetes and Linux
- Experience with Terraform is required

Preferred
- Go programming experience is a plus
- Master's degree preferred

We are happy to offer visa sponsorship and relocation support.`,
});

export const ALL_FIXTURES: EnrichmentInput[] = [
  normalJob,
  veryShortJob,
  longJob,
  remoteWorldwideJob,
  hybridJob,
  onsiteJob,
  salaryRangeJob,
  salaryMissingJob,
  ...multiCurrencyJobs,
  visaOfferedJob,
  visaNotOfferedJob,
  visaUnspecifiedJob,
  conflictingSeniorityJob,
  multiLocationJob,
  scamJob,
  duplicateJob,
  atsApplicationJob,
  socialPostJob,
  nigerianJob,
  internationalJob,
];
