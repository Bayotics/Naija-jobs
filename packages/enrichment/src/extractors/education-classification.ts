import type {
  Classification,
  EducationLevel,
  EducationRequirement,
  JobFunction,
} from '@job-intel/contracts';
import { collapseWhitespace } from '@job-intel/core';
import type { JobSections } from '../cleaning/content-cleaner';

/**
 * Education requirements and job classification.
 *
 * The education rule that matters: a degree is only recorded when the posting
 * states one. Inferring "bachelor's required" because engineering roles usually
 * ask for one would filter out exactly the postings that deliberately do not —
 * and those are often the more accessible ones.
 */

const DEGREE_PATTERNS: Array<{ level: EducationLevel; pattern: RegExp }> = [
  { level: 'doctorate', pattern: /\b(?:ph\.?d\.?|doctorate|doctoral)\b/i },
  { level: 'masters', pattern: /\b(?:master'?s?|m\.?sc\.?|m\.?s\.?|m\.?eng\.?|mba)\b(?:\s+degree)?/i },
  { level: 'bachelors', pattern: /\b(?:bachelor'?s?|b\.?sc\.?|b\.?s\.?|b\.?eng\.?|b\.?a\.?|undergraduate)\b(?:\s+degree)?/i },
  { level: 'diploma', pattern: /\b(?:diploma|hnd|associate'?s?\s+degree|ond)\b/i },
  { level: 'high_school', pattern: /\b(?:high\s+school|secondary\s+school|ssce|waec|ged)\b/i },
];

/** A degree is optional, not required. */
const OPTIONAL_DEGREE_PATTERNS: RegExp[] = [
  /\bdegree\s+(?:is\s+)?(?:not\s+required|optional|not\s+necessary)\b/i,
  /\bno\s+degree\s+(?:required|necessary)\b/i,
  /\bor\s+equivalent\s+(?:practical\s+)?experience\b/i,
  /\bdegree\s+or\s+equivalent\b/i,
  /\bself[\s-]taught\s+(?:candidates?\s+)?welcome\b/i,
];

const PREFERRED_CUES = /\b(?:preferred|nice\s+to\s+have|a\s+plus|desirable|advantageous|ideally)\b/i;
const REQUIRED_CUES = /\b(?:required|must\s+have|essential|minimum)\b/i;

const FIELD_PATTERN =
  /\b(?:degree|bsc|b\.?s\.?|msc|phd)\b[^.]{0,60}?\bin\s+([A-Za-z][A-Za-z\s,/&-]{3,60}?)(?:\s+or\b|[.,;]|$)/i;

const CERTIFICATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\baws\s+certified[\w\s-]{0,40}/i, label: 'AWS Certification' },
  { pattern: /\bazure\s+(?:certified|administrator|solutions\s+architect)\b/i, label: 'Azure Certification' },
  { pattern: /\bcka\b|\bcertified\s+kubernetes\b/i, label: 'Certified Kubernetes Administrator' },
  { pattern: /\bcissp\b/i, label: 'CISSP' },
  { pattern: /\bcism\b/i, label: 'CISM' },
  { pattern: /\bceh\b/i, label: 'CEH' },
  { pattern: /\bpmp\b/i, label: 'PMP' },
  { pattern: /\bprince2\b/i, label: 'PRINCE2' },
  { pattern: /\bcsm\b|\bcertified\s+scrum\s+master\b/i, label: 'Certified ScrumMaster' },
  { pattern: /\bacca\b/i, label: 'ACCA' },
  { pattern: /\bcpa\b/i, label: 'CPA' },
  { pattern: /\bcfa\b/i, label: 'CFA' },
];

export function extractEducation(input: {
  description: string | null;
  sections: JobSections;
}): EducationRequirement {
  const result: EducationRequirement = {
    level: null,
    requirement: 'not_specified',
    fields: [],
    certifications: [],
    confidence: 0.9, // confident that nothing was stated
    method: 'default',
    evidence: null,
  };

  const text = input.description ?? '';
  if (!text) return result;

  // Certifications are independent of degree level.
  result.certifications = CERTIFICATION_PATTERNS.filter((c) => c.pattern.test(text))
    .map((c) => c.label)
    .slice(0, 10);

  const explicitlyOptional = OPTIONAL_DEGREE_PATTERNS.some((p) => p.test(text));

  // Highest degree mentioned wins — "BSc required, MSc preferred" is a
  // bachelor's requirement, so the *requirement* is read from context below.
  let match: { level: EducationLevel; text: string; index: number } | null = null;
  for (const rule of DEGREE_PATTERNS) {
    const hit = rule.pattern.exec(text);
    if (hit) {
      match = { level: rule.level, text: hit[0], index: hit.index };
      break;
    }
  }

  if (!match) {
    if (result.certifications.length > 0) {
      result.method = 'pattern';
      result.evidence = `certifications mentioned: ${result.certifications.join(', ')}`;
    }
    return result;
  }

  // Read the requirement strength from the sentence around the mention, and
  // from which section it appeared in.
  const window = collapseWhitespace(
    text.slice(Math.max(0, match.index - 150), match.index + match.text.length + 150),
  );
  const inPreferredSection = input.sections.preferredQualifications.some((line) =>
    DEGREE_PATTERNS.some((r) => r.pattern.test(line)),
  );
  const inRequiredSection = input.sections.requirements.some((line) =>
    DEGREE_PATTERNS.some((r) => r.pattern.test(line)),
  );

  let requirement: EducationRequirement['requirement'] = 'not_specified';
  let confidence = 0.5;

  if (explicitlyOptional) {
    requirement = 'preferred';
    confidence = 0.85;
  } else if (inPreferredSection || PREFERRED_CUES.test(window)) {
    requirement = 'preferred';
    confidence = 0.85;
  } else if (inRequiredSection || REQUIRED_CUES.test(window)) {
    requirement = 'required';
    confidence = 0.85;
  } else {
    // Mentioned with no cue: record the level but do not claim it is required.
    requirement = 'not_specified';
    confidence = 0.45;
  }

  const fieldMatch = FIELD_PATTERN.exec(text);
  const fields = fieldMatch?.[1]
    ? fieldMatch[1]
        .split(/,|\/|\bor\b|&/)
        .map((f) => collapseWhitespace(f))
        .filter((f) => f.length > 2 && f.length < 60)
        .slice(0, 5)
    : [];

  return {
    level: match.level,
    requirement,
    fields,
    certifications: result.certifications,
    confidence,
    method: 'pattern',
    evidence: window.slice(0, 400),
  };
}

// ── Classification ──────────────────────────────────────────────────────────

const FUNCTION_RULES: Array<{ fn: JobFunction; patterns: RegExp[]; weight: number }> = [
  { fn: 'devops_sre', weight: 90, patterns: [/\bdevops\b/i, /\bsite reliability\b/i, /\bsre\b/i, /\bplatform engineer\b/i, /\binfrastructure engineer\b/i] },
  { fn: 'security', weight: 88, patterns: [/\bsecurity engineer\b/i, /\bcyber\s?security\b/i, /\bappsec\b/i, /\bpenetration test/i, /\bsoc analyst\b/i] },
  { fn: 'data', weight: 86, patterns: [/\bdata (?:engineer|scientist|analyst)\b/i, /\bmachine learning\b/i, /\bml engineer\b/i, /\banalytics engineer\b/i, /\bbusiness intelligence\b/i] },
  { fn: 'qa', weight: 84, patterns: [/\b(?:qa|quality assurance) (?:engineer|analyst)\b/i, /\btest (?:engineer|automation)\b/i, /\bsdet\b/i] },
  { fn: 'design', weight: 82, patterns: [/\b(?:ux|ui|product) designer\b/i, /\bgraphic designer\b/i, /\buser experience\b/i] },
  { fn: 'product', weight: 80, patterns: [/\bproduct manager\b/i, /\bproduct owner\b/i, /\bproduct lead\b/i] },
  { fn: 'software_engineering', weight: 78, patterns: [/\b(?:software|frontend|backend|full[\s-]?stack|web|mobile|application) (?:engineer|developer)\b/i, /\bprogrammer\b/i, /\bengineer\b/i, /\bdeveloper\b/i] },
  { fn: 'it_support', weight: 70, patterns: [/\bit support\b/i, /\bhelpdesk\b/i, /\bsystem administrator\b/i, /\bnetwork (?:engineer|administrator)\b/i] },
  { fn: 'sales', weight: 68, patterns: [/\bsales (?:representative|manager|executive)\b/i, /\baccount executive\b/i, /\bbusiness development\b/i] },
  { fn: 'marketing', weight: 66, patterns: [/\bmarketing\b/i, /\bseo\b/i, /\bcontent (?:writer|strategist)\b/i, /\bgrowth\b/i] },
  { fn: 'finance', weight: 64, patterns: [/\baccountant\b/i, /\bfinancial analyst\b/i, /\bfinance manager\b/i, /\bauditor\b/i, /\bbookkeep/i] },
  { fn: 'hr', weight: 62, patterns: [/\b(?:hr|human resources)\b/i, /\brecruit(?:er|ment)\b/i, /\btalent acquisition\b/i, /\bpeople operations\b/i] },
  { fn: 'legal', weight: 60, patterns: [/\blegal counsel\b/i, /\blawyer\b/i, /\bparalegal\b/i, /\bcompliance officer\b/i] },
  { fn: 'healthcare', weight: 58, patterns: [/\bnurse\b/i, /\bphysician\b/i, /\bmedical officer\b/i, /\bpharmacist\b/i, /\bclinical\b/i] },
  { fn: 'education', weight: 56, patterns: [/\bteacher\b/i, /\blecturer\b/i, /\btutor\b/i, /\binstructor\b/i] },
  { fn: 'operations', weight: 50, patterns: [/\boperations (?:manager|analyst)\b/i, /\bsupply chain\b/i, /\blogistics\b/i, /\bwarehouse\b/i] },
];

const INDUSTRY_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'FinTech', pattern: /\bfintech\b|\bpayments?\s+(?:platform|company)\b|\bbanking\b|\bneobank\b/i },
  { label: 'Healthcare', pattern: /\bhealth\s?(?:care|tech)\b|\bmedical\b|\bclinical\b|\bpatient\b/i },
  { label: 'E-commerce', pattern: /\be-?commerce\b|\bonline retail\b|\bmarketplace\b/i },
  { label: 'AI/ML', pattern: /\b(?:artificial intelligence|machine learning|generative ai|llm)\b/i },
  { label: 'Cybersecurity', pattern: /\bcyber\s?security\b|\binfosec\b/i },
  { label: 'Cloud', pattern: /\bcloud (?:platform|infrastructure|provider)\b|\bsaas\b/i },
  { label: 'Gaming', pattern: /\bgam(?:e|ing)\s+(?:studio|development|industry)\b/i },
  { label: 'EdTech', pattern: /\bed-?tech\b|\be-?learning\b/i },
  { label: 'Consulting', pattern: /\bconsult(?:ing|ancy)\b|\bprofessional services\b/i },
  { label: 'Government', pattern: /\bgovernment\b|\bpublic sector\b|\bfederal\b|\bministry\b/i },
  { label: 'Telecommunications', pattern: /\btelecom(?:munications)?\b/i },
  { label: 'Energy', pattern: /\boil (?:and|&) gas\b|\brenewable energy\b|\bsolar\b|\bpower sector\b/i },
  { label: 'Logistics', pattern: /\blogistics\b|\bsupply chain\b|\bfreight\b/i },
  { label: 'Manufacturing', pattern: /\bmanufacturing\b|\bproduction plant\b|\bfactory\b/i },
  { label: 'Real Estate', pattern: /\breal estate\b|\bproperty (?:management|development)\b/i },
  { label: 'Media', pattern: /\bmedia\b|\bpublishing\b|\bbroadcast\b|\bstreaming\b/i },
];

export function classifyJob(input: {
  title: string;
  description: string | null;
  companyName: string;
  tags?: readonly string[];
}): Classification {
  const title = input.title;
  const body = (input.description ?? '').slice(0, 4000);
  const tagText = (input.tags ?? []).join(' ');

  // The title decides the function; the body only breaks ties. A description
  // mentioning "we use machine learning" does not make a sales role a data role.
  let best: { fn: JobFunction; weight: number; evidence: string } | null = null;
  for (const rule of FUNCTION_RULES) {
    for (const pattern of rule.patterns) {
      const inTitle = pattern.exec(title);
      if (inTitle) {
        if (!best || rule.weight > best.weight) {
          best = { fn: rule.fn, weight: rule.weight, evidence: `title matched "${inTitle[0]}"` };
        }
        break;
      }
    }
  }

  let functionConfidence = 0.85;
  if (!best) {
    functionConfidence = 0.45;
    for (const rule of FUNCTION_RULES) {
      for (const pattern of rule.patterns) {
        const hit = pattern.exec(`${tagText} ${body}`);
        if (hit) {
          if (!best || rule.weight > best.weight) {
            best = { fn: rule.fn, weight: rule.weight, evidence: `body matched "${hit[0]}"` };
          }
          break;
        }
      }
    }
  }

  const haystack = `${title} ${input.companyName} ${tagText} ${body}`;
  const industries = INDUSTRY_RULES.filter((r) => r.pattern.test(haystack))
    .map((r) => r.label)
    .slice(0, 5);

  return {
    jobFunction: best?.fn ?? 'other',
    functionConfidence: best ? functionConfidence : 0,
    industries,
    // Industry cues are genuinely weak — a mention is not a sector.
    industryConfidence: industries.length > 0 ? 0.5 : 0,
    method: best ? 'pattern' : 'default',
    evidence: best?.evidence ?? 'no job function matched',
  };
}
