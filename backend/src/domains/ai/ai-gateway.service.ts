import { Inject, Injectable } from '@nestjs/common';
import { AppError, ProviderError } from '../../common/errors/app-error';
import { AI_PROVIDER, type AiGenerateRequest, type AiGenerateResult, type AiProvider } from './ai-provider.interface';

/**
 * Single application-facing entry point for AI calls (doc 12 — AI
 * Gateway). Depends on the AiProvider contract, never a concrete
 * provider, so Phase 12/13 consumers stay provider-agnostic. Retry/
 * timeout policy lands once a real provider exists to apply it to
 * (Part 3).
 */
@Injectable()
export class AiGatewayService {
  constructor(@Inject(AI_PROVIDER) private readonly provider: AiProvider) {}

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    const startedAt = Date.now();
    try {
      const result = await this.provider.generate(request);
      return { ...result, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new ProviderError(
        `AI provider "${this.provider.name}" request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
