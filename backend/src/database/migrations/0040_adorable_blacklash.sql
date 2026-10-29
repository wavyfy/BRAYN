CREATE TABLE IF NOT EXISTS "customer_memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_customer_id" uuid NOT NULL,
	"content" text NOT NULL,
	"provenance" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_memory_entry_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"memory_entry_id" uuid NOT NULL,
	"action" text NOT NULL,
	"content" text NOT NULL,
	"provenance" text NOT NULL,
	"status" text NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_memory_entries" ADD CONSTRAINT "customer_memory_entries_canonical_customer_id_canonical_customers_id_fk" FOREIGN KEY ("canonical_customer_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_memory_entries" ADD CONSTRAINT "customer_memory_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_memory_entry_history" ADD CONSTRAINT "customer_memory_entry_history_memory_entry_id_customer_memory_entries_id_fk" FOREIGN KEY ("memory_entry_id") REFERENCES "public"."customer_memory_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_memory_entry_history" ADD CONSTRAINT "customer_memory_entry_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_memory_entries_workspace_customer_idx" ON "customer_memory_entries" USING btree ("workspace_id","canonical_customer_id");