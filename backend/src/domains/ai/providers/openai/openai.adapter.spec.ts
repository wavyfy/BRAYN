import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../../config/env.schema';
import type { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import { ProviderError } from '../../../../common/errors/app-error';
import { OpenAiAdapter } from './openai.adapter';

const mockCreate = vi.fn();
const mockConstructor = vi.fn();

vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: mockCreate };
    constructor(options: unknown) {
      mockConstructor(options);
    }
  },
  APIConnectionError: class APIConnectionError extends Error {},
  APIConnectionTimeoutError: class APIConnectionTimeoutError extends Error {},
  InternalServerError: class InternalServerError extends Error {},
  RateLimitError: class RateLimitError extends Error {},
}));

function makeConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const env: Partial<Env> = { AI_MODEL: 'gpt-5.6-luna', ...overrides };
  return { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
}

function makeLogger(): StructuredLoggerService {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

const request = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('OpenAiAdapter', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockConstructor.mockReset();
  });

  it('satisfies the AiProvider contract', () => {
    const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

    expect(adapter.name).toBe('openai');
    expect(typeof adapter.generate).toBe('function');
  });

  it('initializes the OpenAI client with the configured API key, bounded timeout, and no SDK-level retry', () => {
    new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test-key' }), makeLogger());

    expect(mockConstructor).toHaveBeenCalledWith({ apiKey: 'sk-test-key', timeout: 30_000, maxRetries: 0 });
  });

  it('does not initialize a client when no API key is configured', () => {
    new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: undefined }), makeLogger());

    expect(mockConstructor).not.toHaveBeenCalled();
  });

  it('throws ProviderError when generate() is called without a configured API key, without calling OpenAI', async () => {
    const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: undefined }), makeLogger());

    await expect(adapter.generate(request)).rejects.toThrow(ProviderError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('uses the configured AI_MODEL when the request omits one', async () => {
    mockCreate.mockResolvedValue({ output_text: 'hello', model: 'gpt-5.6-luna' });
    const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test', AI_MODEL: 'gpt-5.6-luna' }), makeLogger());

    await adapter.generate(request);

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.6-luna' }));
  });

  it('uses the request-supplied model over the configured default', async () => {
    mockCreate.mockResolvedValue({ output_text: 'hello', model: 'gpt-5.6-luna-mini' });
    const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test', AI_MODEL: 'gpt-5.6-luna' }), makeLogger());

    await adapter.generate({ ...request, model: 'gpt-5.6-luna-mini' });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.6-luna-mini' }));
  });

  it('passes messages through as the Responses API input', async () => {
    mockCreate.mockResolvedValue({ output_text: 'hello', model: 'gpt-5.6-luna' });
    const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

    await adapter.generate(request);

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ input: request.messages }));
  });

  it('converts an OpenAI response with usage into the provider-neutral result shape', async () => {
    mockCreate.mockResolvedValue({
      output_text: 'hello back',
      model: 'gpt-5.6-luna',
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    });
    const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

    const result = await adapter.generate(request);

    expect(result).toEqual({
      content: 'hello back',
      model: 'gpt-5.6-luna',
      provider: 'openai',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
  });

  it('omits usage when the OpenAI response reports none', async () => {
    mockCreate.mockResolvedValue({ output_text: 'hi', model: 'gpt-5.6-luna' });
    const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

    const result = await adapter.generate(request);

    expect(result.usage).toBeUndefined();
  });

  it('throws ProviderError when the OpenAI request rejects, and logs only the error type', async () => {
    mockCreate.mockRejectedValue(new Error('network reset'));
    const logger = makeLogger();
    const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), logger);

    await expect(adapter.generate(request)).rejects.toThrow(/OpenAI request failed: network reset/);
    expect(logger.event).toHaveBeenCalledWith(
      'error',
      'OpenAI request failed',
      'OpenAiAdapter',
      expect.objectContaining({ errorType: 'Error' }),
    );
  });

  it('throws ProviderError when the response reports an error field', async () => {
    mockCreate.mockResolvedValue({ error: { message: 'model overloaded' } });
    const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

    await expect(adapter.generate(request)).rejects.toThrow(/OpenAI returned an error: model overloaded/);
  });

  it('never logs the configured API key', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-super-secret-value' }), makeLogger());

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ');
    expect(logged).not.toContain('sk-super-secret-value');

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
