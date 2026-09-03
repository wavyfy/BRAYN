CREATE TABLE IF NOT EXISTS "automation_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trigger_type" text NOT NULL,
	"conditions" jsonb,
	"action_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"canonical_customer_id" uuid NOT NULL,
	"trigger_event_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automation_definitions_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation_definitions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_canonical_customer_id_canonical_customers_id_fk" FOREIGN KEY ("canonical_customer_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
