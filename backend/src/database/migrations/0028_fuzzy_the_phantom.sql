CREATE TABLE IF NOT EXISTS "shopify_oauth_handoff_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_oauth_handoff_tokens_workspace_idx" ON "shopify_oauth_handoff_tokens" USING btree ("workspace_id");