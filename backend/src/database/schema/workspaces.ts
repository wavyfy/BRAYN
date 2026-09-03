import { pgTable, text } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns';

/**
 * A workspace represents one merchant/business environment (doc 05).
 * Deliberately minimal: only what's clearly implied by the canonical
 * docs today. Billing/plan fields are explicitly not added — SaaS
 * subscription/billing scope is still an unresolved product decision
 * (doc 02, Pre-Implementation Decisions).
 */
export const workspaces = pgTable('workspaces', {
  id: id(),
  name: text('name').notNull(),
  ...timestamps(),
});
