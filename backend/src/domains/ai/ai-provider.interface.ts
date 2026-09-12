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

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiGenerateRequest {
  messages: AiMessage[];
  /**
   * Provider model identifier. Optional so callers aren't forced to
   * hard-code a model — model selection is configuration-driven (locked
   * decision), applied by the concrete provider when this is omitted.
   */
  model?: string;
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
  content: string;
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
