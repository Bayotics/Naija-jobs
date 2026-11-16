import { createHash } from 'node:crypto';
import {
  applicationBlockerSchema,
  eligibilityAssessmentSchema,
  requirementAssessmentSchema,
  type ApplicationBlocker,
  type AuthorizationAssessment,
  type CandidateIntelligence,
  type CompensationAssessment,
  type EligibilityAssessment,
  type ExperienceAlignment,
  type LanguageAssessment,
  type LocationAssessment,
  type ParsedRequirementRecord,
  type RequirementAssessment,
  type SupportState,
} from '@job-intel/contracts';

/**
 * Hard eligibility and blockers.
 *
 * The whole layer turns on one distinction, and it is worth stating in full
 * because every shortcut in this space gets it wrong:
 *
 *   The posting demands X. The profile does not mention X.
 *   → **UNKNOWN.** A question for the candidate.
 *
 *   The posting demands X. The profile establishes not-X.
 *   → **NOT_SUPPORTED.** A blocker.
 *
 * Resumes are lossy. They omit languages people speak, certifications people
 * hold, and work authorisation nobody thinks to write down. Treating that
 * silence as a negative would filter someone out of jobs they can do, silently,
 * and they would never learn why.
 *
 * So a `HARD_BLOCKER` requires two things to be true at once: the posting states
 * the requirement as required, *and* something in the candidate's own stated
 * data positively contradicts it. Everything else becomes a question.
 */

const blockerId = (...parts: string[]): string =>
  createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

/** Clipping for strings assembled from posting text. See the engine's note. */
const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

export interface EligibilityInput {
  requirements: readonly ParsedRequirementRecord[];
  /** Skill assessments already computed by the matcher. */
  skillAssessments: readonly RequirementAssessment[];
  profile: CandidateIntelligence | null;
  experience: ExperienceAlignment;
  authorization: AuthorizationAssessment;
  language: LanguageAssessment;
  location: LocationAssessment;
  compensation: CompensationAssessment;
  /** Blocker ids the candidate has already dismissed. */
  acknowledgedBlockerIds?: readonly string[];
}

/**
 * Education, checked against what the profile records.
 *
 * A profile with no education records at all cannot answer a degree
 * requirement, and returns UNKNOWN. A profile that records a bachelor's against
 * a master's requirement can, and returns NOT_SUPPORTED — that is a real
 * negative established by the candidate's own data.
 */
function assessEducation(
  requirement: ParsedRequirementRecord,
  profile: CandidateIntelligence | null,
): { support: SupportState; explanation: string } {
  const order = ['none', 'high_school', 'diploma', 'bachelors', 'masters', 'doctorate'];

  if (!profile || profile.education.length === 0) {
    return {
      support: 'UNKNOWN',
      explanation:
        'Your profile records no education, so this cannot be checked. Add it if you hold a qualification.',
    };
  }

  const needed = requirement.educationLevel;
  if (!needed) {
    return {
      support: 'SUPPORTED',
      explanation: `You have ${profile.education[0]!.degree ?? 'a recorded qualification'} and the posting does not state a level.`,
    };
  }

  const highest = profile.education
    .map((record) => order.indexOf(record.level ?? 'none'))
    .reduce((max, index) => Math.max(max, index), -1);

  const neededIndex = order.indexOf(needed);

  if (highest < 0 || neededIndex < 0) {
    return {
      support: 'UNKNOWN',
      explanation: 'Your recorded qualification could not be compared with the one asked for.',
    };
  }

  if (highest >= neededIndex) {
    return {
      support: 'SUPPORTED',
      explanation: `You hold ${order[highest]!.replace(/_/g, ' ')} against ${needed.replace(/_/g, ' ')} required.`,
    };
  }

  return {
    support: 'NOT_SUPPORTED',
    explanation: `Your highest recorded qualification is ${order[highest]!.replace(/_/g, ' ')}, below the ${needed.replace(/_/g, ' ')} asked for.`,
  };
}

function assessCertification(
  requirement: ParsedRequirementRecord,
  profile: CandidateIntelligence | null,
): { support: SupportState; explanation: string } {
  if (!profile || profile.certifications.length === 0) {
    return {
      support: 'UNKNOWN',
      explanation:
        'Your profile records no certifications. That is not evidence you hold none — add any you have.',
    };
  }

  const needle = requirement.text.toLowerCase();
  const held = profile.certifications.find(
    (record) =>
      needle.includes(record.name.toLowerCase()) ||
      record.name.toLowerCase().includes(needle.slice(0, 24)),
  );

  if (held) {
    return {
      support: 'SUPPORTED',
      explanation: `You hold ${held.name}${held.issuer ? ` from ${held.issuer}` : ''}. The system has not verified this with the issuer.`,
    };
  }

  /*
   * Deliberately UNKNOWN rather than NOT_SUPPORTED even though the profile has
   * certifications: someone who listed two AWS certificates may well hold a
   * third they did not bother to type in.
   */
  return {
    support: 'UNKNOWN',
    explanation: `No matching certification is recorded. You may hold it without having listed it.`,
  };
}

export function assessEligibility(input: EligibilityInput): EligibilityAssessment {
  const acknowledged = new Set(input.acknowledgedBlockerIds ?? []);
  const assessments: RequirementAssessment[] = [];
  const blockers: ApplicationBlocker[] = [];
  const questions: string[] = [];

  const record = (
    requirement: ParsedRequirementRecord,
    support: SupportState,
    explanation: string,
    credit: number,
  ): void => {
    const parsed = requirementAssessmentSchema.safeParse({
      requirement,
      strength:
        support === 'SUPPORTED' ? 'DIRECT_MATCH' : support === 'NOT_SUPPORTED' ? 'CONFLICT' : 'NO_EVIDENCE',
      support,
      credit,
      evidence: [],
      via: [],
      explanation: clip(explanation, 500),
    });

    if (parsed.success) assessments.push(parsed.data);
  };

  const addBlocker = (
    requirement: ParsedRequirementRecord,
    statement: string,
    detail: string,
    resolution: string | null,
    severity: ApplicationBlocker['severity'] = 'HARD_BLOCKER',
  ): void => {
    const id = blockerId(requirement.type, requirement.slug ?? requirement.text);

    const parsed = applicationBlockerSchema.safeParse({
      id,
      severity,
      requirementType: requirement.type,
      statement: clip(statement, 300),
      detail: clip(detail, 500),
      evidence: [],
      resolution: resolution === null ? null : clip(resolution, 300),
      acknowledged: acknowledged.has(id),
      acknowledgedNote: null,
    });

    if (parsed.success) blockers.push(parsed.data);
  };

  // Skill assessments already carry their own verdicts.
  assessments.push(...input.skillAssessments);

  const hard = input.requirements.filter(
    (requirement) => requirement.importance === 'required' && requirement.confidence >= 0.5,
  );

  for (const requirement of hard) {
    switch (requirement.type) {
      // ── Years ────────────────────────────────────────────────────────────
      case 'experience_years': {
        const needed = requirement.minYears;
        if (needed === null) break;

        /*
         * Relevant years, not the single core skill.
         *
         * An earlier version measured this against `coreSkillYears` — the years
         * of whichever required skill the extractor was most confident about.
         * Extraction confidence is about how sure the parser is that it read a
         * requirement correctly; it says nothing about which skill the posting
         * cares most about, and using it as a proxy meant a job asking for "4+
         * years of platform engineering" was judged against one year of
         * Terraform while three years of AWS and two of Docker were ignored.
         *
         * A screener reads the span of relevant work. `coreSkillYears` still
         * drives the mismatch flag and the explanation, where naming the
         * specific shortfall is useful.
         */
        const measured = input.experience.relevantYears ?? input.experience.totalYears;

        if (measured === null) {
          record(
            requirement,
            'UNKNOWN',
            'No datable employment history was found, so years of experience could not be checked.',
            0,
          );
          questions.push(`How many years of experience do you have? The posting asks for ${needed}.`);
          break;
        }

        /*
         * Total experience is not a substitute when relevance is unknowable.
         *
         * A posting that names no skills the taxonomy recognises — a rice-mill
         * supervisor, an HR manager — gives nothing to measure relevance
         * against, so `relevantYears` is null and this falls back to total
         * tenure. On the live database that made a frontend engineer "directly
         * evidence" a ten-year milling requirement, which is the exact
         * substitution this layer exists to prevent, arriving through the one
         * door left open.
         *
         * Ten years of *something* is genuinely weak evidence for ten years of
         * *this*, so it resolves to UNKNOWN with the reason stated.
         */
        if (input.experience.relevantYears === null) {
          record(
            requirement,
            'UNKNOWN',
            `You have about ${measured.toFixed(1)} years of experience overall, but this posting names nothing ` +
              'that lets your relevant experience be checked against it.',
            0.3,
          );
          break;
        }

        if (measured >= needed) {
          record(requirement, 'SUPPORTED', `About ${measured.toFixed(1)} years against ${needed} required.`, 1);
          break;
        }

        const shortfall = needed - measured;
        record(
          requirement,
          // Within a year is close enough that a screener would not reject on
          // it, and saying otherwise costs the candidate real opportunities.
          shortfall <= 1 ? 'UNKNOWN' : 'NOT_SUPPORTED',
          shortfall <= 1
            ? `About ${measured.toFixed(1)} years against ${needed} required — close enough to be worth applying.`
            : `About ${measured.toFixed(1)} years against ${needed} required.`,
          Math.max(0, measured / needed),
        );

        /*
         * A years shortfall is a `LIKELY_BLOCKER`, never a hard one.
         *
         * Stated year requirements are routinely aspirational, and plenty of
         * people are hired below them. Making this hard would block a large
         * share of good applications on the least reliable number in a posting.
         */
        if (shortfall > 2) {
          addBlocker(
            requirement,
            `Requires ${needed} years of experience.`,
            `Your profile evidences about ${measured.toFixed(1)} years of the relevant experience.`,
            'Stated year requirements are often flexible. Apply anyway if the rest fits well.',
            'LIKELY_BLOCKER',
          );
        }
        break;
      }

      // ── Education ────────────────────────────────────────────────────────
      case 'education': {
        const result = assessEducation(requirement, input.profile);
        record(requirement, result.support, result.explanation, result.support === 'SUPPORTED' ? 1 : 0);

        if (result.support === 'UNKNOWN') {
          questions.push(clip(`Do you hold ${requirement.text}?`, 300));
        } else if (result.support === 'NOT_SUPPORTED') {
          addBlocker(
            requirement,
            clip(`Requires ${requirement.text}.`, 300),
            result.explanation,
            'Some employers accept equivalent experience. Worth asking if the rest is a strong fit.',
            'LIKELY_BLOCKER',
          );
        }
        break;
      }

      // ── Certifications and licences ──────────────────────────────────────
      case 'certification':
      case 'license': {
        const result = assessCertification(requirement, input.profile);
        record(requirement, result.support, result.explanation, result.support === 'SUPPORTED' ? 1 : 0);

        if (result.support !== 'SUPPORTED') {
          questions.push(clip(`Do you hold ${requirement.text}?`, 300));

          /*
           * A licence is different from a certification.
           *
           * "Requires an active medical licence" is a legal precondition, not a
           * preference — but the profile is still only silent, so it is a
           * `SOFT_BLOCKER`: shown prominently, answerable in one click, and
           * never a reason to hide the job outright.
           */
          if (requirement.type === 'license') {
            addBlocker(
              requirement,
              clip(`Requires ${requirement.text}.`, 300),
              'Your profile does not record this. If you hold it, add it and this will clear.',
              'Add the licence to your profile, or confirm you hold it.',
              'SOFT_BLOCKER',
            );
          }
        }
        break;
      }

      // ── Work authorisation ───────────────────────────────────────────────
      case 'work_authorization': {
        const auth = input.authorization;

        if (auth.candidateAuthorized === 'SUPPORTED') {
          record(requirement, 'SUPPORTED', auth.explanation, 1);
          break;
        }

        if (
          auth.candidateAuthorized === 'NOT_SUPPORTED' &&
          auth.sponsorshipAvailable === 'no'
        ) {
          /*
           * The one authorisation case that is genuinely hard.
           *
           * The candidate has stated where they can work, this is not among
           * them, and the posting has explicitly said it will not sponsor.
           * Both halves are positive statements — neither is an inference from
           * silence.
           */
          record(requirement, 'NOT_SUPPORTED', auth.explanation, 0);
          addBlocker(
            requirement,
            clip(requirement.text, 300),
            auth.explanation,
            'If your situation has changed, update your work-authorisation settings.',
            'HARD_BLOCKER',
          );
          break;
        }

        record(requirement, 'UNKNOWN', auth.explanation, 0);
        questions.push(
          auth.countryCode
            ? `Are you authorised to work in ${auth.countryCode}?`
            : 'Are you authorised to work where this role is based?',
        );
        break;
      }

      // ── Language ─────────────────────────────────────────────────────────
      case 'language': {
        const match = input.language.requirements.find((entry) =>
          requirement.text.toLowerCase().includes(entry.language.toLowerCase()),
        );

        if (!match) {
          record(requirement, 'UNKNOWN', 'This language requirement could not be checked.', 0);
          break;
        }

        record(requirement, match.support, match.explanation, match.support === 'SUPPORTED' ? 1 : 0);

        if (match.support === 'UNKNOWN') {
          questions.push(
            `Do you speak ${match.language}${match.level ? ` at ${match.level}` : ''}? Your profile does not say.`,
          );
        } else if (match.support === 'NOT_SUPPORTED') {
          addBlocker(
            requirement,
            `Requires ${match.language}${match.level ? ` ${match.level}` : ''}.`,
            match.explanation,
            'If your level has improved, update it in your profile.',
            'HARD_BLOCKER',
          );
        }
        break;
      }

      // ── Location ─────────────────────────────────────────────────────────
      case 'location': {
        record(requirement, input.location.support, input.location.explanation, input.location.support === 'SUPPORTED' ? 1 : 0);

        if (input.location.support === 'NOT_SUPPORTED') {
          addBlocker(
            requirement,
            clip(requirement.text, 300),
            input.location.explanation,
            'Update your location preferences if you would consider this.',
            'HARD_BLOCKER',
          );
        } else if (input.location.support === 'UNKNOWN') {
          questions.push('Can you work from where this role is based?');
        }
        break;
      }

      default:
        break;
    }
  }

  // ── Salary, when the candidate made it hard ─────────────────────────────
  if (input.compensation.belowHardMinimum) {
    const requirement: ParsedRequirementRecord = {
      id: blockerId('salary', 'hard-minimum'),
      text: 'Salary below your non-negotiable minimum',
      type: 'other',
      importance: 'required',
      slug: null,
      matchedText: null,
      minYears: null,
      educationLevel: null,
      languageLevel: null,
      evidence: input.compensation.explanation,
      confidence: input.compensation.confidence,
    };

    addBlocker(
      requirement,
      'Pays below the minimum you marked as non-negotiable.',
      input.compensation.explanation,
      'Adjust your salary settings, or mark your minimum as flexible.',
      'HARD_BLOCKER',
    );
  }

  // ── Location conflict outside a stated requirement ──────────────────────
  if (
    input.location.support === 'NOT_SUPPORTED' &&
    !blockers.some((blocker) => blocker.requirementType === 'location')
  ) {
    const requirement: ParsedRequirementRecord = {
      id: blockerId('location', 'mismatch'),
      text: 'Location',
      type: 'location',
      importance: 'required',
      slug: null,
      matchedText: null,
      minYears: null,
      educationLevel: null,
      languageLevel: null,
      evidence: input.location.explanation,
      confidence: 0.7,
    };

    addBlocker(
      requirement,
      'This role is outside the locations you work in.',
      input.location.explanation,
      'Update your location preferences if you would consider this.',
      'HARD_BLOCKER',
    );
  }

  const supported = assessments.filter((entry) => entry.support === 'SUPPORTED').length;
  const notSupported = assessments.filter((entry) => entry.support === 'NOT_SUPPORTED').length;
  const unknown = assessments.filter((entry) => entry.support === 'UNKNOWN').length;

  const blocking = blockers.filter(
    (blocker) => blocker.severity === 'HARD_BLOCKER' && !blocker.acknowledged,
  );

  return eligibilityAssessmentSchema.parse({
    eligible: blocking.length === 0,
    hasUnknowns: unknown > 0,
    supported,
    notSupported,
    unknown,
    assessments: assessments.slice(0, 60),
    blockers: blockers.slice(0, 20),
    questions: [...new Set(questions)].slice(0, 20),
  });
}
