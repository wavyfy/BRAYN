import { Module } from '@nestjs/common';
import { AI_PROVIDER } from './ai-provider.interface';
import { AiGatewayService } from './ai-gateway.service';
import { OpenAiAdapter } from './providers/openai/openai.adapter';

/**
 * Owns: AI Gateway, model/provider abstraction, agent orchestration, tool
 * registry, tool execution, AI action flow, human escalation.
 * See: "12. BRAYN AI Architecture", "14. BRAYN AI Agents, Tools & Execution"
 *
 * Phase 11 Part 2: AI_PROVIDER now resolves to OpenAiAdapter (Part 1's
 * UnconfiguredAiProvider stub is gone). API key/model come from
 * ConfigService (global, see AppModule) — no local config import needed.
 * Retry/timeout, structured output, Context Builder, and everything in
 * "14. BRAYN AI Agents, Tools & Execution" land in later parts.
 */
@Module({
  providers: [AiGatewayService, { provide: AI_PROVIDER, useClass: OpenAiAdapter }],
  exports: [AiGatewayService],
})
export class AiModule {}
