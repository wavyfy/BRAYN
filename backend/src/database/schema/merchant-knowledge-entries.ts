import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';

/**
 * Current state of a merchant knowledge/policy entry (doc13 — Merchant
 * Knowledge & Policy Store). `type` distinguishes doc13's two concepts
 * sharing one table rather than two near-identical ones (doc03 rule 7 —
 * reuse over duplication): `knowledge` ("information AI can use to
 * understand the business") vs `policy` ("rules that constrain what AI
 * or automation should do" — "higher authority than general knowledge
 * when they conflict").
 *
 * Phase 1 scope: merchant-authored text only (title + content) — no file
 * upload/document ingestion pipeline yet (doc19 Phase 10's "Upload/input
 * flow, Processing" is real additional scope, not built speculatively,
 * doc18) and no retrieval/context-preparation wiring into AI (doc19 Phase
 * 11 AI Foundation doesn't exist yet — nothing to hand context to). This
 * table's `list`/`get` endpoints are the "structured lookup" retrieval
 * doc13 explicitly allows ("The retrieval mechanism is an implementation
 * detail").
 *
 * `version` pairs with `merchant_knowledge_entry_history` — doc13
 * "Important merchant knowledge and policies should retain version/
 * history" — every entry is potentially business-critical (a `policy`
 * constrains AI/automation), so every write is versioned, same pattern
 * as `customer_health_states`/`customer_health_state_history`.
 */
export const merchantKnowledgeEntries = pgTable('merchant_knowledge_entries', {
  id: id(),
  workspaceId: workspaceId(),
  type: text('type', { enum: ['knowledge', 'policy'] }).notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  version: integer('version').notNull().default(1),
  ...timestamps(),
});
