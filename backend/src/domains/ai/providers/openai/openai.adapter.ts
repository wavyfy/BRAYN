import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import type { Responses } from 'openai/resources/responses/responses';
import { ProviderError } from '../../../../common/errors/app-error';
import { withRetry } from '../../../../common/async/retry';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import type { AiGenerateRequest, AiGenerateResult, AiMessage, AiProvider, AiToolDefinition } from '../../ai-provider.interface';
import type { Env } from '../../../../config/env.schema';

/**
 * Each individual call is still a single bounded request-response round
 * trip — doc14's multi-turn tool loop (Tool Selection → Execution → Result
 * → back to the model) is orchestrated by the caller across multiple
 * `generate()` calls, not by this adapter or a stuck long-lived request, so
 * the per-call timeout stays unchanged. No locked number exists for this in
 * doc 18 (Performance Requirements only sets a qualitative "handle timeout
 * ... gracefully" target) — 30s is a judgment call, not a canonical
 * decision.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * OpenAI function names must match `^[a-zA-Z0-9_-]+$`, but BRAYN tool names
 * are AI Action Control action names (e.g. `recommendation.dismiss`), which
 * are persisted and audited and must not change. So names are encoded here,
 * at the provider boundary, and decoded back on every returned tool call.
 */
function toProviderToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/** provider name → BRAYN name for this request's tools; refuses a request where two BRAYN names would encode to the same provider name. */
function providerToolNameMap(tools: AiToolDefinition[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools ?? []) {
    const providerName = toProviderToolName(tool.name);
    const existing = map.get(providerName);
    if (existing !== undefined && existing !== tool.name) {
      throw new ProviderError(`Tool names "${existing}" and "${tool.name}" collide for OpenAI.`);
    }
    map.set(providerName, tool.name);
  }
  return map;
}

/** doc14 Tool Architecture → OpenAI Responses API function-tool shape. `strict: false` — BRAYN tool schemas aren't authored as OpenAI's strict-mode subset (doc19 Phase 12 step 6 scope: reuse existing schemas, don't redesign them to fit a stricter dialect). */
function toResponsesTools(tools: AiToolDefinition[] | undefined): Responses.Tool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map(
    (tool): Responses.FunctionTool => ({
      type: 'function',
      name: toProviderToolName(tool.name),
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }),
  );
}

/**
 * Maps BRAYN's provider-neutral message history to Responses API input
 * items. A `tool` message becomes a `function_call_output` item; an
 * `assistant` message carrying `toolCalls` becomes one `function_call` item
 * per call (replaying the model's own prior tool request, required so a
 * follow-up turn's history stays consistent — Responses API tool-output
 * items must reference a `function_call` item already in the input/output).
 */
function toResponsesInput(messages: AiMessage[]): Responses.ResponseInputItem[] {
  const items: Responses.ResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: message.toolCallId ?? '', output: message.content });
      continue;
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      for (const call of message.toolCalls) {
        items.push({ type: 'function_call', call_id: call.id, name: toProviderToolName(call.name), arguments: call.arguments });
      }
      continue;
    }
    items.push({ role: message.role, content: message.content });
  }
  return items;
}

function isFunctionCall(item: Responses.ResponseOutputItem): item is Responses.ResponseFunctionToolCall {
  return item.type === 'function_call';
}

/**
 * Rate limits, transient network failures, and 5xx are retryable (doc 18
 * "Reliability" — retry only potentially-recoverable failures). 4xx
 * (bad request, auth, permission, not-found, unprocessable) are not:
 * retrying an invalid/rejected request wastes attempts on a failure that
 * will never succeed.
 */
function isTransientOpenAiError(error: unknown): boolean {
  return (
    error instanceof RateLimitError ||
    error instanceof InternalServerError ||
    error instanceof APIConnectionError ||
    error instanceof APIConnectionTimeoutError
  );
}

/**
 * OpenAI implementation of the AiProvider contract (doc 12 — Model
 * Providers: provider-specific APIs/auth/request/response shapes and
 * model identifiers must not leak past this file). AiGatewayService and
 * everything above it only ever see AiProvider/AiGenerateResult.
 *
 * Uses the Responses API, not Chat Completions — OpenAI's official
 * guidance (developers.openai.com, checked for this part) is "Responses
 * is recommended for all new projects" while Chat Completions remains
 * supported but is the legacy path. `EasyInputMessage`'s
 * `{role, content}` shape is a structural match for `AiMessage`.
 *
 * Same fail-closed convention as ShopifyAdapter: an absent OPENAI_API_KEY
 * doesn't throw at construction (most test runs don't set it) — only
 * `generate()` throws, and only if actually called. `maxRetries: 0` on
 * the client disables the SDK's own built-in retry so BRAYN's
 * `withRetry` (doc 18 Reliability) is the single retry authority —
 * layering both would let one call retry up to 3×3 times with
 * uncoordinated backoff.
 */
@Injectable()
export class OpenAiAdapter implements AiProvider {
  readonly name = 'openai' as const;

  private readonly client: OpenAI | undefined;
  private readonly defaultModel: string;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: StructuredLoggerService,
  ) {
    const apiKey = this.config.get('OPENAI_API_KEY', { infer: true });
    this.client = apiKey ? new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }) : undefined;
    // Model selection is configuration-driven (doc 12) — never a literal in this class.
    this.defaultModel = this.config.get('AI_MODEL', { infer: true });
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    if (!this.client) {
      throw new ProviderError('OpenAI is not configured.');
    }
    const client = this.client;

    const model = request.model ?? this.defaultModel;
    const tools = toResponsesTools(request.tools);
    const braynToolName = providerToolNameMap(request.tools);

    const response = await withRetry(
      () => client.responses.create({ model, input: toResponsesInput(request.messages), ...(tools ? { tools } : {}) }),
      { shouldRetry: isTransientOpenAiError },
    ).catch((error: unknown) => {
      // errorType only — never the request/response body, which may carry prompt content (doc 18 Logging).
      this.logger.event('error', 'OpenAI request failed', 'OpenAiAdapter', {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
      throw new ProviderError(`OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    if (response.error) {
      throw new ProviderError(`OpenAI returned an error: ${response.error.message}`);
    }

    const functionCalls = (response.output ?? []).filter(isFunctionCall);

    return {
      content: response.output_text,
      toolCalls:
        functionCalls.length > 0
          ? functionCalls.map((call) => ({ id: call.call_id, name: braynToolName.get(call.name) ?? call.name, arguments: call.arguments }))
          : undefined,
      model: response.model,
      provider: this.name,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }
}
