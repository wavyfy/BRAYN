CREATE TABLE IF NOT EXISTS "customer_preference_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"preference_id" uuid NOT NULL,
	"action" text NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"provenance" text NOT NULL,
	"status" text NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_customer_id" uuid NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"provenance" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_preference_history" ADD CONSTRAINT "customer_preference_history_preference_id_customer_preferences_id_fk" FOREIGN KEY ("preference_id") REFERENCES "public"."customer_preferences"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_preference_history" ADD CONSTRAINT "customer_preference_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_preferences" ADD CONSTRAINT "customer_preferences_canonical_customer_id_canonical_customers_id_fk" FOREIGN KEY ("canonical_customer_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_preferences" ADD CONSTRAINT "customer_preferences_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_preferences_workspace_customer_idx" ON "customer_preferences" USING btree ("workspace_id","canonical_customer_id");