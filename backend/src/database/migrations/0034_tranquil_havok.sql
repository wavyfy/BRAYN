ALTER TABLE "commerce_customers" ADD COLUMN "source_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commerce_orders" ADD COLUMN "source_created_at" timestamp with time zone;