CREATE TABLE IF NOT EXISTS "commerce_refund_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"order_line_item_id" uuid,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commerce_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"note" text,
	"total_refunded" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_refund_line_items" ADD CONSTRAINT "commerce_refund_line_items_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_refund_line_items" ADD CONSTRAINT "commerce_refund_line_items_refund_id_commerce_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."commerce_refunds"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_refund_line_items" ADD CONSTRAINT "commerce_refund_line_items_order_line_item_id_commerce_order_line_items_id_fk" FOREIGN KEY ("order_line_item_id") REFERENCES "public"."commerce_order_line_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_order_id_commerce_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_refund_line_items_workspace_provider_external_unique" ON "commerce_refund_line_items" USING btree ("workspace_id","provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_refunds_workspace_provider_external_unique" ON "commerce_refunds" USING btree ("workspace_id","provider","external_id");