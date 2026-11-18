ALTER TABLE "automation_runs" ADD COLUMN "action_input" jsonb;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "retry_of_run_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_retry_of_run_id_automation_runs_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
