import {
  AUTHORITY_WEIGHTS,
  type JobQuality,
  type JobQualityComponent,
  type QualityAssessment,
  type SourceAuthorityLevel,
} from '@job-intel/contracts';

/**
 * Posting quality, independent of any candidate.
 *
 * The governing rule, and the one most quality scorers get wrong: **missing
 * information reduces confidence, not quality.** Around three quarters of real
 * postings state no salary. A model that treats an absent salary as a defect
 * systematically demotes exactly the roles real employers post and promotes the
 * aggregator spam that dutifully fills every field with an estimate.
 *
 * So a component the posting simply does not address is marked `applicable:
 * false` and excluded from the average — the same treatment the matching engine
 * gives an unanswerable dimension — while the overall `confidence` falls to
 * record that the verdict rests on less.
 *
 * This consumes the enrichment layer's `QualityAssessment` rather than
 * re-deriving it. That analysis is about the *text*; this one adds what only
 * the recommendation layer knows: where the posting came from, whether its
 * application path works, and whether it is one of five copies.
 */

export interface JobQualityInput {
  /** From the enrichment pipeline. Not recomputed here. */
  enrichmentQuality: QualityAssessment;
  companyIdentified: boolean;
  companyDomainKnown: boolean;
  descriptionLength: number;
  requirementsCount: number;
  responsibilitiesCount: number;
  salaryStated: boolean;
  applicationUrlPresent: boolean;
  /** Null when never checked — which is different from "checked and broken". */
  applicationUrlReachable: boolean | null;
  sourceAuthority: SourceAuthorityLevel;
  /** How many sources carry this job. Corroboration, not duplication. */
  sourceCount: number;
  /** True when the posting is a refresh or repost rather than a new opening. */
  isRepost: boolean;
}

function component(
  name: string,
  score: number,
  weight: number,
  explanation: string,
): JobQualityComponent {
  return {
    component: name,
    score: Math.max(0, Math.min(100, score)),
    weight,
    applicable: true,
    explanation,
  };
}

function notApplicable(name: string, weight: number, explanation: string): JobQualityComponent {
  return { component: name, score: 0, weight, applicable: false, explanation };
}

export function scoreJobQuality(input: JobQualityInput): JobQuality {
  const components: JobQualityComponent[] = [];
  const flags: string[] = [];

  // ── Company identity ────────────────────────────────────────────────────
  if (input.companyIdentified) {
    const score = input.companyDomainKnown ? 100 : 75;
    components.push(
      component(
        'company',
        score,
        1.4,
        input.companyDomainKnown
          ? 'Named employer with a resolved domain'
          : 'Named employer, domain not resolved',
      ),
    );
  } else {
    components.push(component('company', 15, 1.4, 'No identifiable employer'));
    flags.push('company unidentified');
  }

  // ── Description completeness ────────────────────────────────────────────
  const length = input.descriptionLength;
  const lengthScore =
    length >= 2500 ? 100 : length >= 1200 ? 88 : length >= 600 ? 70 : length >= 250 ? 45 : 15;
  components.push(
    component('description', lengthScore, 1.2, `Description is ${length} characters`),
  );
  if (length < 250) flags.push('description very short');

  // ── Structured requirements ─────────────────────────────────────────────
  const structured = input.requirementsCount + input.responsibilitiesCount;
  if (structured > 0) {
    components.push(
      component(
        'requirements',
        Math.min(100, 40 + structured * 10),
        1,
        `${input.requirementsCount} requirement(s) and ${input.responsibilitiesCount} responsibility(ies) extracted`,
      ),
    );
  } else {
    // Prose-only postings are perfectly legitimate; this is an absence of
    // structure, not a defect in the job.
    components.push(
      notApplicable('requirements', 1, 'No structured requirements section to assess'),
    );
  }

  // ── Application path ────────────────────────────────────────────────────
  if (!input.applicationUrlPresent) {
    components.push(component('application', 20, 1.5, 'No application URL'));
    flags.push('no application url');
  } else if (input.applicationUrlReachable === false) {
    components.push(component('application', 5, 1.5, 'Application URL did not resolve'));
    flags.push('application url broken');
  } else if (input.applicationUrlReachable === true) {
    components.push(component('application', 100, 1.5, 'Application URL verified reachable'));
  } else {
    // Present but unchecked. Good, not proven — and the confidence says so.
    components.push(component('application', 78, 1.5, 'Application URL present, not yet verified'));
  }

  // ── Source authority ────────────────────────────────────────────────────
  components.push(
    component(
      'source',
      AUTHORITY_WEIGHTS[input.sourceAuthority] * 100,
      1,
      `Source authority: ${input.sourceAuthority}`,
    ),
  );

  // ── Corroboration ───────────────────────────────────────────────────────
  if (input.sourceCount > 1) {
    components.push(
      component(
        'corroboration',
        Math.min(100, 60 + input.sourceCount * 12),
        0.6,
        `Seen on ${input.sourceCount} independent sources`,
      ),
    );
  } else {
    components.push(
      notApplicable('corroboration', 0.6, 'Seen on one source only — no corroboration either way'),
    );
  }

  // ── Salary transparency ─────────────────────────────────────────────────
  if (input.salaryStated) {
    components.push(component('salary_transparency', 100, 0.5, 'Salary is stated'));
  } else {
    // The rule this whole file exists to enforce.
    components.push(
      notApplicable(
        'salary_transparency',
        0.5,
        'Salary not stated — common and not a quality problem, but it lowers confidence',
      ),
    );
    flags.push('salary not stated');
  }

  // ── Enrichment's own textual verdict ────────────────────────────────────
  components.push(
    component(
      'content_quality',
      input.enrichmentQuality.qualityScore * 100,
      1.2,
      `Text analysis scored ${Math.round(input.enrichmentQuality.qualityScore * 100)}/100`,
    ),
  );
  for (const flag of input.enrichmentQuality.flags) flags.push(flag.flag.replace(/_/g, ' '));

  if (input.isRepost) flags.push('repost');

  // ── Aggregate ───────────────────────────────────────────────────────────
  const applicable = components.filter((c) => c.applicable);
  const totalWeight = applicable.reduce((sum, c) => sum + c.weight, 0);
  const score =
    totalWeight === 0
      ? 50
      : applicable.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight;

  // Confidence is coverage: how much of the checklist the posting let us judge.
  const allWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const coverage = allWeight === 0 ? 0 : totalWeight / allWeight;
  const confidence = coverage * (0.7 + 0.3 * input.enrichmentQuality.qualityConfidence);

  const weakest = applicable.slice().sort((a, b) => a.score - b.score)[0];
  const explanation =
    `Posting quality ${Math.round(score)}/100 from ${applicable.length} assessable signals` +
    (weakest && weakest.score < 50 ? `; weakest is ${weakest.component} (${weakest.explanation})` : '') +
    (coverage < 0.8 ? `; ${components.length - applicable.length} signal(s) unassessable` : '');

  return {
    score: Math.round(Math.max(0, Math.min(100, score)) * 100) / 100,
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 1000) / 1000,
    components,
    flags: [...new Set(flags)],
    explanation: explanation.slice(0, 500),
  };
}
