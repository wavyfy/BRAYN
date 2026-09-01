CREATE TABLE IF NOT EXISTS "commerce_order_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"price" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commerce_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"customer_id" uuid,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"total_price" text,
	"source_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_order_line_items" ADD CONSTRAINT "commerce_order_line_items_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_order_line_items" ADD CONSTRAINT "commerce_order_line_items_order_id_commerce_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_order_line_items" ADD CONSTRAINT "commerce_order_line_items_variant_id_commerce_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."commerce_product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_customer_id_commerce_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."commerce_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_order_line_items_workspace_provider_external_unique" ON "commerce_order_line_items" USING btree ("workspace_id","provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_orders_workspace_provider_external_unique" ON "commerce_orders" USING btree ("workspace_id","provider","external_id");