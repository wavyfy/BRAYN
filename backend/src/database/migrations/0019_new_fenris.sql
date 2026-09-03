CREATE TABLE IF NOT EXISTS "canonical_customer_duplicates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_customer_a_id" uuid NOT NULL,
	"canonical_customer_b_id" uuid NOT NULL,
	"matched_signal" text NOT NULL,
	"matched_value" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canonical_customer_duplicates" ADD CONSTRAINT "canonical_customer_duplicates_canonical_customer_a_id_canonical_customers_id_fk" FOREIGN KEY ("canonical_customer_a_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canonical_customer_duplicates" ADD CONSTRAINT "canonical_customer_duplicates_canonical_customer_b_id_canonical_customers_id_fk" FOREIGN KEY ("canonical_customer_b_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canonical_customer_duplicates_pair_signal_unique" ON "canonical_customer_duplicates" USING btree ("workspace_id","canonical_customer_a_id","canonical_customer_b_id","matched_signal");