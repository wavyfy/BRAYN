import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { conversations } from '../../database/schema/conversations';
import { conversationMessages } from '../../database/schema/conversation-messages';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { DatabaseService } from '../../database/database.service';
import { NotFoundError } from '../../common/errors/app-error';
import type { StartConversationInput } from './dto/start-conversation.schema';

/**
 * Conversation foundation (doc15; doc19 Phase 9 item 1 — "Conversation
 * foundation", before item 2 "WhatsApp through WAPon" and item 3 "Human
 * handoff"). This part is channel-agnostic bookkeeping only: no real
 * WAPon/WhatsApp wiring exists yet (that's the next part, and needs a
 * WAPon account — doc19 Phase 0, human-owned setup, not done yet), and no
 * handoff/ownership tracking (a later part).
 *
 * Only outbound, human-composed messages are producible today — there is
 * no inbound channel wired to ever produce an inbound/customer/AI/
 * automation message yet. `sendMessage` is deliberately the only write
 * path; a public "create an inbound message" endpoint would let any
 * caller fabricate a message impersonating the customer, which the real
 * inbound path (doc15 — "Inbound messages must be authenticated/
 * validated") will guard against once it exists as a provider webhook.
 */
@Injectable()
export class ConversationService {
  constructor(private readonly database: DatabaseService) {}

  /** Reuses the customer's own open conversation on this channel, if one exists — doc15's "conversation represents an ongoing communication context", not a new one per message. */
  async startConversation(workspaceId: string, canonicalCustomerId: string, input: StartConversationInput) {
    await this.requireCanonicalCustomer(workspaceId, canonicalCustomerId);

    const [existing] = await this.database.client
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversations.canonicalCustomerId, canonicalCustomerId),
          eq(conversations.channel, input.channel),
          eq(conversations.status, 'open'),
        ),
      )
      .limit(1);

    if (existing) {
      return existing;
    }

    const [created] = await this.database.client
      .insert(conversations)
      .values({ workspaceId, canonicalCustomerId, channel: input.channel })
      .returning();

    return created;
  }

  async listConversations(workspaceId: string, canonicalCustomerId: string) {
    await this.requireCanonicalCustomer(workspaceId, canonicalCustomerId);

    return this.database.client
      .select()
      .from(conversations)
      .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.canonicalCustomerId, canonicalCustomerId)))
      .orderBy(desc(conversations.createdAt));
  }

  /** Ascending — a conversation thread reads oldest-first, unlike the newest-first feeds elsewhere in this domain. */
  async listMessages(workspaceId: string, canonicalCustomerId: string, conversationId: string) {
    await this.requireConversation(workspaceId, canonicalCustomerId, conversationId);

    return this.database.client
      .select()
      .from(conversationMessages)
      .where(and(eq(conversationMessages.workspaceId, workspaceId), eq(conversationMessages.conversationId, conversationId)))
      .orderBy(asc(conversationMessages.createdAt));
  }

  async sendMessage(workspaceId: string, canonicalCustomerId: string, conversationId: string, content: string) {
    await this.requireConversation(workspaceId, canonicalCustomerId, conversationId);

    const now = new Date();
    const [message] = await this.database.client
      .insert(conversationMessages)
      .values({
        workspaceId,
        conversationId,
        direction: 'outbound',
        senderType: 'human',
        content,
        deliveryState: 'pending',
      })
      .returning();

    await this.database.client.update(conversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(conversations.id, conversationId));

    return message;
  }

  private async requireCanonicalCustomer(workspaceId: string, canonicalCustomerId: string): Promise<void> {
    const [canonical] = await this.database.client
      .select({ id: canonicalCustomers.id })
      .from(canonicalCustomers)
      .where(and(eq(canonicalCustomers.workspaceId, workspaceId), eq(canonicalCustomers.id, canonicalCustomerId)))
      .limit(1);

    if (!canonical) {
      throw new NotFoundError('No customer with that id exists in this workspace.');
    }
  }

  private async requireConversation(workspaceId: string, canonicalCustomerId: string, conversationId: string): Promise<void> {
    const [conversation] = await this.database.client
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversations.canonicalCustomerId, canonicalCustomerId),
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1);

    if (!conversation) {
      throw new NotFoundError('No conversation with that id exists for this customer.');
    }
  }
}
