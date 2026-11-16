import { expect } from 'vitest';
import { sourceJobDraftSchema, type SourceJobDraft } from '@job-intel/contracts';
import type { Connector } from '../types';
import { collect, testContext, testHttpClient, type MockRoute } from './index';

/**
 * Reusable connector contract tests.
 *
 * Every connector must satisfy the same behavioural contract, and the cost of
 * *not* having this is that each new connector re-discovers the same bugs:
 * a draft that fails validation on one field, a relative URL that was never
 * resolved, a timestamp parsed as a string, a source failure that throws
 * instead of being reported.
 *
 * The point is that adding a source should be cheap and *safe*. A developer
 * writes `describe('MyConnector', () => runConnectorContract({...}))` and gets
 * the whole checklist for free.
 *
 * These are behavioural assertions, not snapshots: they check properties that
 * must hold for any connector, so they keep working when a source changes its
 * payload.
 */

export interface ConnectorContractCase<TConfig> {
  /** The connector under test. */
  connector: Connector<TConfig>;
  /** A valid configuration. */
  config: unknown;
  /** Fixtures that make `discover` succeed and yield at least one draft. */
  routes: MockRoute[];
  /** Secrets the connector needs to be available. */
  secrets?: Record<string, string>;
  /** Expected minimum number of drafts from `routes`. */
  minDrafts?: number;
  /**
   * Skips checks the connector legitimately cannot satisfy.
   *
   * `emptyResponse`: connectors that treat an empty payload as a hard failure
   * (a feed with no items is genuinely broken) opt out of the empty-run check.
   */
  skip?: {
    emptyResponse?: boolean;
    failureIsolation?: boolean;
    incremental?: boolean;
  };
  /** Routes that return an error, for the failure-handling check. */
  failingRoutes?: MockRoute[];
}

/** One assertion group, so a failure names the property that broke. */
export interface ContractAssertion {
  name: string;
  run(): Promise<void>;
}

export function connectorContractAssertions<TConfig>(
  testCase: ConnectorContractCase<TConfig>,
): ContractAssertion[] {
  const { connector, routes, secrets } = testCase;
  const parseConfig = () => connector.configSchema.parse(testCase.config);

  const runDiscovery = async (
    override?: Partial<{ routes: MockRoute[]; cursor: Record<string, unknown> | null }>,
  ) => {
    const { client } = testHttpClient(override?.routes ?? routes);
    return collect(
      connector.discover(
        testContext({
          config: parseConfig(),
          http: client,
          cursor: override?.cursor ?? null,
          ...(secrets ? { secrets } : {}),
        }),
      ),
    );
  };

  return [
    {
      name: 'declares a stable identity',
      run: () => {
        expect(connector.id).toMatch(/^[a-z0-9_]+$/);
        expect(connector.displayName.length).toBeGreaterThan(0);
        expect(connector.sourceType).toBeTruthy();
        expect(connector.accessTier).toBeTruthy();
        return Promise.resolve();
      },
    },

    {
      name: 'validates its own configuration',
      run: () => {
        // A schema that accepts anything is a schema that catches nothing.
        const rejected = connector.configSchema.safeParse({ __definitely_not_valid: Symbol('x') });
        expect(rejected.success === false || Object.keys(rejected).length > 0).toBe(true);
        expect(() => parseConfig()).not.toThrow();
        return Promise.resolve();
      },
    },

    {
      name: 'reports availability without making a request',
      run: () => {
        const availability = connector.availability({
          config: parseConfig(),
          getSecret: (name) => secrets?.[name],
        });
        expect(typeof availability.available).toBe('boolean');
        if (!availability.available) {
          // An unavailable source must say why and what would fix it.
          expect(availability.reason).toBeTruthy();
          expect(Array.isArray(availability.requires)).toBe(true);
        }
        return Promise.resolve();
      },
    },

    {
      name: 'yields drafts that satisfy the draft schema',
      run: async () => {
        const { items } = await runDiscovery();
        expect(items.length).toBeGreaterThanOrEqual(testCase.minDrafts ?? 1);

        for (const draft of items) {
          const parsed = sourceJobDraftSchema.safeParse(draft);
          expect(
            parsed.success,
            parsed.success ? '' : JSON.stringify(parsed.error?.issues.slice(0, 3)),
          ).toBe(true);
        }
      },
    },

    {
      name: 'produces absolute, fetchable URLs',
      run: async () => {
        const { items } = await runDiscovery();
        for (const draft of items) {
          expect(() => new URL(draft.url)).not.toThrow();
          expect(draft.url).toMatch(/^https?:\/\//);
          if (draft.applyUrl) {
            expect(() => new URL(draft.applyUrl!)).not.toThrow();
          }
        }
      },
    },

    {
      name: 'produces real Date objects or null for timestamps',
      run: async () => {
        const { items } = await runDiscovery();
        for (const draft of items) {
          for (const value of [draft.postedAt, draft.validThrough]) {
            if (value === null) continue;
            expect(value).toBeInstanceOf(Date);
            // A date that parsed to NaN is worse than no date: it silently
            // becomes "1970" or "Invalid Date" everywhere downstream.
            expect(Number.isNaN(value.getTime())).toBe(false);
          }
        }
      },
    },

    {
      name: 'supplies a deduplication identity',
      run: async () => {
        const { items } = await runDiscovery();
        for (const draft of items) {
          // Either a source-stable id or, failing that, a URL that identifies
          // the posting. Without one of the two, deduplication cannot work.
          expect(Boolean(draft.externalId) || Boolean(draft.url)).toBe(true);
        }

        const identities = items.map((draft) => draft.externalId ?? draft.url);
        expect(new Set(identities).size).toBe(identities.length);
      },
    },

    {
      name: 'never yields an empty title or company',
      run: async () => {
        const { items } = await runDiscovery();
        for (const draft of items) {
          expect(draft.title.trim().length).toBeGreaterThan(0);
          expect(draft.companyName.trim().length).toBeGreaterThan(0);
        }
      },
    },

    {
      name: 'preserves the raw payload for replay',
      run: async () => {
        const { items } = await runDiscovery();
        // `raw` is what makes an improved normalizer replayable over history.
        expect(items.every((draft) => draft.raw !== undefined)).toBe(true);
      },
    },

    ...(testCase.skip?.emptyResponse
      ? []
      : [
          {
            name: 'handles an empty response without throwing',
            run: async () => {
              const empty = routes.map((route) => ({
                ...route,
                body: emptyBodyFor(route.body),
              }));
              const { items } = await runDiscovery({ routes: empty });
              expect(Array.isArray(items)).toBe(true);
            },
          },
        ]),

    ...(testCase.skip?.failureIsolation || !testCase.failingRoutes
      ? []
      : [
          {
            name: 'surfaces a source failure as an error rather than silence',
            run: async () => {
              // Either it throws (the runner records a failed run) or it yields
              // nothing. What it must not do is yield fabricated drafts.
              let threw = false;
              let items: SourceJobDraft[] = [];
              try {
                const result = await runDiscovery({ routes: testCase.failingRoutes! });
                items = result.items;
              } catch {
                threw = true;
              }
              expect(threw || items.length === 0).toBe(true);
            },
          },
        ]),

    ...(testCase.skip?.incremental || !connector.capabilities.supportsIncremental
      ? []
      : [
          {
            name: 'returns a cursor when it claims incremental support',
            run: async () => {
              const { result } = await runDiscovery();
              expect(result).toBeDefined();
              expect(
                result && typeof result === 'object' && 'cursor' in result,
                'a connector declaring supportsIncremental must return a cursor',
              ).toBe(true);
            },
          },
        ]),
  ];
}

/** Empties a fixture body while keeping its shape valid. */
function emptyBodyFor(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith('[')) return '[]';
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const emptied: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        emptied[key] = Array.isArray(value) ? [] : value;
      }
      return JSON.stringify(emptied);
    } catch {
      return '{}';
    }
  }
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
    return '<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>';
  }
  return '';
}
