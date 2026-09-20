CREATE TABLE IF NOT EXISTS "website_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"visitor_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "website_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"visitor_id" uuid NOT NULL,
	"session_key" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "website_visitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"visitor_id" text NOT NULL,
	"canonical_customer_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "website_events" ADD CONSTRAINT "website_events_visitor_id_website_visitors_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "public"."website_visitors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "website_events" ADD CONSTRAINT "website_events_session_id_website_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."website_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "website_sessions" ADD CONSTRAINT "website_sessions_visitor_id_website_visitors_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "public"."website_visitors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "website_visitors" ADD CONSTRAINT "website_visitors_canonical_customer_id_canonical_customers_id_fk" FOREIGN KEY ("canonical_customer_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "website_events_workspace_event_unique" ON "website_events" USING btree ("workspace_id","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_events_session_idx" ON "website_events" USING btree ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_events_visitor_idx" ON "website_events" USING btree ("workspace_id","visitor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_events_occurred_at_idx" ON "website_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "website_sessions_workspace_session_unique" ON "website_sessions" USING btree ("workspace_id","session_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_sessions_visitor_idx" ON "website_sessions" USING btree ("workspace_id","visitor_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "website_visitors_workspace_visitor_unique" ON "website_visitors" USING btree ("workspace_id","visitor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_visitors_canonical_customer_idx" ON "website_visitors" USING btree ("canonical_customer_id");