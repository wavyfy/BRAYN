/**
 * Canonical error code taxonomy, matching the classification required by
 * "18. BRAYN Security, Observability & Reliability" (Error Handling):
 * input/validation, authentication, authorization, provider, and
 * unexpected/infrastructure errors must be distinguishable.
 */
export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}
