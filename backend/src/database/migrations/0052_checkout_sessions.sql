CREATE TABLE IF NOT EXISTS "checkout_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_session_id" text NOT NULL,
	"stage" text NOT NULL,
	"abandoned_at" timestamp with time zone NOT NULL,
	"currency" text,
	"item_count" integer DEFAULT 0 NOT NULL,
	"email" text,
	"phone_e164" text,
	"canonical_customer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commerce_orders" ADD COLUMN "external_checkout_session_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_canonical_customer_id_canonical_customers_id_fk" FOREIGN KEY ("canonical_customer_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_sessions_integration_session_unique" ON "checkout_sessions" USING btree ("integration_id","external_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkout_sessions_workspace_session_idx" ON "checkout_sessions" USING btree ("workspace_id","external_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkout_sessions_workspace_canonical_idx" ON "checkout_sessions" USING btree ("workspace_id","canonical_customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkout_sessions_workspace_email_idx" ON "checkout_sessions" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commerce_orders_workspace_checkout_session_idx" ON "commerce_orders" USING btree ("workspace_id","external_checkout_session_id");