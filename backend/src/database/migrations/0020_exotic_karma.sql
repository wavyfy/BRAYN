CREATE TABLE IF NOT EXISTS "customer_health_state_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_customer_id" uuid NOT NULL,
	"score" integer,
	"health_category" text,
	"signals" jsonb NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"trend" text,
	"calculated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_health_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_customer_id" uuid NOT NULL,
	"score" integer,
	"health_category" text,
	"signals" jsonb NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"trend" text,
	"last_calculated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_health_state_history" ADD CONSTRAINT "customer_health_state_history_canonical_customer_id_canonical_customers_id_fk" FOREIGN KEY ("canonical_customer_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_health_states" ADD CONSTRAINT "customer_health_states_canonical_customer_id_canonical_customers_id_fk" FOREIGN KEY ("canonical_customer_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_health_states_workspace_canonical_unique" ON "customer_health_states" USING btree ("workspace_id","canonical_customer_id");