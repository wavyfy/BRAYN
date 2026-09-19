import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RateLimitTier } from '../../common/rate-limit/rate-limit.decorator';
import { MerchantBusinessAnalystService } from './merchant-business-analyst.service';
import { askQuestionSchema, type AskQuestionInput } from './dto/ask-question.schema';

/**
 * Doc23 API Contracts — "Merchant Business Analyst" API domain: "AI
 * requests must pass through the AI Gateway." Doc28 Phase 1 Permission
 * Matrix — every role (Owner/Admin/Marketing/Support/Analyst) can "Use"
 * Merchant Business Analyst, so no @RequireWorkspaceRole restriction:
 * any workspace member may call this.
 *
 * `@RateLimitTier('ai')` (doc19 Phase 17 hardening) — this is the one
 * endpoint in the API that actually calls the AI Gateway/OpenAI; the
 * stricter tier reflects real per-call cost/latency, distinct from a
 * normal CRUD/read request. See RateLimitGuard.
 */
@Controller('workspaces/:workspaceId/merchant-business-analyst')
@UseGuards(WorkspaceMembershipGuard)
export class MerchantBusinessAnalystController {
  constructor(private readonly merchantBusinessAnalystService: MerchantBusinessAnalystService) {}

  @Post('ask')
  @RateLimitTier('ai')
  async ask(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(askQuestionSchema)) body: AskQuestionInput,
  ) {
    return this.merchantBusinessAnalystService.ask(workspaceId, body.question, body.customerId);
  }
}
