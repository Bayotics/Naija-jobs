import {
  preferenceProposalSchema,
  proposalBundleSchema,
  type CandidatePreferences,
  type PreferenceProposal,
  type ProposalBundle,
} from '@job-intel/contracts';

/**
 * Natural-language preference changes.
 *
 * The hard rule: **a language model never mutates the database.** The flow is
 *
 *   natural language → proposals → schema validation → human confirmation →
 *   the same named mutation a UI edit would use
 *
 * so an instruction can only ever produce a change the API already permits.
 * Nothing here executes anything; `parse` returns proposals and the caller
 * decides.
 *
 * A deterministic parser handles the common phrasings. It exists partly because
 * it is free and reliable, and partly because it makes the *shape* of a valid
 * proposal concrete — an LLM provider slots in behind the same interface and
 * its output goes through the identical validation.
 */

export interface NaturalLanguageProvider {
  readonly id: string;
  isAvailable(): boolean;
  propose(input: {
    instruction: string;
    current: CandidatePreferences;
  }): Promise<{ proposals: unknown[]; unparsed: string[] }>;
}

interface Rule {
  name: string;
  pattern: RegExp;
  build(match: RegExpMatchArray, current: CandidatePreferences): PreferenceProposal[] | null;
}

const CURRENCY_BY_SYMBOL: Record<string, string> = {
  '$': 'USD', '£': 'GBP', '€': 'EUR', '₦': 'NGN',
};

function amount(raw: string, suffix?: string): number | null {
  const value = Number(raw.replace(/[,\s]/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  return suffix?.toLowerCase() === 'k' ? value * 1000 : value;
}

/**
 * Deterministic rules, ordered most-specific-first.
 *
 * Each returns a *proposal*, never a mutation, and carries the phrase it came
 * from so the confirmation dialog can quote the user back to themselves.
 */
const RULES: Rule[] = [
  {
    name: 'no_more_remote',
    pattern: /\b(?:i\s+)?(?:don'?t|do not|no longer)\s+want\s+remote\b|\bno more remote\b/i,
    build: (m) => [
      {
        path: 'workArrangement',
        operation: 'set',
        value: 'ONSITE_PREFERRED',
        summary: 'Stop preferring remote roles; prefer on-site instead',
        confidence: 0.7,
        sourceText: m[0],
      },
    ],
  },
  {
    name: 'remote_only',
    pattern: /\b(?:only|exclusively)\s+remote\b|\bremote\s+only\b/i,
    build: (m) => [
      {
        path: 'workArrangement',
        operation: 'set',
        value: 'REMOTE_ONLY',
        summary: 'Only consider fully remote roles',
        confidence: 0.9,
        sourceText: m[0],
      },
    ],
  },
  {
    name: 'hybrid_ok',
    pattern: /\b(?:i'?m\s+)?(?:ok(?:ay)?|fine|happy|open)\s+with\s+hybrid\b|\bhybrid\s+is\s+(?:ok|fine)\b/i,
    build: (m) => [
      {
        path: 'workArrangement',
        operation: 'set',
        value: 'HYBRID_ACCEPTED',
        summary: 'Accept hybrid roles',
        confidence: 0.85,
        sourceText: m[0],
      },
    ],
  },
  {
    name: 'max_office_days',
    pattern: /\b(?:don'?t|do not)\s+(?:show|want).{0,40}?(\d)\s*days?\s+in\s+the\s+office\b/i,
    build: (m) => {
      const days = Number(m[1]);
      if (!Number.isFinite(days)) return null;
      // "don't show me five days in the office" means the acceptable maximum is
      // one below what was named.
      const max = Math.max(0, days - 1);
      return [
        {
          path: 'maxOfficeDaysPerWeek',
          operation: 'set',
          value: max,
          summary: `Reject roles requiring ${days} or more office days per week (max ${max})`,
          confidence: 0.7,
          sourceText: m[0],
        },
      ];
    },
  },
  {
    name: 'salary_floor',
    pattern: /\b(?:nothing|don'?t show|no jobs?)\s+(?:me\s+)?(?:anything\s+)?below\s+([$£€₦]?)\s?([\d,]+)\s*(k)?\b/i,
    build: (m) => {
      const value = amount(m[2] ?? '', m[3]);
      if (value === null) return null;
      const proposals: PreferenceProposal[] = [
        {
          path: 'salary.minimum',
          operation: 'set',
          value,
          summary: `Set the minimum salary to ${value.toLocaleString()}`,
          confidence: 0.85,
          sourceText: m[0],
        },
        {
          path: 'salary.minimumIsHard',
          operation: 'set',
          value: true,
          summary: 'Treat the minimum salary as a hard requirement',
          confidence: 0.7,
          sourceText: m[0],
        },
      ];
      const currency = CURRENCY_BY_SYMBOL[m[1] ?? ''];
      if (currency) {
        proposals.push({
          path: 'salary.currency',
          operation: 'set',
          value: currency,
          summary: `Set the salary currency to ${currency}`,
          confidence: 0.9,
          sourceText: m[0],
        });
      }
      return proposals;
    },
  },
  {
    name: 'prefer_countries',
    // "to work in", "work in" and a bare "in" all occur; each part is optional.
    pattern: /\b(?:i'?d\s+)?(?:rather|prefer(?:ably)?|want)\s+(?:to\s+)?(?:work\s+)?in\s+([A-Za-z][\w\s]*(?:\s+(?:or|and)\s+[A-Za-z][\w\s]*)*)/i,
    build: (m) => {
      const names = (m[1] ?? '')
        .split(/\s+(?:or|and)\s+|,/)
        .map((n) => n.trim())
        .filter((n) => n.length > 1 && n.length < 40);
      if (names.length === 0) return null;
      return names.map((name) => ({
        path: 'countries',
        operation: 'add' as const,
        value: { value: name, strength: 'strongly_preferred', hard: false, note: null, source: 'explicit' },
        summary: `Prefer working in ${name}`,
        confidence: 0.6,
        sourceText: m[0],
      }));
    },
  },
  {
    name: 'want_titles_open_to',
    pattern: /\bi\s+want\s+([\w\s-]+?)\s+roles?\b(?:.{0,40}?\b(?:open to|also)\s+([\w\s-]+?)\s+(?:roles?|positions?)\b)?/i,
    build: (m) => {
      const proposals: PreferenceProposal[] = [];
      const primary = m[1]?.trim();
      const secondary = m[2]?.trim();
      if (primary) {
        proposals.push({
          path: 'titles',
          operation: 'add',
          value: { value: primary, strength: 'strongly_preferred', hard: false, note: null, source: 'explicit' },
          summary: `Prefer ${primary} roles`,
          confidence: 0.65,
          sourceText: m[0],
        });
      }
      if (secondary) {
        proposals.push({
          path: 'titles',
          operation: 'add',
          value: { value: secondary, strength: 'preferred', hard: false, note: null, source: 'explicit' },
          summary: `Also consider ${secondary} roles`,
          confidence: 0.6,
          sourceText: m[0],
        });
      }
      return proposals.length > 0 ? proposals : null;
    },
  },
  {
    name: 'exclude_technology',
    pattern: /\b(?:don'?t|do not|never)\s+(?:want|show).{0,30}?\b(?:jobs?\s+)?(?:with|using|requiring)\s+([\w.+#-]{2,30})\b/i,
    build: (m) => {
      const tech = m[1]?.trim();
      if (!tech) return null;
      return [
        {
          path: 'technologies',
          operation: 'add',
          value: { value: tech, strength: 'excluded', hard: true, note: null, source: 'explicit' },
          summary: `Exclude jobs requiring ${tech}`,
          confidence: 0.7,
          sourceText: m[0],
        },
      ];
    },
  },
  {
    name: 'need_sponsorship',
    pattern: /\bi\s+need\s+(?:visa\s+)?sponsorship\b|\brequire\s+visa\s+sponsorship\b/i,
    build: (m) => [
      {
        path: 'workAuthorization.sponsorshipRequirement',
        operation: 'set',
        value: 'required',
        summary: 'Require visa sponsorship',
        confidence: 0.9,
        sourceText: m[0],
      },
    ],
  },
];

/**
 * Parses an instruction into validated proposals.
 *
 * Returns everything it could not interpret rather than silently dropping it —
 * a user who says three things and sees two applied must be told which one was
 * missed, not left to discover it later.
 */
export function parsePreferenceInstruction(
  instruction: string,
  current: CandidatePreferences,
): ProposalBundle {
  const proposals: PreferenceProposal[] = [];
  const matchedSpans: Array<[number, number]> = [];

  for (const rule of RULES) {
    const match = rule.pattern.exec(instruction);
    if (!match) continue;
    const built = rule.build(match, current);
    if (!built) continue;

    for (const proposal of built) {
      // Validate here as well as at the boundary: a rule with a typo must fail
      // in tests, not produce an unvalidated object that reaches the service.
      const parsed = preferenceProposalSchema.safeParse(proposal);
      if (parsed.success) proposals.push(parsed.data);
    }
    matchedSpans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }

  const unparsed = findUnparsedSegments(instruction, matchedSpans);

  return proposalBundleSchema.parse({
    proposals,
    unparsed,
    // Confirmation is always required. Even a high-confidence parse is a
    // suggestion until the candidate accepts it.
    requiresConfirmation: true,
  });
}

/** Sentences no rule claimed, so the caller can surface them. */
function findUnparsedSegments(text: string, spans: Array<[number, number]>): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 3);
  if (spans.length === 0) return sentences.map((s) => s.trim()).slice(0, 10);

  let offset = 0;
  const unparsed: string[] = [];
  for (const sentence of sentences) {
    const start = text.indexOf(sentence, offset);
    const end = start + sentence.length;
    offset = end;
    const covered = spans.some(([s, e]) => s < end && e > start);
    if (!covered) unparsed.push(sentence.trim());
  }
  return unparsed.slice(0, 10);
}

/**
 * Merges provider output into the deterministic result.
 *
 * Provider proposals are schema-validated and discarded on failure — an
 * unparseable model response must leave the deterministic proposals intact
 * rather than failing the whole request.
 */
export async function proposeWithProvider(
  instruction: string,
  current: CandidatePreferences,
  provider: NaturalLanguageProvider | null,
): Promise<ProposalBundle & { providerError: string | null }> {
  const deterministic = parsePreferenceInstruction(instruction, current);
  if (!provider || !provider.isAvailable() || deterministic.unparsed.length === 0) {
    return { ...deterministic, providerError: null };
  }

  try {
    const result = await provider.propose({ instruction, current });
    const validated = result.proposals
      .map((p) => preferenceProposalSchema.safeParse(p))
      .filter((r): r is { success: true; data: PreferenceProposal } => r.success)
      .map((r) => r.data);

    return {
      ...proposalBundleSchema.parse({
        proposals: [...deterministic.proposals, ...validated],
        unparsed: result.unparsed,
        requiresConfirmation: true,
      }),
      providerError: null,
    };
  } catch (error) {
    return {
      ...deterministic,
      providerError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  }
}
