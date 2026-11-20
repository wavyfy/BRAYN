import * as Sentry from '@sentry/node';
import { scrubSensitive } from '../logging/scrub-sensitive';

/**
 * Sentry is the locked observability provider (doc 29 §21). Wiring is
 * dormant unless SENTRY_DSN is actually configured — no account/DSN is
 * required for the rest of the app to function.
 */
let enabled = false;

/**
 * Same DLP backstop as logs: exception messages (including linked `cause`s) and the event message go through
 * `scrubSensitive` before leaving the process — SQL text from a database error, emails and tokens never reach Sentry.
 */
export function scrubSentryEvent<T extends { message?: string; exception?: { values?: Array<{ value?: string }> } }>(event: T): T {
  if (typeof event.message === 'string') event.message = scrubSensitive(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === 'string') exception.value = scrubSensitive(exception.value);
  }
  return event;
}

export function initSentry(dsn: string | undefined): void {
  if (!dsn) {
    return;
  }

  Sentry.init({ dsn, beforeSend: (event) => scrubSentryEvent(event) });
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
