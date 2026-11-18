import type { ZodType } from 'zod';
import type { WorkspaceRole } from '../workspace/dto/add-member.schema';

export type ActionRiskLevel = 'low' | 'medium' | 'high';

/** What an action executor is given — never a model-supplied workspaceId (doc03 rule 3, doc28 Tenant Isolation): callers pass this from RequestContext, not from the action's own input. */
export interface ActionExecutionContext {
  workspaceId: string;
  customerId?: string;
}

/**
 * One controlled action's full contract (doc14 Tool Architecture — "Name,
 * Purpose, Input schema, Output schema, Permission requirements, Side
 * effects, Validation requirements, Failure behaviour"). `execute` is the
 * only place the actual write happens — `AiActionControlService` is the
 * one caller allowed to invoke it (doc03 rule 7 — the enforcement point
 * sits between the request and the write, not inside every caller).
 */
export interface ActionDefinition<TInput, TResult> {
  name: string;
  description: string;
  riskLevel: ActionRiskLevel;
  /** Doc14 Action Risk — Phase 1 low risk is "automatic execution where permitted"; medium/high require approval before `execute` may run. */
  requiresApproval: boolean;
  /** Doc28 Permission Matrix — which workspace roles may invoke this action at all (checked before risk/approval, per the canonical lifecycle order). */
  allowedRoles: readonly WorkspaceRole[];
  /**
   * Doc16 retry decision (Nov 2, 2026): true only when re-running `execute` after a failure can never duplicate a
   * business effect (the write is idempotent on its own). A failed retry-safe execution releases its idempotency
   * reservation for a retry; any other failure keeps it blocked, because the effect may already have happened.
   */
  retrySafe: boolean;
  inputSchema: ZodType<TInput>;
  /** Domain-state check beyond the input schema, run on request and again on approval (doc14 Execution validation). Returns a failure reason, or null when valid. */
  validate?: (input: TInput, context: ActionExecutionContext) => Promise<string | null>;
  /** Approval-required actions only: at most one `pending` request per workspace with an `inputSummary` containing this subset (e.g. `{ orderId }`). */
  pendingScope?: (input: TInput) => Record<string, string>;
  execute: (input: TInput, context: ActionExecutionContext) => Promise<TResult>;
  /** Reduces a successful result to a small, non-sensitive audit summary (doc18 Logging — never raw customer content). Omit when the result itself is already safe/small enough, or nothing needs recording. */
  summarizeResult?: (result: TResult) => Record<string, unknown> | null;
}
