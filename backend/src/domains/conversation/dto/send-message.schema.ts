import { z } from 'zod';

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(4096),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
