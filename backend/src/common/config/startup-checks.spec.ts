import { describe, expect, it, vi } from 'vitest';
import type { StructuredLoggerService } from '../logging/structured-logger.service';
import { warnOnMissingProductionSecrets } from './startup-checks';
import type { Env } from '../../config/env.schema';

function makeEnv(overrides: Partial<Env>): Env {
  return {
    NODE_ENV: 'development',
    PORT: 3001,
    FRONTEND_URL: 'http://localhost:3000',
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
        missing: expect.arrayContaining(['DATABASE_URL', 'CLERK_SECRET_KEY', 'BRAYN_CREDENTIAL_ENCRYPTION_KEY']),
      }),
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
      }),
      logger,
    );

    expect(logger.event).not.toHaveBeenCalled();
  });
});
