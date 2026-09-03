CREATE TABLE IF NOT EXISTS "integration_reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"triggered_by" text NOT NULL,
	"records_checked" integer DEFAULT 0 NOT NULL,
	"discrepancies_found" integer DEFAULT 0 NOT NULL,
	"discrepancies_repaired" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_reconciliation_runs" ADD CONSTRAINT "integration_reconciliation_runs_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_reconciliation_runs_workspace_idx" ON "integration_reconciliation_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_reconciliation_runs_integration_idx" ON "integration_reconciliation_runs" USING btree ("integration_id");