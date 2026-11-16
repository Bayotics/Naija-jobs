import {
  AUTHORITY_WEIGHTS,
  sourceAuthorityConfigSchema,
  type SourceAuthorityConfig,
  type SourceAuthorityLevel,
} from '@job-intel/contracts';

/**
 * Source authority.
 *
 * How much a given source's version of a fact should be trusted. Resolved from
 * configuration in three steps — per-source override, then source type, then a
 * default — so the ordering can be retuned without a release.
 *
 * The temptation here is to hardcode "careers page beats aggregator". It is a
 * good default and a bad rule: plenty of careers pages are stale mirrors of an
 * ATS, some aggregators carry structured salary the employer omitted, and a
 * source that turns out to be unreliable needs to be demoted the same day it is
 * noticed — not in the next deploy.
 */

export interface SourceDescriptor {
  id: string;
  sourceType: string;
  accessTier?: string;
}

export class SourceAuthorityResolver {
  readonly config: SourceAuthorityConfig;

  constructor(config: Partial<SourceAuthorityConfig> = {}) {
    this.config = sourceAuthorityConfigSchema.parse(config);
  }

  level(source: SourceDescriptor): SourceAuthorityLevel {
    return (
      this.config.bySourceId[source.id] ??
      this.config.bySourceType[source.sourceType] ??
      this.config.default
    );
  }

  /** 0-1, for arithmetic. */
  weight(source: SourceDescriptor): number {
    return AUTHORITY_WEIGHTS[this.level(source)];
  }

  /** 0-100, for the recommendation formula. */
  score(source: SourceDescriptor): number {
    return this.weight(source) * 100;
  }

  /** Higher wins. Ties are broken by the caller, usually on freshness. */
  compare(a: SourceDescriptor, b: SourceDescriptor): number {
    return this.weight(b) - this.weight(a);
  }

  explain(source: SourceDescriptor): string {
    if (this.config.bySourceId[source.id]) {
      return `${source.id} is configured as ${this.level(source)}`;
    }
    if (this.config.bySourceType[source.sourceType]) {
      return `${source.sourceType} sources are configured as ${this.level(source)}`;
    }
    return `no authority configured for ${source.id}; using the ${this.config.default} default`;
  }
}
