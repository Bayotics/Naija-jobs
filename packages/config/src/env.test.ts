import { describe, expect, it } from 'vitest';
import { ConfigurationError } from './errors';
import { loadEnv } from './env';
import { AppConfigProvider, defaultAppConfig, resolveAppConfig } from './app-config';
import { EnvSecretProvider, StaticSecretProvider } from './secrets';

const base = { DATABASE_DRIVER: 'pglite' as const };

describe('environment validation', () => {
  it('boots with safe defaults when only a driver is set', () => {
    const env = loadEnv({ ...base });
    expect(env.NODE_ENV).toBe('development');
    expect(env.QUEUE_DRIVER).toBe('inmemory');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('reports every problem at once, not just the first', () => {
    // A misconfigured deployment should be fixable in one pass, not N restarts.
    try {
      loadEnv({ DATABASE_DRIVER: 'pg', QUEUE_DRIVER: 'bullmq' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const keys = (error as ConfigurationError).issues.map((i) => i.key);
      expect(keys).toContain('DATABASE_URL');
      expect(keys).toContain('REDIS_URL');
    }
  });

  it('includes an actionable hint in the formatted message', () => {
    try {
      loadEnv({ DATABASE_DRIVER: 'pg' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const formatted = (error as ConfigurationError).format();
      expect(formatted).toContain('DATABASE_URL');
      expect(formatted).toContain('postgresql://');
    }
  });

  it('refuses the in-process test driver in production', () => {
    expect(() =>
      loadEnv({ NODE_ENV: 'production', DATABASE_DRIVER: 'pglite', AUTH_SECRET: 'x'.repeat(32) }),
    ).toThrow(ConfigurationError);
  });

  it('requires an auth secret in production', () => {
    try {
      loadEnv({
        NODE_ENV: 'production',
        DATABASE_DRIVER: 'pg',
        DATABASE_URL: 'postgresql://u:p@h:5432/d',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigurationError).issues.map((i) => i.key)).toContain('AUTH_SECRET');
    }
  });

  it('rejects a malformed URL rather than accepting it silently', () => {
    expect(() => loadEnv({ ...base, APP_URL: 'not-a-url' })).toThrow(ConfigurationError);
  });
});

describe('application configuration', () => {
  it('produces a fully valid config with no overrides', () => {
    const config = defaultAppConfig();
    expect(config.matching.minimumScore).toBeGreaterThanOrEqual(0);
    expect(config.notifications.enabled).toBe(false);
  });

  it('deep-merges overrides without dropping sibling defaults', () => {
    const resolved = resolveAppConfig({ matching: { minimumScore: 72 } });
    expect(resolved.matching.minimumScore).toBe(72);
    // Siblings must survive a partial override.
    expect(resolved.matching.instantNotifyScore).toBe(defaultAppConfig().matching.instantNotifyScore);
    expect(resolved.dedup.simhashMaxDistance).toBe(defaultAppConfig().dedup.simhashMaxDistance);
  });

  it('rejects an out-of-range override as a whole rather than half-applying it', () => {
    expect(() => resolveAppConfig({ matching: { minimumScore: 500 } })).toThrow();
  });

  it('reads through a store and can be invalidated', async () => {
    let value = 10;
    const provider = new AppConfigProvider(
      { getAll: () => Promise.resolve({ matching: { minimumScore: value } }), set: async () => {} },
      60_000,
    );

    expect((await provider.get()).matching.minimumScore).toBe(10);

    value = 90;
    // Still cached — the TTL has not elapsed.
    expect((await provider.get()).matching.minimumScore).toBe(10);

    provider.invalidate();
    expect((await provider.get()).matching.minimumScore).toBe(90);
  });

  it('falls back to defaults when no store is configured', async () => {
    const provider = new AppConfigProvider(null);
    expect((await provider.get()).matching.minimumScore).toBe(
      defaultAppConfig().matching.minimumScore,
    );
  });
});

describe('secret providers', () => {
  it('reports missing credentials by name without exposing values', () => {
    const provider = new StaticSecretProvider({ PRESENT: 'value' });
    expect(provider.has('PRESENT')).toBe(true);
    expect(provider.missing(['PRESENT', 'ABSENT'])).toEqual(['ABSENT']);
  });

  it('treats blank environment values as absent', () => {
    const provider = new EnvSecretProvider({ BLANK: '   ', SET: 'x' });
    expect(provider.has('BLANK')).toBe(false);
    expect(provider.get('SET')).toBe('x');
  });
});
