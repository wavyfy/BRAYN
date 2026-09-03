import { z } from 'zod';

/** Doc15 Phase 1 — "WhatsApp through WAPon" is the only communication channel. */
export const conversationChannels = ['whatsapp'] as const;

export const startConversationSchema = z.object({
  channel: z.enum(conversationChannels),
});

export type StartConversationInput = z.infer<typeof startConversationSchema>;
