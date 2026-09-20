import { Inject, Injectable } from '@nestjs/common';
import { AppError, ProviderError } from '../../common/errors/app-error';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { AI_PROVIDER, type AiGenerateRequest, type AiGenerateResult, type AiProvider } from './ai-provider.interface';

/**
 * Single application-facing entry point for AI calls (doc 12 — AI
 * Gateway). Depends on the AiProvider contract, never a concrete
 * provider, so Phase 12/13 consumers stay provider-agnostic. Retry/
 * timeout policy lands once a real provider exists to apply it to
 * (Part 3).
 *
 * Owns AI observability (doc 12 — "AI Gateway" responsibilities include
 * usage/latency/observability tracking; doc 19 Phase 11 lists "AI
 * observability" as its own checklist item). Every call — success or
 * failure — gets exactly one structured event logged here, at the one
 * point that sees every provider's calls. StructuredLoggerService
 * already injects correlationId/userId/workspaceId from RequestContext
 * (doc 18 Correlation & Traceability) into every line, so this only
 * needs to attach the AI-specific fields. Never logs `messages` or
 * `content` — doc 18 Logging forbids request/response bodies.
 */
@Injectable()
export class AiGatewayService {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly logger: StructuredLoggerService,
  ) {}

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    const startedAt = Date.now();
    try {
      const result = await this.provider.generate(request);
      const latencyMs = Date.now() - startedAt;
      this.logger.event('log', 'AI request succeeded', 'AiGatewayService', {
        provider: result.provider,
        model: result.model,
        capability: request.capability,
        latencyMs,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        totalTokens: result.usage?.totalTokens,
        // Tool names only (doc14 AI Observability "Tool selected") — never arguments/output, which may carry customer data.
        toolsOffered: request.tools?.map((tool) => tool.name),
        toolCallsRequested: result.toolCalls?.map((call) => call.name),
      });
      return { ...result, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      this.logger.event('error', 'AI request failed', 'AiGatewayService', {
        provider: this.provider.name,
        model: request.model,
        capability: request.capability,
        latencyMs,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });

      if (error instanceof AppError) {
        throw error;
      }
      throw new ProviderError(
        `AI provider "${this.provider.name}" request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
