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

  /*
   * The blank-secret crash.
   *
   * A hosting blueprint that declares secrets renders one text box each, and a
   * box left alone arrives as "". The variable is then present, so every
   * `.optional()` stops applying, and the process refuses to boot over a
   * credential it would never have read. The build goes green and the service
   * dies seconds later.
   */
  it('treats a blank variable as unset rather than as an invalid value', () => {
    const env = loadEnv({
      ...base,
      CRAWLER_CONTACT_EMAIL: '',
      ANTHROPIC_API_KEY: '   ',
      JOOBLE_API_KEY: '',
    });

    expect(env.CRAWLER_CONTACT_EMAIL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('still refuses to boot when a blank variable was a required one', () => {
    // Normalising blanks must not turn a missing database into a default.
    try {
      loadEnv({ NODE_ENV: 'production', DATABASE_DRIVER: 'pg', DATABASE_URL: '  ' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const issue = (error as ConfigurationError).issues.find((i) => i.key === 'DATABASE_URL');
      // Named as the missing variable it is, not as a failed string rule.
      expect(issue?.problem).toContain('Required');
    }
  });

  /*
   * The outage this prevents.
   *
   * APP_URL is read in exactly one place: the dashboard's origin check. The
   * worker has no origin to check — and a malformed value on its host stopped
   * discovery, enrichment and ranking for two days over an address it never
   * reads. The same shape of failure as demanding AUTH_SECRET from it.
   */
  it('does not let the dashboard URL stop the worker', () => {
    const env = loadEnv({ ...base, APP_URL: 'naija-jobs.vercel.app' }, { role: 'worker' });
    expect(env.APP_URL).toBe('http://localhost:3000');
  });

  it('still rejects a malformed dashboard URL for the dashboard itself', () => {
    // Where it is a security boundary, it stays strict.
    expect(() => loadEnv({ ...base, APP_URL: 'naija-jobs.vercel.app' }, { role: 'web' })).toThrow(
      ConfigurationError,
    );
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
    expect(config.ai.enabled).toBe(false);
  });

  it('deep-merges overrides without dropping sibling defaults', () => {
    const resolved = resolveAppConfig({ matching: { minimumScore: 72 } });
    expect(resolved.matching.minimumScore).toBe(72);
    // Siblings must survive a partial override.
    expect(resolved.matching.exceptionalScore).toBe(defaultAppConfig().matching.exceptionalScore);
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
