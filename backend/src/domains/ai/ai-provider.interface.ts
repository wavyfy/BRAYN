/**
 * Provider-neutral AI request/response contract (doc 12 — AI Gateway).
 * Phase 12/13 consumers call through AiGatewayService only, never a
 * concrete provider, so switching/adding providers later stays behind
 * this boundary — same reasoning as ProviderAdapter for commerce
 * integrations (see integration/provider-adapter.interface.ts).
 *
 * Concrete adapters (OpenAiAdapter, ...) land in a later part — this part
 * only defines and tests the contract in isolation, matching how
 * ProviderAdapter (Phase 3) preceded ShopifyAdapter (Phase 4).
 */

/**
 * One tool the model may call this turn (doc14 Tool Architecture — "Name,
 * Purpose, Input schema"). Provider-neutral: `parameters` is a plain JSON
 * Schema object, mapped to whatever shape the concrete provider's function-
 * calling API expects (see OpenAiAdapter). Output schema/permission/side-
 * effects/validation/failure-behaviour — the rest of doc14's per-tool
 * contract — are the tool owner's concern (ai-agents domain), not the
 * Gateway's; the Gateway only ever forwards `name`/`description`/`parameters`
 * to the model.
 */
export interface AiToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * A tool invocation the model requested instead of (or before) a final
 * answer (doc12 AI Request Lifecycle — "Response OR Tool Selection").
 * `arguments` is the raw JSON string the model produced — parsing/
 * validating it is the tool executor's job, not the Gateway's.
 */
export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Empty when an `assistant` message is pure tool call(s) with no accompanying text. */
  content: string;
  /** Only on an `assistant` message that requested tool call(s) this turn. */
  toolCalls?: AiToolCall[];
  /** Only on a `tool` message — the `AiToolCall.id` this result answers. */
  toolCallId?: string;
}

export interface AiGenerateRequest {
  messages: AiMessage[];
  /**
   * Provider model identifier. Optional so callers aren't forced to
   * hard-code a model — model selection is configuration-driven (locked
   * decision), applied by the concrete provider when this is omitted.
   */
  model?: string;
  /**
   * Which AI capability/agent issued this call (doc 12 — AI Observability
   * "Agent/capability"). No caller sets this yet — Phase 12/13 agents
   * don't exist — so it stays optional and unset rather than a Phase-11
   * placeholder value. Present now purely so AiGatewayService has a field
   * to log once a caller supplies it.
   */
  capability?: string;
  /**
   * Tools the model may call this turn (doc14 Tool Architecture). Omitted
   * or empty means no tool-calling — existing Phase 11/12 steps 1-5
   * callers are unaffected since they never set this field.
   */
  tools?: AiToolDefinition[];
}

/**
 * Token counts for one AI call (doc 12 — AI Gateway "Token tracking", AI
 * Observability "Token usage"). Provider-neutral shape; no cost figure
 * here — cost requires a per-model pricing table, which is a persistence/
 * analytics concern deferred past this part.
 */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiGenerateResult {
  /** Empty when the model chose to call tool(s) instead of answering — check `toolCalls` first. */
  content: string;
  /** Present when the model requested tool call(s) this turn (doc12 — "Response OR Tool Call"). The caller executes them and calls `generate()` again with the results appended as `tool` messages. */
  toolCalls?: AiToolCall[];
  /** The model that actually produced this result (echoes request.model, or the provider's configured default). */
  model: string;
  /** Which provider served this result (doc 12 — Prompt & Model Versioning, AI Observability both track "Provider"). */
  provider: string;
  /** Omitted when a provider response doesn't report usage. */
  usage?: AiUsage;
  /** Wall-clock duration of the call. Set by AiGatewayService, not the provider — doc 12 assigns latency tracking to the Gateway. */
  latencyMs?: number;
}

/**
 * Contract every AI provider implements. Must throw `ProviderError` (see
 * common/errors/app-error.ts) for request failures — same convention as
 * `ProviderAdapter` — rather than a silent/empty result.
 */
export interface AiProvider {
  readonly name: string;
  /** Implementations return `latencyMs` unset — AiGatewayService fills it in around the call. */
  generate(request: AiGenerateRequest): Promise<AiGenerateResult>;
}

/** DI token — AiProvider is an interface and has no runtime identity of its own. */
export const AI_PROVIDER = Symbol('AI_PROVIDER');
