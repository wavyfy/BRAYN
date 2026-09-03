import { Injectable, type LoggerService } from '@nestjs/common';
import { RequestContext } from './request-context';

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
 * error information. Never log secrets — call sites are responsible for
 * not passing them in `meta`.
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
    const line: LogLine = {
      timestamp: new Date().toISOString(),
      level,
      context,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      correlationId: store?.correlationId,
      userId: store?.userId,
      workspaceId: store?.workspaceId,
      ...meta,
    };

    const target = level === 'error' || level === 'fatal' ? console.error : console.log;
    target(JSON.stringify(line));
  }
}
