CREATE TABLE IF NOT EXISTS "internal_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"canonical_customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "internal_notifications" ADD CONSTRAINT "internal_notifications_opportunity_id_revenue_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."revenue_opportunities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "internal_notifications" ADD CONSTRAINT "internal_notifications_canonical_customer_id_canonical_customers_id_fk" FOREIGN KEY ("canonical_customer_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "internal_notifications_workspace_opportunity_unique" ON "internal_notifications" USING btree ("workspace_id","opportunity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "internal_notifications_workspace_created_idx" ON "internal_notifications" USING btree ("workspace_id","created_at");