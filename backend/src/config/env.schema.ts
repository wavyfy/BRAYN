import { z } from 'zod';

/**
 * Canonical environment variable schema for the BRAYN backend.
 *
 * Only variables tied to a locked technology decision (see
 * "29. BRAYN Technology Stack, Engineering Standards & Exclusions") are
 * defined here. Variables tied to an unresolved product/architecture
 * decision (AI provider, cloud/region, billing) must not be added until
 * that decision is locked.
 *
 * Most external-service variables are optional at this stage: wiring them
 * into actual clients happens in the Database/Security foundation steps,
 * not project structure. Actual values are provisioned by the developer
 * locally / by the platform in each environment — never committed.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  // Primary database — PostgreSQL via Neon, pgvector for retrieval (doc 29 §8, §10)
  DATABASE_URL: z.string().url().optional(),

  // Authentication — Clerk (doc 29 §11)
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),

  // Object storage — Cloudflare R2 (doc 29 §12)
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),

  // Redis — Upstash (doc 29 §13)
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // Observability — Sentry (doc 29 §21)
  SENTRY_DSN: z.string().url().optional(),

  // Provider credential encryption — app-level AES-256-GCM (doc 18 Secrets).
  // 64-character hex string (32 raw bytes), e.g. `openssl rand -hex 32`.
  BRAYN_CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),

  // Frontend origin allowed to call this API (CORS) — doc 29 §7 Next.js frontend
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  // This API's own public origin — used to build the Shopify OAuth
  // redirect_uri, which must exactly match the URL registered as an
  // Allowed redirection URL in the Shopify Dev Dashboard.
  BACKEND_URL: z.string().url().default('http://localhost:3001'),

  // Shopify OAuth app credentials (Dev Dashboard — doc 06/20 Shopify auth).
  // Optional: absent in environments that don't need a real Shopify
  // connection (e.g. most test runs); ShopifyOAuthService fails closed if
  // an OAuth route is actually invoked without them configured.
  SHOPIFY_APP_CLIENT_ID: z.string().optional(),
  SHOPIFY_APP_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;
