import { ConfigurationError } from './errors';
import type { Connector } from './types';

/**
 * The connector registry.
 *
 * The rest of the system resolves connectors by id — `registry.get(source.connectorId)`
 * — and never learns how Reddit or an RSS feed actually works. Adding a source
 * is therefore:
 *
 *   1. implement the connector
 *   2. register it here
 *   3. insert a `job_sources` row
 *
 * and touches neither the matching engine, the notification engine, the
 * persistence pipeline, nor the frontend.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector<never>>();

  register<TConfig>(connector: Connector<TConfig>): this {
    if (this.connectors.has(connector.id)) {
      throw new ConfigurationError(
        `Connector "${connector.id}" is already registered. Ids must be unique.`,
        { connectorId: connector.id },
      );
    }
    this.connectors.set(connector.id, connector as unknown as Connector<never>);
    return this;
  }

  /** Throws when unknown — a source referencing a missing connector is a bug. */
  get(id: string): Connector<never> {
    const connector = this.connectors.get(id);
    if (!connector) {
      throw new ConfigurationError(
        `Unknown connector "${id}". Registered: ${this.ids().join(', ') || '(none)'}`,
        { connectorId: id, available: this.ids() },
      );
    }
    return connector;
  }

  /** Non-throwing lookup, for callers that treat absence as a normal state. */
  find(id: string): Connector<never> | null {
    return this.connectors.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.connectors.has(id);
  }

  ids(): string[] {
    return [...this.connectors.keys()].sort();
  }

  all(): Connector<never>[] {
    return [...this.connectors.values()];
  }

  /**
   * Validates a source's config against its connector's schema.
   * Returns a typed result rather than throwing: an invalid config is a normal,
   * reportable state that must show up on the source's health, not a crash.
   */
  validateConfig(
    connectorId: string,
    config: unknown,
  ): { ok: true; value: unknown } | { ok: false; errors: string[] } {
    const connector = this.find(connectorId);
    if (!connector) return { ok: false, errors: [`Unknown connector "${connectorId}"`] };

    const parsed = connector.configSchema.safeParse(config);
    if (parsed.success) return { ok: true, value: parsed.data };
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }

  /** Describes the registry for the API and the settings UI. */
  describe(): Array<{
    id: string;
    displayName: string;
    sourceType: string;
    accessTier: string;
    capabilities: Connector<never>['capabilities'];
  }> {
    return this.all()
      .map((c) => ({
        id: c.id,
        displayName: c.displayName,
        sourceType: c.sourceType,
        accessTier: c.accessTier,
        capabilities: c.capabilities,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
