import { describe, expect, it } from 'vitest';
import { createLogger } from '@job-intel/observability';
import { SkillGraph } from '@job-intel/candidate';
import {
  hardConstraintResultSchema,
  jobMatchSchema,
  type LlmReasoning,
  type LlmUsage,
} from '@job-intel/contracts';
import { MatchingEngine, assertEligibilityRespected } from './engine/matching-engine';
import { classify } from './engine/recommendation';
import { aggregate, normalize } from './weights/weight-normalizer';
import { cosineSimilarity, compareEmbeddings, similarityToScore } from './semantic/similarity';
import { HashingEmbeddingProvider } from './semantic/embedding-provider';
import { validateReasoning, shouldUseLlm } from './llm/match-reasoning-provider';
import { scoreSkills } from './scoring/skills';
import { scoreExperience, scoreSeniority, scoreEducation } from './scoring/experience';
import { scoreSalary, scoreVisa } from './scoring/compensation';
import { scoreLocation, scoreWorkArrangement } from './scoring/place';
import { scoreTitle, scoreIndustry, scoreCompany } from './scoring/role';
import { scoreBehavioral } from './behavioral/behavioral-adjustment';
import { evaluateHardConstraints } from './constraints/hard-constraints';
import type { MatchReasoningProvider, MatchReasoningResult } from './llm/match-reasoning-provider';
import {
  makeCandidateContext,
  makeCandidateSkill,
  makeJobContext,
  makeSkills,
} from './testing/fixtures';

/**
 * Matching engine tests.
 *
 * Organised around the properties that must hold rather than around the code's
 * structure: eligibility beats everything, missing data is not failure,
 * preferences are data, and every number is explainable. Where a test looks
 * redundant it usually is not — the near-duplicate is the boundary case that
 * the obvious implementation gets wrong.
 */

const logger = createLogger({ level: 'error', pretty: false, base: { service: 'test' } });
const engine = new MatchingEngine({ logger });

function input(candidate = makeCandidateContext(), job = makeJobContext()) {
  return { candidate, job };
}

describe('hard constraints', () => {
  // 0 — regression: an over-long display value failed contract validation on
  // the *read* path, taking down a whole listing over one long salary line.
  it('truncates display values to the contract limit', () => {
    const result = evaluateHardConstraints(
      input(
        makeCandidateContext({ preferences: { salary: { minimum: 1, target: 2 } } }),
        makeJobContext({
          enrichment: {
            compensation: {
              stated: true,
              rawText: 'x'.repeat(400),
              minimum: 1,
              currency: 'USD',
              period: 'year',
              confidence: 0.9,
              method: 'pattern',
              conversion: {
                annualUsd: 1,
                rate: 1,
                rateSource: 'test',
                rateTimestamp: new Date('2026-01-01T00:00:00Z'),
                periodInferred: false,
              },
            },
          },
        }),
      ),
    );
    expect(hardConstraintResultSchema.safeParse(result).success).toBe(true);
  });

  // 0b — same class of bug, found in the same run: a quoted salary line
  // exceeded the evidence-item limit.
  it('keeps every component score inside the contract limits', async () => {
    const match = await engine.match(
      makeCandidateContext({
        preferences: { salary: { minimum: 1, target: 2 } },
      }),
      makeJobContext({
        enrichment: {
          compensation: {
            stated: true,
            rawText: 'y'.repeat(400),
            minimum: 1,
            currency: 'USD',
            period: 'year',
            confidence: 0.9,
            method: 'pattern',
            conversion: {
              annualUsd: 1,
              rate: 1,
              rateSource: 'test',
              rateTimestamp: new Date('2026-01-01T00:00:00Z'),
              periodInferred: false,
            },
          },
        },
      }),
    );
    // Validating the whole match is the point: the failure showed up on read,
    // not on write, so only a round-trip through the schema catches it.
    expect(jobMatchSchema.safeParse(match).success).toBe(true);
  });

  // 1
  it('finds a neutral candidate eligible for anything', () => {
    const result = evaluateHardConstraints(input());
    expect(result.eligible).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // 2
  it('excludes an on-site job for a remote-only candidate', () => {
    const result = evaluateHardConstraints(
      input(
        makeCandidateContext({ preferences: { workArrangement: 'REMOTE_ONLY' } }),
        makeJobContext({ enrichment: { workArrangement: { mode: 'onsite', confidence: 0.9 } } }),
      ),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations[0]?.severity).toBe('ABSOLUTE');
    expect(result.violations[0]?.explanation).toMatch(/remote-only/i);
  });

  // 3
  it('reports an unstated field as UNKNOWN, not FAIL', () => {
    // The corpus is mostly silence: 202 of 210 live jobs said nothing about
    // visas. Treating silence as refusal would suppress nearly everything.
    const result = evaluateHardConstraints(
      input(
        makeCandidateContext({
          preferences: { workAuthorization: { sponsorshipRequirement: 'required' } },
        }),
        makeJobContext({ enrichment: { workAuthorization: { sponsorship: 'not_mentioned' } } }),
      ),
    );
    expect(result.eligible).toBe(true);
    expect(result.unknowns.map((u) => u.constraint)).toContain('Visa sponsorship');
    expect(result.violations).toHaveLength(0);
  });

  // 4
  it('fails an unstated field when the candidate refused to tolerate it', () => {
    const result = evaluateHardConstraints(
      input(
        makeCandidateContext({
          preferences: {
            workAuthorization: {
              sponsorshipRequirement: 'required',
              acceptUnknownSponsorship: false,
            },
          },
        }),
        makeJobContext({ enrichment: { workAuthorization: { sponsorship: 'not_mentioned' } } }),
      ),
    );
    expect(result.eligible).toBe(false);
  });

  // 5
  it('omits dimensions the candidate never configured', () => {
    const result = evaluateHardConstraints(input());
    // A neutral candidate should not be shown a wall of constraints they never
    // set; that is noise, not transparency.
    expect(result.checks.length).toBeLessThanOrEqual(2);
  });

  // 6
  it('excludes a job above the candidate office-day limit', () => {
    const result = evaluateHardConstraints(
      input(
        makeCandidateContext({
          preferences: { workArrangement: 'HYBRID_ACCEPTED', maxOfficeDaysPerWeek: 2 },
        }),
        makeJobContext({
          enrichment: { workArrangement: { mode: 'hybrid', confidence: 0.9, officeDaysPerWeek: 4 } },
        }),
      ),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations[0]?.constraint).toBe('Office days per week');
  });
});

describe('skill scoring', () => {
  const graph = new SkillGraph();

  // 7
  it('credits an exact skill match fully', () => {
    const result = scoreSkills(
      input(
        makeCandidateContext({
          skills: [makeCandidateSkill('React', { slug: 'react', proficiency: 'expert' })],
          skillGraph: graph,
        }),
        makeJobContext({ enrichment: { skills: makeSkills([['react']]) } }),
      ),
    );
    expect(result.component.score).toBe(100);
    expect(result.matches[0]?.kind).toBe('exact');
  });

  // 8
  it('credits a related skill partially and records the path', () => {
    const result = scoreSkills(
      input(
        makeCandidateContext({
          skills: [makeCandidateSkill('Next.js', { slug: 'nextjs', proficiency: 'expert' })],
          skillGraph: graph,
        }),
        makeJobContext({ enrichment: { skills: makeSkills([['react']]) } }),
      ),
    );
    expect(result.component.score).toBeGreaterThan(60);
    expect(result.component.score).toBeLessThan(100);
    expect(result.matches[0]?.kind).toBe('closely_related');
    // The path is what makes an indirect match explainable rather than magic.
    expect(result.matches[0]?.via).toContain('nextjs');
  });

  // 9
  it('weights a missing required skill more heavily than a missing optional one', () => {
    const candidate = makeCandidateContext({
      skills: [makeCandidateSkill('Python', { slug: 'python' })],
      skillGraph: graph,
    });
    const missingRequired = scoreSkills(
      input(candidate, makeJobContext({ enrichment: { skills: makeSkills([['rust', 'required']]) } })),
    );
    const missingOptional = scoreSkills(
      input(
        candidate,
        makeJobContext({
          enrichment: { skills: makeSkills([['python', 'required'], ['rust', 'optional']]) },
        }),
      ),
    );
    expect(missingRequired.component.score).toBeLessThan(missingOptional.component.score);
  });

  // 10
  it('does not apply when the candidate has no recorded skills', () => {
    const result = scoreSkills(
      input(makeCandidateContext(), makeJobContext({ enrichment: { skills: makeSkills([['react']]) } })),
    );
    expect(result.component.applicable).toBe(false);
  });

  // 11
  it('scales credit by proficiency', () => {
    const job = makeJobContext({ enrichment: { skills: makeSkills([['react']]) } });
    const expert = scoreSkills(
      input(
        makeCandidateContext({
          skills: [makeCandidateSkill('React', { slug: 'react', proficiency: 'expert' })],
        }),
        job,
      ),
    );
    const beginner = scoreSkills(
      input(
        makeCandidateContext({
          skills: [makeCandidateSkill('React', { slug: 'react', proficiency: 'beginner' })],
        }),
        job,
      ),
    );
    expect(expert.component.score).toBeGreaterThan(beginner.component.score);
  });
});

describe('dimension scorers', () => {
  // 12
  it('penalises an experience shortfall proportionally', () => {
    const oneShort = scoreExperience(
      input(
        makeCandidateContext({ professional: { yearsOfExperience: 4 } }),
        makeJobContext({ enrichment: { experience: { minimumYears: 5, confidence: 0.9 } } }),
      ),
    );
    const fourShort = scoreExperience(
      input(
        makeCandidateContext({ professional: { yearsOfExperience: 1 } }),
        makeJobContext({ enrichment: { experience: { minimumYears: 5, confidence: 0.9 } } }),
      ),
    );
    expect(oneShort.score).toBeGreaterThan(fourShort.score);
    expect(oneShort.score).toBeGreaterThan(70);
  });

  // 13
  it('flags over-qualification without treating it as disqualifying', () => {
    const result = scoreExperience(
      input(
        makeCandidateContext({ professional: { yearsOfExperience: 15 } }),
        makeJobContext({
          enrichment: { experience: { minimumYears: 1, maximumYears: 3, confidence: 0.8 } },
        }),
      ),
    );
    expect(result.score).toBeLessThan(100);
    expect(result.score).toBeGreaterThanOrEqual(45);
    expect(result.explanation).toMatch(/over-qualified/i);
  });

  // 14
  it('treats a stated target seniority as outranking the current level', () => {
    const result = scoreSeniority(
      input(
        makeCandidateContext({
          preferences: { seniorityLevels: ['staff'] },
          professional: { seniority: 'mid' },
        }),
        makeJobContext({ enrichment: { seniority: 'staff', seniorityConfidence: 0.9 } }),
      ),
    );
    // Wanting a step up is intent, not error.
    expect(result.score).toBe(100);
  });

  // 15
  it('does not penalise a missing education level', () => {
    const result = scoreEducation(
      input(
        makeCandidateContext(),
        makeJobContext({
          enrichment: { education: { level: 'bachelors', requirement: 'required', confidence: 0.8 } },
        }),
      ),
    );
    expect(result.applicable).toBe(false);
  });

  // 16
  it('scores salary against the target, not just the floor', () => {
    const candidate = makeCandidateContext({
      preferences: { salary: { minimum: 60_000, target: 100_000, currency: 'USD', period: 'year' } },
    });
    const atTarget = scoreSalary(
      input(candidate, makeJobContext({ enrichment: compensation(100_000) })),
    );
    const atFloor = scoreSalary(
      input(candidate, makeJobContext({ enrichment: compensation(60_000) })),
    );
    expect(atTarget.score).toBeGreaterThan(atFloor.score);
    expect(atFloor.score).toBeGreaterThan(0);
  });

  // 17
  it('does not compare a salary in a currency it has no rate for', () => {
    const result = scoreSalary(
      input(
        makeCandidateContext({
          preferences: { salary: { minimum: 100, currency: 'XYZ', period: 'year' } },
        }),
        makeJobContext({ enrichment: compensation(80_000) }),
      ),
    );
    // Refusing to guess beats inventing a comparison out of an assumed parity.
    expect(result.applicable).toBe(false);
    expect(result.explanation).toMatch(/exchange rate/i);
  });

  // 18
  it('separates "not mentioned" from "not offered" for visas', () => {
    const candidate = makeCandidateContext({
      preferences: { workAuthorization: { sponsorshipRequirement: 'preferred' } },
    });
    const silent = scoreVisa(
      input(candidate, makeJobContext({ enrichment: { workAuthorization: { sponsorship: 'not_mentioned' } } })),
    );
    const refused = scoreVisa(
      input(candidate, makeJobContext({ enrichment: { workAuthorization: { sponsorship: 'not_offered' } } })),
    );
    expect(silent.score).toBeGreaterThan(refused.score);
    // Silence is honestly reported as low confidence, not confident neutrality.
    expect(silent.confidence).toBeLessThan(0.4);
  });

  // 19
  it('treats remote-worldwide as location-independent', () => {
    const result = scoreLocation(
      input(
        makeCandidateContext({
          preferences: { countries: [{ value: 'DE', strength: 'preferred' }] },
        }),
        makeJobContext({
          enrichment: {
            workArrangement: { mode: 'remote', confidence: 0.9, remoteWorldwide: true },
          },
        }),
      ),
    );
    expect(result.score).toBeGreaterThan(80);
  });

  // 20
  it('rewards a hybrid role that stays under the office-day limit', () => {
    const under = scoreWorkArrangement(
      input(
        makeCandidateContext({
          preferences: { workArrangement: 'HYBRID_ACCEPTED', maxOfficeDaysPerWeek: 3 },
        }),
        makeJobContext({
          enrichment: { workArrangement: { mode: 'hybrid', confidence: 0.9, officeDaysPerWeek: 1 } },
        }),
      ),
    );
    expect(under.score).toBe(100);
    expect(under.evidence).toContain('1 office day(s)/week');
  });

  // 21
  it('scores a substring title match on preference strength', () => {
    const result = scoreTitle(
      input(
        makeCandidateContext({
          preferences: { titles: [{ value: 'frontend engineer', strength: 'strongly_preferred' }] },
        }),
        makeJobContext({ enrichment: { normalizedTitle: 'Senior Frontend Engineer' } }),
      ),
    );
    expect(result.score).toBeGreaterThan(80);
  });

  // 21b — regression from a live run over 331 real postings.
  it('falls back to the current title when no targets are set', () => {
    const candidate = makeCandidateContext({
      professional: { currentTitle: 'Software Engineer' },
    });

    const unrelated = scoreTitle(
      input(candidate, makeJobContext({ enrichment: { normalizedTitle: 'Laundry Attendant' } })),
    );
    const related = scoreTitle(
      input(
        candidate,
        makeJobContext({ enrichment: { normalizedTitle: 'Senior Software Engineer' } }),
      ),
    );

    // Without this, a candidate who has not filled in target titles has no
    // applicable title dimension at all, and a laundry role scores as well as
    // an engineering one on the remaining dimensions.
    expect(unrelated.applicable).toBe(true);
    expect(unrelated.score).toBeLessThan(20);
    expect(related.score).toBeGreaterThan(60);
    expect(related.explanation).toMatch(/current title/);
  });

  // 21c
  it('has no title opinion when neither targets nor a current title exist', () => {
    const result = scoreTitle(input(makeCandidateContext(), makeJobContext()));
    expect(result.applicable).toBe(false);
  });

  // 22
  it('lets a negative reaction outweigh a positive one', () => {
    const result = scoreIndustry(
      input(
        makeCandidateContext({
          preferences: {
            industries: [
              { value: 'fintech', strength: 'strongly_preferred' },
              { value: 'gambling', strength: 'undesirable' },
            ],
          },
        }),
        makeJobContext({ enrichment: { classification: { industries: ['fintech', 'gambling'] } } }),
      ),
    );
    // The exclusion is the salient fact, not the average of the two.
    expect(result.score).toBeLessThan(50);
  });

  // 23
  it('does not treat an unlisted company as a negative opinion', () => {
    const result = scoreCompany(
      input(
        makeCandidateContext({ preferences: { companies: [{ value: 'Acme', strength: 'preferred' }] } }),
        makeJobContext({ companyName: 'Unknown Startup' }),
      ),
    );
    expect(result.score).toBe(50);
  });
});

describe('weighting', () => {
  // 24
  it('excludes inapplicable dimensions from the average', () => {
    const components = [
      { dimension: 'skills', score: 100, confidence: 1, applicable: true, explanation: '', evidence: [] },
      { dimension: 'salary', score: 0, confidence: 0, applicable: false, explanation: '', evidence: [] },
    ];
    const weights = { technicalSkills: 30, salary: 10 } as never;
    // Averaging the unstated salary in as zero would rank a detailed posting
    // below a vague one, which is exactly backwards.
    expect(aggregate(components, weights).score).toBe(100);
  });

  // 25
  it('survives NaN, negative and infinite weights', () => {
    const components = [
      { dimension: 'skills', score: 80, confidence: 1, applicable: true, explanation: '', evidence: [] },
      { dimension: 'salary', score: 20, confidence: 1, applicable: true, explanation: '', evidence: [] },
    ];
    const weights = { technicalSkills: Number.NaN, salary: -5 } as never;
    const result = aggregate(components, weights);
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBe(50);
  });

  // 26
  it('falls back to equal weight when every weight is zero', () => {
    const normalized = normalize({
      technicalSkills: 0, experience: 0, location: 0, workArrangement: 0, salary: 0,
      visa: 0, seniority: 0, industry: 0, companyPreference: 0, titleMatch: 0,
      education: 0, employmentType: 0, quality: 0, semantic: 0,
    });
    const values = Object.values(normalized);
    expect(values.every((v) => v > 0)).toBe(true);
  });
});

describe('semantic similarity', () => {
  // 27
  it('refuses to compare vectors from different models', () => {
    const result = compareEmbeddings(
      { model: 'a', vector: [1, 0] },
      { model: 'b', vector: [1, 0] },
    );
    expect(result.similarity).toBeNull();
    expect(result.reason).toMatch(/model mismatch/);
  });

  // 28
  it('refuses to compare vectors of different dimensions', () => {
    expect(compareEmbeddings({ model: 'a', vector: [1, 0] }, { model: 'a', vector: [1, 0, 0] }).similarity).toBeNull();
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBeNull();
  });

  // 29
  it('scores identical text higher than unrelated text', async () => {
    const provider = new HashingEmbeddingProvider(128);
    const { vectors } = await provider.embed([
      'senior react typescript frontend engineer',
      'senior react typescript frontend engineer',
      'warehouse forklift operator night shift',
    ]);
    const same = cosineSimilarity(vectors[0]!, vectors[1]!)!;
    const different = cosineSimilarity(vectors[0]!, vectors[2]!)!;
    expect(same).toBeGreaterThan(different);
    expect(similarityToScore(same)).toBeGreaterThan(similarityToScore(different));
  });
});

describe('behavioural signals', () => {
  // 30
  it('never applies a signal that contradicts an explicit preference', () => {
    const result = scoreBehavioral(
      input(
        makeCandidateContext({
          preferences: { countries: [{ value: 'NG', strength: 'excluded' }] },
          learnedSignals: [
            {
              dimension: 'countries', value: 'NG', affinity: 0.9,
              observations: 30, confidence: 1, conflictsWithExplicit: true,
            },
          ],
        }),
        makeJobContext({ enrichment: { location: { countryCode: 'NG', confidence: 0.9 } } }),
      ),
      5,
    );
    expect(result.adjustment).toBe(0);
    expect(result.suppressed).toHaveLength(1);
  });

  // 31
  it('stays inside the configured adjustment budget', () => {
    const result = scoreBehavioral(
      input(
        makeCandidateContext({
          learnedSignals: [
            {
              dimension: 'companies', value: 'Example Co', affinity: 1,
              observations: 50, confidence: 1, conflictsWithExplicit: false,
            },
          ],
        }),
        makeJobContext({ companyName: 'Example Co' }),
      ),
      5,
    );
    expect(result.adjustment).toBeLessThanOrEqual(5);
    expect(result.adjustment).toBeGreaterThan(0);
  });
});

describe('LLM boundary', () => {
  // 32
  it('clamps an out-of-range model adjustment', () => {
    const result = validateReasoning(
      { assessment: 'great', scoreAdjustment: 50, confidence: 0.9 },
      10,
    );
    expect(result?.reasoning.scoreAdjustment).toBe(10);
    expect(result?.clamped).toBe(true);
  });

  // 33
  it('discards a response that fails schema validation', () => {
    expect(validateReasoning({ assessment: 'x', scoreAdjustment: 'lots' }, 10)).toBeNull();
  });

  // 34
  it('never runs the model on an ineligible job', () => {
    const config = {
      maxLlmAdjustment: 10,
      maxBehavioralAdjustment: 5,
      thresholds: { exceptional: 90, strong: 78, good: 65, possible: 50, minConfidence: 0.35 },
      llm: { enabled: true, minStructuredScore: 0, maxConfidence: 1, maxCallsPerRun: 50, model: 'test' },
    };
    const gate = shouldUseLlm(
      { eligible: false, structuredScore: 95, confidence: 0.1, callsMade: 0 },
      config,
    );
    expect(gate.use).toBe(false);
    expect(gate.reason).toMatch(/ineligible/);
  });

  // 35
  it('skips the model when the structural result is already confident', () => {
    const config = {
      maxLlmAdjustment: 10,
      maxBehavioralAdjustment: 5,
      thresholds: { exceptional: 90, strong: 78, good: 65, possible: 50, minConfidence: 0.35 },
      llm: { enabled: true, minStructuredScore: 50, maxConfidence: 0.75, maxCallsPerRun: 50, model: 'test' },
    };
    expect(
      shouldUseLlm({ eligible: true, structuredScore: 80, confidence: 0.9, callsMade: 0 }, config).use,
    ).toBe(false);
  });

  // 36
  it('completes the match when the provider throws', async () => {
    const failing: MatchReasoningProvider = {
      id: 'failing',
      isAvailable: () => true,
      reason: () => Promise.reject(new Error('provider exploded')),
    };
    const withLlm = new MatchingEngine({
      logger,
      reasoning: failing,
      config: { llm: { enabled: true, minStructuredScore: 0, maxConfidence: 1 } },
    });

    const match = await withLlm.match(makeCandidateContext(), makeJobContext());
    // A flaky provider must not cost the candidate the result.
    expect(match.overallScore).toBeGreaterThan(0);
    expect(match.trace.llmAdjustment).toBe(0);
    expect(match.trace.notes.some((n) => n.includes('llm'))).toBe(true);
  });

  // 37
  it('applies a valid model adjustment within bounds', async () => {
    const reasoning: LlmReasoning = {
      assessment: 'Strong overlap with the platform work described.',
      scoreAdjustment: 8,
      confidence: 0.8,
      positiveSignals: ['Owns the frontend platform'],
      negativeSignals: [],
      missingRequirements: [],
      concerns: [],
    };
    const usage: LlmUsage = {
      model: 'test-model', inputTokens: 100, outputTokens: 50,
      costUsd: 0.001, latencyMs: 120, cached: false,
    };
    const provider: MatchReasoningProvider = {
      id: 'stub',
      isAvailable: () => true,
      reason: (): Promise<MatchReasoningResult> => Promise.resolve({ reasoning, usage }),
    };

    const withLlm = new MatchingEngine({
      logger,
      reasoning: provider,
      config: { maxLlmAdjustment: 10, llm: { enabled: true, minStructuredScore: 0, maxConfidence: 1 } },
    });

    const baseline = await engine.match(makeCandidateContext(), makeJobContext());
    const adjusted = await withLlm.match(makeCandidateContext(), makeJobContext());

    expect(adjusted.trace.llmAdjustment).toBe(8);
    expect(adjusted.overallScore).toBeCloseTo(baseline.overallScore + 8, 1);
    expect(adjusted.llmUsage?.model).toBe('test-model');
  });
});

describe('recommendation', () => {
  const thresholds = { exceptional: 90, strong: 78, good: 65, possible: 50, minConfidence: 0.35 };

  // 38
  it('reports a high score built on nothing as UNCERTAIN', () => {
    expect(classify({ eligible: true, score: 95, confidence: 0.1 }, thresholds)).toBe('UNCERTAIN');
  });

  // 39
  it('returns INELIGIBLE regardless of score or confidence', () => {
    expect(classify({ eligible: false, score: 99, confidence: 1 }, thresholds)).toBe('INELIGIBLE');
  });

  // 40
  it('maps scores onto the configured bands', () => {
    expect(classify({ eligible: true, score: 92, confidence: 0.9 }, thresholds)).toBe('EXCEPTIONAL_MATCH');
    expect(classify({ eligible: true, score: 80, confidence: 0.9 }, thresholds)).toBe('STRONG_MATCH');
    expect(classify({ eligible: true, score: 70, confidence: 0.9 }, thresholds)).toBe('GOOD_MATCH');
    expect(classify({ eligible: true, score: 55, confidence: 0.9 }, thresholds)).toBe('POSSIBLE_MATCH');
    expect(classify({ eligible: true, score: 20, confidence: 0.9 }, thresholds)).toBe('WEAK_MATCH');
  });

  // 41
  it('honours reconfigured thresholds without a code change', () => {
    const strict = { ...thresholds, exceptional: 99, strong: 95, good: 90, possible: 85 };
    expect(classify({ eligible: true, score: 92, confidence: 0.9 }, strict)).toBe('GOOD_MATCH');
  });
});

describe('the engine end to end', () => {
  // 42
  it('produces a full explainable match', async () => {
    const match = await engine.match(
      makeCandidateContext({
        preferences: {
          titles: [{ value: 'frontend engineer', strength: 'strongly_preferred' }],
          workArrangement: 'REMOTE_PREFERRED',
        },
        professional: { yearsOfExperience: 6, seniority: 'senior' },
        skills: [
          makeCandidateSkill('React', { slug: 'react', proficiency: 'expert' }),
          makeCandidateSkill('TypeScript', { slug: 'typescript', proficiency: 'advanced' }),
        ],
      }),
      makeJobContext({
        title: 'Senior Frontend Engineer',
        enrichment: {
          normalizedTitle: 'Senior Frontend Engineer',
          seniority: 'senior',
          seniorityConfidence: 0.9,
          experience: { minimumYears: 5, confidence: 0.9 },
          workArrangement: { mode: 'remote', confidence: 0.95, remoteWorldwide: true },
          skills: makeSkills([['react'], ['typescript']]),
        },
      }),
    );

    expect(match.eligible).toBe(true);
    expect(match.overallScore).toBeGreaterThan(70);
    expect(match.explanation.length).toBeGreaterThan(40);
    expect(match.componentScores.length).toBeGreaterThan(8);
    expect(match.matchedRequirements).toContain('react');
    expect(match.trace.matchingVersion).toBeTruthy();
    expect(match.trace.weightsUsed).toHaveProperty('skills');
  });

  // 43
  it('zeroes an ineligible job and skips semantic and LLM entirely', async () => {
    const provider: MatchReasoningProvider = {
      id: 'should-not-run',
      isAvailable: () => true,
      reason: () => Promise.reject(new Error('the LLM must never be consulted here')),
    };
    const withLlm = new MatchingEngine({
      logger,
      reasoning: provider,
      config: { llm: { enabled: true, minStructuredScore: 0, maxConfidence: 1 } },
    });

    const embedding = { model: 'test', vector: [1, 0, 0] };
    const match = await withLlm.match(
      makeCandidateContext({ preferences: { workArrangement: 'REMOTE_ONLY' }, embedding }),
      makeJobContext({
        enrichment: { workArrangement: { mode: 'onsite', confidence: 0.95 } },
        // A perfectly similar vector must not rescue it.
        embedding,
      }),
    );

    expect(match.eligible).toBe(false);
    expect(match.overallScore).toBe(0);
    expect(match.recommendation).toBe('INELIGIBLE');
    expect(match.trace.semanticScore).toBeNull();
    expect(match.trace.llmAdjustment).toBe(0);
    expect(match.explanation).toMatch(/ineligible/i);
  });

  // 44
  it('rejects a match object that violates the eligibility invariant', async () => {
    const match = await engine.match(
      makeCandidateContext({ preferences: { workArrangement: 'REMOTE_ONLY' } }),
      makeJobContext({ enrichment: { workArrangement: { mode: 'onsite', confidence: 0.9 } } }),
    );
    // The guard is what stops a future refactor silently recommending a job
    // the candidate said they cannot take.
    expect(() =>
      assertEligibilityRespected({ ...match, recommendation: 'STRONG_MATCH' }),
    ).toThrow(/invariant violated/i);
    expect(() => assertEligibilityRespected({ ...match, overallScore: 80 })).toThrow();
  });

  // 45
  it('reports low confidence for a posting that states almost nothing', async () => {
    const match = await engine.match(
      makeCandidateContext({
        preferences: {
          titles: [{ value: 'data engineer', strength: 'required' }],
          countries: [{ value: 'DE', strength: 'preferred' }],
          salary: { minimum: 80_000, target: 120_000, currency: 'USD', period: 'year' },
          workAuthorization: { sponsorshipRequirement: 'preferred' },
        },
        skills: [makeCandidateSkill('Python', { slug: 'python' })],
      }),
      makeJobContext({ enrichment: { normalizedTitle: 'Engineer' } }),
    );
    expect(match.confidence).toBeLessThan(0.5);
  });

  // 46
  it('includes the semantic dimension when both vectors are present', async () => {
    const provider = new HashingEmbeddingProvider(128);
    const { vectors, model } = await provider.embed([
      'react typescript frontend engineer building web applications',
      'react typescript frontend engineer building web applications',
    ]);

    const match = await engine.match(
      makeCandidateContext({ embedding: { model, vector: vectors[0]! } }),
      makeJobContext({ embedding: { model, vector: vectors[1]! } }),
    );

    expect(match.trace.semanticScore).not.toBeNull();
    expect(match.componentScores.find((c) => c.dimension === 'semantic')?.applicable).toBe(true);
  });

  // 47
  it('notes why the semantic dimension was skipped', async () => {
    const match = await engine.match(makeCandidateContext(), makeJobContext());
    expect(match.trace.semanticScore).toBeNull();
    expect(match.trace.notes.join(' ')).toMatch(/no candidate embedding/);
  });

  // 48
  it('records enough provenance to reconstruct the score', async () => {
    const match = await engine.match(
      makeCandidateContext({ profileVersion: 3, preferenceVersion: 7 }),
      makeJobContext(),
    );
    expect(match.trace.profileVersion).toBe(3);
    expect(match.trace.preferenceVersion).toBe(7);
    expect(match.trace.enrichmentVersion).toBe(1);
    expect(match.trace.componentScores.length).toBe(match.componentScores.length);
    expect(match.trace.llmDecision).toBeTruthy();
  });

  // 49
  it('penalises a scam-flagged posting', async () => {
    const clean = await engine.match(makeCandidateContext(), makeJobContext());
    const scam = await engine.match(
      makeCandidateContext(),
      makeJobContext({
        enrichment: {
          quality: {
            qualityScore: 0.3,
            scamScore: 0.85,
            qualityConfidence: 0.9,
            flags: [{ flag: 'payment_requested', weight: 1, evidence: 'registration fee' }],
          },
        },
      }),
    );
    expect(scam.overallScore).toBeLessThan(clean.overallScore);
    expect(scam.concerns.join(' ')).toMatch(/payment_requested/);
  });

  // 50
  it('never returns a score outside 0-100 or a confidence outside 0-1', async () => {
    const extremes = [
      makeJobContext({ enrichment: { quality: { qualityScore: 1, scamScore: 0, qualityConfidence: 1, flags: [] } } }),
      makeJobContext({ enrichment: { quality: { qualityScore: 0, scamScore: 1, qualityConfidence: 1, flags: [] } } }),
      makeJobContext({ enrichment: { experience: { minimumYears: 40, confidence: 1 } } }),
    ];
    for (const job of extremes) {
      const match = await engine.match(
        makeCandidateContext({ professional: { yearsOfExperience: 0 } }),
        job,
      );
      expect(match.overallScore).toBeGreaterThanOrEqual(0);
      expect(match.overallScore).toBeLessThanOrEqual(100);
      expect(match.confidence).toBeGreaterThanOrEqual(0);
      expect(match.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('preferences are data', () => {
  /**
   * The property the whole system is built around: the same code, the same
   * job, different stored preferences, a different verdict. No branch anywhere
   * names a country, technology or salary figure.
   */

  // 51
  it('flips eligibility when only the stored preferences change', async () => {
    const job = makeJobContext({
      enrichment: { workArrangement: { mode: 'onsite', confidence: 0.95 } },
    });

    const strict = await engine.match(
      makeCandidateContext({ preferences: { workArrangement: 'REMOTE_ONLY' } }),
      job,
    );
    const relaxed = await engine.match(
      makeCandidateContext({ preferences: { workArrangement: 'ONSITE_ACCEPTED' } }),
      job,
    );

    expect(strict.eligible).toBe(false);
    expect(relaxed.eligible).toBe(true);
    expect(relaxed.overallScore).toBeGreaterThan(strict.overallScore);
  });

  // 52
  it('changes ranking when only the weights change', async () => {
    const job = makeJobContext({
      enrichment: {
        normalizedTitle: 'Backend Engineer',
        skills: makeSkills([['python']]),
        location: { countryCode: 'NG', city: 'Lagos', confidence: 0.9 },
      },
    });
    const base = {
      titles: [{ value: 'frontend engineer', strength: 'preferred' }],
      countries: [{ value: 'DE', strength: 'preferred' }],
    };

    const titleHeavy = await engine.match(
      makeCandidateContext({ preferences: { ...base, weights: { titleMatch: 90, location: 1 } } }),
      job,
    );
    const locationHeavy = await engine.match(
      makeCandidateContext({ preferences: { ...base, weights: { titleMatch: 1, location: 90 } } }),
      job,
    );

    expect(titleHeavy.overallScore).not.toBe(locationHeavy.overallScore);
    expect(titleHeavy.trace.weightsUsed.title).toBeGreaterThan(
      locationHeavy.trace.weightsUsed.title!,
    );
  });

  // 53
  it('reflects a new excluded keyword immediately', async () => {
    const job = makeJobContext({
      title: 'Blockchain Engineer',
      description: 'Work on our blockchain protocol.',
      enrichment: { normalizedTitle: 'Blockchain Engineer', cleanedDescription: 'blockchain protocol work' },
    });

    const before = await engine.match(makeCandidateContext(), job);
    const after = await engine.match(
      makeCandidateContext({ preferences: { excludedKeywords: ['blockchain'] } }),
      job,
    );

    expect(before.eligible).toBe(true);
    expect(after.eligible).toBe(false);
  });
});

/** Compensation block with a USD conversion already computed. */
function compensation(annualUsd: number): Record<string, unknown> {
  return {
    compensation: {
      stated: true,
      minimum: annualUsd,
      maximum: annualUsd,
      currency: 'USD',
      period: 'year',
      confidence: 0.9,
      method: 'pattern',
      rawText: `$${annualUsd}/year`,
      conversion: {
        annualUsd,
        rate: 1,
        rateSource: 'test',
        rateTimestamp: new Date('2026-01-01T00:00:00Z'),
        periodInferred: false,
      },
    },
  };
}
