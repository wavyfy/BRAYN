import { describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestContext } from './request-context';

describe('RequestContext', () => {
  it('isolates concurrent contexts from each other', async () => {
    async function simulateRequest(id: string, delayMs: number) {
      return RequestContext.run({ correlationId: id }, async () => {
        await delay(delayMs);
        // If contexts leaked across concurrent async chains, this would
        // observe a different request's id after the await.
        return RequestContext.correlationId();
      });
    }

    const [a, b] = await Promise.all([
      simulateRequest('request-a', 20),
      simulateRequest('request-b', 5),
    ]);

    expect(a).toBe('request-a');
    expect(b).toBe('request-b');
  });

  it('is undefined outside of any request context', () => {
    expect(RequestContext.correlationId()).toBeUndefined();
  });
});
