ALTER TABLE "revenue_opportunities" ADD COLUMN "evidence_product_id" uuid;--> statement-breakpoint
ALTER TABLE "revenue_opportunities" ADD COLUMN "evidence_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "revenue_opportunities" ADD CONSTRAINT "revenue_opportunities_evidence_product_id_commerce_products_id_fk" FOREIGN KEY ("evidence_product_id") REFERENCES "public"."commerce_products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
