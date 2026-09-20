import { describe, expect, it, vi } from 'vitest';
import type { StructuredLoggerService } from '../logging/structured-logger.service';
import { warnOnMissingProductionSecrets } from './startup-checks';
import type { Env } from '../../config/env.schema';

function makeEnv(overrides: Partial<Env>): Env {
  return {
    NODE_ENV: 'development',
    PORT: 3001,
    FRONTEND_URL: 'http://localhost:3000',
    BACKEND_URL: 'http://localhost:3001',
    AI_MODEL: 'gpt-5.6-luna',
    RATE_LIMIT_WINDOW_SECONDS: 60,
    RATE_LIMIT_DEFAULT_MAX: 120,
    RATE_LIMIT_AI_MAX: 10,
    RATE_LIMIT_PUBLIC_MAX: 20,
    ...overrides,
  };
}

function makeLoggerSpy() {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

describe('warnOnMissingProductionSecrets', () => {
  it('does nothing outside of production', () => {
    const logger = makeLoggerSpy();

    warnOnMissingProductionSecrets(makeEnv({ NODE_ENV: 'development' }), logger);

    expect(logger.event).not.toHaveBeenCalled();
  });

  it('warns when production is missing required secrets', () => {
    const logger = makeLoggerSpy();

    warnOnMissingProductionSecrets(makeEnv({ NODE_ENV: 'production' }), logger);

    expect(logger.event).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('DATABASE_URL'),
      'StartupChecks',
      expect.objectContaining({
        missing: expect.arrayContaining(['DATABASE_URL', 'CLERK_SECRET_KEY', 'BRAYN_CREDENTIAL_ENCRYPTION_KEY', 'UPSTASH_REDIS_REST_URL', 'BRAYN_ENV']),
      }),
    );
  });

  it('warns about missing Upstash Redis specifically — RateLimitGuard fails open without it', () => {
    const logger = makeLoggerSpy();

    warnOnMissingProductionSecrets(
      makeEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://user:pass@host/db',
        CLERK_SECRET_KEY: 'sk_live_xxx',
        BRAYN_CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64),
        BRAYN_ENV: 'production',
      }),
      logger,
    );

    expect(logger.event).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('UPSTASH_REDIS_REST_URL'),
      'StartupChecks',
      expect.objectContaining({ missing: ['UPSTASH_REDIS_REST_URL'] }),
    );
  });

  it('warns about missing BRAYN_ENV specifically — RateLimitGuard fails open without it (same as missing Redis)', () => {
    const logger = makeLoggerSpy();

    warnOnMissingProductionSecrets(
      makeEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://user:pass@host/db',
        CLERK_SECRET_KEY: 'sk_live_xxx',
        BRAYN_CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64),
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      }),
      logger,
    );

    expect(logger.event).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('BRAYN_ENV'),
      'StartupChecks',
      expect.objectContaining({ missing: ['BRAYN_ENV'] }),
    );
  });

  it('does not warn when production has all required secrets', () => {
    const logger = makeLoggerSpy();

    warnOnMissingProductionSecrets(
      makeEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://user:pass@host/db',
        CLERK_SECRET_KEY: 'sk_live_xxx',
        BRAYN_CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64),
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
        BRAYN_ENV: 'production',
      }),
      logger,
    );

    expect(logger.event).not.toHaveBeenCalled();
  });
});
