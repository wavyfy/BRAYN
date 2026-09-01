ALTER TABLE "integration_webhook_events" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "integration_webhook_events" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;