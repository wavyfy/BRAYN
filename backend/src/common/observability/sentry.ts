import * as Sentry from '@sentry/node';

/**
 * Sentry is the locked observability provider (doc 29 §21). Wiring is
 * dormant unless SENTRY_DSN is actually configured — no account/DSN is
 * required for the rest of the app to function.
 */
let enabled = false;

export function initSentry(dsn: string | undefined): void {
  if (!dsn) {
    return;
  }

  Sentry.init({ dsn });
  enabled = true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

export function captureException(exception: unknown): void {
  if (enabled) {
    Sentry.captureException(exception);
  }
}
