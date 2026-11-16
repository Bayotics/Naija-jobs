import {
  documentSectionSchema,
  type DocumentSection,
  type SectionKind,
} from '@job-intel/contracts';

/**
 * Resume section detection.
 *
 * Deterministic first, and deterministic for almost everything. Resume headings
 * are drawn from a small vocabulary in practice — "Experience", "Work
 * Experience", "Employment History", "Professional Experience" — and matching
 * that vocabulary is both cheaper and more reliable than asking a model.
 *
 * The genuinely hard cases are the ones the brief names: "Professional
 * Journey", "Where I've Been", "What I Bring". Those are what the optional
 * classifier is for, and they are a small fraction of a small part of the
 * document. Sending the whole resume to a model to find its headings would be
 * the expensive way to solve the easy 95%.
 *
 * A heading is identified structurally before it is classified semantically:
 * short, on its own line, not ending in a sentence, often uppercase or
 * title-case. That structural test is what stops a sentence containing the word
 * "experience" from being read as a section boundary.
 */

/** Canonical heading vocabulary. Order matters: first match wins. */
const HEADING_PATTERNS: ReadonlyArray<{ kind: SectionKind; patterns: RegExp[] }> = [
  {
    kind: 'experience',
    patterns: [
      /^(work|professional|employment|career|relevant)?\s*(experience|history|background)$/i,
      /^employment$/i,
      /^positions?\s*held$/i,
      /^professional\s+journey$/i,
      /^career\s+(summary|highlights|journey|path)$/i,
      /^work\s+history$/i,
    ],
  },
  {
    kind: 'education',
    patterns: [
      /^education(al)?(\s+(background|history|qualifications?))?$/i,
      /^academic(\s+(background|history|qualifications?))?$/i,
      /^qualifications?$/i,
      /^degrees?$/i,
    ],
  },
  {
    kind: 'skills',
    patterns: [
      /^(technical\s+|core\s+|key\s+|professional\s+)?skills?(\s*(&|and)\s*\w+)?$/i,
      /^competenc(y|ies)$/i,
      /^expertise$/i,
      /^technolog(y|ies)$/i,
      /^tech\s*stack$/i,
      /^tools?(\s*(&|and)\s*technologies)?$/i,
      /^what\s+i\s+(bring|know|use)$/i,
    ],
  },
  {
    kind: 'projects',
    patterns: [
      /^(personal\s+|selected\s+|key\s+|side\s+|notable\s+)?projects?$/i,
      /^portfolio$/i,
      /^case\s+studies$/i,
      /^things\s+i('ve)?\s+built$/i,
    ],
  },
  {
    kind: 'certifications',
    patterns: [
      /^certifications?$/i,
      /^certificates?$/i,
      /^licen[cs]es?(\s*(&|and)\s*certifications?)?$/i,
      /^credentials?$/i,
      /^training(\s*(&|and)\s*certifications?)?$/i,
    ],
  },
  {
    kind: 'summary',
    patterns: [
      /^(professional\s+|executive\s+|career\s+)?(summary|profile|overview)$/i,
      /^about(\s+me)?$/i,
      /^objective$/i,
      /^introduction$/i,
      /^who\s+i\s+am$/i,
    ],
  },
  {
    kind: 'awards',
    patterns: [/^awards?(\s*(&|and)\s*\w+)?$/i, /^honou?rs?$/i, /^achievements?$/i, /^recognition$/i],
  },
  {
    kind: 'publications',
    patterns: [/^publications?$/i, /^papers?$/i, /^research$/i, /^talks?(\s*(&|and)\s*\w+)?$/i],
  },
  {
    kind: 'languages',
    patterns: [/^languages?$/i, /^language\s+skills?$/i, /^spoken\s+languages?$/i],
  },
  {
    kind: 'volunteer',
    patterns: [/^volunteer(ing|\s+experience)?$/i, /^community(\s+involvement)?$/i],
  },
  { kind: 'interests', patterns: [/^interests?$/i, /^hobb(y|ies)$/i, /^outside\s+work$/i] },
  {
    kind: 'contact',
    patterns: [/^contact(\s+(details?|information))?$/i, /^details$/i, /^personal\s+details$/i],
  },
];

/**
 * Whether a line is structurally a heading.
 *
 * Deliberately strict. A false positive splits a role description in half and
 * silently loses everything after it, which is far worse than a false negative
 * — an unrecognised heading merely leaves its content in the previous section
 * where the entity extractors will still see it.
 */
export function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();

  if (trimmed.length === 0 || trimmed.length > 60) return false;
  // A heading is not a sentence.
  if (/[.!?]$/.test(trimmed)) return false;
  if (trimmed.startsWith('•')) return false;
  // Contains a date range: that is a role line, not a section heading.
  if (/\b(19|20)\d{2}\b/.test(trimmed)) return false;
  // Contact lines masquerade as short headings.
  if (/@|https?:\/\/|\+\d{2,}/.test(trimmed)) return false;

  /*
   * Separators and lists. "Meridian Labs — Senior Software Engineer" and
   * "React, TypeScript, Python" are both short and title-cased, and both would
   * split a section in half if read as headings. A heading is a phrase; these
   * are records.
   */
  if (/[,|–—·]/.test(trimmed)) return false;

  // "Grade: First Class Honours" is a labelled value, not a heading. A trailing
  // colon with nothing after it still is one.
  if (/^[^:]{1,40}:\s*\S/.test(trimmed)) return false;

  const words = trimmed.split(/\s+/);
  const letters = trimmed.replace(/[^a-z]/gi, '');
  if (letters.length < 3) return false;

  const isUpper = letters === letters.toUpperCase();
  const isTitle = words.every((word) => /^[^a-z]|^[A-Z]/.test(word) || word.length <= 3);
  const endsWithColon = trimmed.endsWith(':');

  // Upper-case headings run longer ("PROFESSIONAL EXPERIENCE & ACHIEVEMENTS");
  // title-case lines that long are almost always content.
  if (words.length > (isUpper ? 6 : 5)) return false;

  return isUpper || isTitle || endsWithColon;
}

/**
 * Whether a structural heading is strong enough to end the previous section.
 *
 * Two acceptable proofs: the vocabulary recognises it, or the document marks it
 * out by capitalising it. Everything else stays where it is — a false boundary
 * silently discards content, while a missed one merely leaves that content in
 * the previous section where the extractors still see it.
 */
export function isSectionBoundary(line: string, kind: SectionKind): boolean {
  if (kind !== 'unknown') return true;
  const letters = line.trim().replace(/[^a-z]/gi, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
}

/** Classifies a heading against the vocabulary. */
export function classifyHeading(
  heading: string,
): { kind: SectionKind; confidence: number } {
  const cleaned = heading
    .trim()
    .replace(/[:•\-–—]+$/, '')
    .replace(/^[•\-–—]+/, '')
    .trim();

  for (const entry of HEADING_PATTERNS) {
    for (const pattern of entry.patterns) {
      if (pattern.test(cleaned)) {
        // An exact vocabulary hit is about as certain as this gets, but never
        // 1: "Projects" under an Experience section is still ambiguous.
        return { kind: entry.kind, confidence: 0.95 };
      }
    }
  }

  // Partial containment: "Technical Skills & Tools" style headings that the
  // anchored patterns miss.
  const lower = cleaned.toLowerCase();
  const containment: Array<[SectionKind, string[]]> = [
    ['experience', ['experience', 'employment', 'career']],
    // Deliberately not "university" or "degree": those are content words that
    // appear in the *body* of an education section, not in its heading.
    ['education', ['education', 'academic', 'qualification']],
    ['skills', ['skill', 'technolog', 'stack', 'competenc', 'proficienc']],
    ['projects', ['project', 'portfolio']],
    ['certifications', ['certif', 'licen', 'credential']],
    ['awards', ['award', 'honor', 'honour', 'achievement']],
    ['publications', ['publication', 'paper', 'research']],
    ['languages', ['language']],
    ['summary', ['summary', 'profile', 'objective', 'about']],
    ['volunteer', ['volunteer', 'community']],
  ];

  for (const [kind, needles] of containment) {
    if (needles.some((needle) => lower.includes(needle))) {
      return { kind, confidence: 0.7 };
    }
  }

  return { kind: 'unknown', confidence: 0.2 };
}

/** Optional model, used only for headings the vocabulary could not place. */
export interface HeadingClassifier {
  readonly model: string;
  classify(input: { heading: string; excerpt: string }): Promise<{ kind: string; confidence: number }>;
}

export interface SectionOptions {
  classifier?: HeadingClassifier | null;
  /** Cap on model calls, so an odd document cannot become expensive. */
  maxClassifierCalls?: number;
}

/**
 * Splits a document into sections.
 *
 * Everything before the first recognised heading becomes a `contact` section:
 * that is where names, emails and phone numbers live, and treating it as
 * `unknown` would send it to entity extractors that have no use for it.
 */
export async function detectSections(
  text: string,
  options: SectionOptions = {},
): Promise<DocumentSection[]> {
  const lines = text.split('\n');
  const sections: DocumentSection[] = [];

  interface Pending {
    heading: string;
    kind: SectionKind;
    confidence: number;
    aiClassified: boolean;
    startOffset: number;
    bodyStart: number;
  }

  let offset = 0;
  let current: Pending | null = null;
  let bodyLines: string[] = [];
  let classifierCalls = 0;
  const maxCalls = options.maxClassifierCalls ?? 6;

  const flush = (endOffset: number): void => {
    if (!current) return;
    const body = bodyLines.join('\n').trim();
    if (body.length === 0 && current.kind === 'unknown') {
      current = null;
      bodyLines = [];
      return;
    }

    const parsed = documentSectionSchema.safeParse({
      kind: current.kind,
      heading: current.heading,
      startOffset: current.startOffset,
      endOffset,
      text: body.slice(0, 100_000),
      confidence: current.confidence,
      aiClassified: current.aiClassified,
    });

    if (parsed.success) sections.push(parsed.data);
    current = null;
    bodyLines = [];
  };

  // The preamble, before any heading.
  const preamble: string[] = [];
  let preambleEnd = 0;
  let seenHeading = false;

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;

    if (looksLikeHeading(line)) {
      const classified = classifyHeading(line);

      // Only a genuinely unplaceable heading is worth a model call.
      let kind = classified.kind;
      let confidence = classified.confidence;
      let aiClassified = false;

      /*
       * The model is asked only about lines the *document* marks as headings —
       * capitalised, or ending in a colon — and that the vocabulary could not
       * place. A title-cased line the vocabulary does not recognise is
       * indistinguishable from a role header ("Meridian Labs"), and sending
       * those to a model costs money to produce a coin flip.
       */
      if (
        kind === 'unknown' &&
        isSectionBoundary(line, kind) &&
        options.classifier &&
        classifierCalls < maxCalls
      ) {
        classifierCalls += 1;
        try {
          const result = await options.classifier.classify({
            heading: line.trim(),
            excerpt: lines.slice(lines.indexOf(line) + 1, lines.indexOf(line) + 6).join('\n'),
          });
          const candidate = documentSectionSchema.shape.kind.safeParse(result.kind);
          if (candidate.success) {
            kind = candidate.data;
            confidence = Math.min(0.8, Math.max(0, result.confidence));
            aiClassified = true;
          }
        } catch {
          // A classifier failure leaves the heading unknown, which is a
          // perfectly workable outcome — its content still gets extracted.
        }
      }

      /*
       * A structurally heading-shaped line that neither the vocabulary nor the
       * classifier could place, and which the document did not capitalise, is
       * left as content. Splitting on it would silently move everything below
       * into a section nothing reads.
       */
      if (!aiClassified && !isSectionBoundary(line, kind)) {
        if (current) bodyLines.push(line);
        else preamble.push(line);
        continue;
      }

      if (!seenHeading) {
        preambleEnd = lineStart;
        seenHeading = true;
      }

      flush(lineStart);
      current = {
        heading: line.trim(),
        kind,
        confidence,
        aiClassified,
        startOffset: lineStart,
        bodyStart: offset,
      };
      continue;
    }

    if (current) bodyLines.push(line);
    else preamble.push(line);
  }

  flush(offset);

  if (preamble.join('').trim().length > 0) {
    const parsed = documentSectionSchema.safeParse({
      kind: 'contact',
      heading: '(header)',
      startOffset: 0,
      endOffset: seenHeading ? preambleEnd : offset,
      text: preamble.join('\n').trim().slice(0, 100_000),
      confidence: 0.6,
      aiClassified: false,
    });
    if (parsed.success) sections.unshift(parsed.data);
  }

  return sections;
}

/** All text belonging to one kind, concatenated. */
export function sectionText(sections: readonly DocumentSection[], kind: SectionKind): string {
  return sections
    .filter((section) => section.kind === kind)
    .map((section) => section.text)
    .join('\n\n');
}
