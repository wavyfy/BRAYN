CREATE TABLE IF NOT EXISTS "canonical_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"primary_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commerce_customers" ADD COLUMN "canonical_customer_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canonical_customers_workspace_email_unique" ON "canonical_customers" USING btree ("workspace_id","primary_email");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_customers" ADD CONSTRAINT "commerce_customers_canonical_customer_id_canonical_customers_id_fk" FOREIGN KEY ("canonical_customer_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
