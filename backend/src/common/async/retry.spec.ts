import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './retry';

describe('withRetry', () => {
  it('returns the result immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await withRetry(fn);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries after failures and succeeds within the attempt budget', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error once maxAttempts is exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent'));

    await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 })).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry when shouldRetry rejects the error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('not retryable'));

    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, shouldRetry: () => false }),
    ).rejects.toThrow('not retryable');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('applies exponential backoff between attempts', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce('ok');

      const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });

      await vi.advanceTimersByTimeAsync(100); // after attempt 1
      await vi.advanceTimersByTimeAsync(200); // after attempt 2 (2x backoff)

      await expect(promise).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
