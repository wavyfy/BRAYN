CREATE TABLE IF NOT EXISTS "shopify_compliance_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" text NOT NULL,
	"topic" text NOT NULL,
	"shop_domain" text NOT NULL,
	"shop_id" text,
	"status" text NOT NULL,
	"outcome" text,
	"matched_integrations" integer,
	"attempts" integer DEFAULT 1 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shopify_compliance_webhooks_webhook_id_unique" ON "shopify_compliance_webhooks" USING btree ("webhook_id");