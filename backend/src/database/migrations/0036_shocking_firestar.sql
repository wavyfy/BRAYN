ALTER TABLE "integration_webhook_events" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "integration_webhook_events" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_webhook_events" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_webhook_events" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_webhook_events_claim_idx" ON "integration_webhook_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
-- Map the old intake statuses onto the durable lifecycle. `received` (row
-- persisted, never marked processed) and `failed` (dispatch threw before the
-- handler ran) both have direct evidence the record was never applied, so they
-- become claimable `pending` work. `processed` and `dead_letter` keep their
-- meaning unchanged (old `processed` cannot be told apart from a truly
-- applied delivery — see the migration report).
UPDATE "integration_webhook_events" SET "status" = 'pending', "retry_count" = 0 WHERE "status" IN ('received', 'failed');
