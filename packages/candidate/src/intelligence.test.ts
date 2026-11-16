import { describe, expect, it } from 'vitest';
import {
  candidateIntelligenceSchema,
  candidateSkillFactSchema,
  dateRangeSchema,
  educationRecordSchema,
  evidenceItemSchema,
  experienceEntrySchema,
  fieldOverrideSchema,
  partialDateSchema,
  type CandidateIntelligence,
  type CandidateSkillFact,
  type EvidenceItem,
  type ExperienceEntry,
} from '@job-intel/contracts';
import { SkillGraph } from './skills/skill-graph';
import {
  analyseGaps,
  buildRequirementMatrix,
  checkHardRequirements,
  type ParsedRequirement,
} from './intelligence/requirement-matrix';
import {
  applyOverrides,
  buildProfile,
  computeQuality,
  detectConflicts,
  type DocumentExtraction,
} from './intelligence/profile-builder';
import {
  buildJobCandidateView,
  compareResumes,
  generateProfileSummary,
  scoreResumeFit,
} from './intelligence/job-view';

const NOW = new Date('2025-06-15T00:00:00Z');
const CANDIDATE = '11111111-2222-4333-8444-555555555555';
const JOB = '99999999-8888-4777-8666-555555555555';
const DOC_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const DOC_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const OVERRIDE_1 = 'cccccccc-3333-4333-8333-333333333333';
const OVERRIDE_2 = 'dddddddd-4444-4444-8444-444444444444';

const emptyRange = () =>
  dateRangeSchema.parse({
    start: partialDateSchema.parse({}),
    end: partialDateSchema.parse({}),
  });

function evidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return evidenceItemSchema.parse({
    id: overrides.id ?? 'ev1',
    source: overrides.source ?? 'employment_responsibility',
    documentId: overrides.documentId ?? null,
    context: overrides.context ?? 'Acme — Engineer',
    excerpt: overrides.excerpt ?? 'Built the thing in React',
    confidence: overrides.confidence ?? 0.85,
    observedFrom: overrides.observedFrom ?? new Date('2021-01-01'),
    observedTo: overrides.observedTo ?? new Date('2024-01-01'),
    extractedBy: null,
    extractedAt: NOW,
  });
}

function skill(slug: string, overrides: Partial<CandidateSkillFact> = {}): CandidateSkillFact {
  return candidateSkillFactSchema.parse({
    slug,
    name: overrides.name ?? slug,
    category: overrides.category ?? 'framework',
    proficiency: overrides.proficiency ?? 'PROFICIENT',
    proficiencyConfidence: overrides.proficiencyConfidence ?? 0.7,
    proficiencyRationale: overrides.proficiencyRationale ?? 'Evidence suggests proficient.',
    totalMonths: overrides.totalMonths ?? 36,
    lastEvidencedAt: overrides.lastEvidencedAt ?? new Date('2025-01-01'),
    firstEvidencedAt: overrides.firstEvidencedAt ?? new Date('2021-01-01'),
    evidence: overrides.evidence ?? [evidence({ id: `ev-${slug}` })],
    strongestSource: overrides.strongestSource ?? 'employment_responsibility',
    userVerified: overrides.userVerified ?? false,
  });
}

function role(
  company: string,
  title: string,
  startYear: number,
  endYear: number | null,
  overrides: Partial<ExperienceEntry> = {},
): ExperienceEntry {
  return experienceEntrySchema.parse({
    id: `${company}-${startYear}`,
    company,
    title,
    location: 'London',
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
    description: overrides.description ?? null,
    responsibilities: overrides.responsibilities ?? ['Built services'],
    achievements: overrides.achievements ?? [],
    technologies: overrides.technologies ?? ['react'],
    seniorityIndicators: overrides.seniorityIndicators ?? [],
    sourceText: `${company} ${title}`,
    confidence: overrides.confidence ?? 0.9,
  });
}

function profileWith(overrides: Partial<CandidateIntelligence> = {}): CandidateIntelligence {
  return candidateIntelligenceSchema.parse({
    candidateId: CANDIDATE,
    profileVersion: 1,
    skills: overrides.skills ?? [skill('react', { name: 'React' })],
    experience: overrides.experience ?? [role('Acme', 'Senior Engineer', 2021, null)],
    education: overrides.education ?? [],
    certifications: overrides.certifications ?? [],
    projects: overrides.projects ?? [],
    achievements: overrides.achievements ?? [],
    languages: overrides.languages ?? [],
    seniority: overrides.seniority ?? { estimatedLevel: 'senior', confidence: 0.7 },
    trajectory: overrides.trajectory ?? { totalExperienceMonths: 60 },
    quality: overrides.quality ?? null,
    openConflicts: overrides.openConflicts ?? 0,
    computedAt: NOW,
  });
}

const requirement = (
  text: string,
  overrides: Partial<ParsedRequirement> = {},
): ParsedRequirement => ({
  text,
  kind: overrides.kind ?? 'skill',
  slug: overrides.slug ?? null,
  required: overrides.required ?? true,
  minYears: overrides.minYears,
  educationLevel: overrides.educationLevel,
});

// ── Requirement matrix ──────────────────────────────────────────────────────

describe('requirement matrix', () => {
  it('records direct evidence with its origin', () => {
    const matrix = buildRequirementMatrix({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith(),
      requirements: [requirement('React', { slug: 'react' })],
      now: NOW,
    });

    const row = matrix.rows[0]!;
    expect(row.evidenceKind).toBe('direct');
    expect(row.support).toBe('SUPPORTED');
    expect(row.evidence.length).toBeGreaterThan(0);
    expect(matrix.directMatches).toBe(1);
  });

  it('treats absence of evidence as UNKNOWN, never as a failure', () => {
    const matrix = buildRequirementMatrix({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith(),
      requirements: [requirement('Haskell', { slug: 'haskell' })],
      now: NOW,
    });

    const row = matrix.rows[0]!;
    expect(row.support).toBe('UNKNOWN');
    expect(row.evidenceKind).toBe('insufficient_evidence');
    expect(row.explanation).toMatch(/not evidence the candidate lacks it/i);
    expect(matrix.unknowns).toBe(1);
    expect(matrix.missing).toBe(0);
  });

  it('distinguishes missing from insufficient evidence', () => {
    const matrix = buildRequirementMatrix({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith({ trajectory: { totalExperienceMonths: 24 } as never }),
      requirements: [
        requirement('10+ years of experience', { kind: 'experience_years', minYears: 10 }),
        requirement('Kubernetes', { slug: 'kubernetes' }),
      ],
      now: NOW,
    });

    // Dates establish a real shortfall; a silent profile does not.
    expect(matrix.rows[0]!.support).toBe('NOT_SUPPORTED');
    expect(matrix.rows[0]!.evidenceKind).toBe('missing');
    expect(matrix.rows[1]!.support).toBe('UNKNOWN');
  });

  it('credits transferable skills without calling them direct', () => {
    const matrix = buildRequirementMatrix({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith({ skills: [skill('nextjs', { name: 'Next.js' })] }),
      requirements: [requirement('React', { slug: 'react' })],
      graph: new SkillGraph(),
      now: NOW,
    });

    const row = matrix.rows[0]!;
    expect(row.evidenceKind).toBe('transferable');
    expect(row.support).toBe('SUPPORTED');
    expect(row.transferable[0]!.fromSlug).toBe('nextjs');
    // Transfer is never equivalence.
    expect(row.transferable[0]!.strength).toBeLessThan(1);
    expect(row.explanation).toMatch(/not the same as direct experience/i);
  });

  it('scores a stale skill below a current one', () => {
    const stale = buildRequirementMatrix({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith({
        skills: [skill('react', { lastEvidencedAt: new Date('2015-01-01') })],
      }),
      requirements: [requirement('React', { slug: 'react' })],
      now: NOW,
    });

    const current = buildRequirementMatrix({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith(),
      requirements: [requirement('React', { slug: 'react' })],
      now: NOW,
    });

    expect(stale.rows[0]!.strength).toBeLessThan(current.rows[0]!.strength);
  });

  it('refuses to decide eligibility questions from a resume', () => {
    const matrix = buildRequirementMatrix({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith(),
      requirements: [
        requirement('Must have the right to work in the US', { kind: 'work_authorization' }),
      ],
      now: NOW,
    });

    expect(matrix.rows[0]!.support).toBe('UNKNOWN');
    expect(matrix.rows[0]!.explanation).toMatch(/stated constraints, not inferred/i);
  });

  it('never fabricates certification verification', () => {
    const matrix = buildRequirementMatrix({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith({
        certifications: [
          {
            id: 'c1',
            name: 'AWS Certified Solutions Architect',
            issuer: 'Amazon',
            issued: partialDateSchema.parse({ year: 2022 }),
            expires: partialDateSchema.parse({}),
            credentialId: null,
            credentialUrl: null,
            verification: 'UNVERIFIED',
            sourceText: null,
            confidence: 0.8,
            userVerified: false,
          },
        ] as never,
      }),
      requirements: [
        requirement('AWS Certified Solutions Architect', { kind: 'certification', required: false }),
      ],
      now: NOW,
    });

    expect(matrix.rows[0]!.support).toBe('SUPPORTED');
    expect(matrix.rows[0]!.explanation).toMatch(/has not verified this with the issuer/i);
  });

  it('weights optional requirements below required ones', () => {
    const allRequired = buildRequirementMatrix({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith(),
      requirements: [requirement('React', { slug: 'react' }), requirement('Rust', { slug: 'rust' })],
      now: NOW,
    });

    const rustOptional = buildRequirementMatrix({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith(),
      requirements: [
        requirement('React', { slug: 'react' }),
        requirement('Rust', { slug: 'rust', required: false }),
      ],
      now: NOW,
    });

    expect(rustOptional.coverageScore).toBeGreaterThan(allRequired.coverageScore);
  });
});

// ── Gap analysis ────────────────────────────────────────────────────────────

describe('gap analysis', () => {
  it('separates real gaps from unknowns and phrases unknowns as questions', () => {
    const matrix = buildRequirementMatrix({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith({ trajectory: { totalExperienceMonths: 12 } as never }),
      requirements: [
        requirement('5+ years of experience', { kind: 'experience_years', minYears: 5 }),
        requirement('Elixir', { slug: 'elixir' }),
      ],
      now: NOW,
    });

    const gaps = analyseGaps(matrix);
    expect(gaps.hardGaps).toHaveLength(1);
    expect(gaps.unknowns).toHaveLength(1);
    expect(gaps.unknowns[0]!.question).toMatch(/\?/);
    expect(gaps.meetsAllRequired).toBe(false);
  });

  it('reports the tri-state per hard requirement without collapsing UNKNOWN', () => {
    const matrix = buildRequirementMatrix({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith(),
      requirements: [
        requirement('React', { slug: 'react' }),
        requirement('Scala', { slug: 'scala' }),
      ],
      now: NOW,
    });

    const states = checkHardRequirements(matrix).map((entry) => entry.support);
    expect(states).toEqual(['SUPPORTED', 'UNKNOWN']);
  });
});

// ── Profile assembly ────────────────────────────────────────────────────────

function extraction(
  documentId: string,
  label: string,
  overrides: Partial<DocumentExtraction> = {},
): DocumentExtraction {
  return {
    documentId,
    label,
    uploadedAt: overrides.uploadedAt ?? new Date('2025-01-01'),
    targetRole: overrides.targetRole ?? null,
    experience: overrides.experience ?? [role('Acme', 'Engineer', 2021, null)],
    education: overrides.education ?? [],
    certifications: overrides.certifications ?? [],
    projects: overrides.projects ?? [],
    achievements: overrides.achievements ?? [],
    languages: overrides.languages ?? [],
    skills: overrides.skills ?? [skill('react')],
    summary: overrides.summary ?? null,
  };
}

describe('profile assembly', () => {
  it('merges the same role from two documents into one', () => {
    const profile = buildProfile({
      candidateId: CANDIDATE,
      profileVersion: 1,
      documents: [
        extraction(DOC_A, 'Frontend CV'),
        extraction(DOC_B, 'Cloud CV', {
          experience: [role('Acme', 'Engineer', 2021, null, { responsibilities: ['A', 'B', 'C'] })],
        }),
      ],
      now: NOW,
    });

    expect(profile.experience).toHaveLength(1);
    // The fuller description wins.
    expect(profile.experience[0]!.responsibilities).toHaveLength(3);
  });

  it('unions evidence but does not add durations across documents', () => {
    const profile = buildProfile({
      candidateId: CANDIDATE,
      profileVersion: 1,
      documents: [
        extraction(DOC_A, 'A', {
          skills: [skill('react', { totalMonths: 36, evidence: [evidence({ id: 'a' })] })],
        }),
        extraction(DOC_B, 'B', {
          skills: [skill('react', { totalMonths: 30, evidence: [evidence({ id: 'b' })] })],
        }),
      ],
      now: NOW,
    });

    const react = profile.skills.find((fact) => fact.slug === 'react')!;
    // One career: the longer observation, not the sum.
    expect(react.totalMonths).toBe(36);
    expect(react.evidence).toHaveLength(2);
  });

  it('keeps the duration and its explanation from the same document', () => {
    const profile = buildProfile({
      candidateId: CANDIDATE,
      profileVersion: 1,
      documents: [
        extraction(DOC_A, 'Long', {
          skills: [
            skill('python', {
              totalMonths: 89,
              proficiencyConfidence: 0.4,
              proficiencyRationale: 'Evidence suggests advanced: about 7 years of evidenced use.',
            }),
          ],
        }),
        extraction(DOC_B, 'Short', {
          skills: [
            skill('python', {
              totalMonths: 36,
              proficiencyConfidence: 0.9,
              proficiencyRationale: 'Evidence suggests working: about 3 years of evidenced use.',
            }),
          ],
        }),
      ],
      now: NOW,
    });

    const python = profile.skills.find((fact) => fact.slug === 'python')!;
    expect(python.totalMonths).toBe(89);
    // The sentence must describe the number shown next to it, not a different
    // document's shorter estimate that happened to score higher confidence.
    expect(python.proficiencyRationale).toMatch(/7 years/);
  });

  it('recomputes the strongest source across the merged evidence', () => {
    const profile = buildProfile({
      candidateId: CANDIDATE,
      profileVersion: 1,
      documents: [
        extraction(DOC_A, 'Listed only', {
          skills: [
            skill('postgresql', {
              strongestSource: 'resume_skill_section',
              evidence: [evidence({ id: 'listed', source: 'resume_skill_section', confidence: 0.5 })],
            }),
          ],
        }),
        extraction(DOC_B, 'Evidenced', {
          skills: [
            skill('postgresql', {
              strongestSource: 'employment_responsibility',
              evidence: [evidence({ id: 'role', source: 'employment_responsibility' })],
            }),
          ],
        }),
      ],
      now: NOW,
    });

    const postgres = profile.skills.find((fact) => fact.slug === 'postgresql')!;
    // Inheriting the first document's label described the strongest evidence in
    // the weakest terms available.
    expect(postgres.strongestSource).toBe('employment_responsibility');
  });

  it('detects conflicting dates without resolving them', () => {
    const conflicts = detectConflicts(
      CANDIDATE,
      [
        extraction(DOC_A, 'CV one', { experience: [role('Acme', 'Engineer', 2021, 2023)] }),
        extraction(DOC_B, 'CV two', { experience: [role('Acme', 'Engineer', 2021, 2024)] }),
      ],
      NOW,
    );

    const dates = conflicts.find((conflict) => conflict.kind === 'employment_dates')!;
    expect(dates.positions).toHaveLength(2);
    expect(dates.status).toBe('open');
    expect(dates.resolvedValue).toBeNull();
    expect(dates.detail).toMatch(/Which is correct/i);
  });

  it('detects conflicting titles for the same role', () => {
    const conflicts = detectConflicts(
      CANDIDATE,
      [
        extraction(DOC_A, 'CV one', { experience: [role('Acme', 'Engineer', 2021, 2023)] }),
        extraction(DOC_B, 'CV two', { experience: [role('Acme', 'Lead Engineer', 2021, 2023)] }),
      ],
      NOW,
    );

    expect(conflicts.some((conflict) => conflict.kind === 'job_title')).toBe(true);
  });

  it('does not raise a conflict from a single document', () => {
    expect(detectConflicts(CANDIDATE, [extraction(DOC_A, 'Only CV')], NOW)).toHaveLength(0);
  });

  it('ignores a skill-duration difference below a year', () => {
    const conflicts = detectConflicts(
      CANDIDATE,
      [
        extraction(DOC_A, 'A', { skills: [skill('react', { totalMonths: 36 })] }),
        extraction(DOC_B, 'B', { skills: [skill('react', { totalMonths: 39 })] }),
      ],
      NOW,
    );

    expect(conflicts.filter((conflict) => conflict.kind === 'skill_duration')).toHaveLength(0);
  });
});

// ── Overrides ───────────────────────────────────────────────────────────────

describe('user overrides', () => {
  it('applies a correction and marks the entity verified', () => {
    const profile = profileWith();

    const updated = applyOverrides(profile, [
      fieldOverrideSchema.parse({
        id: OVERRIDE_1,
        candidateId: CANDIDATE,
        path: 'skills.react.proficiency',
        value: 'EXPERT',
        previousValue: 'PROFICIENT',
        createdAt: NOW,
      }),
    ]);

    const react = updated.skills.find((fact) => fact.slug === 'react')!;
    expect(react.proficiency).toBe('EXPERT');
    expect(react.userVerified).toBe(true);
  });

  it('survives a rebuild from fresh extractions', () => {
    const override = fieldOverrideSchema.parse({
      id: OVERRIDE_1,
      candidateId: CANDIDATE,
      path: 'summary',
      value: 'I write backend systems.',
      previousValue: null,
      createdAt: NOW,
    });

    const rebuilt = buildProfile({
      candidateId: CANDIDATE,
      profileVersion: 2,
      documents: [extraction(DOC_A, 'CV', { summary: 'Extracted summary' })],
      overrides: [override],
      now: NOW,
    });

    expect(rebuilt.summary).toBe('I write backend systems.');
  });

  it('lets a later correction win over an earlier one', () => {
    const updated = applyOverrides(profileWith(), [
      fieldOverrideSchema.parse({
        id: OVERRIDE_2,
        candidateId: CANDIDATE,
        path: 'summary',
        value: 'Second',
        createdAt: new Date('2025-02-01'),
      }),
      fieldOverrideSchema.parse({
        id: OVERRIDE_1,
        candidateId: CANDIDATE,
        path: 'summary',
        value: 'First',
        createdAt: new Date('2025-01-01'),
      }),
    ]);

    expect(updated.summary).toBe('Second');
  });

  it('leaves the profile intact when an override is malformed', () => {
    const profile = profileWith();
    const updated = applyOverrides(profile, [
      fieldOverrideSchema.parse({
        id: OVERRIDE_1,
        candidateId: CANDIDATE,
        path: 'skills.nonexistent.proficiency',
        value: 'EXPERT',
        createdAt: NOW,
      }),
    ]);

    expect(updated.skills).toHaveLength(profile.skills.length);
  });
});

// ── Quality ─────────────────────────────────────────────────────────────────

describe('profile quality', () => {
  it('scores completeness, evidence and confidence separately', () => {
    const quality = computeQuality(profileWith(), NOW);

    expect(quality.completenessScore).toBeGreaterThan(0);
    expect(quality.evidenceQualityScore).toBeGreaterThan(0);
    expect(quality.confidenceScore).toBeGreaterThan(0);
    // Different questions, so they must not be forced into agreement.
    expect(
      new Set([quality.completenessScore, quality.evidenceQualityScore, quality.confidenceScore]).size,
    ).toBeGreaterThan(1);
  });

  it('can be complete but poorly evidenced', () => {
    const listedOnly = profileWith({
      skills: Array.from({ length: 8 }, (_, index) =>
        skill(`s${index}`, { strongestSource: 'resume_skill_section', evidence: [] }),
      ),
      education: [
        educationRecordSchema.parse({
          id: 'e1',
          institution: 'A University',
          dates: emptyRange(),
          sourceText: 'A University',
          confidence: 0.5,
        }),
      ],
      projects: [
        {
          id: 'p1',
          name: 'Thing',
          context: 'unknown',
          description: null,
          outcome: null,
          technologies: [],
          url: null,
          dates: emptyRange(),
          sourceText: null,
          confidence: 0.4,
          userVerified: false,
        } as never,
      ],
      achievements: [
        {
          id: 'a1',
          title: 'Won a thing',
          kind: 'award',
          date: partialDateSchema.parse({}),
          detail: null,
          isDistinction: true,
          sourceText: null,
          confidence: 0.5,
          userVerified: false,
        } as never,
      ],
      summary: 'A summary',
    });

    const quality = computeQuality(listedOnly, NOW);
    expect(quality.completenessScore).toBeGreaterThan(80);
    expect(quality.evidenceQualityScore).toBeLessThan(quality.completenessScore);
    expect(quality.materialGaps.some((gap) => gap.field === 'skill_evidence')).toBe(true);
  });

  it('names gaps that would change match outcomes', () => {
    const empty = profileWith({ skills: [], experience: [] });
    const quality = computeQuality(empty, NOW);

    const high = quality.materialGaps.filter((gap) => gap.impact === 'high');
    expect(high.length).toBeGreaterThanOrEqual(2);
    for (const gap of quality.materialGaps) expect(gap.action.length).toBeGreaterThan(0);
  });

  it('lowers confidence while conflicts are open', () => {
    const clean = computeQuality(profileWith(), NOW);
    const conflicted = computeQuality(profileWith({ openConflicts: 2 }), NOW);
    expect(conflicted.confidenceScore).toBeLessThan(clean.confidenceScore);
  });
});

// ── Resume fit and comparison ───────────────────────────────────────────────

describe('resume fit', () => {
  it('scores a document against a job independently of the profile', () => {
    const fit = scoreResumeFit({
      document: extraction(DOC_A, 'Frontend CV', { skills: [skill('react')] }),
      jobId: JOB,
      requirements: [
        requirement('React', { slug: 'react' }),
        requirement('Kubernetes', { slug: 'kubernetes' }),
      ],
      now: NOW,
    });

    expect(fit.resumeFitScore).toBeGreaterThan(0);
    expect(fit.resumeFitScore).toBeLessThan(100);
    expect(fit.coveredRequirements).toContain('React');
    expect(fit.uncoveredRequirements).toContain('Kubernetes');
  });

  it('ranks the document that mentions more of the job higher', () => {
    const requirements = [
      requirement('React', { slug: 'react' }),
      requirement('AWS', { slug: 'aws' }),
    ];

    const frontend = scoreResumeFit({
      document: extraction(DOC_A, 'Frontend CV', { skills: [skill('react')] }),
      jobId: JOB,
      requirements,
      now: NOW,
    });

    const both = scoreResumeFit({
      document: extraction(DOC_B, 'Full CV', { skills: [skill('react'), skill('aws')] }),
      jobId: JOB,
      requirements,
      now: NOW,
    });

    expect(both.resumeFitScore).toBeGreaterThan(frontend.resumeFitScore);
  });

  it('names what each document uniquely evidences', () => {
    const comparison = compareResumes(CANDIDATE, [
      extraction(DOC_A, 'Frontend CV', { skills: [skill('react'), skill('typescript')] }),
      extraction(DOC_B, 'Cloud CV', { skills: [skill('react'), skill('aws')] }),
    ]);

    expect(comparison.sharedSkills).toContain('react');
    const frontend = comparison.documents.find((entry) => entry.label === 'Frontend CV')!;
    expect(frontend.uniqueSkills).toContain('typescript');
    expect(comparison.differences.length).toBeGreaterThan(0);
  });
});

// ── Job-specific view ───────────────────────────────────────────────────────

describe('job candidate view', () => {
  it('assembles evidence, gaps and the best-fitting document', () => {
    const view = buildJobCandidateView({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith(),
      requirements: [
        requirement('React', { slug: 'react' }),
        requirement('Kubernetes', { slug: 'kubernetes' }),
      ],
      documents: [
        extraction(DOC_A, 'Frontend CV', { skills: [skill('react')] }),
        extraction(DOC_B, 'Cloud CV', { skills: [skill('aws')] }),
      ],
      now: NOW,
    });

    expect(view.relevantSkills).toContain('react');
    expect(view.relevantExperience.length).toBeGreaterThan(0);
    expect(view.resumeFits[0]!.label).toBe('Frontend CV');
    expect(view.evidenceConfidence).toBeGreaterThan(0);
  });

  it('states unknowns as unknowns in the explanation', () => {
    const view = buildJobCandidateView({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith(),
      requirements: [requirement('Kubernetes', { slug: 'kubernetes' })],
      now: NOW,
    });

    expect(view.explanation).toMatch(/does not say either way/i);
    expect(view.explanation).toMatch(/unknowns, not gaps/i);
  });

  it('never claims direct experience for a transferable match', () => {
    const view = buildJobCandidateView({
      jobId: JOB,
      candidateId: CANDIDATE,
      profile: profileWith({ skills: [skill('nextjs', { name: 'Next.js' })] }),
      requirements: [requirement('React', { slug: 'react' })],
      now: NOW,
    });

    expect(view.transferable.length).toBeGreaterThan(0);
    expect(view.explanation).toMatch(/related experience rather than directly/i);
  });
});

// ── Summary generation ──────────────────────────────────────────────────────

describe('summary generation', () => {
  it('describes the profile from its facts', () => {
    const summary = generateProfileSummary(profileWith());
    expect(summary).toMatch(/years of recorded experience/i);
    expect(summary).toMatch(/senior/i);
  });

  it('says so when there is not enough to describe', () => {
    const summary = generateProfileSummary(profileWith({ skills: [], experience: [] }));
    expect(summary).toMatch(/not enough information/i);
  });

  it('hedges when confidence is low', () => {
    const summary = generateProfileSummary(
      profileWith({ seniority: { estimatedLevel: 'senior', confidence: 0.2 } as never }),
    );
    expect(summary).toMatch(/on limited evidence/i);
  });
});
