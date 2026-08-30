import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

/**
 * Base class for BRAYN's own domain-thrown errors. Carries a stable
 * `code` (see error-codes.ts) that survives independently of the HTTP
 * status, so clients and logs can key off it directly.
 */
export abstract class AppError extends HttpException {
  protected constructor(
    public readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
  ) {
    super(message, status);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The request is invalid.') {
    super(ErrorCode.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication is required.') {
    super(ErrorCode.UNAUTHENTICATED, message, HttpStatus.UNAUTHORIZED);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'You are not authorized to perform this action.') {
    super(ErrorCode.UNAUTHORIZED, message, HttpStatus.FORBIDDEN);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.') {
    super(ErrorCode.NOT_FOUND, message, HttpStatus.NOT_FOUND);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'The request conflicts with the current state.') {
    super(ErrorCode.CONFLICT, message, HttpStatus.CONFLICT);
  }
}

export class ProviderError extends AppError {
  constructor(message = 'An upstream provider error occurred.') {
    super(ErrorCode.PROVIDER_ERROR, message, HttpStatus.BAD_GATEWAY);
  }
}
