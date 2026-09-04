/**
 * Fixed-pattern text scrubber for BRAYN's logging/error-persistence funnel
 * (Shopify Protected Customer Data — Data Loss Prevention). Not a policy
 * engine: a short, non-configurable list of known-sensitive shapes, run
 * against free-text that reaches a log line or a persisted error column.
 *
 * Deliberately does not attempt to catch arbitrary customer names/phone
 * numbers embedded in unstructured third-party error strings — that would
 * require a much heavier (and much less reliable) approach than this
 * lightweight control is meant to be.
 */

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+\S+/gi;
/** Shopify access-token prefixes (shopify.dev — shpat_/shpca_/shpss_ + custom-app equivalents). */
const SHOPIFY_TOKEN_PATTERN = /\bshp(?:at|ca|ss|ua)_[A-Za-z0-9]+/gi;
/**
 * A long run of hex/base64 characters with no separators — the shape of a
 * raw secret/token, not of a UUID (which is dash-separated and excluded
 * here on purpose so ordinary id fields in error/log context survive).
 */
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9+/]{32,}={0,2}\b/g;

/**
 * Redacts known-sensitive substrings in place, leaving the rest of the
 * text (status codes, entity names, provider names, etc.) intact so the
 * log/error remains useful. Never returns or stores the original value.
 */
export function scrubSensitive(text: string): string {
  return text
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [redacted-token]')
    .replace(SHOPIFY_TOKEN_PATTERN, '[redacted-shopify-token]')
    .replace(LONG_TOKEN_PATTERN, '[redacted-token]');
}
