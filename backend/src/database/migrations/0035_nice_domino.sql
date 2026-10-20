ALTER TABLE "idempotency_keys" ADD COLUMN "reserved_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "idempotency_keys" SET "reserved_at" = "created_at";
