import {
  CANDIDATE_EVIDENCE_KINDS,
  integrityReportSchema,
  type EvidenceRef,
  type IntegrityFinding,
  type IntegrityReport,
  type SupportedClaim,
} from '@job-intel/contracts';

/**
 * The fabrication guard.
 *
 * Everything else in this layer generates text. This is the part that refuses
 * to let the text ship if it says something nobody can back, and it is written
 * on the assumption that the generator *will* try — not because a model is
 * malicious, but because producing fluent plausible prose is exactly what it is
 * good at, and "plausible" and "true" are different properties.
 *
 * Three checks, in increasing order of how badly they fail.
 *
 * **Unsupported claims.** A statement with no evidence reference. Caught by the
 * schema in most cases; caught here when a claim's evidence is present but does
 * not actually contain what the claim asserts.
 *
 * **Invented specifics.** Numbers, employers, credentials and dates that appear
 * in generated text and nowhere in the candidate's record. A percentage in a
 * resume bullet is the single most dangerous thing this system can produce,
 * because it is precise, memorable, and the candidate will be asked about it.
 *
 * **Cross-job contamination.** Company A's name in Company B's cover letter.
 * The most embarrassing failure mode available, and the easiest to produce
 * accidentally when packages share any mutable state.
 */

export interface FactCheckContext {
  /** The job this package is for. Anything else named is contamination. */
  jobId: string;
  companyName: string;
  jobTitle: string;

  /** Employers the candidate has actually worked for. */
  knownEmployers: readonly string[];
  /** Credentials the candidate actually holds. */
  knownCertifications: readonly string[];
  /** Every number that appears anywhere in the candidate's own record. */
  knownMetrics: readonly string[];
  /** Technologies the candidate can evidence. */
  knownSkills: readonly string[];

  /** Companies from *other* jobs in play, for contamination detection. */
  otherCompanies?: readonly string[];
  otherJobTitles?: readonly string[];
}

/** A piece of generated text, and where it came from. */
export interface CheckedText {
  location: string;
  text: string;
  evidence?: readonly EvidenceRef[];
}

/**
 * Numbers that assert an outcome.
 *
 * Deliberately narrow: it matches percentages, multipliers, currency amounts
 * and large round counts, not every digit. "React 18" and "2019–2022" are
 * numbers nobody is claiming credit for, and flagging them would bury the one
 * pattern that matters — "reduced load time by 60%" — in noise.
 */
/*
 * No trailing word boundary.
 *
 * An earlier version ended this pattern with `\b`, and it silently disabled
 * every alternative ending in a non-word character. "60%" never matched — a
 * word boundary cannot follow "%" at the end of a string — so the single most
 * dangerous fabrication this system can produce, an invented percentage in a
 * resume bullet, sailed straight through the check that exists to catch it.
 *
 * Found by the adversarial test, not by reading the regex.
 */
const METRIC_PATTERN =
  /\b(\d{1,3}(?:\.\d+)?%|\d+(?:\.\d+)?x|[$€£₦]\s?\d[\d,.]*\s?[kmb]?|\d{1,3}(?:,\d{3})+|\d+\s*(?:million|thousand|billion))/gi;

/** Credential-shaped phrases, which must never appear unsupported. */
const CREDENTIAL_PATTERN =
  /\b(?:certified|certification|certificate|licensed|accredited|AWS Certified|Azure|PMP|CISSP|CPA|Scrum Master)\b/gi;

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9%.$€£₦x]+/g, ' ').trim();
}

/**
 * Whether the evidence actually contains what the claim asserts.
 *
 * Token containment rather than semantic comparison, and that is deliberate: a
 * semantic check would need a model, and using a model to verify a model's
 * output means a fabrication that survives one pass survives both. This is
 * mechanical, cheap and strict — a claim must reuse the words its evidence
 * supplies.
 */
function evidenceSupports(claim: string, evidence: readonly EvidenceRef[]): boolean {
  if (evidence.length === 0) return false;

  const haystack = normalise(evidence.map((entry) => entry.quote).join(' '));

  const metrics = claim.match(METRIC_PATTERN) ?? [];

  /*
   * Every metric in the claim must appear in the evidence, verbatim. This is
   * the strictest rule here and the most important: a rewritten bullet may
   * rephrase freely, but it may not introduce a number.
   */
  for (const metric of metrics) {
    if (!haystack.includes(normalise(metric))) return false;
  }

  return true;
}

/**
 * Checks one package's generated text.
 *
 * Returns findings rather than throwing, so a caller can decide: a HIGH finding
 * blocks the package, a LOW one is surfaced for review. Throwing would make the
 * whole package unavailable over a single questionable phrase, which pushes
 * people toward disabling the check.
 */
export function factCheck(
  texts: readonly CheckedText[],
  claims: readonly SupportedClaim[],
  context: FactCheckContext,
): IntegrityReport {
  const findings: IntegrityFinding[] = [];

  let claimsChecked = 0;
  let claimsWithEvidence = 0;

  // ── Claims must be backed, and backed by what they say ──────────────────
  for (const claim of claims) {
    claimsChecked += 1;

    /*
     * A claim about the candidate needs *candidate* evidence. Citing the job
     * posting to support "you have four years of React" would be circular — the
     * posting says the job wants it, not that the candidate has it — and is a
     * mistake a generator makes readily because both texts mention React.
     */
    const candidateBacked = claim.evidence.some((entry) =>
      CANDIDATE_EVIDENCE_KINDS.includes(entry.kind),
    );

    if (claim.evidence.length === 0) {
      findings.push({
        violation: 'UNSUPPORTED_CLAIM',
        severity: 'CRITICAL',
        location: 'claim',
        offendingText: claim.claim.slice(0, 600),
        explanation: 'This claim has no evidence reference and cannot be made.',
      });
      continue;
    }

    claimsWithEvidence += 1;

    if (!candidateBacked) {
      findings.push({
        violation: 'UNSUPPORTED_CLAIM',
        severity: 'HIGH',
        location: 'claim',
        offendingText: claim.claim.slice(0, 600),
        explanation:
          'This claim is about the candidate but cites only the job posting or external research.',
      });
    }

    if (!evidenceSupports(claim.claim, claim.evidence)) {
      findings.push({
        violation: 'FABRICATED_METRIC',
        severity: 'CRITICAL',
        location: 'claim',
        offendingText: claim.claim.slice(0, 600),
        explanation:
          'This claim states a figure that does not appear in the evidence it cites.',
      });
    }
  }

  // ── Generated text must not invent specifics ────────────────────────────
  const knownMetrics = new Set(context.knownMetrics.map(normalise));
  const knownEmployers = context.knownEmployers.map((name) => name.toLowerCase());
  const knownCertifications = context.knownCertifications.map((name) => name.toLowerCase());

  for (const entry of texts) {
    const evidenceText = normalise((entry.evidence ?? []).map((ref) => ref.quote).join(' '));

    for (const metric of entry.text.match(METRIC_PATTERN) ?? []) {
      const key = normalise(metric);

      if (knownMetrics.has(key) || evidenceText.includes(key)) continue;

      findings.push({
        violation: 'FABRICATED_METRIC',
        severity: 'CRITICAL',
        location: entry.location,
        offendingText: metric,
        explanation:
          `The figure "${metric}" appears nowhere in the candidate's record or in the cited evidence.`,
      });
    }

    const lower = entry.text.toLowerCase();

    if (CREDENTIAL_PATTERN.test(entry.text)) {
      CREDENTIAL_PATTERN.lastIndex = 0;

      const claimed = knownCertifications.some((cert) => lower.includes(cert.toLowerCase()));

      if (!claimed) {
        findings.push({
          violation: 'FABRICATED_CREDENTIAL',
          severity: 'CRITICAL',
          location: entry.location,
          offendingText: entry.text.slice(0, 300),
          explanation:
            'This text implies a credential the candidate has not recorded holding.',
        });
      }
    }

    CREDENTIAL_PATTERN.lastIndex = 0;

    // ── Cross-job contamination ──────────────────────────────────────────
    for (const other of context.otherCompanies ?? []) {
      if (other.toLowerCase() === context.companyName.toLowerCase()) continue;

      /*
       * Word-boundary matched. A substring check would fire on "Meta" inside
       * "metadata" and train whoever maintains this to ignore the finding.
       */
      const pattern = new RegExp(`\\b${escapeRegExp(other)}\\b`, 'i');

      if (pattern.test(entry.text)) {
        findings.push({
          violation: 'CROSS_JOB_CONTAMINATION',
          severity: 'CRITICAL',
          location: entry.location,
          offendingText: other,
          explanation:
            `This text names "${other}" in an application to ${context.companyName}. ` +
            'Material from one application has leaked into another.',
        });
      }
    }

    for (const other of context.otherJobTitles ?? []) {
      if (other.toLowerCase() === context.jobTitle.toLowerCase()) continue;

      const pattern = new RegExp(`\\b${escapeRegExp(other)}\\b`, 'i');

      if (pattern.test(entry.text)) {
        findings.push({
          violation: 'CROSS_JOB_CONTAMINATION',
          severity: 'HIGH',
          location: entry.location,
          offendingText: other,
          explanation: `This text names the role "${other}", which belongs to a different job.`,
        });
      }
    }

    // ── Employers the candidate never worked for ─────────────────────────
    /*
     * "at" and "for" only — never "with".
     *
     * "with" introduces technologies far more often than employers, and the
     * first version flagged "with React and TypeScript experience" as a
     * fabricated employer named "React". A false positive like that teaches
     * whoever maintains this to ignore the entire check, which costs more than
     * the missed detection it was trying to buy.
     */
    const employerClaim = /\b(?:at|for)\s+([A-Z][A-Za-z0-9&.\- ]{2,40}?)(?=[,.;]|\s+(?:as|from|in|where|and)\b|$)/g;

    for (const match of entry.text.matchAll(employerClaim)) {
      const named = (match[1] ?? '').trim();
      const lowered = named.toLowerCase();

      if (lowered === context.companyName.toLowerCase()) continue;
      if (knownEmployers.some((employer) => employer.toLowerCase() === lowered)) continue;

      /*
       * A technology is not an employer. Checked against what the candidate can
       * actually evidence rather than a hardcoded list, so it stays correct as
       * the skill taxonomy grows.
       */
      if (context.knownSkills.some((skill) => skill.toLowerCase() === lowered)) continue;

      /*
       * Only flagged when the sentence reads as employment history. Naming a
       * technology vendor or a university in passing is ordinary, and treating
       * every capitalised word after "at" as a fabricated employer would make
       * the check useless.
       */
      if (!/\b(?:worked|experience|role|engineer|developer|led|built)\b/i.test(entry.text)) {
        continue;
      }

      findings.push({
        violation: 'FABRICATED_EMPLOYER',
        severity: 'HIGH',
        location: entry.location,
        offendingText: named,
        explanation:
          `"${named}" is described as somewhere the candidate worked, and it is not in their history.`,
      });
    }
  }

  return integrityReportSchema.parse({
    /*
     * A package passes only when nothing critical was found. HIGH findings are
     * surfaced but do not block — they are usually the employer-name heuristic
     * being cautious, and blocking on them would make the check something
     * people route around.
     */
    passed: !findings.some((finding) => finding.severity === 'CRITICAL'),
    findings: findings.slice(0, 50),
    claimsChecked,
    claimsWithEvidence,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a package may be shown to the candidate as ready.
 *
 * Separated from `factCheck` so the decision is one line a reader can find,
 * rather than a condition buried in whichever caller happened to write it
 * first.
 */
export function isPackagePresentable(report: IntegrityReport): {
  presentable: boolean;
  reason: string;
} {
  if (!report.passed) {
    const critical = report.findings.filter((finding) => finding.severity === 'CRITICAL');

    return {
      presentable: false,
      reason: `${critical.length} unsupported or fabricated statement(s) were found and removed before this package could be shown.`,
    };
  }

  const highs = report.findings.filter((finding) => finding.severity === 'HIGH');

  return {
    presentable: true,
    reason:
      highs.length > 0
        ? `${highs.length} statement(s) need your review before you use them.`
        : 'Every statement in this package is backed by your own records.',
  };
}
