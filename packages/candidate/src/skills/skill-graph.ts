import type { SkillRelation, SkillRelationType } from '@job-intel/contracts';

/**
 * Skill relationship graph.
 *
 * Deliberately a small seed plus an extensible structure, not an attempt at an
 * exhaustive taxonomy. Relationships are *data*: they load from the database,
 * and adding one is a row rather than a release.
 *
 * The purpose is credit transfer during matching. A candidate who knows Next.js
 * demonstrably knows React, and a job asking for React should not score them as
 * a stranger to it. Transfer is damped by edge weight so indirect credit never
 * equals direct evidence.
 */

/** Seed edges. `implies` is directional; `related` is symmetric proximity. */
export const SEED_SKILL_RELATIONS: SkillRelation[] = [
  { fromSlug: 'nextjs', toSlug: 'react', type: 'implies', weight: 0.9 },
  { fromSlug: 'remix', toSlug: 'react', type: 'implies', weight: 0.85 },
  { fromSlug: 'react-native', toSlug: 'react', type: 'implies', weight: 0.8 },
  { fromSlug: 'redux', toSlug: 'react', type: 'implies', weight: 0.7 },
  { fromSlug: 'nuxt', toSlug: 'vue', type: 'implies', weight: 0.9 },
  // Browser frameworks imply the language they are written in. Without these
  // edges a candidate with four years of React scores as a JavaScript stranger.
  { fromSlug: 'react', toSlug: 'javascript', type: 'implies', weight: 0.9 },
  { fromSlug: 'vue', toSlug: 'javascript', type: 'implies', weight: 0.9 },
  { fromSlug: 'angular', toSlug: 'typescript', type: 'implies', weight: 0.85 },
  { fromSlug: 'svelte', toSlug: 'javascript', type: 'implies', weight: 0.9 },
  { fromSlug: 'typescript', toSlug: 'javascript', type: 'implies', weight: 0.95 },
  { fromSlug: 'nodejs', toSlug: 'javascript', type: 'implies', weight: 0.9 },
  { fromSlug: 'express', toSlug: 'nodejs', type: 'implies', weight: 0.85 },
  { fromSlug: 'nestjs', toSlug: 'nodejs', type: 'implies', weight: 0.85 },
  { fromSlug: 'django', toSlug: 'python', type: 'implies', weight: 0.9 },
  { fromSlug: 'flask', toSlug: 'python', type: 'implies', weight: 0.9 },
  { fromSlug: 'fastapi', toSlug: 'python', type: 'implies', weight: 0.9 },
  { fromSlug: 'rails', toSlug: 'ruby', type: 'implies', weight: 0.9 },
  { fromSlug: 'spring', toSlug: 'java', type: 'implies', weight: 0.9 },
  { fromSlug: 'laravel', toSlug: 'php', type: 'implies', weight: 0.9 },
  { fromSlug: 'dotnet', toSlug: 'csharp', type: 'implies', weight: 0.9 },

  // Cloud services are parts of their platform.
  { fromSlug: 'ec2', toSlug: 'aws', type: 'part_of', weight: 0.9 },
  { fromSlug: 's3', toSlug: 'aws', type: 'part_of', weight: 0.9 },
  { fromSlug: 'lambda', toSlug: 'aws', type: 'part_of', weight: 0.9 },
  { fromSlug: 'rds', toSlug: 'aws', type: 'part_of', weight: 0.85 },

  /*
   * Docker and Kubernetes are neighbours, not substitutes.
   *
   * Weighted below the partial-match floor deliberately. Someone who has run
   * containers has a real head start on orchestrating them, and a posting that
   * asks for production Kubernetes is not asking about Docker. Rating this any
   * higher turns "I have used Docker" into a claim of Kubernetes experience,
   * which is exactly the inflation the layer above exists to prevent.
   */
  { fromSlug: 'kubernetes', toSlug: 'docker', type: 'related', weight: 0.55 },

  /*
   * Services within one cloud platform.
   *
   * `part_of` already runs service → platform: using S3 proves you have used
   * AWS. These edges run the other way at a lower weight, which is the case the
   * brief calls out — a candidate with ECS and S3 against a Lambda requirement
   * has genuine AWS experience and no Lambda experience, and both halves of
   * that sentence have to survive.
   */
  { fromSlug: 'aws', toSlug: 'lambda', type: 'related', weight: 0.75 },
  { fromSlug: 'aws', toSlug: 'ec2', type: 'related', weight: 0.75 },
  { fromSlug: 'aws', toSlug: 's3', type: 'related', weight: 0.78 },
  { fromSlug: 'aws', toSlug: 'ecs', type: 'related', weight: 0.75 },
  { fromSlug: 'terraform', toSlug: 'ci-cd', type: 'related', weight: 0.5 },
  { fromSlug: 'react', toSlug: 'vue', type: 'related', weight: 0.4 },
  { fromSlug: 'vue', toSlug: 'angular', type: 'related', weight: 0.4 },
  { fromSlug: 'postgresql', toSlug: 'mysql', type: 'related', weight: 0.6 },
  { fromSlug: 'postgresql', toSlug: 'sql', type: 'implies', weight: 0.9 },
  { fromSlug: 'mysql', toSlug: 'sql', type: 'implies', weight: 0.9 },

  /*
   * Edges added after measuring against real postings.
   *
   * A sweep over the sixty most-demanded skills in the database found thirty
   * with no route from a broad senior profile, and most of the gaps were
   * relationships a hiring manager would consider obvious. The seed graph was
   * built framework-to-language, so credit flowed *upward* (Next.js proves
   * React proves JavaScript) and never sideways — which is where most real
   * transfer lives.
   */

  // Symmetric siblings: knowing one is genuine partial evidence for the other.
  { fromSlug: 'react', toSlug: 'react-native', type: 'related', weight: 0.55 },
  { fromSlug: 'react', toSlug: 'redux', type: 'related', weight: 0.6 },
  { fromSlug: 'css', toSlug: 'tailwind', type: 'related', weight: 0.6 },
  { fromSlug: 'html', toSlug: 'css', type: 'related', weight: 0.8 },
  { fromSlug: 'csharp', toSlug: 'dotnet', type: 'related', weight: 0.8 },
  { fromSlug: 'ruby', toSlug: 'rails', type: 'related', weight: 0.7 },
  { fromSlug: 'java', toSlug: 'kotlin', type: 'related', weight: 0.6 },
  { fromSlug: 'swift', toSlug: 'ios', type: 'related', weight: 0.8 },
  { fromSlug: 'kotlin', toSlug: 'android', type: 'related', weight: 0.7 },

  // Cloud platforms. Not interchangeable, but someone who has run production
  // on one is not starting from zero on another.
  { fromSlug: 'aws', toSlug: 'gcp', type: 'related', weight: 0.5 },
  { fromSlug: 'aws', toSlug: 'azure', type: 'related', weight: 0.5 },
  { fromSlug: 'gcp', toSlug: 'azure', type: 'related', weight: 0.5 },

  // Anyone shipping a web backend has built REST endpoints, whatever else
  // they also used. This was the single most common unrouted requirement.
  { fromSlug: 'express', toSlug: 'rest-api', type: 'implies', weight: 0.85 },
  { fromSlug: 'nestjs', toSlug: 'rest-api', type: 'implies', weight: 0.85 },
  { fromSlug: 'django', toSlug: 'rest-api', type: 'implies', weight: 0.8 },
  { fromSlug: 'fastapi', toSlug: 'rest-api', type: 'implies', weight: 0.9 },
  { fromSlug: 'spring', toSlug: 'rest-api', type: 'implies', weight: 0.85 },
  { fromSlug: 'rails', toSlug: 'rest-api', type: 'implies', weight: 0.8 },
  { fromSlug: 'graphql', toSlug: 'rest-api', type: 'related', weight: 0.5 },

  // Container work is Linux work.
  { fromSlug: 'docker', toSlug: 'linux', type: 'implies', weight: 0.7 },
  { fromSlug: 'kubernetes', toSlug: 'linux', type: 'implies', weight: 0.75 },

  // Message queues and warehouses.
  { fromSlug: 'kafka', toSlug: 'rabbitmq', type: 'related', weight: 0.5 },
  { fromSlug: 'postgresql', toSlug: 'snowflake', type: 'related', weight: 0.4 },
  { fromSlug: 'dynamodb', toSlug: 'mongodb', type: 'related', weight: 0.5 },

  // Ways of working.
  { fromSlug: 'agile', toSlug: 'collaboration', type: 'related', weight: 0.5 },
  { fromSlug: 'mentoring', toSlug: 'collaboration', type: 'implies', weight: 0.7 },
  { fromSlug: 'leadership', toSlug: 'collaboration', type: 'implies', weight: 0.7 },
  { fromSlug: 'system-design', toSlug: 'problem-solving', type: 'implies', weight: 0.6 },

  /*
   * Vocabulary reconciliation.
   *
   * The job-side extractor and the resume-side taxonomy were built separately
   * and disagree on a few slugs: postings say `jenkins` where resumes are
   * folded into `ci-cd`, and `html-css` where resumes carry `html` and `css`
   * separately. Left alone this costs matches silently — the candidate has the
   * skill, the posting asks for it, and the slugs never meet. Alias edges are
   * symmetric, so one row fixes both directions.
   */
  { fromSlug: 'jenkins', toSlug: 'ci-cd', type: 'alias', weight: 0.95 },
  { fromSlug: 'github-actions', toSlug: 'ci-cd', type: 'alias', weight: 0.95 },
  { fromSlug: 'gitlab-ci', toSlug: 'ci-cd', type: 'alias', weight: 0.95 },
  { fromSlug: 'html-css', toSlug: 'css', type: 'alias', weight: 0.9 },
  { fromSlug: 'html-css', toSlug: 'html', type: 'alias', weight: 0.9 },
  { fromSlug: 'restful-api', toSlug: 'rest-api', type: 'alias', weight: 1 },
  { fromSlug: 'nodejs', toSlug: 'node', type: 'alias', weight: 1 },
  { fromSlug: 'k8s', toSlug: 'kubernetes', type: 'alias', weight: 1 },
];

export interface SkillMatch {
  slug: string;
  /** 1 for a direct match; less when credit came through the graph. */
  strength: number;
  /** The path taken, so a surprising match is explainable. */
  via: string[];
}

export class SkillGraph {
  private readonly outgoing = new Map<string, SkillRelation[]>();

  constructor(relations: readonly SkillRelation[] = SEED_SKILL_RELATIONS) {
    for (const relation of relations) {
      this.addEdge(relation);
      // `related` and `alias` are symmetric; store both directions so traversal
      // does not depend on which way the row happened to be written.
      if (relation.type === 'related' || relation.type === 'alias') {
        this.addEdge({
          fromSlug: relation.toSlug,
          toSlug: relation.fromSlug,
          type: relation.type,
          weight: relation.weight,
        });
      }
    }
  }

  private addEdge(relation: SkillRelation): void {
    const list = this.outgoing.get(relation.fromSlug) ?? [];
    list.push(relation);
    this.outgoing.set(relation.fromSlug, list);
  }

  /** Adds a relationship at runtime, so the graph grows without a release. */
  add(relation: SkillRelation): void {
    this.addEdge(relation);
    if (relation.type === 'related' || relation.type === 'alias') {
      this.addEdge({
        fromSlug: relation.toSlug,
        toSlug: relation.fromSlug,
        type: relation.type,
        weight: relation.weight,
      });
    }
  }

  /**
   * Everything a candidate knowing `slug` gets partial credit for.
   *
   * Breadth-first with multiplicative damping and a depth cap: without the cap,
   * a densely connected graph eventually credits a candidate with every skill
   * in the taxonomy at trivial weight, which is noise dressed as signal.
   */
  expand(slug: string, options: { maxDepth?: number; minStrength?: number } = {}): SkillMatch[] {
    const maxDepth = options.maxDepth ?? 2;
    const minStrength = options.minStrength ?? 0.25;

    const best = new Map<string, SkillMatch>([[slug, { slug, strength: 1, via: [slug] }]]);
    let frontier: SkillMatch[] = [{ slug, strength: 1, via: [slug] }];

    for (let depth = 0; depth < maxDepth; depth += 1) {
      const next: SkillMatch[] = [];
      for (const current of frontier) {
        for (const edge of this.outgoing.get(current.slug) ?? []) {
          const strength = current.strength * edge.weight;
          if (strength < minStrength) continue;

          const existing = best.get(edge.toSlug);
          if (existing && existing.strength >= strength) continue;

          const match: SkillMatch = {
            slug: edge.toSlug,
            strength: Math.round(strength * 1000) / 1000,
            via: [...current.via, edge.toSlug],
          };
          best.set(edge.toSlug, match);
          next.push(match);
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }

    return [...best.values()].sort((a, b) => b.strength - a.strength);
  }

  /**
   * How well a candidate's skills cover a required skill.
   *
   * Returns the strongest route, so "knows Next.js" scores highly against a
   * React requirement while remaining distinguishable from knowing React itself.
   */
  coverage(candidateSlugs: readonly string[], requiredSlug: string): SkillMatch | null {
    if (candidateSlugs.includes(requiredSlug)) {
      return { slug: requiredSlug, strength: 1, via: [requiredSlug] };
    }

    let best: SkillMatch | null = null;
    for (const slug of candidateSlugs) {
      const match = this.expand(slug).find((m) => m.slug === requiredSlug);
      if (match && (!best || match.strength > best.strength)) best = match;
    }
    return best;
  }

  relationsFrom(slug: string): SkillRelation[] {
    return [...(this.outgoing.get(slug) ?? [])];
  }

  size(): { nodes: number; edges: number } {
    const nodes = new Set<string>();
    let edges = 0;
    for (const [from, list] of this.outgoing) {
      nodes.add(from);
      for (const edge of list) {
        nodes.add(edge.toSlug);
        edges += 1;
      }
    }
    return { nodes: nodes.size, edges };
  }

  /** Groups by relation type, for the settings UI. */
  describe(): Record<SkillRelationType, number> {
    const counts: Record<string, number> = {};
    for (const list of this.outgoing.values()) {
      for (const edge of list) counts[edge.type] = (counts[edge.type] ?? 0) + 1;
    }
    return counts as Record<SkillRelationType, number>;
  }
}
