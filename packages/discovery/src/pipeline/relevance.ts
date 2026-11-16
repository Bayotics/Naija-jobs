import type { SearchProfile } from '@job-intel/contracts';
import type { ValidationRule } from './discovery-pipeline';

/**
 * The relevance gate.
 *
 * Rejects postings that cannot plausibly be what the candidate is looking for,
 * *before* they are written to the database.
 *
 * The original design deferred all filtering to the matching engine: fetch
 * everything, score later, show what wins. That is defensible when matching
 * runs. It is indefensible when it does not — and it produced a jobs page where
 * a software engineer scrolled past "IGCSE Teacher — English Language",
 * "Laundry Marketing Supervisor" and "Palmpay Limited Job Recruitment
 * (17 Positions)". Storage, embedding, enrichment and matching were all being
 * spent on postings no scoring pass could ever surface.
 *
 * ── What this is not ──────────────────────────────────────────────────────
 *
 * This is *not* the matching engine and must never grow into it. Matching
 * decides how well a plausible job fits, using structured evidence, and Prompt
 * 18 rules out keyword overlap as the primary mechanism for that judgement.
 *
 * This answers a coarser and much easier question: **is this posting in the
 * candidate's field at all?** A title-level check is sufficient for that, and
 * it is the same judgement a person makes scanning a list — nobody reads the
 * body of a laundry supervisor posting to decide it is not a backend role.
 *
 * ── Why title-only ────────────────────────────────────────────────────────
 *
 * Descriptions were deliberately excluded from the accept path. A teaching
 * posting that mentions "computer lab" or "must be comfortable with technology"
 * contains enough incidental vocabulary to pass a body scan, and every such
 * false accept is exactly the noise this exists to remove. Titles are written
 * to say what the job is.
 *
 * ── The bias, stated plainly ──────────────────────────────────────────────
 *
 * This gate is built to under-reject. Every ambiguous case is kept: a title
 * with no signal either way passes when the profile is thin, unrecognised
 * vocabulary passes, and the vocabulary expansion below only ever *adds*
 * acceptable terms. Dropping a real opportunity is unrecoverable and invisible
 * — the candidate never learns what they did not see — while keeping some noise
 * costs a row and is visible and fixable. Those failures are not symmetrical
 * and this does not treat them as if they were.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * Terms that mean the same *kind of work* as a term the candidate wrote.
 *
 * Expansion is keyed on what the user actually stated, and applies only to
 * families their targets touch. Someone targeting "Nurse" never picks up
 * software vocabulary from this table — the entry is not reached.
 *
 * Additive by construction: an entry can only ever cause a posting to be
 * accepted that would otherwise be dropped. A missing entry costs noise; a
 * wrong entry cannot cause a real job to be rejected.
 */
/**
 * Terms that mean the same *kind of work* as a term the candidate wrote.
 *
 * Rewritten wholesale for this system's fields. The vocabulary it replaced was
 * entirely software — engineer, developer, backend, devops — and against an
 * admin-and-sales corpus it would have rejected essentially everything, which
 * is the failure mode this gate is most dangerous for: silent, total, and
 * invisible from the dashboard.
 *
 * Expansion is keyed on what the user actually stated, so a profile that never
 * mentions sales never picks up sales vocabulary.
 *
 * Additive by construction: an entry can only ever cause a posting to be
 * accepted that would otherwise be dropped. A missing entry costs noise; a
 * wrong entry cannot cause a real job to be rejected.
 */
const ROLE_EQUIVALENTS: Readonly<Record<string, readonly string[]>> = {
  // ── Administration / secretarial / clerical ──
  administrative: ['administrative', 'administrator', 'admin', 'administration', 'office', 'clerical', 'clerk', 'secretary', 'secretarial'],
  administrator: ['administrator', 'administrative', 'admin', 'office', 'clerical', 'coordinator'],
  admin: ['admin', 'administrative', 'administrator', 'administration', 'office', 'clerical', 'secretary'],
  secretary: ['secretary', 'secretarial', 'administrative', 'admin', 'clerical', 'assistant', 'executive'],
  assistant: ['assistant', 'administrative', 'admin', 'secretary', 'support', 'officer', 'aide'],
  office: ['office', 'admin', 'administrative', 'clerical', 'back-office', 'front-office'],
  personal: ['personal', 'executive', 'assistant', 'pa', 'ea'],

  // ── Customer service / front desk ──
  customer: ['customer', 'client', 'service', 'support', 'care', 'success', 'relations'],
  service: ['service', 'customer', 'support', 'care', 'client', 'helpdesk'],
  receptionist: ['receptionist', 'reception', 'front', 'desk', 'concierge', 'frontdesk'],
  'front-desk': ['front-desk', 'frontdesk', 'reception', 'receptionist', 'front'],
  support: ['support', 'customer', 'service', 'care', 'helpdesk', 'client'],
  'call-centre': ['call-centre', 'call-center', 'callcentre', 'telemarketing', 'telesales', 'contact'],

  // ── Sales / business development / marketing ──
  sales: ['sales', 'selling', 'salesperson', 'representative', 'rep', 'account', 'business', 'development', 'merchandiser', 'retail'],
  marketing: ['marketing', 'marketer', 'brand', 'branding', 'advertising', 'promotions', 'communications', 'digital', 'growth'],
  business: ['business', 'development', 'sales', 'account', 'partnerships', 'commercial'],
  merchandiser: ['merchandiser', 'merchandising', 'retail', 'sales', 'store'],
  advertising: ['advertising', 'advert', 'marketing', 'brand', 'branding', 'creative', 'media'],
  brand: ['brand', 'branding', 'marketing', 'advertising', 'communications'],
  'public-relations': ['public-relations', 'pr', 'communications', 'media', 'publicity'],
  communications: ['communications', 'communication', 'pr', 'media', 'brand', 'marketing'],
  adviser: ['adviser', 'advisor', 'consultant', 'representative', 'officer', 'agent'],
  financial: ['financial', 'finance', 'adviser', 'advisor', 'accounts', 'insurance'],

  // ── Graduate / entry level ──
  graduate: ['graduate', 'trainee', 'intern', 'internship', 'entry', 'nysc', 'fresh', 'apprentice', 'traineeship'],
  trainee: ['trainee', 'graduate', 'intern', 'internship', 'entry', 'apprentice', 'nysc'],
  intern: ['intern', 'internship', 'trainee', 'graduate', 'nysc', 'industrial'],

  // ── Research / data entry ──
  research: ['research', 'researcher', 'survey', 'analyst', 'analysis', 'data', 'field'],
  data: ['data', 'entry', 'encoder', 'capture', 'analyst', 'processing', 'clerk'],
  entry: ['entry', 'data', 'encoder', 'capture', 'clerk', 'typist'],
  survey: ['survey', 'research', 'enumerator', 'field', 'data'],

  // ── Shape of the role, not the field ──
  officer: ['officer', 'executive', 'associate', 'coordinator', 'specialist', 'representative', 'assistant'],
  executive: ['executive', 'officer', 'associate', 'representative', 'specialist'],
  coordinator: ['coordinator', 'officer', 'administrator', 'assistant', 'supervisor'],
  manager: ['manager', 'management', 'supervisor', 'lead', 'head', 'officer'],
  freelance: ['freelance', 'freelancer', 'contract', 'remote', 'virtual', 'independent'],
  virtual: ['virtual', 'remote', 'online', 'assistant', 'freelance'],
};

/**
 * Dropped before matching — they carry no information about the kind of work.
 *
 * `entry` and `level` were removed from this list when the vocabulary was
 * rewritten. In a software corpus "entry level" is pure seniority noise; here
 * "Data Entry Officer" is one of the seven fields being searched for, and
 * discarding the word would have made the gate blind to it.
 */
const STOP_WORDS = new Set([
  'senior',
  'junior',
  'staff',
  'principal',
  'lead',
  'mid',
  'i',
  'ii',
  'iii',
  'iv',
  'sr',
  'jr',
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'for',
  'to',
  'in',
  'at',
  'with',
  'remote',
  'hybrid',
  'onsite',
  'contract',
  'permanent',
  'fulltime',
  'parttime',
  'freelance',
  'm',
  'f',
  'd',
  'x',
  'gn',
  'mwd',
  'wm',
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    /* Keep hyphens: "full-stack" and "back-end" are single concepts. */
    .replace(/[^a-z0-9+#-]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

// ── The profile ─────────────────────────────────────────────────────────────

export interface RelevanceProfile {
  /** Terms whose presence in a title makes a posting plausible. */
  acceptTerms: ReadonlySet<string>;
  /** Terms whose presence in a title rejects it outright. */
  rejectTerms: ReadonlySet<string>;
  /** False when the profile is too thin to judge; the gate then accepts all. */
  usable: boolean;
}

/**
 * Builds the gate's vocabulary from the candidate's own search profiles.
 *
 * Everything here traces to something the user typed. Nothing is inferred from
 * their name, location, or the jobs they have been shown.
 */
export function buildRelevanceProfile(
  profiles: readonly SearchProfile[],
): RelevanceProfile {
  const accept = new Set<string>();
  const reject = new Set<string>();

  for (const profile of profiles) {
    for (const role of profile.roles) {
      for (const token of tokens(role.title)) {
        accept.add(token);
        for (const equivalent of ROLE_EQUIVALENTS[token] ?? []) accept.add(equivalent);
      }
      for (const alternative of role.alternatives) {
        for (const token of tokens(alternative)) accept.add(token);
      }
    }

    /*
     * Skills widen the accept set but are never sufficient on their own to
     * reject. "React Developer" should pass for someone targeting "Software
     * Engineer", and the skill is what carries that.
     */
    for (const skill of profile.skills) {
      for (const token of tokens(skill.value)) accept.add(token);
    }

    for (const keyword of profile.keywords.mustContain) {
      for (const token of tokens(keyword)) accept.add(token);
    }

    /*
     * Exclusions are the user speaking directly and are honoured literally.
     * Unlike the accept set, these are not expanded — "manager" excluded means
     * manager, not every term some table calls adjacent.
     */
    for (const excluded of profile.excludedSkills) {
      for (const token of tokens(excluded)) reject.add(token);
    }
    for (const keyword of profile.keywords.mustNotContain) {
      for (const token of tokens(keyword)) reject.add(token);
    }
  }

  /*
   * Below three accept terms there is not enough stated preference to tell a
   * relevant posting from an irrelevant one, and a gate that guesses would
   * silently discard the candidate's market. It stands down instead.
   */
  return { acceptTerms: accept, rejectTerms: reject, usable: accept.size >= 3 };
}

// ── The decision ────────────────────────────────────────────────────────────

export interface RelevanceVerdict {
  relevant: boolean;
  reason: string;
  matched: string[];
}

export function judgeRelevance(title: string, profile: RelevanceProfile): RelevanceVerdict {
  if (!profile.usable) {
    return { relevant: true, reason: 'No usable search profile; gate stood down.', matched: [] };
  }

  const titleTokens = tokens(title);

  if (titleTokens.length === 0) {
    /* Nothing to judge. Structural rules already require a title. */
    return { relevant: true, reason: 'Title carried no comparable terms.', matched: [] };
  }

  const excluded = titleTokens.filter((token) => profile.rejectTerms.has(token));
  if (excluded.length > 0) {
    return {
      relevant: false,
      reason: `Title contains excluded term(s): ${excluded.join(', ')}.`,
      matched: excluded,
    };
  }

  const matched = titleTokens.filter((token) => profile.acceptTerms.has(token));
  if (matched.length > 0) {
    return { relevant: true, reason: `Title matches ${matched.join(', ')}.`, matched };
  }

  return {
    relevant: false,
    reason: `Title has no term in common with your target roles or skills.`,
    matched: [],
  };
}

/**
 * The gate as a pipeline rule.
 *
 * Returned as a rule rather than wired in directly so it composes with the
 * structural rules and so a caller with no search profile simply does not pass
 * one — there is no flag to forget to set.
 */
export function relevanceRule(profile: RelevanceProfile): ValidationRule {
  return {
    name: 'relevance',
    check: ({ job }) => {
      if (!job.ok) return null; // structural rules own this case
      const verdict = judgeRelevance(job.job.title, profile);
      return verdict.relevant ? null : verdict.reason;
    },
  };
}
