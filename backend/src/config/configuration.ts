import { envSchema, type Env } from './env.schema';

/**
 * Loads and validates process.env against the canonical schema.
 * Fails fast on startup if a defined variable is present but malformed.
 */
export function loadConfiguration(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration:\n${parsed.error.issues
        .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')}`,
    );
  }

  return parsed.data;
}
