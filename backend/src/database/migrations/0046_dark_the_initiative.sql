ALTER TABLE "revenue_opportunities" ADD COLUMN "affinity_owned_product_id" uuid;--> statement-breakpoint
ALTER TABLE "revenue_opportunities" ADD COLUMN "affinity_other_product_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "revenue_opportunities" ADD CONSTRAINT "revenue_opportunities_affinity_owned_product_id_commerce_products_id_fk" FOREIGN KEY ("affinity_owned_product_id") REFERENCES "public"."commerce_products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "revenue_opportunities" ADD CONSTRAINT "revenue_opportunities_affinity_other_product_id_commerce_products_id_fk" FOREIGN KEY ("affinity_other_product_id") REFERENCES "public"."commerce_products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
