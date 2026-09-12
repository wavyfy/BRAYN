import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { MerchantBusinessAnalystService } from './merchant-business-analyst.service';
import { askQuestionSchema, type AskQuestionInput } from './dto/ask-question.schema';

/**
 * Doc23 API Contracts — "Merchant Business Analyst" API domain: "AI
 * requests must pass through the AI Gateway." Doc28 Phase 1 Permission
 * Matrix — every role (Owner/Admin/Marketing/Support/Analyst) can "Use"
 * Merchant Business Analyst, so no @RequireWorkspaceRole restriction:
 * any workspace member may call this.
 */
@Controller('workspaces/:workspaceId/merchant-business-analyst')
@UseGuards(WorkspaceMembershipGuard)
export class MerchantBusinessAnalystController {
  constructor(private readonly merchantBusinessAnalystService: MerchantBusinessAnalystService) {}

  @Post('ask')
  async ask(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(askQuestionSchema)) body: AskQuestionInput,
  ) {
    return this.merchantBusinessAnalystService.ask(workspaceId, body.question, body.customerId);
  }
}
