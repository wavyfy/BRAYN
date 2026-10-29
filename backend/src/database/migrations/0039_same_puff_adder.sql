CREATE TABLE IF NOT EXISTS "identity_merge_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"surviving_canonical_customer_id" uuid NOT NULL,
	"merged_canonical_customer_id" uuid NOT NULL,
	"duplicate_id" uuid NOT NULL,
	"performed_by_user_id" uuid NOT NULL,
	"matched_signal" text NOT NULL,
	"confidence" text NOT NULL,
	"reason" text,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Every row before this migration is a phone match (the only signal that existed) → medium (possible) confidence.
ALTER TABLE "canonical_customer_duplicates" ADD COLUMN "confidence" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "canonical_customer_duplicates" ALTER COLUMN "confidence" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "canonical_customer_duplicates" ADD COLUMN "reviewed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "canonical_customer_duplicates" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canonical_customers" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "canonical_customers" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_merge_history" ADD CONSTRAINT "identity_merge_history_surviving_canonical_customer_id_canonical_customers_id_fk" FOREIGN KEY ("surviving_canonical_customer_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_merge_history" ADD CONSTRAINT "identity_merge_history_merged_canonical_customer_id_canonical_customers_id_fk" FOREIGN KEY ("merged_canonical_customer_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_merge_history" ADD CONSTRAINT "identity_merge_history_duplicate_id_canonical_customer_duplicates_id_fk" FOREIGN KEY ("duplicate_id") REFERENCES "public"."canonical_customer_duplicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_merge_history" ADD CONSTRAINT "identity_merge_history_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canonical_customer_duplicates" ADD CONSTRAINT "canonical_customer_duplicates_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canonical_customers" ADD CONSTRAINT "canonical_customers_merged_into_id_canonical_customers_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
