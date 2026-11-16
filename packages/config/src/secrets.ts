import type { Env } from './env';

/**
 * Secret access port.
 *
 * Source records reference credentials *by name* (`credentialRefs`) and never
 * store values. Resolution happens here, at run time, against the process
 * environment — so a database dump contains no credentials and a connector
 * cannot accidentally persist one.
 */
export interface SecretProvider {
  get(name: string): string | undefined;
  /** Reports which of the required names are missing, without revealing values. */
  missing(names: readonly string[]): string[];
  has(name: string): boolean;
}

export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly source: NodeJS.ProcessEnv | Env = process.env) {}

  get(name: string): string | undefined {
    const value = (this.source as Record<string, unknown>)[name];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  missing(names: readonly string[]): string[] {
    return names.filter((n) => !this.has(n));
  }
}

/** In-memory provider for tests. Never reads the real environment. */
export class StaticSecretProvider implements SecretProvider {
  constructor(private readonly values: Record<string, string> = {}) {}

  get(name: string): string | undefined {
    return this.values[name];
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  missing(names: readonly string[]): string[] {
    return names.filter((n) => !this.has(n));
  }
}
