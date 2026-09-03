import { z } from 'zod';

/**
 * Canonical client-exposed environment variable schema.
 * Only NEXT_PUBLIC_* variables belong here — server secrets never reach
 * the client bundle. See "29. BRAYN Technology Stack" for locked providers.
 */
const envSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
});

export const env = envSchema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
});
