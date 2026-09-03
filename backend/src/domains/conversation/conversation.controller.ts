import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { ConversationService } from './conversation.service';
import { startConversationSchema, type StartConversationInput } from './dto/start-conversation.schema';
import { sendMessageSchema, type SendMessageInput } from './dto/send-message.schema';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home): any
 * workspace member can view or send on a customer's conversations.
 */
@Controller('workspaces/:workspaceId/customers/:canonicalCustomerId/conversations')
@UseGuards(WorkspaceMembershipGuard)
export class ConversationController {
  constructor(private readonly conversationService: ConversationService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.conversationService.listConversations(workspaceId, canonicalCustomerId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async start(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Body(new ZodValidationPipe(startConversationSchema)) body: StartConversationInput,
  ) {
    return this.conversationService.startConversation(workspaceId, canonicalCustomerId, body);
  }

  @Get(':conversationId/messages')
  async listMessages(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversationService.listMessages(workspaceId, canonicalCustomerId, conversationId);
  }

  @Post(':conversationId/messages')
  @HttpCode(HttpStatus.OK)
  async sendMessage(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Param('conversationId') conversationId: string,
    @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageInput,
  ) {
    return this.conversationService.sendMessage(workspaceId, canonicalCustomerId, conversationId, body.content);
  }
}
