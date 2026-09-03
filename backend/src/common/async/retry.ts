export interface RetryOptions {
  maxAttempts?: number;
  /** Base delay in ms; actual delay is baseDelayMs * 2^(attempt - 1). */
  baseDelayMs?: number;
  /** Only retry errors this predicate accepts; default retries everything. */
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Generic retry-with-backoff, independent of what triggers it (event
 * handler, integration call, ...) — see "07. BRAYN Event, Job &
 * Processing Architecture" (Retry) and "18. BRAYN Security,
 * Observability & Reliability": "Retry only failures that are
 * potentially recoverable." Callers pass `shouldRetry` to make that
 * judgment; this utility only owns the backoff/attempt mechanics.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
