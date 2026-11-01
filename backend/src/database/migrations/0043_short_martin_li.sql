CREATE TABLE IF NOT EXISTS "intelligence_daily_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"customers_processed" integer DEFAULT 0 NOT NULL,
	"health_recalculated" integer DEFAULT 0 NOT NULL,
	"health_skipped" integer DEFAULT 0 NOT NULL,
	"customers_failed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "intelligence_daily_runs_single_running" ON "intelligence_daily_runs" USING btree ("status") WHERE "intelligence_daily_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intelligence_daily_runs_started_at_idx" ON "intelligence_daily_runs" USING btree ("started_at");