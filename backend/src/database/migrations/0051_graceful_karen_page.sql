CREATE TABLE IF NOT EXISTS "customer_erasures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"canonical_customer_id" uuid NOT NULL,
	"source_customers_erased" integer NOT NULL,
	"orders_erased" integer NOT NULL,
	"webhook_payloads_cleared" integer NOT NULL,
	"identifiers_blocked" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erased_customer_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value_hmac" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_erasures" ADD CONSTRAINT "customer_erasures_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erased_customer_identifiers" ADD CONSTRAINT "erased_customer_identifiers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_erasures_workspace_idx" ON "customer_erasures" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erased_customer_identifiers_workspace_kind_value_unique" ON "erased_customer_identifiers" USING btree ("workspace_id","kind","value_hmac");