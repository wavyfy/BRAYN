ALTER TABLE "ai_action_requests" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_action_requests" ADD COLUMN "decided_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_action_requests" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_action_requests" ADD CONSTRAINT "ai_action_requests_customer_id_canonical_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."canonical_customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_action_requests" ADD CONSTRAINT "ai_action_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
