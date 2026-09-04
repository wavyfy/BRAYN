CREATE TABLE IF NOT EXISTS "customer_data_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"integration_id" uuid,
	"provider" text NOT NULL,
	"shop_domain" text NOT NULL,
	"shopify_customer_id" text NOT NULL,
	"customer_email" text,
	"orders_requested" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "shop_domain" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_data_requests_workspace_idx" ON "customer_data_requests" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integrations_shop_domain_idx" ON "integrations" USING btree ("shop_domain");