import { z } from 'zod';

export const startShopifyOAuthSchema = z.object({
  shopDomain: z.string().min(1),
});

export type StartShopifyOAuthInput = z.infer<typeof startShopifyOAuthSchema>;
