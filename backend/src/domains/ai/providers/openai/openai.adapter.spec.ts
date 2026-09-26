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

  describe('tool calling (doc19 Phase 12 step 6)', () => {
    it('omits tools from the request when none are supplied (existing steps 1-5 behavior unchanged)', async () => {
      mockCreate.mockResolvedValue({ output_text: 'hello', model: 'gpt-5.6-luna' });
      const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

      await adapter.generate(request);

      const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(call).not.toHaveProperty('tools');
    });

    it('maps AiToolDefinition[] to the Responses API function-tool shape', async () => {
      mockCreate.mockResolvedValue({ output_text: 'hello', model: 'gpt-5.6-luna' });
      const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

      await adapter.generate({
        ...request,
        tools: [{ name: 'get_thing', description: 'Gets a thing.', parameters: { type: 'object', properties: {} } }],
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [
            {
              type: 'function',
              name: 'get_thing',
              description: 'Gets a thing.',
              parameters: { type: 'object', properties: {} },
              strict: false,
            },
          ],
        }),
      );
    });

    it('returns toolCalls when the model requests a function call instead of a final answer', async () => {
      mockCreate.mockResolvedValue({
        output_text: '',
        model: 'gpt-5.6-luna',
        output: [{ type: 'function_call', call_id: 'call_1', name: 'get_thing', arguments: '{"id":"123"}' }],
      });
      const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

      const result = await adapter.generate({
        ...request,
        tools: [{ name: 'get_thing', description: 'Gets a thing.', parameters: {} }],
      });

      expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'get_thing', arguments: '{"id":"123"}' }]);
      expect(result.content).toBe('');
    });

    it('omits toolCalls from the result when the model returns only text', async () => {
      mockCreate.mockResolvedValue({ output_text: 'hi', model: 'gpt-5.6-luna', output: [] });
      const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

      const result = await adapter.generate(request);

      expect(result.toolCalls).toBeUndefined();
    });

    it('maps a tool result message to a function_call_output input item, replaying the prior function_call', async () => {
      mockCreate.mockResolvedValue({ output_text: 'final answer', model: 'gpt-5.6-luna' });
      const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

      await adapter.generate({
        messages: [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_thing', arguments: '{}' }] },
          { role: 'tool', content: '{"result":"ok"}', toolCallId: 'call_1' },
        ],
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          input: [
            { role: 'user', content: 'question' },
            { type: 'function_call', call_id: 'call_1', name: 'get_thing', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_1', output: '{"result":"ok"}' },
          ],
        }),
      );
    });

    describe('tool names outside OpenAI\'s ^[a-zA-Z0-9_-]+$ pattern (AI Action Control names like recommendation.dismiss)', () => {
      const dottedTools = [
        { name: 'get_customer_activity_history', description: 'Read.', parameters: {} },
        { name: 'recommendation.dismiss', description: 'Dismiss.', parameters: {} },
      ];

      it('sends an OpenAI-valid encoded name, leaving already-valid names unchanged', async () => {
        mockCreate.mockResolvedValue({ output_text: 'ok', model: 'gpt-5.6-luna' });
        const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

        await adapter.generate({ ...request, tools: dottedTools });

        const sent = (mockCreate.mock.calls[0][0] as { tools: { name: string }[] }).tools.map((tool) => tool.name);
        expect(sent).toEqual(['get_customer_activity_history', 'recommendation-dismiss']);
        for (const name of sent) expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
      });

      it('decodes a returned tool call back to the BRAYN action name', async () => {
        mockCreate.mockResolvedValue({
          output_text: '',
          model: 'gpt-5.6-luna',
          output: [{ type: 'function_call', call_id: 'call_1', name: 'recommendation-dismiss', arguments: '{}' }],
        });
        const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

        const result = await adapter.generate({ ...request, tools: dottedTools });

        expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'recommendation.dismiss', arguments: '{}' }]);
      });

      it('replays a prior dotted tool call in the history under its encoded name', async () => {
        mockCreate.mockResolvedValue({ output_text: 'done', model: 'gpt-5.6-luna' });
        const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

        await adapter.generate({
          tools: dottedTools,
          messages: [
            { role: 'user', content: 'question' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'recommendation.dismiss', arguments: '{}' }] },
            { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' },
          ],
        });

        const input = (mockCreate.mock.calls[0][0] as { input: { name?: string }[] }).input;
        expect(input[1]).toMatchObject({ type: 'function_call', name: 'recommendation-dismiss' });
      });

      it('refuses, without calling OpenAI, when two tool names would encode to the same OpenAI name', async () => {
        const adapter = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'sk-test' }), makeLogger());

        await expect(
          adapter.generate({
            ...request,
            tools: [
              { name: 'a.b', description: '', parameters: {} },
              { name: 'a-b', description: '', parameters: {} },
            ],
          }),
        ).rejects.toThrow(ProviderError);
        expect(mockCreate).not.toHaveBeenCalled();
      });
    });
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
