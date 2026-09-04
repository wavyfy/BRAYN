import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { captureException } from '../observability/sentry';
import { StructuredLoggerService } from '../logging/structured-logger.service';
import { scrubSensitive } from '../logging/scrub-sensitive';
import { AppError } from './app-error';
import { ErrorCode } from './error-codes';

/**
 * Maps a Nest built-in HttpException's status to our error-code taxonomy,
 * for exceptions that didn't originate from an AppError subclass (e.g.
 * framework-thrown BadRequestException from a future validation pipe).
 */
const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_ERROR,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.BAD_GATEWAY]: ErrorCode.PROVIDER_ERROR,
};

interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string | string[];
    requestId: string;
  };
}

/**
 * Global exception filter — the single place that turns any thrown value
 * into the canonical API error envelope defined in
 * "23. BRAYN API Contracts" (Error Contract).
 *
 * Unrecognized errors are never exposed to the client: only their code,
 * a generic message, and the request id are returned. Full detail is
 * logged server-side only (and reported to Sentry, when configured), per
 * "18. BRAYN Security, Observability & Reliability" (Error Handling,
 * Safe error exposure).
 */
@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = request.id;

    if (exception instanceof AppError) {
      this.logger.event('warn', exception.message, 'AllExceptionsFilter', {
        code: exception.code,
        requestId,
      });
      this.send(reply, exception.getStatus(), {
        error: { code: exception.code, message: exception.message, requestId },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL_ERROR;
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);

      this.logger.event(
        'warn',
        typeof message === 'string' ? message : JSON.stringify(message),
        'AllExceptionsFilter',
        { code, requestId },
      );
      this.send(reply, status, { error: { code, message, requestId } });
      return;
    }

    // An unhandled exception's message/stack is unstructured — unlike every
    // AppError/HttpException branch above, this text was never written by
    // BRAYN code with logging in mind (a third-party SDK error, a raw driver
    // error, ...), so it gets the DLP scrub explicitly here rather than
    // relying only on StructuredLoggerService's own backstop.
    this.logger.event(
      'error',
      scrubSensitive(exception instanceof Error ? exception.message : 'Unhandled exception'),
      'AllExceptionsFilter',
      {
        requestId,
        trace: scrubSensitive(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)),
      },
    );
    captureException(exception);

    this.send(reply, HttpStatus.INTERNAL_SERVER_ERROR, {
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred.',
        requestId,
      },
    });
  }

  private send(reply: FastifyReply, status: number, body: ErrorResponseBody): void {
    reply.status(status).send(body);
  }
}
