import { z } from 'zod';

/**
 * Deliberately generic (doc 06 — Provider Isolation): the controller and
 * this schema know nothing about what keys a given provider needs
 * (Shopify: shopDomain/accessToken; a future provider may differ
 * entirely). Each ProviderAdapter's verifyConnection() interprets and
 * validates its own required keys.
 */
export const connectCredentialsSchema = z.object({
  credentials: z.record(z.string(), z.string().min(1)),
});

export type ConnectCredentialsInput = z.infer<typeof connectCredentialsSchema>;
