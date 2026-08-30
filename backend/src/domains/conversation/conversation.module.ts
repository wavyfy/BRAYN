import { Module } from '@nestjs/common';

/**
 * Owns: conversations, messages, conversation state, WAPon/WhatsApp
 * channel communication, inbound/outbound handling, human handoff.
 * See: "15. BRAYN Conversation & Communication"
 *
 * Email is not part of BRAYN scope (removed — see doc 02, doc 29 §14).
 */
@Module({})
export class ConversationModule {}
