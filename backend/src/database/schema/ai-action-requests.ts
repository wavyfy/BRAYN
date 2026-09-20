import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, workspaceId } from './columns';
import { users } from './users';
import { canonicalCustomers } from './canonical-customers';

/**
 * One lifecycle record per AI/tool-initiated action request (doc19 Phase
 * 14 — "Audit trail"; doc03 rule 7/15; doc18 AI Reliability — "Action
 * audit trail"). Written once by `AiActionControlService.execute()` when
 * the request reaches an immediate terminal outcome (every case except
 * `pending`). A `pending` row (approval required) is the one exception:
 * `AiActionControlService.approve()`/`deny()` update that same row in
 * place once a merchant decides — `decidedByUserId`/`decidedAt` record
 * when that happened, and `approvalState`/`executionStatus`/
 * `resultSummary`/`failureReason` move to their final values (doc19 Phase
 * 14 Approval-Grant Workflow). Still no generic `updatedAt` — this one
 * specific transition is the only update this row ever receives.
 *
 * Deliberately metadata-only: `inputSummary`/`resultSummary` must never
 * carry raw customer PII or message content (doc18 Logging) — callers pass
 * only small, already-safe identifiers/counts, the same discipline
 * `AiGatewayService` applies to prompts/completions.
 */
export const aiActionRequests = pgTable('ai_action_requests', {
  id: id(),
  workspaceId: workspaceId(),
  /**
   * Internal `users.id` the action was performed on behalf of — not the
   * Clerk external sub. Null for a system/automation-initiated request
   * (doc19 Phase 15 item 7 — `AiActionControlService.executeForAutomation()`)
   * — there is no human actor to attribute it to; the automation itself,
   * via `action`/`workspaceId`, is the attribution.
   */
  actorUserId: uuid('actor_user_id').references(() => users.id),
  /** Snapshot of the actor's workspace role at request time — roles can change later; this reflects what it was then. Null alongside `actorUserId` for a system/automation-initiated request — there is no role to check (doc16 Core Flow still routes automation through this same enforcement point; see `executeForAutomation()`'s doc comment for why no role check applies). */
  actorRole: text('actor_role', { enum: ['owner', 'admin', 'marketing', 'support', 'analyst'] }),
  /** Registered action name, e.g. 'recommendation.dismiss' (doc14 Tool Architecture — "Name"). */
  action: text('action').notNull(),
  riskLevel: text('risk_level', { enum: ['low', 'medium', 'high'] }).notNull(),
  permissionDecision: text('permission_decision', { enum: ['permitted', 'denied'] }),
  approvalState: text('approval_state', { enum: ['not_required', 'pending', 'approved', 'denied'] }).notNull(),
  executionStatus: text('execution_status', {
    enum: ['blocked_validation', 'blocked_permission', 'blocked_approval', 'duplicate', 'executed', 'failed'],
  }).notNull(),
  /** Small, non-sensitive input identifiers only (e.g. `{ recommendationId }`) — never raw customer content. */
  inputSummary: jsonb('input_summary'),
  /** Small, non-sensitive result shape on success (e.g. `{ recommendationId, state }`). Null unless executed. */
  resultSummary: jsonb('result_summary'),
  /** Set only when executionStatus is 'blocked_validation' or 'failed'. */
  failureReason: text('failure_reason'),
  /** Correlates back to the originating request's log lines (doc18 Correlation & Traceability). */
  correlationId: text('correlation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * The `context.customerId` the action was requested against, if any
   * (doc19 Phase 14 Approval-Grant Workflow). Null for workspace-level
   * actions. Persisted so `AiActionControlService.approve()` can
   * reconstruct the same `ActionExecutionContext` later, when the pending
   * row's `inputSummary` alone isn't enough — the original request never
   * had anywhere else to put it.
   */
  customerId: uuid('customer_id').references(() => canonicalCustomers.id),
  /** Who decided a `pending` approval (doc14 Human Approval — "Merchant Approval"; doc28 "AI action approval": owner/admin only in Phase 1). Null until decided. */
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
  /** When the approval decision was made. Null until decided. */
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});
