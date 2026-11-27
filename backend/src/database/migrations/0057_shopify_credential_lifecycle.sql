ALTER TABLE "integrations" ADD COLUMN "credential_refresh_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "credential_renewal_error" text;--> statement-breakpoint
UPDATE "integrations" SET "credential_renewal_error" = 'expiry_unknown' WHERE "provider" = 'shopify' AND "credentials" IS NOT NULL;
