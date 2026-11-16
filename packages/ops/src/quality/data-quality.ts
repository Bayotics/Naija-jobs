import { type DataQualityMetric, type PipelineStage } from '@job-intel/contracts';

/**
 * Data-quality reporting.
 *
 * Answers "where is the extraction pipeline weakest?" — which is a different
 * question from "is this job any good". A corpus where 78% of postings have no
 * salary is telling you about the *world*; one where 78% have no salary but the
 * source's own field is populated is telling you about a broken extractor.
 *
 * So each metric names the stage it implicates, and the ones that reflect the
 * world rather than a defect say so in their detail. A dashboard that flags
 * "missing salary" in red teaches its reader to ignore red.
 */

export interface DataQualityCounts {
  total: number;
  missingSalary: number;
  missingLocation: number;
  uncertainRemote: number;
  uncertainVisa: number;
  shortDescription: number;
  failedEnrichment: number;
  lowExtractionConfidence: number;
  missingApplicationUrl: number;
  noCompanyResolved: number;
}

interface MetricSpec {
  key: keyof DataQualityCounts;
  label: string;
  stage: PipelineStage;
  detail: string;
  /** Above this share, the metric is worth someone's attention. */
  concernThreshold: number;
}

const SPECS: MetricSpec[] = [
  {
    key: 'missingSalary',
    label: 'No salary stated',
    stage: 'enrichment',
    detail: 'Usually the posting, not the extractor — most employers omit salary',
    concernThreshold: 0.95,
  },
  {
    key: 'missingLocation',
    label: 'No location resolved',
    stage: 'normalization',
    detail: 'A high share suggests location parsing is failing, not that jobs are placeless',
    concernThreshold: 0.4,
  },
  {
    key: 'uncertainRemote',
    label: 'Work arrangement unknown',
    stage: 'enrichment',
    detail: 'The posting did not say, or the classifier could not tell',
    concernThreshold: 0.5,
  },
  {
    key: 'uncertainVisa',
    label: 'Visa status not mentioned',
    stage: 'enrichment',
    detail: 'Expected to be high — very few postings mention sponsorship at all',
    concernThreshold: 0.98,
  },
  {
    key: 'shortDescription',
    label: 'Description too short to analyse',
    stage: 'normalization',
    detail: 'Often a feed that only carries a summary; check the connector',
    concernThreshold: 0.25,
  },
  {
    key: 'failedEnrichment',
    label: 'Enrichment failed',
    stage: 'enrichment',
    detail: 'A real defect at any level above zero',
    concernThreshold: 0.01,
  },
  {
    key: 'lowExtractionConfidence',
    label: 'Low extraction confidence',
    stage: 'enrichment',
    detail: 'Structured but uncertain; these carry weak match confidence downstream',
    concernThreshold: 0.35,
  },
  {
    key: 'missingApplicationUrl',
    label: 'No application URL',
    stage: 'enrichment',
    detail: 'These can never be notified — there is nowhere to send you',
    concernThreshold: 0.2,
  },
  {
    key: 'noCompanyResolved',
    label: 'Company not resolved to a registry entry',
    stage: 'normalization',
    detail: 'Costs quality points and weakens deduplication',
    concernThreshold: 0.5,
  },
];

export function buildDataQuality(counts: DataQualityCounts): DataQualityMetric[] {
  const total = Math.max(0, counts.total);

  return SPECS.map((spec) => {
    const count = Math.max(0, counts[spec.key]);
    const share = total === 0 ? 0 : count / total;

    return {
      key: spec.key,
      label: spec.label,
      count,
      total,
      share: Math.round(share * 1000) / 1000,
      stage: spec.stage,
      detail:
        total === 0
          ? 'No jobs to assess yet'
          : share > spec.concernThreshold
            ? `${Math.round(share * 100)}% — above the ${Math.round(spec.concernThreshold * 100)}% level worth investigating. ${spec.detail}`
            : `${Math.round(share * 100)}%. ${spec.detail}`,
    };
  });
}

/** The metrics currently past their concern threshold, worst first. */
export function concerningMetrics(metrics: readonly DataQualityMetric[]): DataQualityMetric[] {
  const thresholds = new Map(SPECS.map((s) => [s.key as string, s.concernThreshold]));
  return metrics
    .filter((m) => m.total > 0 && m.share > (thresholds.get(m.key) ?? 1))
    .sort((a, b) => b.share - a.share);
}
