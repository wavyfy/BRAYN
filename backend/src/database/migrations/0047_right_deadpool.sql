ALTER TABLE "revenue_opportunities" ADD COLUMN "upsell_target_variant_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "revenue_opportunities" ADD CONSTRAINT "revenue_opportunities_upsell_target_variant_id_commerce_product_variants_id_fk" FOREIGN KEY ("upsell_target_variant_id") REFERENCES "public"."commerce_product_variants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
