import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { ProviderError } from '../../../../common/errors/app-error';
import { withRetry } from '../../../../common/async/retry';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import type { AiGenerateRequest, AiGenerateResult, AiProvider } from '../../ai-provider.interface';
import type { Env } from '../../../../config/env.schema';

/**
 * A text-generation call is not agentic/tool-running — bounded well under
 * the SDK's 10-minute default so a stuck request fails fast instead of
 * hanging a caller. No locked number exists for this in doc 18
 * (Performance Requirements only sets a qualitative "handle timeout ...
 * gracefully" target) — 30s is a judgment call, not a canonical decision.
 */
const REQUEST_TIMEOUT_MS = 30_000;

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

    const response = await withRetry(() => client.responses.create({ model, input: request.messages }), {
      shouldRetry: isTransientOpenAiError,
    }).catch((error: unknown) => {
      // errorType only — never the request/response body, which may carry prompt content (doc 18 Logging).
      this.logger.event('error', 'OpenAI request failed', 'OpenAiAdapter', {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
      throw new ProviderError(`OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    if (response.error) {
      throw new ProviderError(`OpenAI returned an error: ${response.error.message}`);
    }

    return {
      content: response.output_text,
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
