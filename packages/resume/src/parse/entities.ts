import { createHash } from 'node:crypto';
import {
  achievementRecordSchema,
  certificationRecordSchema,
  dateRangeSchema,
  educationRecordSchema,
  experienceEntrySchema,
  languageRecordSchema,
  partialDateSchema,
  projectRecordSchema,
  type AchievementRecord,
  type CertificationRecord,
  type DocumentSection,
  type EducationRecord,
  type ExperienceEntry,
  type LanguageRecord,
  type ProjectRecord,
} from '@job-intel/contracts';
import { findDateRange, parsePartialDate, stripDateRange } from './dates';

/**
 * Entity extraction.
 *
 * Deterministic parsing of resume blocks into structured records. The design
 * constraint that shapes everything here: **preserve the source text**. Every
 * record carries the block it came from, because a structured field with no
 * traceable origin is exactly the kind of claim this layer exists to avoid —
 * and because the candidate needs to be able to see what the parser saw when it
 * gets something wrong.
 *
 * Resume layout is genuinely unruly, so the strategy is to split into blocks on
 * blank lines and date lines, then read each block's first two or three lines
 * for the header fields. That is imperfect and known to be imperfect; the
 * confidence on each record says so, and the editor lets a person fix it.
 */

const id = (kind: string, ...parts: Array<string | null>): string =>
  `${kind}_${createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 12)}`;

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Separators resumes use between company, title and location on one line. */
const FIELD_SEPARATOR = /\s+[|·•‧–—]\s+|\s{2,}|\s+@\s+|,\s+(?=[A-Z])/;

const BULLET = /^\s*•\s+/;

/**
 * Splits a section into per-entry blocks.
 *
 * Blank lines are the primary separator. Where a section has none — a common
 * single-spaced layout — the rule is that **one entry carries one date range**:
 * a second date line means a second entry has begun.
 *
 * The naive version of this rule (any date line starts a block) splits
 *
 *     University of Leeds
 *     BSc Computer Science, 2013 – 2016
 *
 * into two records, one of which is an institution with no degree and the other
 * a degree with no institution.
 */
export function splitBlocks(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  if (paragraphs.length > 1) return paragraphs;

  const blocks: string[] = [];
  let current: string[] = [];
  let currentHasDate = false;

  for (const line of text.split('\n')) {
    const hasDate = !BULLET.test(line) && findDateRange(line) !== null;

    if (hasDate && currentHasDate) {
      blocks.push(current.join('\n').trim());
      current = [];
      currentHasDate = false;
    }

    current.push(line);
    if (hasDate) currentHasDate = true;
  }

  if (current.length > 0) blocks.push(current.join('\n').trim());
  return blocks.filter((block) => block.length > 0);
}

/**
 * Bullets, with wrapped continuations rejoined.
 *
 * A bullet that runs past the column width continues on an indented line, and
 * splitting a resume on newlines alone cuts it in half. "Led the migration,
 * reducing" and "median page load from 4.1s to 1.3s" are one statement; keeping
 * them apart loses the number, which is the part that mattered.
 */
export function collectBullets(lines: readonly string[]): string[] {
  const bullets: string[] = [];

  for (const line of lines) {
    if (BULLET.test(line)) {
      bullets.push(clean(line.replace(BULLET, '')));
      continue;
    }

    // An indented line following a bullet is that bullet's continuation.
    if (bullets.length > 0 && /^\s{2,}\S/.test(line)) {
      bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} ${clean(line)}`.trim();
    }
  }

  return bullets.filter((bullet) => bullet.length > 3);
}

/** Lines that are neither a bullet nor a bullet's continuation. */
export function proseLines(lines: readonly string[]): string[] {
  const prose: string[] = [];
  let inBullet = false;

  for (const line of lines) {
    if (BULLET.test(line)) {
      inBullet = true;
      continue;
    }
    if (inBullet && /^\s{2,}\S/.test(line)) continue;
    inBullet = false;
    prose.push(line);
  }

  return prose;
}

const EMPLOYMENT_HINTS: ReadonlyArray<[RegExp, ExperienceEntry['employmentKind']]> = [
  [/\b(full[\s-]?time)\b/i, 'full_time'],
  [/\b(part[\s-]?time)\b/i, 'part_time'],
  [/\b(contract|contractor)\b/i, 'contract'],
  [/\bfreelance\b/i, 'freelance'],
  [/\b(intern|internship|placement)\b/i, 'internship'],
  [/\bvolunteer\b/i, 'volunteer'],
];

/**
 * Achievements state an outcome; responsibilities state a duty.
 *
 * Matched on stems rather than exact words, because a resume writes the same
 * claim four ways — "reduced", "reducing", "reduction" — and an exact-word list
 * classifies three of them as duties. The split is imperfect by nature, which
 * is why both lists are kept on the record rather than one being discarded.
 */
const OUTCOME_VERB =
  /\b(increas|reduc|improv|sav(ed|ing|es)?|grew|grow|shipp?ed|launch|deliver|cut|achiev|won|award|optimis|optimiz|accelerat|eliminat|doubl|tripl|halv)\w*/i;

/** A measured change, which is an outcome even with no outcome verb. */
const QUANTIFIED_DELTA = /\d+(\.\d+)?\s*%|\bby\s+\$?\d|\bfrom\s+[\d$]\S*\s+to\s+[\d$]|\bx\d+\b/i;

/** Phrases that indicate scope and ownership rather than task execution. */
const SENIORITY_INDICATORS: readonly RegExp[] = [
  /\bled\b|\bleading\b|\bleadership\b/i,
  /\bmentor(ed|ing|ship)?\b/i,
  /\bown(ed|ership)?\b/i,
  /\barchitect(ed|ure|ing)?\b/i,
  /\bdesigned the\b/i,
  /\bmanaged\b|\bmanaging\b/i,
  /\bteam of \d+/i,
  /\bhired\b|\brecruit(ed|ing)\b/i,
  /\bstrategy\b|\broadmap\b/i,
  /\bcross[- ]functional\b/i,
  /\bstakeholder/i,
  /\bdrove\b|\bspearheaded\b/i,
];

/**
 * Reads the header lines of an experience block.
 *
 * Company and title cannot be told apart reliably by content alone, so the
 * heuristic is positional with a title-vocabulary tiebreak: whichever field
 * reads like a job title is the title, and the other is the company.
 */
const TITLE_WORDS =
  /\b(engineer|developer|designer|manager|director|analyst|scientist|architect|consultant|lead|head|officer|specialist|administrator|intern|associate|principal|founder|cto|ceo|vp)\b/i;

function readHeader(lines: readonly string[]): {
  company: string | null;
  title: string | null;
  location: string | null;
} {
  const candidates: string[] = [];

  for (const line of lines.slice(0, 3)) {
    const withoutDates = clean(stripDateRange(line));
    if (withoutDates.length === 0 || BULLET.test(line)) continue;

    for (const part of withoutDates.split(FIELD_SEPARATOR)) {
      const value = clean(part);
      if (value.length >= 2 && value.length <= 120) candidates.push(value);
    }
  }

  if (candidates.length === 0) return { company: null, title: null, location: null };

  const titleIndex = candidates.findIndex((value) => TITLE_WORDS.test(value));
  const title = titleIndex >= 0 ? candidates[titleIndex]! : (candidates[1] ?? null);

  const remaining = candidates.filter((_, index) => index !== titleIndex);
  const company = remaining[0] ?? null;

  // A location is the short trailing field that is neither company nor title.
  const location =
    remaining
      .slice(1)
      .find((value) => value.split(/\s+/).length <= 4 && !TITLE_WORDS.test(value)) ?? null;

  return { company, title, location };
}

export interface ExtractionContext {
  documentId: string | null;
  now?: Date;
}

/** Experience entries from the experience section. */
export function extractExperience(
  section: string,
  context: ExtractionContext = { documentId: null },
): ExperienceEntry[] {
  const now = context.now ?? new Date();
  const entries: ExperienceEntry[] = [];

  for (const block of splitBlocks(section)) {
    const lines = block.split('\n');
    const dates = findDateRange(block, now) ?? dateRangeSchema.parse({
      start: partialDateSchema.parse({}),
      end: partialDateSchema.parse({}),
    });

    const { company, title, location } = readHeader(lines);
    // A block with neither a company nor a title is not a role.
    if (!company && !title) continue;

    const bullets = collectBullets(lines);

    const achievements = bullets.filter((bullet) => OUTCOME_VERB.test(bullet) || QUANTIFIED_DELTA.test(bullet));
    const responsibilities = bullets.filter((bullet) => !achievements.includes(bullet));

    const prose = proseLines(lines).join(' ');
    const employmentKind =
      EMPLOYMENT_HINTS.find(([pattern]) => pattern.test(block))?.[1] ?? 'unknown';

    const indicators = SENIORITY_INDICATORS.flatMap((pattern) => {
      const match = pattern.exec(block);
      if (!match) return [];
      // A window around the match, so the indicator is readable in context.
      const start = Math.max(0, match.index - 40);
      return [clean(block.slice(start, Math.min(block.length, match.index + 80)))];
    }).slice(0, 8);

    const parsed = experienceEntrySchema.safeParse({
      id: id('exp', company, title, dates.start.raw),
      company: company ?? 'Unknown',
      title: title ?? 'Unknown',
      location,
      employmentKind,
      dates,
      description: clean(prose).slice(0, 8_000) || null,
      responsibilities: responsibilities.slice(0, 30),
      achievements: achievements.slice(0, 30),
      technologies: [],
      domain: null,
      seniorityIndicators: indicators,
      sourceText: block.slice(0, 8_000),
      // Confidence reflects how much of the header was actually recoverable.
      confidence:
        (company ? 0.35 : 0) + (title ? 0.35 : 0) + (dates.start.year !== null ? 0.3 : 0),
      userVerified: false,
    });

    if (parsed.success) entries.push(parsed.data);
  }

  return entries;
}

const DEGREE_LEVELS: ReadonlyArray<[RegExp, EducationRecord['level']]> = [
  [/\bph\.?d\b|\bdoctor(ate|al)\b/i, 'doctorate'],
  [/\bm\.?(sc|s|a|eng|ba)\b|\bmaster'?s?\b/i, 'masters'],
  [/\bb\.?(sc|s|a|eng|tech)\b|\bbachelor'?s?\b|\bhnd\b/i, 'bachelors'],
  [/\b(associate|diploma|foundation)\b/i, 'diploma'],
  [/\b(high school|secondary|a-?levels?|gcse|waec)\b/i, 'high_school'],
];

export function extractEducation(
  section: string,
  context: ExtractionContext = { documentId: null },
): EducationRecord[] {
  const now = context.now ?? new Date();
  const records: EducationRecord[] = [];

  for (const block of splitBlocks(section)) {
    const lines = block.split('\n').map(clean).filter(Boolean);
    if (lines.length === 0) continue;

    const dates = findDateRange(block, now) ?? dateRangeSchema.parse({
      start: partialDateSchema.parse({}),
      end: partialDateSchema.parse({}),
    });

    const level = DEGREE_LEVELS.find(([pattern]) => pattern.test(block))?.[1] ?? null;

    // The institution is the line naming a university/college; the degree line
    // is the one carrying the qualification vocabulary.
    const institutionLine =
      lines.find((line) => /\b(university|college|institute|school|academy|polytechnic)\b/i.test(line)) ??
      lines[0]!;

    const degreeLine =
      lines.find((line) => DEGREE_LEVELS.some(([pattern]) => pattern.test(line))) ?? null;

    const institution = clean(institutionLine.split(FIELD_SEPARATOR)[0] ?? institutionLine);

    // "BSc Computer Science" → degree "BSc", field "Computer Science".
    let degree: string | null = null;
    let field: string | null = null;

    if (degreeLine) {
      const inField = /\b(?:in|of)\s+(.{3,80})$/i.exec(degreeLine);
      field = inField ? clean(inField[1]!) : null;
      degree = clean(degreeLine.replace(/\b(?:in|of)\s+.+$/i, ''));
      if (!field) {
        const parts = degreeLine.split(FIELD_SEPARATOR).map(clean);
        if (parts.length > 1) {
          degree = parts[0]!;
          field = parts[1]!;
        }
      }
    }

    /*
     * Grades are read only when explicitly labelled.
     *
     * Part 21 is emphatic that grades must not be inferred, and resumes are
     * full of numbers that look like grades and are not — GPA-shaped strings
     * appear in project metrics and dates alike.
     */
    const grade =
      /\b(?:gpa|grade|classification|result)\s*[:-]?\s*([\w. /]{1,20})/i.exec(block)?.[1] ??
      /\b(first class|second class(?:\s+upper|\s+lower)?|distinction|merit|pass)\b/i.exec(block)?.[1] ??
      null;

    const coursework = /\b(?:relevant\s+)?(?:coursework|modules|courses)\s*[:-]\s*(.+)/i
      .exec(block)?.[1]
      ?.split(/[,;]/)
      .map(clean)
      .filter((entry) => entry.length > 1)
      .slice(0, 40);

    const parsed = educationRecordSchema.safeParse({
      id: id('edu', institution, degree, String(dates.end.year)),
      institution,
      degree,
      field,
      level,
      dates,
      grade: grade ? clean(grade) : null,
      coursework: coursework ?? [],
      sourceText: block.slice(0, 4_000),
      confidence: (institution ? 0.4 : 0) + (degree ? 0.3 : 0) + (dates.end.year ? 0.3 : 0),
      userVerified: false,
    });

    if (parsed.success) records.push(parsed.data);
  }

  return records;
}

export function extractCertifications(
  section: string,
  context: ExtractionContext = { documentId: null },
): CertificationRecord[] {
  const records: CertificationRecord[] = [];

  const lines = section
    .split('\n')
    .map((line) => clean(line.replace(BULLET, '')))
    .filter((line) => line.length > 3);

  for (const line of lines) {
    const dates = findDateRange(line, context.now);
    const parts = line.split(FIELD_SEPARATOR).map(clean).filter(Boolean);

    const name = clean((parts[0] ?? line).replace(/\(?\s*(19|20)\d{2}.*$/, ''));
    if (name.length < 3) continue;

    const issuer =
      parts.slice(1).find((part) => !/(19|20)\d{2}/.test(part) && part.length < 80) ?? null;

    const credentialId =
      /\b(?:credential|certificate|licen[cs]e|id)\s*(?:id|no\.?|#)?\s*[:-]?\s*([A-Z0-9-]{6,})/i.exec(
        line,
      )?.[1] ?? null;

    const credentialUrl = /(https?:\/\/\S+)/.exec(line)?.[1] ?? null;

    const expires = /\b(?:expir\w*|valid\s+until|until)\s*[:-]?\s*([A-Za-z]*\s*\d{4})/i.exec(line)?.[1];

    const parsed = certificationRecordSchema.safeParse({
      id: id('cert', name, issuer),
      name,
      issuer,
      issued: dates?.start ?? partialDateSchema.parse({}),
      expires: expires ? parsePartialDate(expires) : partialDateSchema.parse({}),
      credentialId,
      credentialUrl,
      // Never VERIFIED: nothing here checks anything with an issuer.
      verification: 'UNVERIFIED',
      sourceText: line.slice(0, 2_000),
      confidence: 0.5 + (issuer ? 0.2 : 0) + (dates?.start.year ? 0.2 : 0),
      userVerified: false,
    });

    if (parsed.success) records.push(parsed.data);
  }

  return records;
}

export function extractProjects(
  section: string,
  context: ExtractionContext = { documentId: null },
): ProjectRecord[] {
  const records: ProjectRecord[] = [];

  for (const block of splitBlocks(section)) {
    const lines = block.split('\n');
    const first = clean(lines[0] ?? '');
    if (first.length < 2) continue;

    const name = clean(
      (first.split(FIELD_SEPARATOR)[0] ?? first).replace(/\(?\s*(19|20)\d{2}.*$/, '').replace(BULLET, ''),
    );
    if (name.length < 2 || name.length > 200) continue;

    const links = [...block.matchAll(/(https?:\/\/[^\s)>\]]+)/g)]
      .map((match) => match[1]!)
      .slice(0, 10);

    const body = lines.slice(1).map((line) => clean(line.replace(BULLET, ''))).filter(Boolean);

    /*
     * Professional vs personal.
     *
     * Defaults to `unknown` rather than guessing: a project section in a resume
     * legitimately contains both, and mislabelling a side project as
     * professional experience overstates the evidence in exactly the direction
     * this layer is meant to prevent.
     */
    const context_ =
      /\b(open[- ]source|github|contributed to)\b/i.test(block)
        ? 'open_source'
        : /\b(university|coursework|thesis|dissertation|final year)\b/i.test(block)
          ? 'academic'
          : /\b(client|for\s+\w+\s+(?:ltd|inc|gmbh)|at\s+work|production)\b/i.test(block)
            ? 'professional'
            : /\b(personal|side project|hobby|weekend)\b/i.test(block)
              ? 'personal'
              : 'unknown';

    const outcome =
      body.find((line) =>
        /\b(resulted|achieved|reduced|increased|used by|serving|users|downloads)\b/i.test(line),
      ) ?? null;

    const parsed = projectRecordSchema.safeParse({
      id: id('proj', name),
      name,
      description: body.join(' ').slice(0, 4_000) || null,
      role: /\b(?:role|as)\s*[:-]\s*(.{3,80})/i.exec(block)?.[1]?.trim() ?? null,
      context: context_,
      technologies: [],
      outcome,
      scale: /\b([\d,]+\+?\s*(?:users|customers|requests|records|downloads|MAU|DAU))\b/i.exec(block)?.[1] ?? null,
      links,
      dates: findDateRange(block, context.now) ?? dateRangeSchema.parse({
        start: partialDateSchema.parse({}),
        end: partialDateSchema.parse({}),
      }),
      sourceText: block.slice(0, 4_000),
      confidence: 0.45 + (body.length > 0 ? 0.2 : 0) + (links.length > 0 ? 0.15 : 0),
      userVerified: false,
    });

    if (parsed.success) records.push(parsed.data);
  }

  return records;
}

/**
 * Achievements.
 *
 * The distinction Part 23 asks for is between a distinction and a duty. An
 * award, a scholarship or a competition placement is a third party recognising
 * something; "led the migration" is a description of a job. Only the former is
 * marked `isDistinction`.
 */
const DISTINCTION_MARKERS =
  /\b(award(ed)?|winner|won|first place|runner[- ]up|scholarship|fellowship|prize|medal|dean'?s list|top \d+|selected|finalist|patent|published)\b/i;

const ACHIEVEMENT_KINDS: ReadonlyArray<[RegExp, AchievementRecord['kind']]> = [
  [/\b(award|prize|medal|winner|won)\b/i, 'award'],
  [/\b(scholarship|fellowship|bursary|grant)\b/i, 'scholarship'],
  [/\b(hackathon|competition|contest|olympiad|finalist)\b/i, 'competition'],
  [/\b(published|publication|paper|journal|conference)\b/i, 'publication'],
  [/\b(president|chair|founder|captain|organiser|organizer|lead(er)?)\b/i, 'leadership'],
  [/\b(launched|shipped|released|went live)\b/i, 'launch'],
];

export function extractAchievements(
  section: string,
  context: ExtractionContext = { documentId: null },
): AchievementRecord[] {
  void context;
  const records: AchievementRecord[] = [];

  const lines = section
    .split('\n')
    .map((line) => clean(line.replace(BULLET, '')))
    .filter((line) => line.length > 5);

  for (const line of lines) {
    const kind = ACHIEVEMENT_KINDS.find(([pattern]) => pattern.test(line))?.[1] ?? 'other';
    const year = /\b((?:19|20)\d{2})\b/.exec(line)?.[1];

    const parsed = achievementRecordSchema.safeParse({
      id: id('ach', line.slice(0, 80)),
      title: line.slice(0, 300),
      kind,
      date: year ? parsePartialDate(year) : partialDateSchema.parse({}),
      detail: null,
      isDistinction: DISTINCTION_MARKERS.test(line),
      sourceText: line.slice(0, 2_000),
      confidence: 0.5,
      userVerified: false,
    });

    if (parsed.success) records.push(parsed.data);
  }

  return records;
}

const LANGUAGE_LEVELS: ReadonlyArray<[RegExp, LanguageRecord['proficiency']]> = [
  [/\b(native|mother\s*tongue|first language)\b/i, 'NATIVE'],
  [/\b(fluent|c2|bilingual)\b/i, 'FLUENT'],
  [/\b(professional|business|working proficiency|c1)\b/i, 'PROFESSIONAL'],
  [/\b(conversational|intermediate|b1|b2)\b/i, 'CONVERSATIONAL'],
  [/\b(basic|elementary|beginner|a1|a2)\b/i, 'BASIC'],
];

/**
 * Languages.
 *
 * Proficiency defaults to `UNKNOWN` when the document lists a language with no
 * level — which is the common case, and precisely the situation Part 30
 * addresses. "German" on a resume means German is spoken to *some* degree, not
 * to none and not to any particular one.
 */
export function extractLanguages(section: string): LanguageRecord[] {
  const records: LanguageRecord[] = [];

  const entries = section
    .split(/[\n,;]/)
    .map((entry) => clean(entry.replace(BULLET, '')))
    .filter((entry) => entry.length > 1 && entry.length < 80);

  for (const entry of entries) {
    const level = LANGUAGE_LEVELS.find(([pattern]) => pattern.test(entry))?.[1] ?? 'UNKNOWN';
    const language = clean(
      entry
        .replace(/[(–—-].*$/, '')
        .replace(/\b(native|fluent|professional|conversational|basic|intermediate|beginner|bilingual|mother\s*tongue|[abc][12])\b/gi, '')
        .replace(/[:|]/g, ''),
    );

    if (language.length < 2 || language.length > 40) continue;
    if (!/^[A-Za-z][A-Za-z\s'-]*$/.test(language)) continue;

    const parsed = languageRecordSchema.safeParse({
      language,
      proficiency: level,
      sourceText: entry.slice(0, 400),
      userVerified: false,
    });

    if (parsed.success) records.push(parsed.data);
  }

  return records;
}

/** Convenience: every entity from a set of classified sections. */
export function extractAll(
  sections: readonly DocumentSection[],
  context: ExtractionContext = { documentId: null },
): {
  experience: ExperienceEntry[];
  education: EducationRecord[];
  certifications: CertificationRecord[];
  projects: ProjectRecord[];
  achievements: AchievementRecord[];
  languages: LanguageRecord[];
  summary: string | null;
} {
  const of = (kind: DocumentSection['kind']): string =>
    sections
      .filter((section) => section.kind === kind)
      .map((section) => section.text)
      .join('\n\n');

  return {
    experience: extractExperience(of('experience'), context),
    education: extractEducation(of('education'), context),
    certifications: extractCertifications(of('certifications'), context),
    projects: extractProjects(of('projects'), context),
    achievements: extractAchievements(
      [of('awards'), of('publications')].filter(Boolean).join('\n'),
      context,
    ),
    languages: extractLanguages(of('languages')),
    summary: clean(of('summary')).slice(0, 2_000) || null,
  };
}
