import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { LogsProtectedAccess } from '../../common/access-log/protected-data-access.decorator';
import { ConversationService } from './conversation.service';
import { startConversationSchema, type StartConversationInput } from './dto/start-conversation.schema';
import { sendMessageSchema, type SendMessageInput } from './dto/send-message.schema';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home).
 *
 * Owner/admin only — conversation messages are free-text customer
 * communication and can carry personal data. Class-level
 * `@RequireWorkspaceRole` applies to all four handlers, declared once
 * rather than repeated per method.
 */
@Controller('workspaces/:workspaceId/customers/:canonicalCustomerId/conversations')
@UseGuards(WorkspaceMembershipGuard)
@RequireWorkspaceRole('owner', 'admin')
export class ConversationController {
  constructor(private readonly conversationService: ConversationService) {}

  @Get()
  @LogsProtectedAccess('conversation', 'canonicalCustomerId')
  async list(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.conversationService.listConversations(workspaceId, canonicalCustomerId);
  }

  /** resourceId is canonicalCustomerId, not the new conversation's id — the latter only exists in the response body, not a route param (doc — resourceId comes from route/controller metadata, never a response payload). */
  @Post()
  @HttpCode(HttpStatus.OK)
  @LogsProtectedAccess('conversation', 'canonicalCustomerId')
  async start(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Body(new ZodValidationPipe(startConversationSchema)) body: StartConversationInput,
  ) {
    return this.conversationService.startConversation(workspaceId, canonicalCustomerId, body);
  }

  @Get(':conversationId/messages')
  @LogsProtectedAccess('conversation', 'conversationId')
  async listMessages(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversationService.listMessages(workspaceId, canonicalCustomerId, conversationId);
  }

  @Post(':conversationId/messages')
  @HttpCode(HttpStatus.OK)
  @LogsProtectedAccess('conversation', 'conversationId')
  async sendMessage(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Param('conversationId') conversationId: string,
    @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageInput,
  ) {
    return this.conversationService.sendMessage(workspaceId, canonicalCustomerId, conversationId, body.content);
  }
}
