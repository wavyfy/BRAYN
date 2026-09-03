import type { Env } from '../../config/env.schema';
import type { StructuredLoggerService } from '../logging/structured-logger.service';

/**
 * Secrets a production deploy needs to actually function once their
 * owning foundation step wires them in. Local/dev/test runs are expected
 * to have most of these unset — this only guards a genuinely
 * misconfigured production deploy, and warns rather than crashes so it
 * never blocks earlier-phase work that doesn't need them yet.
 *
 * See "18. BRAYN Security, Observability & Reliability" (Secrets).
 */
const REQUIRED_IN_PRODUCTION: ReadonlyArray<keyof Env> = [
  'DATABASE_URL',
  'CLERK_SECRET_KEY',
  'BRAYN_CREDENTIAL_ENCRYPTION_KEY',
];

export function warnOnMissingProductionSecrets(env: Env, logger: StructuredLoggerService): void {
  if (env.NODE_ENV !== 'production') {
    return;
  }

  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !env[key]);
  if (missing.length > 0) {
    logger.event('warn', `Running in production without: ${missing.join(', ')}`, 'StartupChecks', {
      missing,
    });
  }
}
