import { z } from 'zod';

/**
 * Storefront origins (scheme + host + port, e.g. `https://shop.example.com`)
 * the write key is accepted from. Exact-match only — no wildcards. Each
 * entry is normalized to `URL.origin` and the list deduped; an empty list
 * is valid and means no browser origin is accepted.
 */
export const setAllowedOriginsSchema = z.object({
  origins: z
    .array(
      z
        .string()
        .max(255)
        .transform((value, ctx) => {
          try {
            const url = new URL(value);
            if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
          } catch {
            // fall through
          }
          ctx.addIssue({ code: 'custom', message: `"${value}" is not an http(s) origin.` });
          return z.NEVER;
        }),
    )
    .max(20)
    .transform((origins) => [...new Set(origins)]),
});

export type SetAllowedOriginsInput = z.infer<typeof setAllowedOriginsSchema>;
