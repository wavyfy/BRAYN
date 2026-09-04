import { Injectable, type LoggerService } from '@nestjs/common';
import { RequestContext } from './request-context';
import { scrubSensitive } from './scrub-sensitive';

type Level = 'debug' | 'verbose' | 'log' | 'warn' | 'error' | 'fatal';

interface LogLine {
  timestamp: string;
  level: Level;
  context?: string;
  message: string;
  correlationId?: string;
  userId?: string;
  workspaceId?: string;
  [key: string]: unknown;
}

/**
 * JSON-line structured logger. Implements Nest's LoggerService so it can
 * replace the framework's default logger via app.useLogger(), and exposes
 * `event()` for call sites that want to attach structured fields (status
 * code, duration, error code, ...).
 *
 * Fields follow "18. BRAYN Security, Observability & Reliability" (Logging):
 * timestamp, correlation id, context/service, operation, result, duration,
 * error information.
 *
 * `message` and every string field in `meta` are run through
 * `scrubSensitive` before being written — a fixed-pattern DLP backstop
 * (emails, bearer/Shopify tokens, long token-like strings) for the rare
 * case a call site accidentally passes one through, not a substitute for
 * call sites staying disciplined about what they log.
 */
@Injectable()
export class StructuredLoggerService implements LoggerService {
  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context, trace ? { trace } : undefined);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  fatal(message: unknown, context?: string): void {
    this.write('fatal', message, context);
  }

  /** Structured event log for call sites that have extra fields to attach. */
  event(level: Level, message: string, context: string, meta?: Record<string, unknown>): void {
    this.write(level, message, context, meta);
  }

  private write(
    level: Level,
    message: unknown,
    context?: string,
    meta?: Record<string, unknown>,
  ): void {
    const store = RequestContext.get();
    const rawMessage = typeof message === 'string' ? message : JSON.stringify(message);
    const line: LogLine = {
      timestamp: new Date().toISOString(),
      level,
      context,
      message: scrubSensitive(rawMessage),
      correlationId: store?.correlationId,
      userId: store?.userId,
      workspaceId: store?.workspaceId,
      ...scrubMeta(meta),
    };

    const target = level === 'error' || level === 'fatal' ? console.error : console.log;
    target(JSON.stringify(line));
  }
}

/** Shallow — every current call site passes a flat record of primitives/arrays, never nested objects. */
function scrubMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) {
    return meta;
  }
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    scrubbed[key] = typeof value === 'string' ? scrubSensitive(value) : value;
  }
  return scrubbed;
}
