import { describe, expect, it } from 'vitest';
import { dateRangeSchema, partialDateSchema } from '@job-intel/contracts';
import { validateDocument, hashDocument, readZipDirectory, MAX_FILE_BYTES } from './validate/file-validation';
import { normaliseExtractedText, extractPlainText, extractText } from './extract/text-extraction';
import { classifyHeading, detectSections, looksLikeHeading, sectionText } from './parse/sections';
import {
  findDateRange,
  isPresent,
  mergedMonths,
  monthsBetween,
  parseDateRange,
  parsePartialDate,
} from './parse/dates';
import {
  extractAchievements,
  extractCertifications,
  extractEducation,
  extractExperience,
  extractLanguages,
  extractProjects,
  splitBlocks,
} from './parse/entities';
import {
  collectSkillMentions,
  findSkillsInText,
  normaliseSkill,
  parseSkillSection,
  technologiesFor,
} from './parse/skills';
import { buildSkillFacts, estimateProficiency, monthsSinceUse } from './analyse/skill-facts';
import { estimateSeniority, levelFromTitle } from './analyse/seniority';
import { analyseTrajectory, buildTimeline, findGaps } from './analyse/trajectory';
import { runPipeline } from './pipeline';
import {
  CAREER_CHANGE_RESUME,
  NO_HEADINGS_RESUME,
  OVERLAPPING_ROLES_RESUME,
  SKILLS_ONLY_RESUME,
  STANDARD_RESUME,
  UNDATED_RESUME,
  UNUSUAL_HEADINGS_RESUME,
  YEAR_ONLY_RESUME,
  fixtureBytes,
  minimalPdf,
  mislabelledFile,
  pdfWithJavaScript,
  zipBomb,
} from './testing/fixtures';

const NOW = new Date('2025-06-15T00:00:00Z');
const DOC_ID = '11111111-2222-4333-8444-555555555555';
const TEXT_MIME = 'text/plain';

async function sectionsOf(text: string) {
  return detectSections(text);
}

// ── 1. File validation ──────────────────────────────────────────────────────

describe('file validation', () => {
  it('accepts a plain-text resume', () => {
    const result = validateDocument({
      bytes: fixtureBytes(STANDARD_RESUME),
      filename: 'resume.txt',
      declaredMimeType: 'text/plain',
    });

    expect(result.accepted).toBe(true);
    expect(result.detectedMimeType).toBe('text/plain');
  });

  it('rejects an empty file', () => {
    const result = validateDocument({
      bytes: new Uint8Array(0),
      filename: 'resume.pdf',
      declaredMimeType: 'application/pdf',
    });

    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toMatch(/empty/i);
  });

  it('rejects a file over the size limit', () => {
    const result = validateDocument({
      bytes: new Uint8Array(MAX_FILE_BYTES + 1),
      filename: 'resume.pdf',
      declaredMimeType: 'application/pdf',
    });

    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toMatch(/limit|large|size/i);
  });

  it('detects the type from the signature, not the extension', () => {
    const { bytes, filename, declared } = mislabelledFile();
    const result = validateDocument({ bytes, filename, declaredMimeType: declared });

    // The bytes are a PDF. Whatever the caller claimed, extraction must not be
    // handed to the DOCX parser.
    expect(result.detectedMimeType).toBe('application/pdf');
  });

  it('rejects a PDF declaring embedded JavaScript', () => {
    const result = validateDocument({
      bytes: pdfWithJavaScript(),
      filename: 'resume.pdf',
      declaredMimeType: 'application/pdf',
    });

    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toMatch(/active content|javascript|embedded/i);
  });

  it('rejects a zip bomb by reading the directory, not decompressing', () => {
    const result = validateDocument({
      bytes: zipBomb(),
      filename: 'resume.docx',
      declaredMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toMatch(/compress|expand|ratio/i);
  });

  it('reads a zip central directory without inflating members', () => {
    const entries = readZipDirectory(zipBomb());
    expect(entries).not.toBeNull();
    expect(entries![0]!.name).toBe('word/document.xml');
    expect(entries![0]!.uncompressedSize).toBeGreaterThan(1_000_000);
  });

  it('hashes content stably', () => {
    const bytes = fixtureBytes(STANDARD_RESUME);
    expect(hashDocument(bytes)).toBe(hashDocument(bytes));
    expect(hashDocument(bytes)).not.toBe(hashDocument(fixtureBytes(YEAR_ONLY_RESUME)));
  });
});

// ── 2. Text extraction ──────────────────────────────────────────────────────

describe('text extraction', () => {
  it('preserves line structure while collapsing runs', () => {
    const normalised = normaliseExtractedText('A\r\n\r\n\r\n\r\nB   C\n​D');
    expect(normalised).toBe('A\n\nB  C\nD');
  });

  it('normalises bullet glyphs to one marker', () => {
    expect(normaliseExtractedText('  - one\n• two\n* three')).toBe('• one\n• two\n• three');
  });

  it('extracts plain text', () => {
    const result = extractPlainText(fixtureBytes(STANDARD_RESUME));
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Meridian Labs');
  });

  it('extracts text from a real PDF', async () => {
    const result = await extractText(minimalPdf('Extraction works'), 'application/pdf');
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Extraction works');
  });

  it('reports an unsupported type as a result, not an exception', async () => {
    const result = await extractText(new Uint8Array([1, 2, 3]), 'image/png');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a supported/i);
  });
});

// ── 3. Section detection ────────────────────────────────────────────────────

describe('section detection', () => {
  it('classifies conventional headings', () => {
    expect(classifyHeading('WORK EXPERIENCE').kind).toBe('experience');
    expect(classifyHeading('Education').kind).toBe('education');
    expect(classifyHeading('Technical Skills').kind).toBe('skills');
    expect(classifyHeading('Certifications').kind).toBe('certifications');
  });

  it('handles unusual headings the brief names', () => {
    expect(classifyHeading('Professional Journey').kind).toBe('experience');
    expect(classifyHeading('What I Bring').kind).toBe('skills');
    expect(classifyHeading("Things I've Built").kind).toBe('projects');
    expect(classifyHeading('Who I Am').kind).toBe('summary');
  });

  it('does not treat a sentence containing "experience" as a heading', () => {
    expect(looksLikeHeading('I have eight years of experience building software.')).toBe(false);
    expect(looksLikeHeading('WORK EXPERIENCE')).toBe(true);
  });

  it('does not treat a dated role line as a heading', () => {
    expect(looksLikeHeading('Meridian Labs 2021 - 2023')).toBe(false);
  });

  it('splits a standard resume into the expected sections', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const kinds = sections.map((section) => section.kind);

    expect(kinds).toContain('experience');
    expect(kinds).toContain('education');
    expect(kinds).toContain('skills');
    expect(kinds).toContain('certifications');
    expect(sectionText(sections, 'experience')).toContain('Meridian Labs');
  });

  it('places the preamble in a contact section', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const contact = sections.find((section) => section.kind === 'contact');
    expect(contact?.text).toContain('alex.morgan@example.invalid');
  });

  it('uses the classifier only for headings the vocabulary cannot place', async () => {
    let calls = 0;
    await detectSections(STANDARD_RESUME, {
      classifier: {
        model: 'test-model',
        classify: async () => {
          calls += 1;
          return { kind: 'experience', confidence: 0.6 };
        },
      },
    });

    // Every heading in the standard resume is in the vocabulary.
    expect(calls).toBe(0);
  });
});

// ── 4. Date parsing ─────────────────────────────────────────────────────────

describe('date parsing', () => {
  it('parses month names, ISO and slashed forms', () => {
    expect(parsePartialDate('January 2024')).toMatchObject({ year: 2024, month: 1, precision: 'month' });
    expect(parsePartialDate('Sept 2024')).toMatchObject({ year: 2024, month: 9 });
    expect(parsePartialDate('2024-03')).toMatchObject({ year: 2024, month: 3 });
    expect(parsePartialDate('03/2024')).toMatchObject({ year: 2024, month: 3 });
    expect(parsePartialDate('Q2 2024')).toMatchObject({ year: 2024, month: 4 });
  });

  it('never invents a missing month', () => {
    const parsed = parsePartialDate('2021');
    expect(parsed.year).toBe(2021);
    expect(parsed.month).toBeNull();
    expect(parsed.precision).toBe('year');
  });

  it('discards an ambiguous day rather than guessing', () => {
    // 06/07/2024 is June 7 in the US and 6 July elsewhere.
    const parsed = parsePartialDate('06/07/2024');
    expect(parsed.year).toBe(2024);
    expect(parsed.day).toBeNull();
  });

  it('recognises present-tense end markers', () => {
    expect(isPresent('Present')).toBe(true);
    expect(isPresent('current')).toBe(true);
    expect(isPresent('2023')).toBe(false);
  });

  it('flags durations derived from year-only dates as estimates', () => {
    const range = parseDateRange('2021 - 2023', NOW);
    expect(range.durationIsEstimate).toBe(true);
    expect(range.durationMonths).toBe(24);
  });

  it('returns null months when no year is available', () => {
    const result = monthsBetween(partialDateSchema.parse({}), partialDateSchema.parse({}), NOW);
    expect(result.months).toBeNull();
  });

  it('finds a range anywhere in a line', () => {
    const range = findDateRange('London, UK | March 2021 - Present', NOW);
    expect(range?.start).toMatchObject({ year: 2021, month: 3 });
    expect(range?.isCurrent).toBe(true);
  });

  it('counts overlapping spans once', () => {
    const ranges = [
      dateRangeSchema.parse({
        start: partialDateSchema.parse({ year: 2021, month: 1, precision: 'month' }),
        end: partialDateSchema.parse({ year: 2023, month: 1, precision: 'month' }),
      }),
      dateRangeSchema.parse({
        start: partialDateSchema.parse({ year: 2022, month: 1, precision: 'month' }),
        end: partialDateSchema.parse({ year: 2024, month: 1, precision: 'month' }),
      }),
    ];

    // 2021→2024 is 36 months, not the 48 that naive addition produces.
    expect(mergedMonths(ranges, NOW).months).toBe(36);
  });
});

// ── 5. Entity extraction ────────────────────────────────────────────────────

describe('entity extraction', () => {
  it('splits blocks on blank lines', () => {
    expect(splitBlocks('A\nB\n\nC\nD')).toHaveLength(2);
  });

  it('extracts roles with company, title and dates', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const roles = extractExperience(sectionText(sections, 'experience'), { documentId: null, now: NOW });

    expect(roles.length).toBeGreaterThanOrEqual(3);
    const senior = roles.find((role) => role.company.includes('Meridian'));
    expect(senior?.title).toMatch(/Senior Software Engineer/i);
    expect(senior?.dates.isCurrent).toBe(true);
  });

  it('preserves the original text as evidence', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const roles = extractExperience(sectionText(sections, 'experience'), { documentId: null, now: NOW });
    expect(roles[0]?.sourceText).toContain(roles[0]!.company);
  });

  it('separates achievements from responsibilities', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const roles = extractExperience(sectionText(sections, 'experience'), { documentId: null, now: NOW });
    const meridian = roles.find((role) => role.company.includes('Meridian'))!;

    expect(meridian.achievements.some((line) => /reducing median page load/i.test(line))).toBe(true);
    expect(meridian.responsibilities.length).toBeGreaterThan(0);
  });

  it('reads a grade only when it is explicitly labelled', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const education = extractEducation(sectionText(sections, 'education'), { documentId: null, now: NOW });

    expect(education[0]?.grade).toMatch(/First Class/i);

    const noGrade = extractEducation('University of Leeds\nBSc Computer Science, 2013 - 2016', {
      documentId: null,
      now: NOW,
    });
    expect(noGrade[0]?.grade).toBeNull();
  });

  it('never fabricates certification verification', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const certifications = extractCertifications(sectionText(sections, 'certifications'), {
      documentId: null,
      now: NOW,
    });

    expect(certifications.length).toBeGreaterThan(0);
    for (const certification of certifications) {
      expect(certification.verification).toBe('UNVERIFIED');
    }
  });

  it('does not guess whether a project was professional', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const projects = extractProjects(sectionText(sections, 'projects'), { documentId: null, now: NOW });

    expect(projects.length).toBeGreaterThan(0);
    expect(projects.every((project) => project.context !== 'professional')).toBe(true);
  });

  it('defaults language proficiency to UNKNOWN when unstated', () => {
    const languages = extractLanguages('English\nSpanish');
    expect(languages.every((language) => language.proficiency === 'UNKNOWN')).toBe(true);
  });

  it('reads a stated language level when given', () => {
    const languages = extractLanguages('English (Native), Spanish (Professional working proficiency)');
    const english = languages.find((language) => /english/i.test(language.language));
    expect(english?.proficiency).not.toBe('UNKNOWN');
  });

  it('marks distinctions in achievements', () => {
    const achievements = extractAchievements('Winner, National Coding Championship, 2021', {
      documentId: null,
      now: NOW,
    });
    expect(achievements[0]?.isDistinction).toBe(true);
  });
});

// ── 6. Skills ───────────────────────────────────────────────────────────────

describe('skill normalisation', () => {
  it('maps aliases to one canonical skill', () => {
    expect(normaliseSkill('React.js')?.slug).toBe('react');
    expect(normaliseSkill('ReactJS')?.slug).toBe('react');
    expect(normaliseSkill('JS')?.slug).toBe('javascript');
    expect(normaliseSkill('NodeJS')?.slug).toBe('nodejs');
  });

  it('keeps an unrecognised skill rather than dropping it', () => {
    const skill = normaliseSkill('Zygote Framework');
    expect(skill?.slug).toBe('zygote-framework');
    expect(skill?.category).toBe('other');
  });

  it('matches terms containing punctuation at word boundaries', () => {
    const found = findSkillsInText('Built services in C# and Node.js');
    const slugs = found.map((skill) => skill.slug);
    expect(slugs).toContain('csharp');
    expect(slugs).toContain('nodejs');
  });

  it('prefers the longer alias', () => {
    const found = findSkillsInText('Shipped a React Native app');
    expect(found.map((skill) => skill.slug)).toContain('react-native');
  });

  it('parses a labelled skills section', () => {
    const skills = parseSkillSection('Languages: JavaScript, TypeScript, Python\nCloud: AWS, Docker');
    const slugs = skills.map((skill) => skill.slug);
    expect(slugs).toEqual(expect.arrayContaining(['javascript', 'typescript', 'python', 'aws', 'docker']));
  });

  it('does not turn prose fragments into skills', () => {
    // The unstructured-document path hands whole prose to this function, and
    // comma-splitting a sentence must not produce "where they have" as a skill.
    const skills = parseSkillSection(
      'Casey has built pipelines in Python and Kafka, where they have, and previously used SQL',
    );
    const slugs = skills.map((skill) => skill.slug);

    expect(slugs).toContain('python');
    expect(slugs).toContain('sql');
    expect(slugs).not.toContain('where-they-have');
    expect(slugs).not.toContain('and');
  });

  it('keeps an unrecognised technology that looks like a name', () => {
    const slugs = parseSkillSection('Languages: Python, Zygote Framework, COBOL').map(
      (skill) => skill.slug,
    );

    expect(slugs).toContain('zygote-framework');
    expect(slugs).toContain('cobol');
  });

  it('excludes soft skills from role technologies', () => {
    const slugs = technologiesFor('Led the team and built the API in Python');
    expect(slugs).toContain('python');
    expect(slugs).not.toContain('leadership');
  });
});

// ── 7. Skill evidence and proficiency ───────────────────────────────────────

describe('skill facts', () => {
  it('attaches evidence with its source', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const experience = extractExperience(sectionText(sections, 'experience'), { documentId: DOC_ID, now: NOW });

    const mentions = collectSkillMentions({
      documentId: DOC_ID,
      skillSection: sectionText(sections, 'skills'),
      experience,
      projects: [],
      certifications: [],
      educationCoursework: [],
    });

    const react = mentions.filter((mention) => mention.skill.slug === 'react');
    expect(react.length).toBeGreaterThan(0);
    expect(react.some((mention) => mention.evidence.source === 'employment_responsibility')).toBe(true);
  });

  it('caps assertion-only skills at WORKING', () => {
    const result = estimateProficiency({
      months: null,
      monthsIsEstimate: false,
      lastEvidencedAt: null,
      evidence: [
        {
          id: 'a',
          source: 'resume_skill_section',
          documentId: null,
          context: 'Skills',
          excerpt: null,
          confidence: 0.5,
          observedFrom: null,
          observedTo: null,
          extractedBy: null,
          extractedAt: NOW,
        },
      ],
      now: NOW,
      staleAfterMonths: 48,
    });

    expect(result.level).toBe('WORKING');
    expect(result.confidence).toBeLessThan(0.4);
  });

  it('phrases proficiency as what the evidence supports', () => {
    const result = estimateProficiency({
      months: 60,
      monthsIsEstimate: false,
      lastEvidencedAt: NOW,
      evidence: [
        {
          id: 'a',
          source: 'employment_responsibility',
          documentId: null,
          context: 'Role',
          excerpt: null,
          confidence: 0.85,
          observedFrom: new Date('2020-01-01'),
          observedTo: NOW,
          extractedBy: null,
          extractedAt: NOW,
        },
      ],
      now: NOW,
      staleAfterMonths: 48,
    });

    expect(result.rationale).toMatch(/^Evidence suggests/);
    expect(result.rationale).not.toMatch(/definitely|certainly|is an expert/i);
  });

  it('does not double-count overlapping roles', async () => {
    const sections = await sectionsOf(OVERLAPPING_ROLES_RESUME);
    const experience = extractExperience(sectionText(sections, 'experience'), { documentId: DOC_ID, now: NOW });

    const mentions = collectSkillMentions({
      documentId: DOC_ID,
      skillSection: sectionText(sections, 'skills'),
      experience,
      projects: [],
      certifications: [],
      educationCoursework: [],
    });

    const facts = buildSkillFacts(mentions, { now: NOW });
    const react = facts.find((fact) => fact.slug === 'react');

    // Jan 2021 → Jan 2024 is 36 months. Adding the spans would give 60.
    expect(react?.totalMonths).toBe(36);
  });

  it('reports null duration when nothing is dated', async () => {
    const sections = await sectionsOf(UNDATED_RESUME);
    const experience = extractExperience(sectionText(sections, 'experience'), { documentId: DOC_ID, now: NOW });

    const facts = buildSkillFacts(
      collectSkillMentions({
        documentId: DOC_ID,
        skillSection: sectionText(sections, 'skills'),
        experience,
        projects: [],
        certifications: [],
        educationCoursework: [],
      }),
      { now: NOW },
    );

    // Null, not zero: "no dates" and "zero months" are different facts.
    expect(facts.every((fact) => fact.totalMonths === null)).toBe(true);
  });

  it('tracks recency separately from duration', async () => {
    const facts = buildSkillFacts(
      [
        {
          skill: { slug: 'react', name: 'React', category: 'framework', aliases: [] },
          evidence: {
            id: 'old',
            source: 'employment_responsibility',
            documentId: null,
            context: 'Old role',
            excerpt: null,
            confidence: 0.85,
            observedFrom: new Date('2012-01-01'),
            observedTo: new Date('2017-01-01'),
            extractedBy: null,
            extractedAt: NOW,
          },
        },
      ],
      { now: NOW },
    );

    const react = facts[0]!;
    expect(react.totalMonths).toBe(60);
    expect(monthsSinceUse(react, NOW)).toBeGreaterThan(90);
    // Five years of use, but eight years stale — the estimate is reduced.
    expect(react.proficiency).not.toBe('EXPERT');
  });
});

// ── 8. Seniority ────────────────────────────────────────────────────────────

describe('seniority estimation', () => {
  it('reads a level from a title', () => {
    expect(levelFromTitle('Senior Software Engineer')).toBe('senior');
    expect(levelFromTitle('Staff Engineer')).toBe('staff');
    expect(levelFromTitle('Engineering Manager')).toBe('manager');
    expect(levelFromTitle('Software Engineer')).toBeNull();
  });

  it('does not decide seniority from the title alone', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const experience = extractExperience(sectionText(sections, 'experience'), { documentId: null, now: NOW });
    const estimate = estimateSeniority({ experience, now: NOW });

    const names = estimate.signals.map((signal) => signal.name);
    expect(names).toContain('total_experience');
    expect(names.some((name) => name !== 'current_title' && name !== 'total_experience')).toBe(true);

    // The title signal must not carry a majority of the weight on its own.
    const titleWeight = estimate.signals.find((signal) => signal.name === 'current_title')?.weight ?? 0;
    const total = estimate.signals.reduce((sum, signal) => sum + signal.weight, 0);
    expect(titleWeight / total).toBeLessThan(0.5);
  });

  it('returns null rather than guessing with no history', () => {
    const estimate = estimateSeniority({ experience: [], now: NOW });
    expect(estimate.estimatedLevel).toBeNull();
    expect(estimate.confidence).toBe(0);
  });

  it('lets a stated level outrank inference', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const experience = extractExperience(sectionText(sections, 'experience'), { documentId: null, now: NOW });
    const estimate = estimateSeniority({ experience, statedLevel: 'principal', now: NOW });

    expect(estimate.estimatedLevel).toBe('principal');
    expect(estimate.confidence).toBe(1);
  });
});

// ── 9. Timeline and trajectory ──────────────────────────────────────────────

describe('career timeline', () => {
  it('builds a chronological timeline', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const experience = extractExperience(sectionText(sections, 'experience'), { documentId: null, now: NOW });
    const timeline = buildTimeline({ experience, now: NOW });

    expect(timeline.length).toBeGreaterThan(0);
    for (let index = 1; index < timeline.length; index += 1) {
      expect(timeline[index]!.year).toBeGreaterThanOrEqual(timeline[index - 1]!.year);
    }
  });

  it('reports gaps without interpreting them', async () => {
    const sections = await sectionsOf(CAREER_CHANGE_RESUME);
    const experience = extractExperience(sectionText(sections, 'experience'), { documentId: null, now: NOW });
    const gaps = findGaps(experience, NOW);

    for (const gap of gaps) {
      expect(gap.note).toMatch(/months between recorded roles/i);
      expect(gap.note).not.toMatch(/concern|unexplained|red flag|problem/i);
    }
  });

  it('does not manufacture a gap between concurrent roles', async () => {
    const sections = await sectionsOf(OVERLAPPING_ROLES_RESUME);
    const experience = extractExperience(sectionText(sections, 'experience'), { documentId: null, now: NOW });
    expect(findGaps(experience, NOW)).toHaveLength(0);
  });

  it('measures trajectory direction, not level', async () => {
    const sections = await sectionsOf(STANDARD_RESUME);
    const experience = extractExperience(sectionText(sections, 'experience'), { documentId: null, now: NOW });
    const trajectory = analyseTrajectory({ experience, now: NOW });

    expect(trajectory.dimensions.length).toBeGreaterThan(0);
    for (const dimension of trajectory.dimensions) {
      expect(dimension.direction).toBeGreaterThanOrEqual(-1);
      expect(dimension.direction).toBeLessThanOrEqual(1);
    }
    expect(trajectory.totalExperienceMonths).toBeGreaterThan(0);
  });
});

// ── 10. The pipeline end to end ─────────────────────────────────────────────

describe('pipeline', () => {
  it('runs every stage on a standard resume', async () => {
    const result = await runPipeline({
      bytes: fixtureBytes(STANDARD_RESUME),
      filename: 'resume.txt',
      declaredMimeType: TEXT_MIME,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      'validate',
      'extract',
      'sections',
      'entities',
      'normalise',
      'evidence',
    ]);
    expect(result.experience.length).toBeGreaterThanOrEqual(3);
    expect(result.skills.length).toBeGreaterThan(5);
    expect(result.seniority?.estimatedLevel).not.toBeNull();
  });

  it('stops at the failing stage and says which', async () => {
    const result = await runPipeline({
      bytes: zipBomb(),
      filename: 'resume.docx',
      declaredMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe('validate');
    expect(result.error).toBeTruthy();
  });

  it('handles unusual headings', async () => {
    const result = await runPipeline({
      bytes: fixtureBytes(UNUSUAL_HEADINGS_RESUME),
      filename: 'resume.txt',
      declaredMimeType: TEXT_MIME,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.experience.length).toBeGreaterThanOrEqual(2);
    expect(result.skills.map((skill) => skill.slug)).toContain('java');
  });

  it('flags year-only durations as estimates', async () => {
    const result = await runPipeline({
      bytes: fixtureBytes(YEAR_ONLY_RESUME),
      filename: 'resume.txt',
      declaredMimeType: TEXT_MIME,
      now: NOW,
    });

    expect(result.experience.every((role) => role.dates.durationIsEstimate)).toBe(true);
  });

  it('produces something from a document with no headings', async () => {
    const result = await runPipeline({
      bytes: fixtureBytes(NO_HEADINGS_RESUME),
      filename: 'resume.txt',
      declaredMimeType: TEXT_MIME,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    // Skills are still found even when structure is absent.
    expect(result.skills.map((skill) => skill.slug)).toContain('python');
  });

  it('warns when skills are asserted with no supporting evidence', async () => {
    const result = await runPipeline({
      bytes: fixtureBytes(SKILLS_ONLY_RESUME),
      filename: 'resume.txt',
      declaredMimeType: TEXT_MIME,
      now: NOW,
    });

    const evidenceStage = result.stages.find((stage) => stage.stage === 'evidence')!;
    expect(evidenceStage.warnings.join(' ')).toMatch(/only in the skills section/i);

    const rust = result.skills.find((skill) => skill.slug === 'rust');
    expect(rust?.proficiency).toBe('WORKING');
    expect(rust?.proficiencyConfidence).toBeLessThan(0.4);
  });

  it('never places document text in a stage detail', async () => {
    const result = await runPipeline({
      bytes: fixtureBytes(STANDARD_RESUME),
      filename: 'resume.txt',
      declaredMimeType: TEXT_MIME,
      now: NOW,
    });

    const details = result.stages.map((stage) => stage.detail).join(' ');
    expect(details).not.toContain('alex.morgan@example.invalid');
    expect(details).not.toContain('+44 7700 900000');
  });

  it('is deterministic', async () => {
    const run = () =>
      runPipeline({
        bytes: fixtureBytes(STANDARD_RESUME),
        filename: 'resume.txt',
        declaredMimeType: TEXT_MIME,
        now: NOW,
      });

    const [first, second] = await Promise.all([run(), run()]);
    expect(second.skills.map((skill) => skill.slug)).toEqual(first.skills.map((skill) => skill.slug));
    expect(second.experience.map((role) => role.id)).toEqual(first.experience.map((role) => role.id));
  });
});
