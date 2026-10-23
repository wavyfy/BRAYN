/**
 * Normalizes a provider phone value to E.164 for identity matching (doc 09 —
 * Phone is an identity source; "Do not merge solely on weak or ambiguous
 * signals"). Strips common separators (spaces, `-`, `.`, parentheses),
 * treats a leading international `00` as `+`, and accepts only
 * `+<country code><number>` with 8–15 digits. Anything else — a national
 * number with no country code, letters, an extension — returns null: the
 * country is never guessed, so a null value is simply excluded from phone
 * matching.
 *
 * ponytail: shape check only, no per-country length/validity rules (e.g. a
 * stray national trunk `0` after the country code still passes). Add
 * libphonenumber-js plus a provider country (WooCommerce `billing.country`)
 * if national-format numbers need to match.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }

  let phone = raw.trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) {
    phone = `+${phone.slice(2)}`;
  }

  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}
