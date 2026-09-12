import { describe, expect, it, vi } from 'vitest';
import { AiGatewayService } from './ai-gateway.service';
import { ValidationError } from '../../common/errors/app-error';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { RequestContext } from '../../common/logging/request-context';
import type { AiGenerateRequest, AiGenerateResult, AiProvider } from './ai-provider.interface';

function makeProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    name: 'test-provider',
    generate: vi.fn(async () => ({ content: 'ok', model: 'test-model', provider: 'test-provider' })),
    ...overrides,
  };
}

function makeLogger(): StructuredLoggerService {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

const request: AiGenerateRequest = { messages: [{ role: 'user', content: 'hello' }] };

describe('AiGatewayService', () => {
  it('constructs with an injected AiProvider and logger', () => {
    const gateway = new AiGatewayService(makeProvider(), makeLogger());

    expect(gateway).toBeInstanceOf(AiGatewayService);
  });

  it('delegates generate() to the provider and passes its result through', async () => {
    const result: AiGenerateResult = { content: 'hello back', model: 'gpt-5.6-luna', provider: 'openai' };
    const provider = makeProvider({ generate: vi.fn(async () => result) });
    const gateway = new AiGatewayService(provider, makeLogger());

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
    const gateway = new AiGatewayService(provider, makeLogger());

    const actual = await gateway.generate(request);

    expect(actual.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof actual.latencyMs).toBe('number');
  });

  it('preserves usage metadata returned by the provider', async () => {
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    const provider = makeProvider({
      generate: vi.fn(async () => ({ content: 'ok', model: 'test-model', provider: 'test-provider', usage })),
    });
    const gateway = new AiGatewayService(provider, makeLogger());

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
    const gateway = new AiGatewayService(provider, makeLogger());

    await expect(gateway.generate(request)).rejects.toBe(thrown);
  });

  it('normalizes a non-AppError provider failure into a ProviderError', async () => {
    const provider = makeProvider({
      generate: vi.fn(async () => {
        throw new Error('network reset');
      }),
    });
    const gateway = new AiGatewayService(provider, makeLogger());

    await expect(gateway.generate(request)).rejects.toThrow(/AI provider "test-provider" request failed: network reset/);
    await expect(gateway.generate(request)).rejects.toEqual(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
  });

  describe('observability', () => {
    it('logs one success event with provider, model, capability, latency and token usage', async () => {
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      const provider = makeProvider({
        generate: vi.fn(async () => ({ content: 'ok', model: 'gpt-5.6-luna', provider: 'openai', usage })),
      });
      const logger = makeLogger();
      const gateway = new AiGatewayService(provider, logger);

      await gateway.generate({ ...request, capability: 'merchant-business-analyst' });

      expect(logger.event).toHaveBeenCalledTimes(1);
      expect(logger.event).toHaveBeenCalledWith(
        'log',
        'AI request succeeded',
        'AiGatewayService',
        expect.objectContaining({
          provider: 'openai',
          model: 'gpt-5.6-luna',
          capability: 'merchant-business-analyst',
          latencyMs: expect.any(Number),
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        }),
      );
    });

    it('leaves capability undefined when the caller does not supply one (no agents exist yet)', async () => {
      const provider = makeProvider();
      const logger = makeLogger();
      const gateway = new AiGatewayService(provider, logger);

      await gateway.generate(request);

      expect(logger.event).toHaveBeenCalledWith(
        'log',
        'AI request succeeded',
        'AiGatewayService',
        expect.objectContaining({ capability: undefined }),
      );
    });

    it('logs one failure event with provider, attempted model, capability, latency and normalized error type', async () => {
      const provider = makeProvider({
        generate: vi.fn(async () => {
          throw new Error('network reset');
        }),
      });
      const logger = makeLogger();
      const gateway = new AiGatewayService(provider, logger);

      await expect(gateway.generate({ ...request, model: 'gpt-5.6-luna-mini' })).rejects.toThrow(
        /AI provider "test-provider" request failed: network reset/,
      );

      expect(logger.event).toHaveBeenCalledTimes(1);
      expect(logger.event).toHaveBeenCalledWith(
        'error',
        'AI request failed',
        'AiGatewayService',
        expect.objectContaining({
          provider: 'test-provider',
          model: 'gpt-5.6-luna-mini',
          latencyMs: expect.any(Number),
          errorType: 'Error',
        }),
      );
    });

    it('never logs message content, prompts, or the raw result/error payload', async () => {
      const provider = makeProvider({
        generate: vi.fn(async () => ({
          content: 'super secret customer detail',
          model: 'gpt-5.6-luna',
          provider: 'openai',
        })),
      });
      const logger = makeLogger();
      const gateway = new AiGatewayService(provider, logger);

      await gateway.generate({ messages: [{ role: 'user', content: 'my card number is 4111...' }] });

      const [, , , meta] = (logger.event as ReturnType<typeof vi.fn>).mock.calls[0];
      const logged = JSON.stringify(meta);
      expect(logged).not.toContain('super secret customer detail');
      expect(logged).not.toContain('my card number');
    });

    it('logs tool names offered and requested, never arguments (doc19 Phase 12 step 6)', async () => {
      const provider = makeProvider({
        generate: vi.fn(async () => ({
          content: '',
          toolCalls: [{ id: 'call_1', name: 'get_customer_activity_history', arguments: '{"secret":"shh"}' }],
          model: 'test-model',
          provider: 'test-provider',
        })),
      });
      const logger = makeLogger();
      const gateway = new AiGatewayService(provider, logger);

      await gateway.generate({
        ...request,
        tools: [{ name: 'get_customer_activity_history', description: 'x', parameters: {} }],
      });

      expect(logger.event).toHaveBeenCalledWith(
        'log',
        'AI request succeeded',
        'AiGatewayService',
        expect.objectContaining({
          toolsOffered: ['get_customer_activity_history'],
          toolCallsRequested: ['get_customer_activity_history'],
        }),
      );
      const [, , , meta] = (logger.event as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.stringify(meta)).not.toContain('shh');
    });

    it('propagates workspace/user/correlation context from RequestContext into the real logger output', async () => {
      const provider = makeProvider();
      const logger = new StructuredLoggerService();
      const gateway = new AiGatewayService(provider, logger);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await RequestContext.run({ correlationId: 'corr-1', userId: 'user-1', workspaceId: 'ws-1' }, () =>
        gateway.generate(request),
      );

      const logged = logSpy.mock.calls.map((call) => JSON.parse(call[0] as string));
      const successLine = logged.find((line) => line.message === 'AI request succeeded');
      expect(successLine).toMatchObject({ correlationId: 'corr-1', userId: 'user-1', workspaceId: 'ws-1' });

      logSpy.mockRestore();
    });
  });
});
