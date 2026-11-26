ALTER TABLE "integrations" ADD COLUMN "shopify_shop_id" text;--> statement-breakpoint
ALTER TABLE "shopify_compliance_webhooks" ADD COLUMN "exception_reason" text;--> statement-breakpoint
ALTER TABLE "shopify_compliance_webhooks" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "shopify_compliance_webhooks" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shopify_compliance_webhooks" ADD COLUMN "resolution_note" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integrations_shopify_live_shop_id_unique" ON "integrations" USING btree ("shopify_shop_id") WHERE "integrations"."provider" = 'shopify' and "integrations"."status" <> 'disconnected' and "integrations"."shopify_shop_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integrations_shopify_shop_id_idx" ON "integrations" USING btree ("shopify_shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_compliance_webhooks_status_idx" ON "shopify_compliance_webhooks" USING btree ("status");