import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { conversations } from './conversations';

/**
 * A message within a conversation (doc15 — "Messages belong to
 * conversations"). `direction`/`senderType` carry doc15's own participant
 * vocabulary ("AI, Human merchant/operator, Business Action Automation")
 * even though only `outbound`/`human` is producible today — see
 * ConversationService's doc comment for why (no inbound channel wired
 * yet). Same precedent as `revenue_opportunities.status` keeping doc10's
 * full fixed vocabulary before every value has a producer.
 *
 * `deliveryState` is null for inbound messages (delivery is BRAYN's own
 * concern, not the customer's) and starts `pending` for outbound — no
 * real channel/provider exists yet to actually move it to
 * sent/delivered/failed (doc15 — "WAPon... communication capabilities";
 * not wired until doc19 Phase 9 item 2).
 */
export const conversationMessages = pgTable('conversation_messages', {
  id: id(),
  workspaceId: workspaceId(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id),
  direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
  senderType: text('sender_type', { enum: ['customer', 'human', 'ai', 'automation'] }).notNull(),
  content: text('content').notNull(),
  deliveryState: text('delivery_state', { enum: ['pending', 'sent', 'delivered', 'failed'] }),
  /** The provider's own message id (e.g. WAPon) — null until that channel is wired. */
  externalId: text('external_id'),
  ...timestamps(),
});
