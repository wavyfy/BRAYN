import { Module } from '@nestjs/common';

/**
 * Owns: AI Gateway, model/provider abstraction, agent orchestration, tool
 * registry, tool execution, AI action flow, human escalation.
 * See: "12. BRAYN AI Architecture", "14. BRAYN AI Agents, Tools & Execution"
 *
 * AI provider/model policy is an unresolved product decision (doc 02,
 * Pre-Implementation Decisions). No provider-specific code belongs here
 * until that decision is locked.
 */
@Module({})
export class AiModule {}
