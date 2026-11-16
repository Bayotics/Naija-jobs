import { createHash } from 'node:crypto';
import {
  parsedRequirementSchema,
  type EducationLevel,
  type JobEnrichment,
  type ParsedRequirementRecord,
  type RequirementImportance,
  type RequirementType,
} from '@job-intel/contracts';
import { normaliseSkill, findSkillsInText } from '@job-intel/resume';

/**
 * Requirement extraction.
 *
 * The enrichment layer already pulls structured fields out of a posting —
 * skills, years, education, work authorisation. This module does something
 * narrower and complementary: it reads the *requirement prose*, the bulleted
 * lists under "Requirements" and "Nice to have", and turns each line into a
 * checkable claim with its importance and its source sentence attached.
 *
 * Two things make that worth doing separately.
 *
 * **Importance is carried in the surrounding text, not the skill.** "React"
 * under a heading called *Required* and "React" in a sentence beginning "Bonus
 * points for" are the same token and completely different demands. A skill
 * extractor that only sees the token cannot tell them apart, and a system that
 * treats "Rust is a plus" as a requirement will recommend skipping jobs the
 * candidate would walk into.
 *
 * **A requirement must be quotable.** Every record here keeps the sentence it
 * came from, so the candidate can see the posting's own words next to the
 * system's reading of them and disagree when the reading is wrong.
 */

const id = (...parts: Array<string | null>): string =>
  createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 16);

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * Phrases that mark what follows as optional.
 *
 * Ordered longest-intent first: "would be a plus" must be tested before "plus"
 * so that a line reading "a plus" is not caught by a generic word match.
 */
const PREFERRED_MARKERS: readonly RegExp[] = [
  /\b(nice[\s-]to[\s-]have|good[\s-]to[\s-]have)\b/i,
  /\b(would|will)\s+be\s+(a\s+)?(big\s+)?(plus|bonus|advantage)\b/i,
  /\bbonus\s+(points|if)\b/i,
  /\b(is|are)\s+a\s+(plus|bonus|advantage)\b/i,
  /\b(preferred|preferable|desirable|advantageous)\b/i,
  /\b(ideally|preferably)\b/i,
  /\bfamiliarity\s+with\b/i,
  /\bexposure\s+to\b/i,
  /\bany\s+of\s+the\s+following\b/i,
];

const NICE_TO_HAVE_MARKERS: readonly RegExp[] = [
  /\b(nice[\s-]to[\s-]have)\b/i,
  /\b(is|are)\s+a\s+plus\b/i,
  /\bbonus\s+points\b/i,
  /\bnot\s+required\b/i,
  /\boptional\b/i,
];

const REQUIRED_MARKERS: readonly RegExp[] = [
  /\b(must|required|requirement|mandatory|essential|non[\s-]negotiable)\b/i,
  /\byou\s+(will\s+)?(need|have)\b/i,
  /\bwe\s+require\b/i,
  /\bminimum\b/i,
  /\bproven\s+(experience|track\s+record)\b/i,
  /\bdemonstrable\b/i,
];

/**
 * Section headings that set the default importance for the lines beneath them.
 *
 * This is the highest-signal cue in a posting and the cheapest to read: a
 * bullet under "Nice to have" is optional even when its own text is silent.
 */
const SECTION_IMPORTANCE: ReadonlyArray<[RegExp, RequirementImportance]> = [
  [/\b(nice[\s-]to[\s-]have|bonus|pluses?)\b/i, 'nice_to_have'],
  [/\b(preferred|desirable|good[\s-]to[\s-]have|advantageous)\s*(qualifications?|skills?|experience)?\b/i, 'preferred'],
  [/\b(requirements?|qualifications?|must[\s-]have|what\s+you.{0,4}ll\s+need|who\s+you\s+are|about\s+you)\b/i, 'required'],
];

/** Requirement type cues, ordered so the most specific wins. */
const TYPE_PATTERNS: ReadonlyArray<[RegExp, RequirementType]> = [
  [/\b(work\s+(authorization|authorisation|permit)|authoris?[ez]?(ed|ation)\s+to\s+work|right\s+to\s+work|visa|sponsorship|citizen(ship)?|security\s+clearance|eligible\s+to\s+work)\b/i, 'work_authorization'],
  [/\b(licen[cs]ed?|licensure|registered\s+(nurse|engineer|architect)|bar\s+admission|practising\s+certificate)\b/i, 'license'],
  [/\b(certifi(ed|cation)|aws\s+certified|pmp\b|cissp|cpa\b|scrum\s+master\s+certif)/i, 'certification'],
  [/\b(bachelor|master|phd|doctorate|degree|bsc|msc|b\.?s\.?\b|m\.?s\.?\b|university\s+degree|diploma)\b/i, 'education'],
  [/\b(fluent|native|proficien\w*\s+in|speak|written\s+and\s+spoken|[abc][12]\s+level|language\s+skills)\b.*\b(english|german|french|spanish|dutch|italian|portuguese|polish|mandarin|japanese|arabic|swedish|danish|norwegian|finnish)\b/i, 'language'],
  [/\b(english|german|french|spanish|dutch|italian|portuguese|polish|mandarin|japanese|arabic|swedish|danish|norwegian|finnish)\b.*\b([abc][12]|fluent|native|business\s+level|professional\s+working)\b/i, 'language'],
  [/\b(\d+\+?\s*(years?|yrs?))\b/i, 'experience_years'],
  [/\b(based\s+in|located\s+in|onsite|on[\s-]site|hybrid|relocat\w+|commut\w+|office\s+in|timezone|time\s+zone)\b/i, 'location'],
  [/\b(full[\s-]time|part[\s-]time|contract|freelance|permanent|temporary|internship)\b/i, 'employment_type'],
  [/\b(senior|junior|mid[\s-]level|staff|principal|lead|manager|director|head\s+of)\b/i, 'seniority'],
  [/\b(fintech|healthcare|e[\s-]?commerce|saas|banking|insurance|logistics|gaming|biotech|edtech|govtech)\b/i, 'industry'],
  [/\b(communicat\w+|collaborat\w+|team\s?work|stakeholder|mentor\w*|leadership|problem[\s-]solving|self[\s-]start\w+|attention\s+to\s+detail|ownership)\b/i, 'soft_skill'],
  [/\b(available|start\s+(date|immediately)|notice\s+period|on[\s-]call)\b/i, 'availability'],
];

const CEFR = /\b([ABC][12])\b/;

const LANGUAGE_NAMES: readonly string[] = [
  'english', 'german', 'french', 'spanish', 'dutch', 'italian', 'portuguese', 'polish',
  'mandarin', 'chinese', 'japanese', 'korean', 'arabic', 'hebrew', 'russian', 'turkish',
  'swedish', 'danish', 'norwegian', 'finnish', 'czech', 'greek', 'hindi',
];

const EDUCATION_PATTERNS: ReadonlyArray<[RegExp, EducationLevel]> = [
  [/\b(ph\.?d|doctorate|doctoral)\b/i, 'doctorate'],
  [/\b(master|msc|m\.?s\.?c?\b|mba|m\.?eng)\b/i, 'masters'],
  [/\b(bachelor|bsc|b\.?s\.?c?\b|b\.?eng|undergraduate\s+degree)\b/i, 'bachelors'],
  [/\b(diploma|associate\s+degree|foundation\s+degree)\b/i, 'diploma'],
  [/\b(high\s+school|secondary\s+school|a[\s-]levels?|gcse)\b/i, 'high_school'],
];

/** Years demanded, from the several ways postings write it. */
export function extractYears(text: string): number | null {
  // "5+ years", "3-5 years", "at least 4 years", "minimum of 2 years"
  const range = /(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i.exec(text);
  if (range) return Number(range[1]);

  const plain = /(?:at\s+least\s+|minimum\s+(?:of\s+)?|min\.?\s*|over\s+)?(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i.exec(text);
  if (!plain) return null;

  const years = Number(plain[1]);
  // A posting asking for 40 years of anything is a parse error, not a demand.
  return years >= 0 && years <= 30 ? years : null;
}

/** The importance a line's own wording implies, or null when it is silent. */
export function importanceFromText(text: string): RequirementImportance | null {
  if (NICE_TO_HAVE_MARKERS.some((pattern) => pattern.test(text))) return 'nice_to_have';
  if (PREFERRED_MARKERS.some((pattern) => pattern.test(text))) return 'preferred';
  if (REQUIRED_MARKERS.some((pattern) => pattern.test(text))) return 'required';
  return null;
}

/** The importance a section heading sets for the lines beneath it. */
export function importanceFromHeading(heading: string): RequirementImportance | null {
  for (const [pattern, importance] of SECTION_IMPORTANCE) {
    if (pattern.test(heading)) return importance;
  }
  return null;
}

export function requirementTypeOf(text: string): RequirementType {
  for (const [pattern, type] of TYPE_PATTERNS) {
    if (pattern.test(text)) return type;
  }
  // A line naming a known technology and nothing else is a technical skill.
  return findSkillsInText(text).length > 0 ? 'technical_skill' : 'other';
}

function educationLevelOf(text: string): EducationLevel | null {
  for (const [pattern, level] of EDUCATION_PATTERNS) {
    if (pattern.test(text)) return level;
  }
  return null;
}

function languageOf(text: string): { language: string; level: string | null } | null {
  const lower = text.toLowerCase();
  const language = LANGUAGE_NAMES.find((name) => new RegExp(`\\b${name}\\b`).test(lower));
  if (!language) return null;

  const cefr = CEFR.exec(text);
  if (cefr) return { language, level: cefr[1]!.toUpperCase() };

  if (/\bnative\b/i.test(text)) return { language, level: 'C2' };
  if (/\b(fluent|full\s+professional)\b/i.test(text)) return { language, level: 'C1' };
  if (/\b(business\s+level|professional\s+working)\b/i.test(text)) return { language, level: 'B2' };
  if (/\b(conversational|working\s+knowledge)\b/i.test(text)) return { language, level: 'B1' };

  return { language, level: null };
}

export interface ExtractionInput {
  /** Lines the enrichment layer identified as requirements. */
  requirements: readonly string[];
  /** Lines it identified as preferred qualifications. */
  preferredQualifications: readonly string[];
  responsibilities?: readonly string[];
  /** Cleaned description, used for headings and for cues nothing else caught. */
  description?: string | null;
  /** Structured fields already extracted upstream. */
  enrichment?: JobEnrichment | null;
}

/**
 * The skills a requirement line names.
 *
 * Reads the taxonomy terms *out of* the sentence rather than trying to
 * normalise the sentence as a whole. "React is required" and "5+ years with
 * React, TypeScript and GraphQL" are both one bullet carrying named
 * technologies, and normalising the whole string produces a slug like
 * `react-is-required` that matches nothing and silently loses the requirement.
 *
 * A short line that is itself exactly a skill name is also accepted, so an
 * unrecognised technology on its own bullet — "Zephyr RTOS" — is still captured
 * rather than dropped for not being in the seed taxonomy.
 */
function skillsInLine(line: string): Array<{ slug: string; name: string; category: string }> {
  const found = findSkillsInText(line);
  if (found.length > 0) {
    return found.map((skill) => ({ slug: skill.slug, name: skill.name, category: skill.category }));
  }

  if (line.split(/\s+/).length > 4) return [];

  /*
   * Guard against manufacturing a skill out of prose.
   *
   * Without this, "4+ years platform engineering" normalises to a slug of
   * `4-years-platform-engineering`, which matches nothing in any profile and
   * therefore reads as a required skill the candidate does not have. That is a
   * fabricated requirement producing a fabricated gap — the worst failure mode
   * available to this module.
   */
  if (/\d/.test(line)) return [];
  if (/\b(years?|yrs?|experience|required|preferred|strong|proven|excellent|ability|knowledge|understanding|background|degree|plus|bonus)\b/i.test(line)) {
    return [];
  }

  const normalised = normaliseSkill(line);
  return normalised
    ? [{ slug: normalised.slug, name: normalised.name, category: normalised.category }]
    : [];
}

/**
 * Reads a posting's requirement prose into checkable records.
 *
 * Deduplicated by (type, slug-or-text): a posting that lists React under both
 * Requirements and Nice-to-have should produce one requirement at the stronger
 * importance, not two that disagree.
 */
export function extractRequirements(input: ExtractionInput): ParsedRequirementRecord[] {
  const found = new Map<string, ParsedRequirementRecord>();

  const push = (candidate: {
    text: string;
    type: RequirementType;
    importance: RequirementImportance;
    slug?: string | null;
    matchedText?: string | null;
    minYears?: number | null;
    educationLevel?: EducationLevel | null;
    languageLevel?: string | null;
    evidence: string | null;
    confidence: number;
  }): void => {
    const text = clean(candidate.text);
    if (text.length < 2 || text.length > 600) return;

    const key = `${candidate.type}:${candidate.slug ?? text.toLowerCase().slice(0, 80)}`;
    const existing = found.get(key);

    const parsed = parsedRequirementSchema.safeParse({
      id: id(key),
      text,
      type: candidate.type,
      importance: candidate.importance,
      slug: candidate.slug ?? null,
      matchedText: candidate.matchedText ?? null,
      minYears: candidate.minYears ?? null,
      educationLevel: candidate.educationLevel ?? null,
      languageLevel: candidate.languageLevel ?? null,
      evidence: candidate.evidence,
      confidence: candidate.confidence,
    });

    if (!parsed.success) return;

    if (!existing) {
      found.set(key, parsed.data);
      return;
    }

    // The stronger statement wins: a posting that says React is required in one
    // place and a bonus in another is asking for React.
    const rank: Record<RequirementImportance, number> = {
      required: 3,
      preferred: 2,
      nice_to_have: 1,
      inferred: 0,
    };

    if (rank[parsed.data.importance] > rank[existing.importance]) {
      found.set(key, { ...parsed.data, confidence: Math.max(parsed.data.confidence, existing.confidence) });
    }
  };

  const readLine = (line: string, sectionImportance: RequirementImportance): void => {
    const text = clean(line.replace(/^[•\-–—*]\s*/, ''));
    if (text.length < 3) return;

    // A line's own wording overrides the section it sits under: "React (nice to
    // have)" under Requirements is still a nice-to-have.
    const importance = importanceFromText(text) ?? sectionImportance;
    const type = requirementTypeOf(text);
    const years = extractYears(text);

    // ── Typed, non-skill requirements ───────────────────────────────────
    if (type === 'language') {
      const language = languageOf(text);
      if (language) {
        push({
          text,
          type: 'language',
          importance,
          languageLevel: language.level,
          matchedText: language.language,
          evidence: text,
          confidence: language.level ? 0.8 : 0.6,
        });
        return;
      }
    }

    if (type === 'education') {
      push({
        text,
        type: 'education',
        importance,
        educationLevel: educationLevelOf(text),
        evidence: text,
        confidence: 0.75,
      });
      return;
    }

    if (
      type === 'work_authorization' ||
      type === 'license' ||
      type === 'certification' ||
      type === 'location' ||
      type === 'availability' ||
      type === 'employment_type' ||
      type === 'seniority' ||
      type === 'industry'
    ) {
      push({ text, type, importance, evidence: text, confidence: 0.7 });
      return;
    }

    /*
     * A years requirement and the skill it attaches to are two claims.
     *
     * "4+ years of React" demands both four years *and* React, and the
     * candidate can fail either independently — six years of engineering with
     * two of React fails the first but not the second.
     */
    if (years !== null) {
      push({
        text,
        type: 'experience_years',
        importance,
        minYears: years,
        evidence: text,
        confidence: 0.8,
      });
    }

    const named = skillsInLine(text);

    for (const skill of named) {
      push({
        text: skill.name,
        type: skill.category === 'soft_skill' ? 'soft_skill' : 'technical_skill',
        importance,
        slug: skill.slug,
        matchedText: skill.name === text ? null : text.slice(0, 200),
        evidence: text,
        confidence: 0.8,
      });
    }

    // Nothing structured came out of it, but the line still says something.
    if (
      years === null &&
      named.length === 0 &&
      type !== 'language' &&
      text.split(/\s+/).length >= 3
    ) {
      push({
        text,
        type: type === 'other' ? 'responsibility' : type,
        importance,
        evidence: text,
        confidence: 0.45,
      });
    }
  };

  for (const line of input.requirements.slice(0, 60)) readLine(line, 'required');
  for (const line of input.preferredQualifications.slice(0, 40)) readLine(line, 'preferred');

  /*
   * Structured fields from enrichment, marked `inferred` unless the posting's
   * own prose already stated them.
   *
   * The extractor above reads what the posting *wrote*; enrichment reads what
   * it *meant*. Both are useful, and only the first can produce a blocker.
   */
  if (input.enrichment) {
    const enrichment = input.enrichment;

    for (const skill of enrichment.skills) {
      const importance: RequirementImportance =
        skill.requirement === 'required'
          ? 'required'
          : skill.requirement === 'preferred'
            ? 'preferred'
            : skill.requirement === 'optional'
              ? 'nice_to_have'
              : 'inferred';

      push({
        text: skill.displayName,
        type: 'technical_skill',
        importance,
        slug: skill.slug,
        matchedText: skill.matchedText,
        evidence: skill.evidence,
        confidence: skill.confidence,
      });
    }

    if (enrichment.experience.minimumYears !== null) {
      push({
        text: `${enrichment.experience.minimumYears}+ years of experience`,
        type: 'experience_years',
        importance: enrichment.experience.qualitativeOnly ? 'inferred' : 'required',
        minYears: enrichment.experience.minimumYears,
        evidence: enrichment.experience.rawText,
        confidence: enrichment.experience.confidence,
      });
    }

    if (enrichment.education.level !== null && enrichment.education.requirement !== 'not_specified') {
      push({
        text: `${enrichment.education.level.replace(/_/g, ' ')} degree`,
        type: 'education',
        importance: enrichment.education.requirement === 'required' ? 'required' : 'preferred',
        educationLevel: enrichment.education.level,
        evidence: enrichment.education.evidence,
        confidence: enrichment.education.confidence,
      });
    }

    for (const certification of enrichment.education.certifications) {
      push({
        text: certification,
        type: 'certification',
        importance: 'preferred',
        evidence: certification,
        confidence: 0.6,
      });
    }

    const authorization = enrichment.workAuthorization;
    if (authorization.workAuthorizationRequirement) {
      push({
        text: authorization.workAuthorizationRequirement,
        type: 'work_authorization',
        importance: 'required',
        evidence: authorization.sponsorshipEvidence ?? authorization.workAuthorizationRequirement,
        confidence: authorization.sponsorshipConfidence,
      });
    }

    if (authorization.securityClearanceRequired) {
      push({
        text: authorization.securityClearanceLevel
          ? `Security clearance: ${authorization.securityClearanceLevel}`
          : 'Security clearance required',
        type: 'license',
        importance: 'required',
        evidence: authorization.securityClearanceLevel,
        confidence: 0.7,
      });
    }
  }

  return [...found.values()].slice(0, 80);
}

/** Requirements that could, if unmet, stop an application. */
export function hardRequirements(
  requirements: readonly ParsedRequirementRecord[],
): ParsedRequirementRecord[] {
  return requirements.filter(
    (requirement) =>
      requirement.importance === 'required' &&
      // An inferred requirement never blocks; neither does one the extractor
      // is barely confident is a requirement at all.
      requirement.confidence >= 0.5,
  );
}
