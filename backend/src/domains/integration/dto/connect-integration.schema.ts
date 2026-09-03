import { z } from 'zod';

/** Phase 1 integration sources (doc 06 — Integration Sources). */
export const integrationProviders = ['shopify', 'woocommerce', 'website_tracking', 'whatsapp'] as const;

export const connectIntegrationSchema = z.object({
  provider: z.enum(integrationProviders),
});

export type ConnectIntegrationInput = z.infer<typeof connectIntegrationSchema>;
export type IntegrationProvider = (typeof integrationProviders)[number];
