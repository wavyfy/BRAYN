import { describe, expect, it, vi } from 'vitest';
import { AiGatewayService } from './ai-gateway.service';
import { ValidationError } from '../../common/errors/app-error';
import type { AiGenerateRequest, AiGenerateResult, AiProvider } from './ai-provider.interface';

function makeProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    name: 'test-provider',
    generate: vi.fn(async () => ({ content: 'ok', model: 'test-model', provider: 'test-provider' })),
    ...overrides,
  };
}

const request: AiGenerateRequest = { messages: [{ role: 'user', content: 'hello' }] };

describe('AiGatewayService', () => {
  it('constructs with an injected AiProvider', () => {
    const gateway = new AiGatewayService(makeProvider());

    expect(gateway).toBeInstanceOf(AiGatewayService);
  });

  it('delegates generate() to the provider and passes its result through', async () => {
    const result: AiGenerateResult = { content: 'hello back', model: 'gpt-5.6-luna', provider: 'openai' };
    const provider = makeProvider({ generate: vi.fn(async () => result) });
    const gateway = new AiGatewayService(provider);

    const actual = await gateway.generate(request);

    expect(provider.generate).toHaveBeenCalledWith(request);
    expect(actual).toEqual(expect.objectContaining(result));
  });

  it('attaches latencyMs measured around the provider call', async () => {
    const provider = makeProvider({
      generate: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { content: 'ok', model: 'test-model', provider: 'test-provider' };
      }),
    });
    const gateway = new AiGatewayService(provider);

    const actual = await gateway.generate(request);

    expect(actual.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof actual.latencyMs).toBe('number');
  });

  it('preserves usage metadata returned by the provider', async () => {
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    const provider = makeProvider({
      generate: vi.fn(async () => ({ content: 'ok', model: 'test-model', provider: 'test-provider', usage })),
    });
    const gateway = new AiGatewayService(provider);

    const actual = await gateway.generate(request);

    expect(actual.usage).toEqual(usage);
  });

  it('propagates an existing AppError from the provider unchanged', async () => {
    const thrown = new ValidationError('bad request shape');
    const provider = makeProvider({
      generate: vi.fn(async () => {
        throw thrown;
      }),
    });
    const gateway = new AiGatewayService(provider);

    await expect(gateway.generate(request)).rejects.toBe(thrown);
  });

  it('normalizes a non-AppError provider failure into a ProviderError', async () => {
    const provider = makeProvider({
      generate: vi.fn(async () => {
        throw new Error('network reset');
      }),
    });
    const gateway = new AiGatewayService(provider);

    await expect(gateway.generate(request)).rejects.toThrow(/AI provider "test-provider" request failed: network reset/);
    await expect(gateway.generate(request)).rejects.toEqual(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
  });
});
