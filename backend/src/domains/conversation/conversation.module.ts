import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { ConversationService } from './conversation.service';
import { ConversationController } from './conversation.controller';

/**
 * Owns: conversations, messages, conversation state, WAPon/WhatsApp
 * channel communication, inbound/outbound handling, human handoff.
 * See: "15. BRAYN Conversation & Communication"
 *
 * Phase 9 item 1 — Conversation foundation only (doc19): conversations +
 * outbound messages, channel-agnostic. WAPon/WhatsApp wiring (item 2) and
 * human handoff (item 3) are later parts — see ConversationService's doc
 * comment.
 *
 * Email is not part of BRAYN scope (removed — see doc 02, doc 29 §14).
 *
 * Imports WorkspaceModule for WorkspaceMembershipGuard rather than
 * duplicating the tenant-isolation/authorization boundary.
 */
@Module({
  imports: [WorkspaceModule],
  controllers: [ConversationController],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
